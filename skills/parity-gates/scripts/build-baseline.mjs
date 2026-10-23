#!/usr/bin/env node
// Baseline builder: freezes a capture folder into baseline/, the fixed record every parity gate
// checks a build against. Pure: it reads the capture from disk and never makes a request.
// --check recounts an existing baseline and compares it with its own counts.json.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const USAGE = `Usage: node build-baseline.mjs --capture <dir> --out <dir> [--csv <file>]
       node build-baseline.mjs --out <dir> --check

Freeze a capture (capture.mjs, media.mjs and templates.mjs output) into a baseline folder:
  routes.json     [{ path, status, kind, template, noindex, snapshot, foundBy[] }] for every
                  captured page, feed and linked file; kind is page|post|archive|feed|file|other
  seo.json        { "<path>": { title, description, canonical, robots, lang, h1[], h2[], og{},
                  twitter{}, jsonLd[] } } for every page answering 200
  redirects.json  [{ from, to, status, source, verified? }] from the capture's redirects and
                  shortlinks; shortlinks keep verified (true when it was requested). Each
                  intermediate hop of a chain (A -> B -> C) gets its own row to the final target
                  (B -> C, note "hop of A" in redirects.csv) unless it is a built route
  media.json      [{ path, bytes, contentType, referencedBy }] for every media file answering 200
                  (referencedBy: the pages that use it, from capture/media.json); a size the
                  capture listed but did not download keeps downloaded: false and its reason
                  (bytes null), so the media gate counts it as skipped
  forms.json      { "<path>": [{ action, method, fields[] }] }
  scripts.json    { "<vendor>": { id, ids[], pages[], keep } }; keep is true, set it to false
                  to drop a vendor from the build
  js.json         [{ src, file, pages[] }]: the site's own script files the capture saved
                  (capture/js/manifest.json; file is relative to the capture), [] when none.
                  The routes gate lets the build serve each at its live path
  sitemaps.json   [name]: the live site's sitemap file names the capture saved (capture/sitemaps/),
                  which the routes gate lets the build serve at the root
  text/           the visible text of each page, copied from the capture
  counts.json     routes, byStatus, byTemplate, redirects (by source), media, forms, scripts
  meta.json       { origin, canonicalOrigin, capturedAt, builtAt, platform } of the capture
and redirects.csv (from,to,status,source,note) for the host. A redirect with no target (an
unverified shortlink the site did not resolve) is left out and named on stderr.

  --capture <dir>   the capture folder (default: capture)
  --out <dir>       the baseline folder to write or check (default: baseline)
  --csv <file>      where to write redirects.csv (default: redirects.csv beside --out)
  --check           recount the baseline in --out and compare with its counts.json
  --help            show this help

The capture needs inventory.json, media.json (media.mjs) and templates.json (templates.mjs).
A missing feeds/index.json or scripts.json is warned about; a missing wp-rest/ is normal off
WordPress. --out must not be the capture folder.

Exit codes: 0 written or counts match, 1 counts drifted, 2 usage error, missing input or a
capture with no page that answered 200.`;

const OPTIONS = {
  capture: { type: 'string', default: 'capture' },
  out: { type: 'string', default: 'baseline' },
  csv: { type: 'string' },
  check: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
// The capture's foundBy order (capture.mjs SOURCE_ORDER).
const SOURCE_ORDER = ['sitemap', 'rest', 'crawl', 'shortlink', 'seed'];
const rank = (s) => (SOURCE_ORDER.includes(s) ? SOURCE_ORDER.indexOf(s) : SOURCE_ORDER.length);
export const sortSources = (sources) => [...new Set(sources)].sort((a, b) => rank(a) - rank(b));
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function pathOf(link) {
  try {
    const url = new URL(link);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

// path -> 'page' | 'post' from the WordPress REST dump, when the capture has one.
function restKinds(capture) {
  const kinds = new Map();
  for (const [file, kind] of [['pages.json', 'page'], ['posts.json', 'post']]) {
    const list = readJson(join(capture, 'wp-rest', file), []);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const path = item?.link ? pathOf(item.link) : null;
      if (path && !kinds.has(path)) kinds.set(path, kind);
    }
  }
  return kinds;
}

function pageKind(record, rest) {
  if (record.status !== 200) return 'other';
  if (rest.has(record.path)) return rest.get(record.path);
  const classes = record.bodyClasses ?? [];
  if (classes.includes('single-post')) return 'post';
  if (classes.includes('archive')) return 'archive';
  return 'page';
}

export function buildRoutes({ inventory, feeds, media, templates, rest, foundBy }) {
  const template = new Map();
  for (const t of templates) for (const path of t.paths ?? []) template.set(path, t.name);
  const routes = inventory.map((r) => ({
    path: r.path,
    status: r.status,
    kind: pageKind(r, rest),
    template: template.get(r.path) ?? 'other',
    noindex: /\bnoindex\b/i.test(r.robots ?? ''),
    snapshot: r.snapshot ?? null,
    foundBy: r.foundBy ?? [],
  }));
  const seen = new Set(routes.map((r) => r.path));
  for (const f of feeds) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    routes.push({ path: f.path, status: f.status, kind: 'feed', template: 'other', noindex: false, snapshot: f.file ?? null, foundBy: sortSources(foundBy[f.url] ?? []) });
  }
  // Files the pages link to (a PDF in the footer) are URLs the new site has to answer too.
  const files = new Map(media.filter((m) => m.status === 200).map((m) => [m.path, m]));
  const linked = new Set(inventory.filter((r) => r.status === 200).flatMap((r) => r.internalLinks ?? []));
  for (const path of linked) {
    if (seen.has(path) || !files.has(path)) continue;
    seen.add(path);
    routes.push({ path, status: 200, kind: 'file', template: 'other', noindex: false, snapshot: null, foundBy: ['crawl'] });
  }
  return routes.sort(byPath);
}

export function buildSeo(inventory) {
  const seo = {};
  for (const r of inventory) {
    if (r.status !== 200 || !r.snapshot) continue;
    seo[r.path] = {
      title: r.title ?? null,
      description: r.description ?? null,
      canonical: r.canonical ?? null,
      robots: r.robots ?? null,
      lang: r.lang ?? null,
      h1: r.h1 ?? [],
      h2: r.h2 ?? [],
      og: r.og ?? {},
      twitter: r.twitter ?? {},
      jsonLd: r.jsonLd ?? [],
    };
  }
  return seo;
}

// Returns { redirects, csvRows, skipped }. Redirects with no target cannot be served and are skipped.
// Every intermediate hop of a captured chain (A -> B -> C keeps hops [B]) also gets a row straight
// to the final target (B -> C, note "hop of A"), so a link to B lands in one hop too; a hop that
// is a built route (`routes`, the paths answering 200), a captured redirect of its own, or part of
// a loop gets none.
export function buildRedirects(captured, { routes = new Set() } = {}) {
  const redirects = [];
  const csvRows = [];
  const skipped = [];
  const sources = new Set(captured.filter((r) => r.to).map((r) => r.from));
  const add = (entry, note) => {
    redirects.push(entry);
    sources.add(entry.from);
    csvRows.push([entry.from, entry.to, entry.status, entry.source, note]);
  };
  for (const r of captured) {
    if (!r.to) {
      skipped.push(r);
      continue;
    }
    const entry = { from: r.from, to: r.to, status: r.status, source: r.source };
    if (typeof r.verified === 'boolean') entry.verified = r.verified;
    add(entry, r.source === 'shortlink' && r.verified === false ? 'unverified shortlink' : '');
    if (r.error === 'loop') continue;
    for (const hop of r.hops ?? []) {
      if (!hop || hop === r.to || sources.has(hop) || routes.has(hop)) continue;
      add({ from: hop, to: r.to, status: r.status, source: r.source }, `hop of ${r.from}`);
    }
  }
  return { redirects, csvRows, skipped };
}

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => `${[['from', 'to', 'status', 'source', 'note'], ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;

export function buildForms(inventory) {
  const forms = {};
  for (const r of inventory) {
    if (r.status !== 200 || !r.forms?.length) continue;
    forms[r.path] = r.forms.map((f) => ({ action: f.action ?? null, method: f.method ?? null, fields: f.fields ?? [] }));
  }
  return forms;
}

// The saved same-origin scripts of capture/js/manifest.json, as { src, file, pages }.
export function buildJs(manifest) {
  return (manifest ?? [])
    .filter((e) => e.file)
    .map((e) => ({ src: e.src, file: `js/${e.file}`, pages: [...(e.pages ?? [])].sort() }));
}

export function buildScripts(captured) {
  const scripts = {};
  for (const [vendor, entry] of Object.entries(captured ?? {})) {
    scripts[vendor] = { id: entry.id ?? null, ids: entry.ids ?? [], pages: entry.pages ?? [], keep: true };
  }
  return scripts;
}

function tally(list, keyOf) {
  const counts = {};
  for (const item of list) {
    const key = String(keyOf(item));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sorted(counts);
}

// { unreferencedSizes: n } when the baseline lists sizes the capture did not download, else {}.
const unreferencedCount = (media) => {
  const n = media.filter((m) => m.downloaded === false).length;
  return n ? { unreferencedSizes: n } : {};
};

// The baseline's media list: every file answering 200, and every size listed but not downloaded.
export function baselineMedia(media) {
  return media
    .filter((m) => m.status === 200 || m.downloaded === false)
    .map((m) => {
      const entry = { path: m.path, bytes: m.bytes, contentType: m.contentType, referencedBy: m.referencedBy ?? [] };
      return m.downloaded === false ? { ...entry, bytes: null, contentType: null, downloaded: false, reason: m.reason ?? 'unreferenced size' } : entry;
    });
}

export function countBaseline({ routes, redirects, media, forms, scripts }) {
  return {
    routes: routes.length,
    byStatus: tally(routes, (r) => r.status),
    byTemplate: tally(routes, (r) => r.template),
    redirects: tally(redirects, (r) => r.source),
    media: media.filter((m) => m.downloaded !== false).length,
    ...unreferencedCount(media),
    forms: Object.values(forms).reduce((n, list) => n + list.length, 0),
    scripts: Object.keys(scripts).length,
  };
}

function readBaseline(dir) {
  return {
    routes: readJson(join(dir, 'routes.json'), []),
    redirects: readJson(join(dir, 'redirects.json'), []),
    media: readJson(join(dir, 'media.json'), []),
    forms: readJson(join(dir, 'forms.json'), {}),
    scripts: readJson(join(dir, 'scripts.json'), {}),
  };
}

// [{ key, expected, actual }] for every count that differs, nested objects compared key by key.
export function countDrift(expected, actual) {
  const drift = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[key];
    const a = actual[key];
    if (e && typeof e === 'object' && a && typeof a === 'object') {
      for (const sub of new Set([...Object.keys(e), ...Object.keys(a)])) {
        if ((e[sub] ?? 0) !== (a[sub] ?? 0)) drift.push({ key: `${key}.${sub}`, expected: e[sub] ?? 0, actual: a[sub] ?? 0 });
      }
    } else if (JSON.stringify(e) !== JSON.stringify(a)) {
      drift.push({ key, expected: e ?? null, actual: a ?? null });
    }
  }
  return drift;
}

function check(out) {
  const countsFile = join(out, 'counts.json');
  if (!existsSync(countsFile)) {
    console.error(`No counts.json in ${out}. Build the baseline first.`);
    process.exit(2);
  }
  const drift = countDrift(readJson(countsFile), countBaseline(readBaseline(out)));
  for (const d of drift) console.log(`  ${d.key}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
  if (drift.length) {
    console.log(`baseline: ${drift.length} counts drifted from ${countsFile}`);
    process.exit(1);
  }
  console.log(`baseline: counts match ${countsFile}`);
}

export function buildMeta(meta, state, builtAt = new Date().toISOString()) {
  return {
    origin: meta.origin ?? state.origin ?? null,
    canonicalOrigin: meta.canonicalOrigin ?? state.canonicalOrigin ?? null,
    capturedAt: meta.finishedAt ?? meta.startedAt ?? null,
    builtAt,
    platform: state.fingerprint?.platform ?? null,
  };
}

// A skipped input is never a pass: a file every baseline needs stops the build.
const REQUIRED = [
  ['inventory.json', 'capture.mjs'],
  ['media.json', 'media.mjs'],
  ['templates.json', 'templates.mjs'],
];
const WARNED = [join('feeds', 'index.json'), 'scripts.json'];

function build(capture, out, csvFile) {
  for (const [file, script] of REQUIRED) {
    if (!existsSync(join(capture, file))) {
      console.error(`No ${file} in ${capture}: run ${script} first.`);
      process.exit(2);
    }
  }
  for (const file of WARNED) {
    if (!existsSync(join(capture, file))) console.error(`warning: no ${file} in ${capture}; the baseline records none.`);
  }
  const inventory = readJson(join(capture, 'inventory.json'));
  if (!inventory.some((r) => r.status === 200)) {
    console.error(`No page in ${join(capture, 'inventory.json')} answered 200: a baseline of nothing is not a baseline. Fix the capture first (capture.mjs).`);
    process.exit(2);
  }
  const media = readJson(join(capture, 'media.json'));
  const state = readJson(join(capture, 'state.json'), {});
  const routes = buildRoutes({
    inventory,
    feeds: readJson(join(capture, 'feeds', 'index.json'), []),
    media,
    templates: readJson(join(capture, 'templates.json')),
    rest: restKinds(capture),
    foundBy: state.foundBy ?? {},
  });
  const { redirects, csvRows, skipped } = buildRedirects(readJson(join(capture, 'redirects.json'), []), {
    routes: new Set(routes.filter((r) => r.status === 200).map((r) => r.path)),
  });
  const baseline = {
    routes,
    redirects,
    media: baselineMedia(media),
    forms: buildForms(inventory),
    scripts: buildScripts(readJson(join(capture, 'scripts.json'), {})),
  };
  const counts = countBaseline(baseline);

  mkdirSync(out, { recursive: true });
  writeJson(join(out, 'routes.json'), baseline.routes);
  writeJson(join(out, 'seo.json'), buildSeo(inventory));
  writeJson(join(out, 'redirects.json'), baseline.redirects);
  writeJson(join(out, 'media.json'), baseline.media);
  writeJson(join(out, 'forms.json'), baseline.forms);
  writeJson(join(out, 'scripts.json'), baseline.scripts);
  writeJson(join(out, 'js.json'), buildJs(readJson(join(capture, 'js', 'manifest.json'), [])));
  const sitemapDir = join(capture, 'sitemaps');
  writeJson(join(out, 'sitemaps.json'), existsSync(sitemapDir) ? readdirSync(sitemapDir).filter((f) => /\.xml$/i.test(f)).sort() : []);
  writeJson(join(out, 'counts.json'), counts);
  writeJson(join(out, 'meta.json'), buildMeta(readJson(join(capture, 'meta.json'), {}), state));
  rmSync(join(out, 'text'), { recursive: true, force: true });
  if (existsSync(join(capture, 'text'))) cpSync(join(capture, 'text'), join(out, 'text'), { recursive: true });
  mkdirSync(dirname(csvFile), { recursive: true });
  writeFileSync(csvFile, toCsv(csvRows));

  for (const r of skipped) {
    console.error(`skipped redirect ${r.from} (${r.source}): no target; run capture.mjs with --verify-shortlinks to resolve it`);
  }
  console.log(
    `Baseline: ${counts.routes} routes, ${redirects.length} redirects (${skipped.length} skipped), ${counts.media} media` +
      (counts.unreferencedSizes ? ` (${counts.unreferencedSizes} unreferenced ${counts.unreferencedSizes === 1 ? 'size' : 'sizes'} listed, not downloaded)` : '') + ', ' +
      `${counts.forms} forms, ${counts.scripts} script vendors. Wrote ${out} and ${csvFile}.`,
  );
}

function main() {
  assertNodeVersion();
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const out = resolve(values.out);
  if (values.check) {
    check(out);
    return;
  }
  const capture = resolve(values.capture);
  if (capture === out) {
    console.error(`--out ${out} is the capture folder; write the baseline somewhere else.`);
    process.exit(2);
  }
  build(capture, out, resolve(values.csv ?? join(dirname(out), 'redirects.csv')));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
