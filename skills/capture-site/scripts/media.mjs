#!/usr/bin/env node
// Media enumeration for a finished capture: every media file the site's pages, stylesheets, REST
// media list and image sitemaps point at, checked with one paced HEAD each (GET when HEAD is
// refused, or to download). Only files on the captured site are listed.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse } from 'parse5';
import { assertNodeVersion } from './lib/node-version.mjs';
import { BLOCK_LIMIT, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, MAX_FILE_BYTES, MAX_TEXT_BYTES, TOO_LARGE } from './lib/http.mjs';
import { cssUrls, FONT_EXTENSIONS, IMAGE_EXTENSIONS } from './lib/css-urls.mjs';
import { extensionOf } from './lib/page-rules.mjs';
import { mediaUrlsOf } from './lib/wp-rest.mjs';
import { srcsetUrls } from '../../parity-gates/scripts/lib/srcset.mjs';

export { srcsetUrls };

const USAGE = `Usage: node media.mjs --capture <dir> [--download <dir>] [--delay <ms>] [--concurrency <n>] [--max-file-bytes <n>]

List every media file of a captured site in <capture>/media.json:
  [{ url, path, source[], referencedBy[], status, contentType, bytes }]
source is where it was found: html (src, data-src, icons, preloads, links to files), srcset,
css (stylesheets and style attributes), rest (the WordPress media list, every size), sitemap
(image sitemaps), og (og:image, twitter:image). referencedBy lists the pages that use it.
Entries are keyed by path: references to the same path (another query string, http or https,
www or not) are one entry, and the first URL found for it is the one listed and requested.
Each file is checked with one paced HEAD request (GET when HEAD is refused). A file that times
out, resets the connection or answers 403 after 3 tries is listed with that status (0 for a
network error, with \`error\`); three such files in a row stop the run. A file larger than
--max-file-bytes is listed with status "too-large" and not saved; a file on a host that resolves
to a loopback, private or link-local address (other than the captured site's own) is not
requested and is listed "blocked-address".

  --capture <dir>   the capture folder written by capture.mjs (reads inventory.json,
                    pages/, css/, wp-rest/media.json, sitemaps/)
  --download <dir>  also save every file that answers 200 under <dir>/<path>, byte for byte
                    (streamed to disk; a download with no data for 30 s is a network error)
  --max-file-bytes <n>  largest file to download or measure (default ${MAX_FILE_BYTES}, 2 GB)
  --delay <ms>      wait between requests (default ${DEFAULT_DELAY_MS})
  --concurrency <n> files requested at once (default 1, at most 32). Raise it only with the site
                    owner's consent: --delay still spaces the request starts, so pair a
                    higher value with a shorter --delay (for example 8 and 100)
  --ua "<string>"   user agent (default: a desktop Chrome)
  --help            show this help

Run it again after a stop: files already checked (and downloaded) are kept.
Exit codes: 0 done, 2 usage error, no capture or no page that answered 200, 3 stopped because the site is blocking
requests (wait, then run the same command again).`;

const SOURCE_ORDER = ['html', 'srcset', 'css', 'rest', 'sitemap', 'og'];
const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS,
  'mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'zip',
]);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
const PRELOAD_AS = new Set(['image', 'font', 'video', 'audio']);
const OG_KEYS = new Set([
  'og:image', 'og:image:url', 'og:image:secure_url', 'og:video', 'og:video:url', 'og:video:secure_url',
  'og:audio', 'twitter:image', 'twitter:image:src',
]);
const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
const HEAD_REFUSED = new Set([400, 403, 405, 501]);
// After its retries, one file's network error or 403 is its answer; a 429 or 503 means the site
// wants us to stop.
const GIVE_UP = new Set([0, 403]);
const GET_TIMEOUT_MS = 120_000;
// A download is bounded by the idle timeout; this only stops one that trickles forever.
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_MIN_MS = 500;

class UsageError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');

function parseArgs(argv) {
  const args = { capture: null, download: null, delayMs: DEFAULT_DELAY_MS, ua: DEFAULT_UA, maxFileBytes: MAX_FILE_BYTES, concurrency: 1, help: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--capture') args.capture = value((i += 1), arg);
    else if (arg === '--download') args.download = value((i += 1), arg);
    else if (arg === '--ua') args.ua = value((i += 1), arg);
    else if (arg === '--delay') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 0) throw new UsageError('--delay needs a whole number');
      args.delayMs = n;
    } else if (arg === '--concurrency') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new UsageError('--concurrency needs a whole number from 1 to 32');
      args.concurrency = n;
    } else if (arg === '--max-file-bytes') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--max-file-bytes needs a whole number of bytes');
      args.maxFileBytes = n;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!args.help && !args.capture) throw new UsageError('--capture <dir> is required');
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;

// Every media reference in one page's HTML: [{ href, source, needsExtension }]. A style
// attribute's url()s are resolved against the page.
function pageRefs(html, pageUrl) {
  const refs = [];
  const add = (href, source, needsExtension = false) => {
    if (href && !/^data:/i.test(href.trim())) refs.push({ href: href.trim(), source, needsExtension });
  };
  const walk = (node) => {
    const tag = node.tagName;
    if (tag === 'img' || tag === 'source') {
      const lazy = LAZY_SRC.map((n) => attr(node, n)).find(Boolean);
      add(lazy ?? attr(node, 'src'), 'html');
      for (const name of ['srcset', ...LAZY_SRCSET]) for (const url of srcsetUrls(attr(node, name))) add(url, 'srcset');
    } else if (tag === 'video' || tag === 'audio') {
      add(attr(node, 'src'), 'html');
      add(attr(node, 'poster'), 'html');
    } else if (tag === 'link') {
      const rels = (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rels.some((r) => ICON_RELS.has(r))) add(attr(node, 'href'), 'html');
      else if (rels.includes('preload') && PRELOAD_AS.has((attr(node, 'as') ?? '').toLowerCase())) add(attr(node, 'href'), 'html');
    } else if (tag === 'a' || tag === 'area') {
      add(attr(node, 'href'), 'html', true);
    } else if (tag === 'meta') {
      const key = (attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase();
      if (OG_KEYS.has(key)) add(attr(node, 'content'), 'og');
    }
    const style = attr(node, 'style');
    if (style) for (const url of cssUrls(`x{${style}}`, pageUrl)) add(url, 'css');
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return refs;
}

function sitemapImages(dir) {
  if (!existsSync(dir)) return [];
  const urls = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'index.json') continue; // the capture's list of sitemaps asked for, not a sitemap
    let buffer = readFileSync(join(dir, name));
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = gunzipSync(buffer, { maxOutputLength: MAX_TEXT_BYTES });
      } catch {
        continue;
      }
    }
    for (const m of buffer.toString('utf8').matchAll(/<image:loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/image:loc>/gi)) {
      urls.push(m[1].trim().replace(/&amp;/g, '&'));
    }
  }
  return urls;
}

// Every media file the capture points at, keyed by path.
export function collectMedia(captureDir) {
  const meta = existsSync(join(captureDir, 'meta.json')) ? readJson(join(captureDir, 'meta.json')) : {};
  const inventory = readJson(join(captureDir, 'inventory.json'));
  const origin = meta.canonicalOrigin ?? meta.origin ?? (inventory[0] ? new URL(inventory[0].url).origin : null);
  if (!origin) throw new UsageError(`${captureDir} has no origin in meta.json and no pages`);
  const site = new URL(origin);
  const found = new Map();

  const add = (href, base, source, page, needsExtension = false) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url) !== bareHost(site)) return;
    url.protocol = site.protocol;
    url.host = site.host;
    url.hash = '';
    if (url.pathname.endsWith('/')) return;
    const ext = extensionOf(url.pathname);
    if (needsExtension && !MEDIA_EXTENSIONS.has(ext)) return;
    const entry = found.get(url.pathname) ?? { url: url.href, path: url.pathname, source: new Set(), referencedBy: new Set() };
    found.set(url.pathname, entry);
    entry.source.add(source);
    if (page) entry.referencedBy.add(page);
  };

  for (const record of inventory) {
    if (record.status !== 200 || !record.snapshot) continue;
    const file = join(captureDir, record.snapshot);
    if (!existsSync(file)) continue;
    const pageUrl = new URL(record.path, origin).href;
    for (const ref of pageRefs(readFileSync(file, 'utf8'), pageUrl)) {
      add(ref.href, pageUrl, ref.source, record.path, ref.needsExtension);
    }
  }

  const manifestFile = join(captureDir, 'css', 'manifest.json');
  for (const entry of existsSync(manifestFile) ? readJson(manifestFile) : []) {
    if (!entry?.file || !existsSync(join(captureDir, 'css', entry.file))) continue;
    const base = entry.finalUrl ?? entry.href ?? new URL(entry.pages?.[0] ?? '/', origin).href;
    for (const url of cssUrls(readFileSync(join(captureDir, 'css', entry.file), 'utf8'), base)) {
      for (const page of entry.pages?.length ? entry.pages : [null]) add(url, base, 'css', page);
    }
  }

  const restMedia = join(captureDir, 'wp-rest', 'media.json');
  if (existsSync(restMedia)) for (const url of mediaUrlsOf(readJson(restMedia))) add(url, origin, 'rest', null);
  for (const url of sitemapImages(join(captureDir, 'sitemaps'))) add(url, origin, 'sitemap', null);

  return [...found.values()]
    .map((e) => ({
      url: e.url,
      path: e.path,
      source: SOURCE_ORDER.filter((s) => e.source.has(s)),
      referencedBy: [...e.referencedBy].sort(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function downloadTarget(dir, path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const root = resolve(dir);
  const target = resolve(root, `.${decoded}`);
  return target.startsWith(root + sep) ? target : null;
}

const fileHolds = (file, bytes) => {
  try {
    return statSync(file).size === bytes;
  } catch {
    return false;
  }
};

async function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const captureDir = resolve(args.capture);
  if (!existsSync(join(captureDir, 'inventory.json'))) {
    console.error(`No capture in ${captureDir}: inventory.json is missing (run capture.mjs first).`);
    process.exit(2);
  }

  if (!readJson(join(captureDir, 'inventory.json')).some((r) => r.status === 200)) {
    console.error(`No page in ${join(captureDir, 'inventory.json')} answered 200: there is no media to list. Fix the capture first (capture.mjs).`);
    process.exit(2);
  }

  let media;
  try {
    media = collectMedia(captureDir);
  } catch (err) {
    console.error(`Cannot read the capture in ${captureDir}: ${err.message}`);
    process.exit(2);
  }
  const outFile = join(captureDir, 'media.json');
  const earlier = new Map();
  try {
    for (const e of existsSync(outFile) ? readJson(outFile) : []) earlier.set(e.path, e);
  } catch {
    // an unreadable earlier list is simply redone
  }
  const write = () => writeFileSync(outFile, `${JSON.stringify(media, null, 2)}\n`);
  const meta = existsSync(join(captureDir, 'meta.json')) ? readJson(join(captureDir, 'meta.json')) : {};
  const trusted = [meta.origin, meta.canonicalOrigin, media[0]?.url];
  const request = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, ua: args.ua, trusted, maxBytes: args.maxFileBytes });
  const streak = new Set();

  // Every entry carries the fields from the start, so a stopped run lists what is left as null.
  for (const entry of media) Object.assign(entry, { status: null, contentType: null, bytes: null });
  // One file: check it (and download it) unless an earlier run already did.
  const checkOne = async (entry) => {
    const before = earlier.get(entry.path);
    const target = args.download ? downloadTarget(args.download, entry.path) : null;
    // A file that was too large is asked again: the cap may have been raised.
    if (before && before.status !== null && !BLOCK_STATUSES.has(before.status) && before.status !== TOO_LARGE) {
      const downloaded = !args.download || before.status !== 200 || !target || fileHolds(target, before.bytes);
      if (downloaded) {
        Object.assign(entry, { status: before.status, contentType: before.contentType, bytes: before.bytes });
        if (before.location) entry.location = before.location;
        return;
      }
    }

    let res;
    let viaGet = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      viaGet = Boolean(args.download);
      if (!viaGet) {
        res = await request(entry.url, { method: 'HEAD' });
        const length = res.headers?.['content-length'];
        viaGet = HEAD_REFUSED.has(res.status) || (res.status === 200 && length === undefined);
      }
      if (viaGet) {
        res = await request(entry.url, target
          ? { toFile: target, timeoutMs: DOWNLOAD_TIMEOUT_MS }
          : { discardBody: true, timeoutMs: args.download ? DOWNLOAD_TIMEOUT_MS : GET_TIMEOUT_MS });
      }
      if (!BLOCK_STATUSES.has(res.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(Math.max(RETRY_MIN_MS, args.delayMs) * 2 ** (attempt - 1));
    }

    const blocked = BLOCK_STATUSES.has(res.status);
    const stop = () => {
      write();
      console.error(
        `Stopped: ${new URL(entry.url).origin} is blocking requests or cannot be reached. Wait a while, then run the same command again; files already checked are kept.`,
      );
      process.exit(3);
    };
    if (blocked && !GIVE_UP.has(res.status)) stop();
    if (blocked) streak.add(entry.path);
    else streak.clear();

    entry.status = res.status;
    entry.contentType = res.headers?.['content-type'] ?? null;
    const length = Number(res.headers?.['content-length']);
    entry.bytes = typeof res.status !== 'number' || res.status === 0 ? null : viaGet ? res.bytes : Number.isFinite(length) ? length : null;
    if (res.status === 0 || typeof res.status !== 'number') entry.error = res.error ?? 'network error';
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      entry.location = new URL(res.headers.location, entry.url).href;
    }
    if (streak.size >= BLOCK_LIMIT) stop();
    done += 1;
    // Save progress now and then, so a stopped run resumes without asking again.
    if (done % 100 === 0) write();
  };

  // --concurrency workers share the per-host pacing in fetchPaced: --delay stays the gap
  // between request starts, and up to --concurrency requests are in flight at once.
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < media.length) await checkOne(media[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, media.length) }, worker));

  write();
  const ok = media.filter((m) => m.status === 200);
  const bytes = ok.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  const saved = args.download ? `, saved under ${resolve(args.download)}` : '';
  console.log(`Listed ${media.length} media files (${media.length - ok.length} not 200, ${bytes} bytes) in ${outFile}${saved}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
