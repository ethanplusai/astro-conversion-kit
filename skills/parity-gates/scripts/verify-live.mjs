#!/usr/bin/env node
// Live verifier: checks a deployed build (a preview or the production host) against the baseline
// over HTTP. Routes answer 200, redirects resolve in one hop, the X-Robots-Tag header matches the
// deploy's purpose, the sitemap answers, and a media sample has the captured sizes. Read-only and
// paced; it stops after three consecutive blocked responses, or at the first answer that is
// Vercel's deployment protection.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { attr, findAll, parseHtml } from './lib/html.mjs';
import { isNoop } from './lib/redirects-csv.mjs';

const USAGE = `Usage: node verify-live.mjs --base <url> --baseline baseline [options]

Checks a deployed site against the baseline:
  route     every baseline route at 200 answers 200 at <base><path>
  redirect  every baseline redirect answers a redirect of the same kind (permanent 301/308,
            temporary 302/303/307) whose Location is its target: one hop, no chain. A
            shortlink the capture did not request (verified: false) still has to resolve; its
            failure is marked "unverified live"
  header    pages (page, post, archive) carry X-Robots-Tag: noindex iff --expect-noindex; with
            --expect-noindex a <meta name="robots"> noindex in the page also counts (the site
            template's staging build sets it on every page); without it, a page whose robots
            meta says noindex fails unless baseline/seo.json says the live page did too
  redirect  a query row whose target is its own path (/?p=2 -> /, left out of the host rules)
            answers 200 in place
  sitemap   /sitemap-index.xml (or /sitemap_index.xml, or /sitemap.xml) answers 200
  media     a random sample of 20 baseline media files (all when fewer) answers 200 with a
            content-length equal to the baseline bytes

  --base <url>            the deploy to check, e.g. https://my-site.vercel.app (required)
  --baseline <dir>        the baseline folder (default: baseline)
  --bypass <value>        sent as the x-vercel-protection-bypass header on every request to --base
  --expect-noindex        the deploy is a preview or staging copy: pages must say noindex
  --sample <n>            check n of the routes at random, always / and one route per template
  --media-manifest <file> media-upload.mjs manifest ([{ path, bytes, url }]): sample its entries
                          and check each one at its url against its bytes; a url that is a site
                          path (starts with "/") is requested at <base><path>
  --delay <ms>            pause between requests (default: 500)
  --json                  print { checked, failed, failures[], skipped[] } as JSON
  --help                  show this help

Requests carry a browser user agent and ask for identity encoding. A 403, 429, 503 or network
error is retried after twice the delay, doubling each time; three in a row stop the run. A
request with no full response within 30 s is that check's failure (field "timeout"), not a
block: the run goes on. A redirect to vercel.com/sso-api is Vercel's deployment protection, not
the site: the run stops at the first one. On a public staging (the default) that means the
wrong URL: run it against the project's production alias, not the raw deployment URL. Only
when staging was deliberately protected, pass --bypass with the bypass secret a person created
(Settings, Deployment Protection, Protection Bypass for Automation).

Exit codes: 0 every check passed, 1 a check failed, 2 usage or missing input, 3 stopped after
three consecutive blocked responses (run it again later) or at deployment protection.`;

const OPTIONS = {
  base: { type: 'string' },
  baseline: { type: 'string', default: 'baseline' },
  bypass: { type: 'string' },
  'expect-noindex': { type: 'boolean', default: false },
  sample: { type: 'string' },
  'media-manifest': { type: 'string' },
  delay: { type: 'string', default: '500' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PAGE_KINDS = new Set(['page', 'post', 'archive']);
const BLOCKED = new Set([403, 429, 503]);
const MAX_BLOCKS = 3;
const MEDIA_SAMPLE = 20;
const SITEMAPS = ['/sitemap-index.xml', '/sitemap_index.xml', '/sitemap.xml'];
const PERMANENT = new Set([301, 308]);
const TEMPORARY = new Set([302, 303, 307]);
export const REQUEST_TIMEOUT_MS = 30_000;

// Vercel Authentication answers a request without a valid bypass with a 302 to
// https://vercel.com/sso-api?url=...: any redirect to a vercel.com host whose URL names sso-api.
export function isVercelProtection(status, location) {
  if (status < 300 || status > 399 || !location) return false;
  let url;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (host === 'vercel.com' || host.endsWith('.vercel.com')) && url.href.includes('sso-api');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const show = (value) => JSON.stringify(value ?? null);

class Stopped extends Error {}
class TimedOut extends Error {}

function usageError(message) {
  process.stderr.write(`verify-live: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

// Picks `count` items at random, keeping the input order.
function pickRandom(items, count, random = Math.random) {
  const indexes = items.map((_, i) => i);
  for (let i = indexes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  const kept = new Set(indexes.slice(0, count));
  return items.filter((_, i) => kept.has(i));
}

// n routes at random, always / and one route of each template (more than n when there are more
// templates than n). Returns { sampled, rest } in baseline order.
export function sampleRoutes(routes, n, random = Math.random) {
  const required = new Set(routes.filter((r) => r.path === '/'));
  const byTemplate = new Map();
  for (const r of routes) byTemplate.set(r.template, [...(byTemplate.get(r.template) ?? []), r]);
  for (const group of byTemplate.values()) {
    if (!group.some((r) => required.has(r))) required.add(pickRandom(group, 1, random)[0]);
  }
  const others = pickRandom(routes.filter((r) => !required.has(r)), Math.max(0, n - required.size), random);
  const chosen = new Set([...required, ...others]);
  return { sampled: routes.filter((r) => chosen.has(r)), rest: routes.filter((r) => !chosen.has(r)) };
}

// The content of the first <meta name="robots"> saying noindex in an HTML response, or null.
function metaNoindex(res) {
  if (!/html/i.test(res.headers.get('content-type') ?? '')) return null;
  const metas = findAll(parseHtml(res.body.toString('utf8')), (n) => n.tagName === 'meta' && (attr(n, 'name') ?? '').trim().toLowerCase() === 'robots');
  const hit = metas.find((n) => /\bnoindex\b/i.test(attr(n, 'content') ?? ''));
  return hit ? attr(hit, 'content') : null;
}

// Same class of redirect: a permanent one stays permanent, a temporary one temporary.
function sameKind(expected, actual) {
  if (PERMANENT.has(expected)) return PERMANENT.has(actual);
  if (TEMPORARY.has(expected)) return TEMPORARY.has(actual);
  return expected === actual;
}

export function createVerifier({ base, bypass, delay = 500, timeout = REQUEST_TIMEOUT_MS, fetchImpl = fetch, out = () => {} }) {
  const baseUrl = new URL(base);
  const prefix = baseUrl.href.replace(/\/+$/, '');
  let requests = 0;
  let blocks = 0;
  let checked = 0;
  const failures = [];
  const skipped = [];

  async function request(url) {
    for (;;) {
      if (requests > 0) await sleep(blocks > 0 ? delay * 2 ** blocks : delay);
      requests += 1;
      const headers = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' };
      if (bypass && new URL(url).origin === baseUrl.origin) headers['x-vercel-protection-bypass'] = bypass;
      let response;
      let reason;
      let body;
      // The signal covers the body too: a host that stalls mid-response is a timeout as well.
      try {
        response = await fetchImpl(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(timeout) });
        if (BLOCKED.has(response.status)) reason = String(response.status);
        else body = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') {
          blocks = 0;
          throw new TimedOut(url);
        }
        reason = `network error: ${error.cause?.code ?? error.message}`;
      }
      if (!reason) {
        blocks = 0;
        const location = response.headers.get('location');
        if (isVercelProtection(response.status, location)) {
          throw new Stopped(
            `deployment protection: ${url} redirected to vercel.com/sso-api; use the project's production alias ` +
              '(public by default), or pass --bypass if staging was deliberately protected',
          );
        }
        return { status: response.status, headers: response.headers, body };
      }
      await response?.body?.cancel().catch(() => {});
      blocks += 1;
      if (blocks >= MAX_BLOCKS) throw new Stopped(`stopped after ${MAX_BLOCKS} consecutive blocked responses (${reason}) at ${url}`);
    }
  }

  // One check: problems is a list of { field, expected, actual }; empty means it passed.
  function record(check, path, problems, extra = {}, label = path) {
    checked += 1;
    if (problems.length === 0) {
      out(`  ok ${check} ${label}`);
      return;
    }
    for (const p of problems) {
      const note = extra.unverified ? ' (unverified live)' : '';
      out(`  FAIL ${check} ${path} ${p.field}${note}: expected ${show(p.expected)}, got ${show(p.actual)}`);
      failures.push({ check, path, field: p.field, expected: p.expected, actual: p.actual, ...extra });
    }
  }

  // Runs one check; a request that timed out fails that check and the run goes on.
  const guarded = (check, pathOf, fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (!(error instanceof TimedOut)) throw error;
      return record(check, pathOf(...args), [{ field: 'timeout', expected: `a response within ${timeout / 1000} s`, actual: 'timed out' }]);
    }
  };

  const relative = (location, from) => {
    const url = new URL(location, from);
    return url.origin === baseUrl.origin ? `${url.pathname}${url.search}` : url.href;
  };

  async function route(r, { expectNoindex, liveNoindex = false }) {
    const res = await request(`${prefix}${r.path}`);
    const problems = [];
    if (res.status !== 200) problems.push({ field: 'status', expected: 200, actual: res.status });
    else if (PAGE_KINDS.has(r.kind)) {
      const tag = res.headers.get('x-robots-tag');
      const noindex = /\bnoindex\b/i.test(tag ?? '');
      if (expectNoindex && !noindex && !metaNoindex(res)) problems.push({ field: 'x-robots-tag', expected: 'noindex (header or meta robots)', actual: tag });
      if (!expectNoindex && noindex) problems.push({ field: 'x-robots-tag', expected: null, actual: tag });
      if (!expectNoindex && !liveNoindex) {
        const meta = metaNoindex(res);
        if (meta !== null) problems.push({ field: 'robots', expected: 'no noindex (the live page is indexable)', actual: meta });
      }
    }
    record('route', r.path, problems);
  }

  // `to` is a path, or an absolute URL that stays one unless it is on one of the old origins.
  async function redirect(r, oldOrigins) {
    const url = `${prefix}${r.from}`;
    const res = await request(url);
    let expected = r.to;
    if (/^https?:/i.test(expected)) {
      const target = new URL(expected);
      if (oldOrigins.has(target.origin)) expected = `${target.pathname}${target.search}`;
    }
    const problems = [];
    const location = res.headers.get('location');
    if (!location || !sameKind(r.status, res.status)) {
      problems.push({ field: 'status', expected: r.status, actual: res.status });
    } else {
      const actual = relative(location, url);
      // Hosts that pass the query string through (/?p=7 -> /services/?p=7) still resolve in one hop.
      const source = new URL(url).search;
      const passedThrough = source && actual === `${expected}${source}`;
      if (actual !== expected && !passedThrough) problems.push({ field: 'location', expected, actual });
    }
    record('redirect', r.from, problems, r.verified === false ? { unverified: true } : {}, `${r.from} -> ${r.to}`);
  }

  // A query row whose target is its own path (left out by build-redirects): the host passes the
  // query on and the page answers in place.
  async function noop(r) {
    const res = await request(`${prefix}${r.from}`);
    const problems = res.status === 200 ? [] : [{ field: 'status', expected: 200, actual: res.status }];
    record('redirect', r.from, problems, r.verified === false ? { unverified: true } : {}, `${r.from} (no-op, served in place)`);
  }

  async function sitemap() {
    let first;
    for (const path of SITEMAPS) {
      const res = await request(`${prefix}${path}`);
      first ??= res;
      if (res.status === 200) return record('sitemap', path, []);
    }
    return record('sitemap', SITEMAPS[0], [{ field: 'status', expected: 200, actual: first.status }]);
  }

  // A manifest url is absolute (the store object) or a site path served by the deploy.
  async function media(item) {
    const url = item.url && !item.url.startsWith('/') ? item.url : `${prefix}${item.url ?? item.path}`;
    const res = await request(url);
    if (res.status !== 200) return record('media', item.path, [{ field: 'status', expected: 200, actual: res.status }]);
    const length = res.headers.get('content-length');
    const bytes = length === null ? res.body.length : Number(length);
    return record('media', item.path, bytes === item.bytes ? [] : [{ field: 'bytes', expected: item.bytes, actual: bytes }]);
  }

  const skip = (check, path, reason) => skipped.push({ check, path, reason });
  const results = () => ({ checked, failed: failures.length, failures, skipped });
  return {
    route: guarded('route', (r) => r.path, route),
    redirect: guarded('redirect', (r) => r.from, redirect),
    noop: guarded('redirect', (r) => r.from, noop),
    sitemap: guarded('sitemap', () => SITEMAPS[0], sitemap),
    media: guarded('media', (item) => item.path, media),
    skip,
    results,
  };
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return usageError(`${label} ${file} is not readable JSON: ${error.message}`);
  }
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    return usageError(error.message);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!values.base) usageError('--base is required');
  let base;
  try {
    base = new URL(values.base);
  } catch {
    usageError(`--base ${values.base} is not a URL`);
  }
  if (!/^https?:$/.test(base.protocol)) usageError(`--base ${values.base} is not an http(s) URL`);
  const delay = Number(values.delay);
  if (!Number.isInteger(delay) || delay < 0) usageError('--delay must be a whole number of milliseconds');
  let sample = null;
  if (values.sample !== undefined) {
    sample = Number(values.sample);
    if (!Number.isInteger(sample) || sample < 1) usageError('--sample must be a positive whole number');
  }
  const missing = ['routes.json', 'redirects.json', 'media.json'].map((f) => join(values.baseline, f)).filter((f) => !existsSync(f));
  if (values['media-manifest'] && !existsSync(values['media-manifest'])) missing.push(values['media-manifest']);
  if (missing.length) {
    process.stderr.write(`verify-live: not found: ${missing.join(', ')}\n`);
    process.exit(2);
  }
  return { ...values, base: base.href, delay, sample };
}

async function main() {
  assertNodeVersion();
  const args = parse(process.argv.slice(2));
  const routes = readJson(join(args.baseline, 'routes.json'), 'baseline').filter((r) => r.status === 200);
  const redirects = readJson(join(args.baseline, 'redirects.json'), 'baseline');
  const meta = existsSync(join(args.baseline, 'meta.json')) ? readJson(join(args.baseline, 'meta.json'), 'baseline') : {};
  const seo = existsSync(join(args.baseline, 'seo.json')) ? readJson(join(args.baseline, 'seo.json'), 'baseline') : {};
  const listed = args['media-manifest']
    ? readJson(args['media-manifest'], 'media manifest')
    : readJson(join(args.baseline, 'media.json'), 'baseline');
  if (!Array.isArray(listed)) usageError('the media list is not a JSON array');
  // A size the capture listed but never downloaded (downloaded: false) is not served by the build.
  const mediaList = listed.filter((m) => m.downloaded !== false);
  const oldOrigins = new Set([meta.origin, meta.canonicalOrigin].filter(Boolean).map((o) => new URL(o).origin));

  const lines = [];
  const out = (line) => (args.json ? lines.push(line) : process.stdout.write(`${line}\n`));
  const verifier = createVerifier({ base: args.base, bypass: args.bypass, delay: args.delay, out });
  const { sampled, rest } = args.sample ? sampleRoutes(routes, args.sample) : { sampled: routes, rest: [] };
  for (const r of rest) verifier.skip('route', r.path, 'not sampled');
  const mediaSample = pickRandom(mediaList, MEDIA_SAMPLE);
  for (const m of mediaList) if (!mediaSample.includes(m)) verifier.skip('media', m.path, 'not sampled');

  let stopped = null;
  try {
    for (const r of sampled) {
      const liveNoindex = /\bnoindex\b/i.test(seo[r.path]?.robots ?? '') || r.noindex === true;
      await verifier.route(r, { expectNoindex: args['expect-noindex'], liveNoindex });
    }
    for (const r of redirects) {
      if (isNoop(r)) await verifier.noop(r);
      else await verifier.redirect(r, oldOrigins);
    }
    await verifier.sitemap();
    for (const m of mediaSample) await verifier.media(m);
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    stopped = error.message;
  }

  const results = verifier.results();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(stopped ? { ...results, stopped } : results, null, 2)}\n`);
  } else {
    process.stdout.write(`verify-live: ${results.checked} checked, ${results.failed} failed\n`);
    if (results.skipped.length) process.stdout.write(`verify-live: ${results.skipped.length} not checked (sampled out)\n`);
    if (stopped) process.stdout.write(`verify-live: ${stopped}\n`);
  }
  process.exit(stopped ? 3 : results.failed > 0 ? 1 : 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
