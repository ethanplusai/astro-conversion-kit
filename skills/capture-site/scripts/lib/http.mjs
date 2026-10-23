// Paced, read-only HTTP for live sites.
// fetchPaced(url, { delayMs, ua, redirect, method, raw, trusted, timeoutMs, idleMs, maxBytes,
//   toFile, discardBody }) -> { status, headers, body, finalUrl, bytes, error? }
// - body is a string for text types and a Buffer otherwise; `raw: true` always gives the Buffer;
// - method defaults to GET (HEAD for a size check without the body);
// - timeoutMs (default 30 s) bounds the whole request, body included; idleMs (default 30 s)
//   aborts when no data arrives for that long;
// - the body is read as a stream and counted after decompression: past maxBytes (default 20 MB)
//   the request is dropped and status is "too-large" (also when Content-Length says so first);
// - toFile streams the body to that path (written as <path>.part, renamed when complete) and
//   discardBody counts it without keeping it; both leave body empty and report `bytes`;
// - SSRF guard: a request (or a followed redirect hop) to any host but a `trusted` URL's
//   host:port (www or not) is resolved first, and a loopback, private, link-local or cloud
//   metadata address is refused without a request: status "blocked-address";
// - redirect: 'follow' follows up to 20 hops by hand, each one through the guard;
// - waits delayMs (default 2500) since the previous request to the same host;
// - doubles that host's wait after a 429 or 503, back to normal after a success;
// - counts consecutive 403/429/503/network errors in `blocked` (callers stop at 3);
// - never throws: a network error or timeout comes back as status 0 with `error` set.
import { lookup } from 'node:dns/promises';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

export const DEFAULT_DELAY_MS = 2500;
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const BLOCK_LIMIT = 3;

export const TIMEOUT_MS = 30_000;
export const IDLE_MS = 30_000;
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 ** 3;
export const TOO_LARGE = 'too-large';
export const BLOCKED_ADDRESS = 'blocked-address';
const MAX_BACKOFF = 32;
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCK_STATUSES = new Set([403, 429, 503]);
const BACKOFF_STATUSES = new Set([429, 503]);
const TEXT_TYPE = /^(text\/|application\/(.*\+)?(xml|json|javascript)|image\/svg\+xml)/i;

const hosts = new Map(); // host -> { lastAt, backoff }

export let blocked = 0;

export function resetBlocked() {
  blocked = 0;
}

export const http = {
  get blocked() {
    return blocked;
  },
  resetBlocked,
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function pace(host, delayMs) {
  const state = hosts.get(host) ?? { lastAt: 0, backoff: 1 };
  hosts.set(host, state);
  // Reserve the next start slot before waiting, so concurrent callers are spaced too.
  const now = Date.now();
  const at = Math.max(now, state.lastAt + delayMs * state.backoff);
  state.lastAt = at;
  if (at > now) await sleep(at - now);
  return state;
}

// IPv4 dotted quad -> 32-bit number, or null.
function ipv4Number(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

const inV4 = (n, base, bits) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits));

// IPv6 text -> eight 16-bit groups (an embedded dotted quad becomes two groups), or null.
function ipv6Groups(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const quad = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const n = ipv4Number(quad[1]);
    if (n === null) return null;
    text = `${text.slice(0, -quad[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// True for an address no capture should reach on another host's behalf: loopback, private,
// link-local, unspecified and cloud metadata addresses, IPv4 or IPv6 (IPv4-mapped included).
export function isBlockedAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4Number(ip);
    return (
      inV4(n, '0.0.0.0', 8) || // "this network"; 0.0.0.0 reaches the local machine
      inV4(n, '127.0.0.0', 8) ||
      inV4(n, '10.0.0.0', 8) ||
      inV4(n, '172.16.0.0', 12) ||
      inV4(n, '192.168.0.0', 16) ||
      inV4(n, '169.254.0.0', 16) || // link-local, including the 169.254.169.254 metadata service
      inV4(n, '100.64.0.0', 10) || // carrier-grade NAT
      n >= ipv4Number('224.0.0.0') // multicast, reserved and broadcast
    );
  }
  if (kind === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
    if (zeros(0, 7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
    const v4 = (hi, lo) => isBlockedAddress(`${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`);
    if (zeros(0, 6)) return v4(g[6], g[7]); // IPv4-compatible ::a.b.c.d
    if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // IPv4-mapped ::ffff:a.b.c.d
    if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]); // IPv4-translated ::ffff:0:a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6], g[7]); // NAT64 64:ff9b::/96
    if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 2002::/16
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local, including fd00:ec2::254
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not an address at all: refuse rather than guess
}

const siteHost = (url) => url.host.toLowerCase().replace(/^www\./, '');

// null when the URL may be requested, else the reason it may not. The lookup is bounded by
// what is left of the request's total timeout.
async function guard(url, trusted, deadline) {
  if (trusted.has(siteHost(url))) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    if (isIP(hostname)) addresses = [{ address: hostname }];
    else {
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), Math.max(0, deadline - Date.now()));
      });
      try {
        addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), late]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    return { network: err.code ?? err.message };
  }
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  return bad ? { address: bad.address } : null;
}

function trustedHosts(trusted) {
  const set = new Set();
  for (const t of [trusted].flat()) {
    if (!t) continue;
    try {
      set.add(siteHost(new URL(t)));
    } catch {
      // not a URL: trusts nothing
    }
  }
  return set;
}

// Reads res.body chunk by chunk. Returns { buffer, bytes } or { tooLarge: true }; throws on a
// network error, the total timeout or the idle timeout.
async function readBody(res, { maxBytes, toFile, discardBody, touch }) {
  const keep = !toFile && !discardBody;
  const chunks = [];
  let bytes = 0;
  const part = toFile ? `${toFile}.part` : null;
  let file = null;
  const reader = res.body?.getReader();
  try {
    if (part) {
      await mkdir(dirname(part), { recursive: true });
      file = await open(part, 'w');
    }
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        await file?.close();
        file = null;
        if (part) await rm(part, { force: true });
        return { tooLarge: true };
      }
      if (keep) chunks.push(value);
      else if (file) await file.write(value);
    }
    if (file) {
      await file.close();
      file = null;
      await rename(part, toFile);
    }
    return { buffer: keep ? Buffer.concat(chunks) : Buffer.alloc(0), bytes };
  } catch (err) {
    await reader?.cancel().catch(() => {});
    await file?.close().catch(() => {});
    if (part) await rm(part, { force: true });
    throw err;
  }
}

export async function fetchPaced(url, {
  delayMs = DEFAULT_DELAY_MS, ua = DEFAULT_UA, redirect = 'manual', method = 'GET', raw = false,
  trusted = [], timeoutMs = TIMEOUT_MS, idleMs = IDLE_MS, maxBytes, toFile = null, discardBody = false,
} = {}) {
  let target = new URL(url);
  const trust = trustedHosts(trusted);
  const cap = maxBytes ?? (toFile || discardBody ? MAX_FILE_BYTES : MAX_TEXT_BYTES);
  const refused = (reason, at) => ({ status: BLOCKED_ADDRESS, headers: {}, body: '', finalUrl: at.href, bytes: null, error: `${at.hostname} resolves to ${reason}` });

  const deadline = Date.now() + timeoutMs;
  const first = await guard(target, trust, deadline);
  if (first?.address) return refused(first.address, target);
  const state = await pace(target.host, delayMs);

  const idle = new AbortController();
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error(`no data for ${idleMs} ms`)), idleMs);
  };
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), idle.signal]);
  const fail = (err) => {
    blocked += 1;
    state.lastAt = Math.max(state.lastAt, Date.now());
    return { status: 0, headers: {}, body: '', finalUrl: target.href, bytes: null, error: err.cause?.code ?? err.message };
  };

  let res;
  let read;
  try {
    touch();
    if (first?.network) throw Object.assign(new Error(first.network), { cause: { code: first.network } });
    let hopMethod = method;
    for (let hop = 0; ; hop += 1) {
      res = await fetch(target, { method: hopMethod, redirect: 'manual', headers: { 'User-Agent': ua, Accept: '*/*' }, signal });
      touch();
      const location = res.headers.get('location');
      if (redirect !== 'follow' || !REDIRECT_STATUSES.has(res.status) || !location || hop >= MAX_REDIRECTS) break;
      await res.body?.cancel().catch(() => {});
      target = new URL(location, target);
      if (res.status === 303 && hopMethod !== 'HEAD') hopMethod = 'GET';
      const check = await guard(target, trust, deadline);
      if (check?.address) {
        clearTimeout(idleTimer);
        state.lastAt = Math.max(state.lastAt, Date.now());
        return refused(check.address, target);
      }
      if (check?.network) throw Object.assign(new Error(check.network), { cause: { code: check.network } });
    }
    const length = Number(res.headers.get('content-length'));
    // Inside the try: a reset or timeout partway through the body is a network error too.
    if (method !== 'HEAD' && Number.isFinite(length) && length > cap && !res.headers.get('content-encoding')) {
      await res.body?.cancel().catch(() => {});
      read = { tooLarge: true };
    } else {
      // Only a 200 is saved to a file; any other answer's body is counted and dropped.
      const save = res.status === 200 ? toFile : null;
      read = await readBody(res, { maxBytes: cap, toFile: save, discardBody: discardBody || Boolean(toFile && !save), touch });
    }
  } catch (err) {
    clearTimeout(idleTimer);
    return fail(err);
  }
  clearTimeout(idleTimer);

  const headers = Object.fromEntries(res.headers);
  state.lastAt = Math.max(state.lastAt, Date.now());
  if (BLOCK_STATUSES.has(res.status)) blocked += 1;
  else blocked = 0;
  if (BACKOFF_STATUSES.has(res.status)) state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF);
  else if (res.status < 400) state.backoff = 1;

  if (read.tooLarge) {
    return { status: TOO_LARGE, headers, body: '', finalUrl: target.href, bytes: null, error: `larger than ${cap} bytes (answered ${res.status})` };
  }
  const type = headers['content-type'] ?? 'text/plain';
  const body = toFile || discardBody ? '' : !raw && TEXT_TYPE.test(type) ? read.buffer.toString('utf8') : read.buffer;
  return { status: res.status, headers, body, finalUrl: target.href, bytes: read.bytes };
}
