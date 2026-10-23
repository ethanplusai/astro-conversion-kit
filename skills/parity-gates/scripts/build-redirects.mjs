#!/usr/bin/env node
// Compiles redirects.csv, the single source of a site's redirects, into the host's config:
// the `redirects` of vercel.json, or a Cloudflare Pages _redirects file.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import {
  CLOUDFLARE_QUERY_CSV, isCatchAll, isDynamic, isExternal, isNoop, readRedirectsCsv, splitFrom,
} from './lib/redirects-csv.mjs';

const NAME = 'build-redirects';
const OUT = { vercel: 'vercel.json', cloudflare: 'public/_redirects' };
const MODES = new Set(['always', 'never']);
export const CLOUDFLARE_LIMITS = { static: 2000, dynamic: 100 };
// Vercel accepts 2,048 routes from vercel.json (redirects, rewrites and headers together).
export const VERCEL_ROUTE_LIMIT = 2048;
const VERCEL_ROUTE_WARNING = 1800;

const HELP = `Usage: ${NAME} --host vercel|cloudflare [options]

Writes the host's redirect rules from redirects.csv (from,to,status,source,note), one rule per row
in the csv's order. Sources are case-sensitive and kept as written.

  --csv <file>              the redirects (default: redirects.csv)
  --host vercel|cloudflare  the hosting target (required)
  --out <file>              where to write (default: vercel.json, or public/_redirects so that
                            Astro copies it into dist/)
  --trailing-slash <mode>   always or never: the site's URL form, used for catch-all targets and
                            Vercel's slash rules (default for vercel: read from the slash rules
                            or keys already in vercel.json, else always; for cloudflare: always)
  --help                    show this help

A query row whose target is its own path (/?p=2 -> /) is left out as a no-op: hosts pass the query
on to the target, so the rule would redirect to itself, and the page is already served there.

vercel: merges into an existing vercel.json, keeping every other key (headers, rewrites,
cleanUrls, ...) and replacing "redirects". Entries are { source, destination, statusCode }, never
"permanent". A query-string row (/?p=7) matches with "has". A catch-all row (/old/* or
/old/:path*) is written in both its /:path* and /:path*/ forms. Vercel applies "trailingSlash"
before "redirects", so an unslashed source would take two hops (308 to the slashed URL, then the
redirect); the key is therefore replaced by the same 308 normalisation written as the last
redirects, after the site's own. Only a path ending in a static-file extension counts as a file
and keeps its unslashed URL; /upgrade-guide/3.5/ is a page like any other. The extensions come
from three sources, each matched in any letter case (.jpg, .JPG, .Jpg): the web types (html, css,
js, json, xml, images, fonts, pdf, zip, audio and video, wasm, webmanifest); the document, media
and archive types an upload folder holds (doc(x), xls(x), ppt(x), csv, rtf, mov, m4a, wav, ogg,
tif, bmp, heic, eps, ics, vcf, epub, gz, ...); and every extension found among the site's own files,
read from dist/ when it exists, else public/ (rerun after the build to pick up the build's
files). Any other file would be 308-redirected to <file>/; the redirects gate fails it as
"built file redirected". Warns near Vercel's 2,048-route limit, and in "always" mode on a
target without its trailing slash (the slash rule would add a second hop).

cloudflare: writes "from to status" lines, static rules first, then splats and placeholders. A
query-string row cannot be matched by _redirects: it is written to ${CLOUDFLARE_QUERY_CSV}
(from,to,status) beside the csv, to be created as a Cloudflare Single Redirect. Pages accepts
2,000 static and 100 dynamic rules; more than that warns.

--routes <file> (baseline/routes.json) also serves every feed route at 200 from its built file:
a rewrite /feed/ -> /feed/index.xml, since neither host serves index.xml for a directory path.
vercel: a "rewrites" entry, merged by source with the rewrites already there (and counted toward
the route limit); cloudflare: a "/feed/ /feed/index.xml 200" line. redirects.csv stays
redirect-only.

A static file at a redirect source competes with the rule: hosts differ on which one answers, so
the redirects gate fails any source that is also a page or file in dist. Delete the page or the
row.

Exit codes: 0 written, 2 usage error or a malformed csv.
`;

const fail = (message) => {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
};
const warn = (message) => process.stderr.write(`${NAME}: warning: ${message}\n`);

// Escape path-to-regexp's special characters, keeping :name, :name*, :name+ and :name? parameters.
const pathToRegexpSafe = (path) => path.replace(/(:\w+[*+?]?)|([(){}*+?])/g, (m, param, ch) => param ?? `\\${ch}`);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The extensions that make a path a static file for the slash rules, besides every extension
// found in the site's own files (filesFound). Anything else after a dot (/upgrade-guide/3.5/,
// /v1.2/) is a page, slashed like every other page.
export const FILE_EXTENSIONS = [
  'html', 'htm', 'xml', 'json', 'txt', 'css', 'js', 'mjs', 'map', 'ico', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'avif', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'pdf', 'zip', 'mp4', 'webm', 'mp3', 'wasm', 'webmanifest',
  // documents, media and archives a CMS upload folder routinely holds
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'mov', 'm4a', 'm4v', 'wav', 'ogg',
  'ogv', 'oga', 'tif', 'tiff', 'bmp', 'heic', 'eps', 'ai', 'psd', 'ics', 'vcf', 'epub', 'gz', 'tgz', 'rar', 'kml', 'kmz',
  // server scripts a WordPress site answers at (admin-ajax.php, served from captured answers)
  'php',
];

// "jpg" -> "[Jj][Pp][Gg]": the extension in any letter case.
const anyCase = (ext) => ext.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
// The alternation of extensions, lower-cased and deduplicated, each in any letter case.
function extPattern(extra = []) {
  const all = [...new Set([...FILE_EXTENSIONS, ...extra].map((e) => e.toLowerCase()))];
  return `\\.(?:${all.map(anyCase).join('|')})`;
}

// The site's trailing-slash normalisation as redirects, matching what vercel.json's
// "trailingSlash" does (except that only a static-file extension makes a path a file), so it runs
// after the site's own rules instead of before them. `extensions` adds the ones found in the site.
export function slashRules(mode, extensions = []) {
  if (mode === 'never') return [{ source: '/:path(.+)/', destination: '/:path', statusCode: 308 }];
  const ext = extPattern(extensions);
  return [
    { source: `/:path((?!\\.well-known(?:/|$))(?!(?:[^/]+/)*[^/]+${ext}$)(?:[^/]+/)*[^/]+)`, destination: '/:path/', statusCode: 308 },
    { source: `/:path((?:[^/]+/)*[^/]+${ext})/`, destination: '/:path', statusCode: 308 },
  ];
}
export const SLASH_RULES = { always: slashRules('always'), never: slashRules('never') };
const isFilePath = (path, extensions = []) => new RegExp(`${extPattern(extensions)}$`).test(path);

// Every file extension (starting with a letter, so "3.5" is not one) in dist/ when it exists, else
// public/: { dir, extensions }, spelled as found; { dir: null, extensions: [] } when neither exists.
export function filesFound(cwd = '.') {
  const dir = ['dist', 'public'].find((d) => existsSync(join(cwd, d)) && statSync(join(cwd, d)).isDirectory()) ?? null;
  if (!dir) return { dir, extensions: [] };
  const found = new Set();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(current, entry.name));
      else {
        const m = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(entry.name);
        if (m) found.add(m[1]);
      }
    }
  };
  visit(join(cwd, dir));
  return { dir, extensions: [...found].sort() };
}

// The mode of slash rules a previous run wrote (whatever extensions they hold), or null.
function slashMode(rule) {
  if (rule.statusCode !== 308) return null;
  if (rule.source === '/:path(.+)/' && rule.destination === '/:path') return 'never';
  if (rule.destination === '/:path/' && rule.source.startsWith('/:path((?!\\.well-known(?:/|$))')) return 'always';
  return null;
}

// [{ source, destination }] for every feed route answering 200: its live path -> <path>/index.xml.
export function feedRewrites(routes) {
  return (routes ?? [])
    .filter((r) => r.kind === 'feed' && r.status === 200)
    .map((r) => ({ source: r.path, destination: `/${r.path.replace(/^\/+|\/+$/g, '')}/index.xml` }));
}

export function vercelRules(rows, mode, extensions = []) {
  const rules = [];
  for (const row of rows) {
    const { path, query } = splitFrom(row.from);
    const has = query.length ? { has: query.map(([key, value]) => ({ type: 'query', key, value: escapeRegex(value) })) } : {};
    let source = pathToRegexpSafe(path);
    let destination = row.to;
    if (/\/\*$/.test(path)) {
      source = `${pathToRegexpSafe(path.slice(0, -2))}/:splat*`;
      destination = destination.replace(/:splat\b(?![*+?])/g, ':splat*');
    }
    if (!isCatchAll(path)) {
      rules.push({ source, ...has, destination, statusCode: row.status });
      continue;
    }
    if (mode === 'always' && !isExternal(destination) && !destination.endsWith('/')) destination += '/';
    rules.push({ source, ...has, destination, statusCode: row.status });
    if (!source.endsWith('/')) rules.push({ source: `${source}/`, ...has, destination, statusCode: row.status });
  }
  return [...rules, ...slashRules(mode, extensions)];
}

// Returns { lines, skipped, counts }. In "always" mode a catch-all's target gets its trailing
// slash (Pages would otherwise add it with a second hop), and the bare prefix (/old/, an empty
// splat) gets a static rule of its own so it does not land on a "//" URL.
export function cloudflareLines(rows, mode = 'always') {
  const staticLines = [];
  const dynamicLines = [];
  const skipped = [];
  for (const row of rows) {
    if (row.from.includes('?')) {
      skipped.push(row);
      continue;
    }
    let { from, to } = row;
    const param = /:(\w+)[*+]/.exec(from);
    if (param) {
      from = from.replace(param[0], '*');
      to = to.replace(new RegExp(`:${param[1]}\\b[*+?]?`, 'g'), ':splat');
    }
    if (mode === 'always' && from.endsWith('/*') && to.endsWith('/:splat')) {
      staticLines.push(`${from.slice(0, -1)} ${to.slice(0, -':splat'.length)} ${row.status}`);
      to = `${to}/`;
    }
    (isDynamic(from) ? dynamicLines : staticLines).push(`${from} ${to} ${row.status}`);
  }
  return {
    lines: [...staticLines, ...dynamicLines],
    skipped,
    counts: { static: staticLines.length, dynamic: dynamicLines.length },
  };
}

// The URL mode of an existing vercel.json: from the slash rules a previous run wrote, else from
// trailingSlash, else cleanUrls (the "never" form), else "always".
export function inferMode(existing) {
  const redirects = Array.isArray(existing.redirects) ? existing.redirects : [];
  const found = redirects.map(slashMode).find(Boolean);
  if (found) return found;
  if (existing.trailingSlash === true) return 'always';
  if (existing.trailingSlash === false || existing.cleanUrls === true) return 'never';
  return 'always';
}

// Static rows whose internal target lacks the trailing slash an "always" site adds with a 308.
function unslashedTargets(rows, extensions) {
  return rows.filter((row) => {
    if (isCatchAll(row.from) || isExternal(row.to)) return false;
    const path = row.to.split(/[?#]/)[0];
    return !path.endsWith('/') && !isFilePath(path, extensions);
  });
}

function writeVercel(out, rows, mode, feeds = []) {
  const { dir, extensions } = filesFound();
  let existing = {};
  if (existsSync(out)) {
    try {
      existing = JSON.parse(readFileSync(out, 'utf8'));
    } catch (error) {
      fail(`${out}: not valid JSON (${error.message})`);
    }
  }
  const urlMode = mode ?? inferMode(existing);
  const { trailingSlash, redirects: _replaced, ...kept } = existing;
  const redirects = vercelRules(rows, urlMode, extensions);
  if (feeds.length) {
    const sources = new Set(feeds.map((f) => f.source));
    kept.rewrites = [...(kept.rewrites ?? []).filter((r) => !sources.has(r.source)), ...feeds];
  }
  writeFileSync(out, `${JSON.stringify({ ...kept, redirects }, null, 2)}\n`);
  if (trailingSlash !== undefined) {
    process.stderr.write(
      `${NAME}: replaced "trailingSlash": ${trailingSlash} with ${slashRules(urlMode).length} slash rule(s) after the site's ` +
        'redirects, so an unslashed source redirects in one hop\n',
    );
  }
  const routes = redirects.length + (kept.headers?.length ?? 0) + (kept.rewrites?.length ?? 0);
  if (routes > VERCEL_ROUTE_WARNING) {
    warn(`${routes} routes in ${out}; Vercel accepts ${VERCEL_ROUTE_LIMIT.toLocaleString('en-US')} (redirects, rewrites and headers together)`);
  }
  if (urlMode === 'always') {
    const unslashed = unslashedTargets(rows, extensions);
    if (unslashed.length) {
      warn(`${unslashed.length} target(s) without a trailing slash; the slash rule adds a second hop: ${unslashed.map((r) => `${r.from} -> ${r.to}`).join(', ')}`);
    }
  }
  const rewritten = feeds.length ? `, ${feeds.length} feed rewrite(s)` : '';
  const scanned = dir ? `, ${extensions.length} extension(s) found in ${dir}/` : ', no dist/ or public/ to scan';
  return `${rows.length} rows -> ${redirects.length} rules in ${out} (vercel, trailing slash ${urlMode}${rewritten}${scanned})`;
}

function writeCloudflare(out, rows, mode, csv, feeds = []) {
  const { lines: redirectLines, skipped, counts } = cloudflareLines(rows, mode ?? 'always');
  const lines = [...feeds.map((f) => `${f.source} ${f.destination} 200`), ...redirectLines];
  counts.static += feeds.length;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `# Generated by ${NAME} from ${csv}; edit that file instead.\n${lines.join('\n')}\n`);
  const queryCsv = join(dirname(csv), CLOUDFLARE_QUERY_CSV);
  if (skipped.length) {
    writeFileSync(queryCsv, `from,to,status\n${skipped.map((r) => `${r.from},${r.to},${r.status}`).join('\n')}\n`);
    process.stderr.write(
      `${NAME}: ${skipped.length} query row(s) cannot be matched by _redirects; wrote ${queryCsv}: create each as a ` +
        'Cloudflare Single Redirect (a rule on http.request.uri.query)\n',
    );
  } else rmSync(queryCsv, { force: true });
  if (counts.static > CLOUDFLARE_LIMITS.static) warn(`${counts.static} static rules; Cloudflare Pages accepts 2,000`);
  if (counts.dynamic > CLOUDFLARE_LIMITS.dynamic) warn(`${counts.dynamic} dynamic rules; Cloudflare Pages accepts 100`);
  return `${rows.length} rows -> ${lines.length} rules in ${out} (cloudflare)`;
}

function main() {
  assertNodeVersion();
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        csv: { type: 'string', default: 'redirects.csv' },
        host: { type: 'string' },
        out: { type: 'string' },
        'trailing-slash': { type: 'string' },
        routes: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    fail(`${error.message}\n\n${HELP}`);
  }
  const { host } = values;
  if (!OUT[host]) fail(`--host must be vercel or cloudflare, not ${JSON.stringify(host ?? '')}`);
  const mode = values['trailing-slash'];
  if (mode !== undefined && !MODES.has(mode)) fail(`--trailing-slash must be always or never, not ${JSON.stringify(mode)}`);
  if (!existsSync(values.csv)) fail(`not found: ${values.csv}`);
  let rows;
  try {
    rows = readRedirectsCsv(values.csv);
  } catch (error) {
    fail(error.message);
  }
  let feeds = [];
  if (values.routes !== undefined) {
    if (!existsSync(values.routes)) fail(`not found: ${values.routes}`);
    try {
      feeds = feedRewrites(JSON.parse(readFileSync(values.routes, 'utf8')));
    } catch (error) {
      fail(`${values.routes}: not valid JSON (${error.message})`);
    }
  }
  const noops = rows.filter(isNoop);
  if (noops.length) {
    process.stderr.write(`${NAME}: ${noops.length} no-op row(s) left out (destination equals source path): ${noops.map((r) => r.from).join(', ')}\n`);
  }
  const live = rows.filter((row) => !isNoop(row));
  const out = values.out ?? OUT[host];
  const summary = host === 'vercel' ? writeVercel(out, live, mode, feeds) : writeCloudflare(out, live, mode, values.csv, feeds);
  process.stdout.write(`${NAME}: ${summary}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
