#!/usr/bin/env node
// Write the links exceptions a build that keeps the captured markup needs: one per WordPress API
// head link per page, and one per link to a page live itself answered 404 or 410.
// Pure: reads the baseline and the capture's page snapshots, appends to the exceptions file.
// Exit codes: 0 written, 2 usage or input error.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { linkRecords } from './lib/link-records.mjs';
import { excludedBy } from './lib/excluded.mjs';

export const API_REASON = 'WordPress API link kept as captured';
export const BROKEN_REASON = 'broken on live';

const HELP = `Usage: node link-exceptions.mjs --baseline baseline --out exceptions.json
                             [--capture capture] [--redirects redirects.csv] [--date YYYY-MM-DD]

Appends to --out one "link" exception per href the links gate would find broken in a build
that keeps the captured markup:
  - every WordPress API head link of each page: wp-json/ (rel="https://api.w.org/"),
    xmlrpc.php?rsd (rel="EditURI"), wp-json/wp/v2/* (rel="alternate") and the oEmbed
    wp-json/oembed/* links; reason "${API_REASON}"
  - every link to a page live answered 404 or 410 (baseline/routes.json); reason
    "${BROKEN_REASON}". A path that is a "from" in --redirects is skipped: the redirect resolves it
Each record is { path, field: "link", from: href, to: href, reason, approvedBy: "kit", date }
with the href exactly as captured; only hrefs on the site's own origin (the ones the gate checks)
are listed, and a record already in --out (same path, field and to) is never added again.
The pages are the baseline routes that answered 200 with an HTML snapshot, plus the captured
404 page as /404.html. Run it again after the baseline changes; it only adds.

  --baseline <dir>   the baseline folder (required): routes.json and meta.json
  --out <file>       the exceptions file to append to (required; created when missing)
  --capture <dir>    the capture folder holding the page snapshots (default: capture)
  --redirects <file> redirects.csv (default: redirects.csv beside the baseline folder)
  --date <date>      the date on new records (default: today)
  --help             show this help

Exit codes: 0 written, 2 usage error or unreadable input.`;

class UsageError extends Error {}

function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`${file} not found`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`${file}: not valid JSON (${err.message})`);
  }
}

// The "from" column of redirects.csv (first field, quotes allowed).
function redirectSources(file) {
  if (!existsSync(file)) return new Set();
  const sources = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const m = /^\s*(?:"((?:[^"]|"")*)"|([^,]*))/.exec(line);
    const from = (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim();
    if (from) sources.add(from);
  }
  return sources;
}

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export function linkExceptions({ baseline, capture, redirects, existing, date }) {
  const routes = readJson(join(baseline, 'routes.json'));
  const meta = readJson(join(baseline, 'meta.json'), {});
  const captureMeta = readJson(join(capture, 'meta.json'), {});
  const origin = originOf(meta.canonicalOrigin ?? '') ?? originOf(meta.origin ?? '') ?? 'http://site.invalid';
  const internalOrigins = new Set([originOf(meta.origin ?? ''), originOf(meta.canonicalOrigin ?? '')].filter(Boolean));
  const excluded = meta.excluded ?? [];
  const internal = (url) => (internalOrigins.has(url.origin) || url.origin === origin) && !excludedBy(excluded, url.pathname);
  const brokenPaths = new Set(routes.filter((r) => r.status === 404 || r.status === 410).map((r) => r.path));
  const sources = redirectSources(redirects);
  const resolves = (path) => sources.has(path) || sources.has(path.replace(/\/$/, '')) || sources.has(`${path}/`);

  const pages = routes.filter((r) => r.status === 200 && typeof r.snapshot === 'string' && r.snapshot.endsWith('.html'))
    .map((r) => ({ path: r.path, snapshot: r.snapshot }));
  if (captureMeta.notFound?.snapshot) pages.push({ path: '/404.html', snapshot: captureMeta.notFound.snapshot });

  const seen = new Set(existing.filter((e) => e.field === 'link').map((e) => `${e.path}\u0000${e.to}`));
  const added = [];
  for (const page of pages) {
    const file = join(capture, page.snapshot);
    if (!existsSync(file)) throw new UsageError(`${file} not found (the snapshot of ${page.path}; pass --capture)`);
    const pageUrl = new URL(page.path === '/404.html' ? '/' : page.path, origin).href;
    for (const { href, kind } of linkRecords(readFileSync(file, 'utf8'), { pageUrl, internal, brokenPaths, resolves })) {
      const key = `${page.path}\u0000${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({ path: page.path, field: 'link', from: href, to: href, reason: kind === 'api' ? API_REASON : BROKEN_REASON, approvedBy: 'kit', date });
    }
  }
  return added;
}

function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        baseline: { type: 'string' },
        out: { type: 'string' },
        capture: { type: 'string', default: 'capture' },
        redirects: { type: 'string' },
        date: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  for (const name of ['baseline', 'out']) if (!values[name]) throw new UsageError(`--${name} is required`);
  if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new UsageError('--date must be YYYY-MM-DD');
  const baseline = resolve(values.baseline);
  return {
    baseline,
    out: resolve(values.out),
    capture: resolve(values.capture),
    redirects: resolve(values.redirects ?? join(dirname(baseline), 'redirects.csv')),
    date: values.date ?? new Date().toISOString().slice(0, 10),
  };
}

function main() {
  assertNodeVersion();
  try {
    const opts = options(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    const existing = readJson(opts.out, []);
    if (!Array.isArray(existing)) throw new UsageError(`${opts.out}: expected an array of exceptions`);
    const added = linkExceptions({ ...opts, existing });
    writeFileSync(opts.out, `${JSON.stringify([...existing, ...added], null, 2)}\n`);
    const api = added.filter((r) => r.reason === API_REASON).length;
    console.log(`link-exceptions: added ${added.length} link exceptions (${api} WordPress API, ${added.length - api} broken on live) to ${opts.out}`);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`link-exceptions: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
