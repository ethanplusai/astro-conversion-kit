#!/usr/bin/env node
// Contact sheet: an index page plus one HTML page per route, with live, new and diff screenshots
// side by side per width and the failing style rows. Images are linked by path, never inlined,
// and each route page is written as soon as it is built, so a site of any size fits.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node sheet.mjs --live <dir> --new <dir> --diff <diff.json> [--styles styles.json] [--out index.html]

Builds the contact sheet: --out is an index listing every route with each width's pass or
fail and differing-pixel percent, and links to one page per route in <out name>-pages/
(review/index.html -> review/index-pages/<route>.html). A route page has a row per width with
the live, new and diff screenshots side by side, the percent, pass or fail, both heights, and
the failing style rows beneath. Images are referenced by relative path, not embedded: keep the
sheet beside the screenshot folders (or copy them with it) to open it elsewhere. A route page an
earlier run wrote (listed in <out name>-pages/.sheet.json) whose route is gone is removed; no
other file there is touched.

  --live, --new  screenshot folders holding manifest.json and <route>/<width>.png
  --diff         diff.json; diff images are read from the folder it sits in
  --styles       styles.json from styles.mjs (optional)
  --out          the index HTML file (default index.html)

Exit codes: 0 sheet written, 2 usage or environment error.`;

class UsageError extends Error {}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${label} ${file}: ${err.message}`);
  }
}

const key = (route, width) => `${route}\u0000${width}`;

function indexManifest(dir) {
  const entries = readJson(join(dir, 'manifest.json'), 'manifest');
  if (!Array.isArray(entries)) throw new UsageError(`${join(dir, 'manifest.json')} is not a JSON array`);
  return new Map(entries.map((e) => [key(e.route, e.width), { ...e, path: !e.file ? null : isAbsolute(e.file) ? e.file : join(dir, e.file) }]));
}

// A relative URL from a page in fromDir to file, each segment encoded.
const hrefTo = (fromDir, file) => relative(fromDir, file).split(sep).map(encodeURIComponent).join('/');

function figure(label, file, pageDir, extra = '') {
  const caption = `<figcaption>${escapeHtml(label)}${extra ? ` <span class="muted">${escapeHtml(extra)}</span>` : ''}</figcaption>`;
  if (!file || !existsSync(file)) return `<figure class="missing">${caption}<div class="none">no image</div></figure>`;
  return `<figure>${caption}<div class="frame"><img src="${escapeHtml(hrefTo(pageDir, file))}" alt="${escapeHtml(label)}" loading="lazy"></div></figure>`;
}

const verdict = (pass) => (pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');
const percentOf = (d) => (Number.isFinite(d?.percent) ? `${d.percent.toFixed(2)} %` : 'n/a');

function styleTable(rows) {
  if (rows.length === 0) return '';
  const body = rows
    .map((r) => `<tr><td>${verdict(false)}</td><td><code>${escapeHtml(r.selector)}</code></td><td>${escapeHtml(r.property)}</td><td>${escapeHtml(r.live)}</td><td>${escapeHtml(r.new)}</td></tr>`)
    .join('\n');
  return `<table class="styles"><thead><tr><th></th><th>Selector</th><th>Property</th><th>Live</th><th>New</th></tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const STYLE = `<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; --pass: #1a7f37; --fail: #c62828; --card: #f7f7f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #ececf1; --muted: #9a9aa3; --line: #2c2c33; --pass: #4cc26a; --fail: #ff6b6b; --card: #1e1e24; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
a { color: inherit; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 32px 0 8px; font-size: 18px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.muted { color: var(--muted); font-weight: 400; }
.pass { color: var(--pass); font-weight: 700; }
.fail { color: var(--fail); font-weight: 700; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
.row.bad { border-color: var(--fail); }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: start; }
figure { margin: 0; }
figcaption { font-size: 13px; margin-bottom: 4px; }
.frame { max-height: 1600px; overflow-y: auto; border: 1px solid var(--line); }
img { width: 100%; height: auto; display: block; }
.none { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--line); }
table { border-collapse: collapse; width: 100%; font-size: 13px; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
table.styles { margin-top: 12px; }
</style>`;

const document = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${STYLE}
</head>
<body>
${body}
</body>
</html>
`;

// The route pages the last run wrote, so the next run removes only its own stale pages.
const SHEET_LIST = '.sheet.json';

// A file name for each route, unique within the sheet.
function pageNames(routes) {
  const used = new Set();
  return new Map(routes.map((route) => {
    const stem = String(route).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'route';
    let name = stem;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${stem}-${n}`;
    used.add(name.toLowerCase());
    return [route, `${name}.html`];
  }));
}

// Writes the index at out and one page per route beside it; returns the counts.
export function writeSheet({ liveDir, newDir, diffFile, stylesFile, out }) {
  const live = indexManifest(liveDir);
  const next = indexManifest(newDir);
  const diff = readJson(diffFile, 'diff');
  if (!Array.isArray(diff)) throw new UsageError(`${diffFile} is not a JSON array`);
  const styles = stylesFile ? readJson(stylesFile, 'styles') : [];
  if (!Array.isArray(styles)) throw new UsageError(`${stylesFile} is not a JSON array`);
  const diffDir = dirname(diffFile);

  const diffByKey = new Map(diff.map((d) => [key(d.route, d.width), d]));
  const widthsOf = new Map();
  for (const { route, width } of [...diff, ...live.values(), ...next.values(), ...styles]) {
    if (!widthsOf.has(route)) widthsOf.set(route, []);
    if (!widthsOf.get(route).includes(width)) widthsOf.get(route).push(width);
  }
  const badStyles = new Map();
  for (const s of styles.filter((row) => !row.pass)) {
    const k = key(s.route, s.width);
    if (!badStyles.has(k)) badStyles.set(k, []);
    badStyles.get(k).push(s);
  }
  const routes = [...widthsOf.keys()];
  const names = pageNames(routes);
  const stem = basename(out, extname(out));
  const pagesDir = join(dirname(out), `${stem}-pages`);
  mkdirSync(pagesDir, { recursive: true });

  let failing = 0;
  let pairs = 0;
  const indexRows = [];
  for (const route of routes) {
    const cells = [];
    let routeFailing = 0;
    const rows = widthsOf.get(route).map((width) => {
      pairs += 1;
      const k = key(route, width);
      const a = live.get(k);
      const b = next.get(k);
      const d = diffByKey.get(k);
      const relativeFile = a?.path ? relative(liveDir, a.path) : b?.path ? relative(newDir, b.path) : null;
      const diffImage = d && relativeFile ? join(diffDir, relativeFile) : null;
      const bad = badStyles.get(k) ?? [];
      const rowFailing = (d && !d.pass ? 1 : 0) + bad.length;
      routeFailing += rowFailing;
      cells.push(`${escapeHtml(width)} px ${d ? `<span class="${d.pass ? 'pass' : 'fail'}">${d.pass ? 'pass' : 'fail'}</span> ${escapeHtml(percentOf(d))}` : '<span class="muted">no diff</span>'}${bad.length ? ` <span class="fail">${bad.length} style</span>` : ''}`);
      const summary = d
        ? `${verdict(d.pass)} <strong>${escapeHtml(percentOf(d))}</strong> differing pixels <span class="muted">heights ${escapeHtml(d.heightA ?? '?')} / ${escapeHtml(d.heightB ?? '?')} px</span>`
        : `<span class="muted">${a || b ? 'no diff' : 'style only'}</span>`;
      const shots = a || b || d
        ? `<div class="shots">
${figure('Live', a?.path, pagesDir, a?.bannerClosed ? 'banner closed' : '')}
${figure('New', b?.path, pagesDir, b?.bannerClosed ? 'banner closed' : '')}
${d ? figure('Diff', diffImage, pagesDir) : ''}
</div>`
        : '';
      return `<div class="row${d && !d.pass ? ' bad' : ''}">
<h3>${escapeHtml(width)} px ${summary}</h3>
${shots}
${styleTable(bad)}
</div>`;
    });
    failing += routeFailing;
    const name = names.get(route);
    writeFileSync(join(pagesDir, name), document(`Visual review: ${route}`, `<p><a href="../${escapeHtml(encodeURIComponent(basename(out)))}">All routes</a></p>
<section><h2><code>${escapeHtml(route)}</code></h2>
<p class="muted">${rows.length} widths, ${routeFailing} failing rows.</p>
${rows.join('\n')}
</section>`));
    indexRows.push(`<tr><td><a href="${escapeHtml(`${encodeURIComponent(`${stem}-pages`)}/${encodeURIComponent(name)}`)}">${escapeHtml(route)}</a></td><td>${routeFailing ? `<span class="fail">${routeFailing}</span>` : '<span class="pass">0</span>'}</td><td>${cells.join('<br>')}</td></tr>`);
  }

  writeFileSync(out, document('Visual review', `<h1>Visual review</h1>
<p class="muted">${routes.length} routes, ${pairs} route-width rows, ${failing} failing rows.</p>
<table><thead><tr><th>Route</th><th>Failing</th><th>Widths</th></tr></thead><tbody>
${indexRows.join('\n')}
</tbody></table>`));
  // Route pages an earlier run wrote (listed in its .sheet.json) that this set no longer has.
  const listFile = join(pagesDir, SHEET_LIST);
  const written = new Set(names.values());
  let earlier = [];
  try {
    earlier = existsSync(listFile) ? JSON.parse(readFileSync(listFile, 'utf8')) : [];
  } catch {
    earlier = [];
  }
  const removed = (Array.isArray(earlier) ? earlier : [])
    .filter((name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(name) && !written.has(name));
  for (const name of removed) rmSync(join(pagesDir, name), { force: true });
  writeFileSync(listFile, `${JSON.stringify([...written].sort(), null, 2)}\n`);
  return { failing, routes: routes.length, pagesDir, removed: removed.length };
}

function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        live: { type: 'string' },
        new: { type: 'string' },
        diff: { type: 'string' },
        styles: { type: 'string' },
        out: { type: 'string', default: 'index.html' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  for (const name of ['live', 'new', 'diff']) {
    if (!values[name]) throw new UsageError(`--${name} is required`);
  }
  return {
    liveDir: resolve(values.live),
    newDir: resolve(values.new),
    diffFile: resolve(values.diff),
    stylesFile: values.styles ? resolve(values.styles) : null,
    out: resolve(values.out),
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = options(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    mkdirSync(dirname(opts.out), { recursive: true });
    const { failing, routes, pagesDir, removed } = writeSheet(opts);
    console.log(`Wrote ${opts.out} and ${routes} route pages in ${pagesDir} (${failing} failing rows)${removed ? `; removed ${removed} route page${removed === 1 ? '' : 's'} no longer in the set` : ''}`);
    return 0;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion();
  process.exitCode = main();
}
