#!/usr/bin/env node
// Capture README: one page a person (or the next agent) reads before planning the build.
// Everything in it is counted from the capture's own files; a file the capture does not have
// is reported as "not captured", never as zero. The ## Notes heading is left for the agent, and
// whatever was written under it is carried over when the README is regenerated. Facts the notes
// must carry (an anti-bot challenge that stopped the capture, a failed Wayback listing, the second
// pass, URLs still failing after retries) open the section between two comment lines, rewritten
// on every run.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const USAGE = `Usage: node readme.mjs --capture <dir>

Write <dir>/README.md summarising the capture: platform and theme, pages per template,
pages per discovery source, redirects by source, media totals, the saved and missing
assets, third-party vendors with ids and page counts, forms, meta noindex pages, feeds,
iframes, the Wayback unverified count, and a ## Notes heading. Under ## Notes it writes how
many Wayback paths the second pass (capture.mjs --resume --seed-file
<dir>/wayback-unverified.txt) verified and what each answered, and every URL still failing
after its retries (status and attempts), every page recorded "suspect-challenge", and the anti-bot challenge that stopped the capture
(host, cause, URL); what else is written under
## Notes is kept when the README is regenerated. Run it after templates.mjs, assets.mjs and the media
step; anything missing is reported as not captured.

  --capture <dir>   the capture folder written by capture.mjs
  --help            show this help

Exit codes: 0 done, 2 usage error or no inventory.json in the capture.`;

const SOURCES = ['sitemap', 'rest', 'crawl', 'shortlink', 'seed'];
const LIST_LIMIT = 10;

function readJson(dir, file) {
  const path = join(dir, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
function someOf(paths) {
  const shown = paths.slice(0, LIST_LIMIT).join(', ');
  return paths.length > LIST_LIMIT ? `${shown} and ${paths.length - LIST_LIMIT} more` : shown;
}

function siteSection(meta, fingerprint, inventory) {
  const lines = ['## Site', ''];
  if (fingerprint) {
    const platform = [fingerprint.platform ?? 'unknown', fingerprint.platformVersion].filter(Boolean).join(' ');
    lines.push(`- Platform: ${platform}`, `- Theme: ${fingerprint.theme ?? 'unknown'}`);
    if (fingerprint.plugins?.length) lines.push(`- Plugins seen: ${fingerprint.plugins.join(', ')}`);
  } else {
    lines.push('- Platform and theme: not captured (no fingerprint in state.json)');
  }
  const byStatus = {};
  for (const r of inventory) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const statuses = Object.keys(byStatus).sort().map((s) => `${byStatus[s]} × ${s}`).join(', ');
  lines.push(`- Pages: ${inventory.length} (${statuses || 'none'})`);
  if (meta?.finishedAt) lines.push(`- Captured: ${meta.startedAt ?? '?'} to ${meta.finishedAt}`);
  for (const e of meta?.discoveryErrors ?? []) lines.push(`- Discovery error: ${e.url} returned ${e.status}`);
  return lines;
}

function templatesSection(templates) {
  const lines = ['## Templates', ''];
  if (!templates) return [...lines, 'Templates: not captured (run templates.mjs)'];
  return [...lines, ...table(['Template', 'Pages', 'Representative'], templates.map((t) => [t.name, t.count, t.representative]))];
}

function discoverySection(inventory) {
  const counts = {};
  for (const r of inventory) for (const s of r.foundBy ?? []) counts[s] = (counts[s] ?? 0) + 1;
  const order = [...SOURCES, ...Object.keys(counts).filter((s) => !SOURCES.includes(s)).sort()];
  const rows = order.filter((s) => counts[s]).map((s) => [s, counts[s]]);
  return ['## Discovery', '', 'Pages per source (a page found several ways counts under each).', '', ...table(['Source', 'Pages'], rows)];
}

function redirectsSection(redirects) {
  const lines = ['## Redirects', ''];
  if (!redirects) return [...lines, 'Redirects: not captured'];
  if (redirects.length === 0) return [...lines, 'Redirects: none'];
  const groups = {};
  for (const r of redirects) (groups[r.source ?? 'crawl'] ??= []).push(r);
  const order = [...SOURCES, ...Object.keys(groups).filter((s) => !SOURCES.includes(s)).sort()].filter((s) => groups[s]);
  const rows = order.map((s) => {
    const list = groups[s];
    const notes = [];
    const unverified = list.filter((r) => r.verified === false).length;
    const chains = list.filter((r) => r.hops?.length).length;
    const errors = list.filter((r) => r.error).length;
    if (unverified) notes.push(`${unverified} unverified`);
    if (chains) notes.push(`${chains} chains`);
    if (errors) notes.push(`${errors} errors`);
    return [s, list.length, notes.join(', ') || '-'];
  });
  return [...lines, ...table(['Source', 'Redirects', 'Notes'], rows)];
}

function mediaSection(media) {
  const lines = ['## Media', ''];
  if (!media) return [...lines, 'Media: not captured (no media.json; run the media step)'];
  // A size only the REST media list names is listed, never fetched (media.mjs --sizes referenced).
  const listedOnly = media.filter((m) => m.downloaded === false);
  const checked = media.filter((m) => m.downloaded !== false);
  const ok = checked.filter((m) => m.status === 200);
  const total = ok.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  lines.push(`- Media files: ${checked.length}, ${formatBytes(total)} answering 200`);
  if (listedOnly.length) lines.push(`- Unreferenced sizes: ${listedOnly.length} (listed only, not downloaded; media.mjs --sizes all fetches them)`);
  const largest = ok.reduce((big, m) => ((m.bytes ?? 0) > (big?.bytes ?? -1) ? m : big), null);
  if (largest) lines.push(`- Largest: ${largest.path ?? largest.url} (${formatBytes(largest.bytes ?? 0)})`);
  const broken = checked.filter((m) => m.status !== 200);
  if (broken.length) lines.push(`- Not 200: ${broken.length} (${someOf(broken.map((m) => `${m.path ?? m.url} ${m.status}`))})`);
  return lines;
}

function vendorsSection(scripts) {
  const lines = ['## Third-party scripts', ''];
  if (!scripts) return [...lines, 'Third-party scripts: not captured'];
  const names = Object.keys(scripts);
  if (names.length === 0) return [...lines, 'Third-party scripts: none'];
  const rows = names.map((n) => [n, (scripts[n].ids?.length ? scripts[n].ids : [scripts[n].id]).filter(Boolean).join(', ') || '-', scripts[n].pages?.length ?? 0]);
  return [...lines, ...table(['Vendor', 'IDs', 'Pages'], rows)];
}

function formsSection(inventory) {
  const lines = ['## Forms', ''];
  const groups = new Map();
  for (const r of inventory) {
    for (const f of r.forms ?? []) {
      const fields = (f.fields ?? []).map((x) => x.name).filter(Boolean).join(', ');
      const key = `${f.action}|${f.method}|${fields}`;
      const group = groups.get(key) ?? { action: f.action, method: f.method, fields, pages: [] };
      group.pages.push(r.path);
      groups.set(key, group);
    }
  }
  if (groups.size === 0) return [...lines, 'Forms: none'];
  const rows = [...groups.values()].map((g) => [g.action ?? '-', g.method ?? 'get', g.fields || '-', `${g.pages.length}: ${someOf(g.pages)}`]);
  return [...lines, ...table(['Action', 'Method', 'Fields', 'Pages'], rows)];
}

function indexingSection(inventory) {
  const noindex = inventory.filter((r) => /noindex/i.test(r.robots ?? '')).map((r) => r.path);
  const lines = ['## Indexing', '', `- meta noindex: ${noindex.length}`];
  if (noindex.length) lines.push(`- meta noindex pages: ${someOf(noindex)}`);
  return lines;
}

function assetsSection(index) {
  const lines = ['## Assets', ''];
  if (!index) return [...lines, 'Assets: not captured (run assets.mjs)'];
  if (index.length === 0) return [...lines, 'Assets: none found'];
  return [...lines, ...index.map((e) => `- ${e.kind}: ${e.file ?? e.note}`)];
}

function feedsSection(feeds) {
  const lines = ['## Feeds', ''];
  if (!feeds) return [...lines, 'Feeds: not captured'];
  if (feeds.length === 0) return [...lines, 'Feeds: none'];
  return [...lines, ...feeds.map((f) => `- ${f.path} (${f.status}, ${f.contentType ?? 'unknown type'})`)];
}

function iframesSection(inventory) {
  const lines = ['## Iframes', ''];
  const pages = {};
  for (const r of inventory) for (const src of r.iframes ?? []) (pages[src] ??= []).push(r.path);
  const srcs = Object.keys(pages).sort();
  if (srcs.length === 0) return [...lines, 'Iframes: none'];
  return [...lines, ...table(['Source', 'Pages'], srcs.map((s) => [s, `${pages[s].length}: ${someOf(pages[s])}`]))];
}

function waybackSection(dir) {
  const lines = ['## Wayback', ''];
  const file = join(dir, 'wayback-unverified.txt');
  if (!existsSync(file)) return [...lines, 'Wayback unverified: not captured'];
  const paths = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  lines.push(`Wayback unverified: ${paths.length}`);
  if (paths.length) lines.push('', 'Archived paths the crawl did not find (check each for a redirect):', '', ...paths.slice(0, 50).map((p) => `- ${p}`));
  if (paths.length > 50) lines.push(`- and ${paths.length - 50} more in wayback-unverified.txt`);
  return lines;
}

const GENERATED_START = '<!-- generated by readme.mjs: rewritten on every run -->';
const GENERATED_END = '<!-- end of generated notes -->';

// What a person or agent wrote under ## Notes in an earlier README, kept on every re-run
// (the generated lines are left out: they are written afresh).
function earlierNotes(dir) {
  const file = join(dir, 'README.md');
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const heading = text.match(/^## Notes[ \t]*$/m);
  if (!heading) return '';
  let notes = text.slice(heading.index + heading[0].length);
  const start = notes.indexOf(GENERATED_START);
  const end = notes.indexOf(GENERATED_END);
  if (start !== -1 && end > start) notes = notes.slice(0, start) + notes.slice(end + GENERATED_END.length);
  return notes.trim();
}

// What each Wayback path answered once it was requested as a seed (the second pass).
function waybackNotes(dir, inventory, redirects) {
  const file = join(dir, 'wayback-unverified.txt');
  if (!existsSync(file)) return [];
  const paths = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  const answers = [];
  for (const path of paths) {
    const redirect = (redirects ?? []).find((r) => r.from === path);
    const record = (inventory ?? []).find((r) => r.path === path);
    if (redirect) {
      const via = redirect.hops?.length ? ` (via ${redirect.hops.join(', ')})` : '';
      answers.push(`  - ${path}: ${redirect.status} to ${redirect.to}${via}${redirect.error ? ` (${redirect.error})` : ''}`);
    } else if (record) answers.push(`  - ${path}: ${record.status}`);
  }
  const lines = [
    `- Wayback second pass: ${answers.length} of ${paths.length} archived paths verified`
      + ' (capture.mjs --resume --seed-file wayback-unverified.txt; redirects found are in redirects.json with source "seed")',
    ...answers.slice(0, LIST_LIMIT * 5),
  ];
  if (answers.length > LIST_LIMIT * 5) lines.push(`  - and ${answers.length - LIST_LIMIT * 5} more (redirects.json, inventory.json)`);
  if (answers.length > 0 && answers.length < paths.length) lines.push(`  - ${paths.length - answers.length} not requested yet`);
  return lines;
}

// A Wayback listing that could not be read: no archived path was checked at all.
function waybackFailureNotes(meta) {
  if (meta?.wayback?.status !== 'failed') return [];
  const error = String(meta.wayback.error ?? 'no answer');
  if (/too-large/.test(error)) {
    return ['- Wayback: the CDX listing was refused for size (too-large), so no archived paths were checked; the capture went on without them'];
  }
  return [`- Wayback: the CDX listing failed (${error}), so no archived paths were checked`];
}

// The bot challenge that stopped the capture: it is not finished, and why.
function challengeNotes(meta) {
  const c = meta?.challenge;
  if (!c) return [];
  return [
    `- Stopped by a ${c.provider ?? 'host'} anti-bot challenge at ${c.path} (${c.cause}): the capture is not finished.`
      + ' Needs the site owner to allowlist the capture machine\'s public IP on the host or in the WAF for the capture'
      + ' window (or a URL list), then capture.mjs --resume',
  ];
}

// Pages that looked like a bot challenge (tiny, untitled) once, mid-crawl: not captured.
function suspectNotes(inventory) {
  return (inventory ?? [])
    .filter((r) => r.status === 'suspect-challenge')
    .map((r) => `- Suspected bot challenge, not captured: ${r.path} (${r.challenge}); open it in a browser and note whether it is a real page or a challenge`);
}

// Pages the crawl gave up on: still blocked (403, 429, 503, no answer) after their retries.
function stuckNotes(inventory) {
  return (inventory ?? [])
    .filter((r) => r.attempts && r.status !== 200)
    .map((r) => `- Still failing after retries: ${r.path} (${r.status || 'no answer'} after ${r.attempts} attempts)`);
}

function notesSection(notes, generated) {
  const lines = ['## Notes', ''];
  if (generated.length) lines.push(GENERATED_START, ...generated, GENERATED_END, ...(notes ? [''] : []));
  return notes ? [...lines, notes] : lines;
}

export function buildReadme(dir) {
  const notes = earlierNotes(dir);
  const inventory = readJson(dir, 'inventory.json');
  const meta = readJson(dir, 'meta.json');
  const fingerprint = readJson(dir, 'state.json')?.fingerprint ?? null;
  const origin = meta?.canonicalOrigin ?? meta?.origin ?? 'the site';
  const redirects = readJson(dir, 'redirects.json');
  const generated = [...challengeNotes(meta), ...waybackFailureNotes(meta), ...waybackNotes(dir, inventory, redirects), ...stuckNotes(inventory), ...suspectNotes(inventory)];
  const sections = [
    [`# Capture of ${origin}`, '', 'Generated by readme.mjs from the files in this folder. Re-run it after re-capturing.'],
    siteSection(meta, fingerprint, inventory),
    templatesSection(readJson(dir, 'templates.json')),
    discoverySection(inventory),
    redirectsSection(redirects),
    mediaSection(readJson(dir, 'media.json')),
    assetsSection(readJson(dir, 'assets/index.json')),
    vendorsSection(readJson(dir, 'scripts.json')),
    formsSection(inventory),
    indexingSection(inventory),
    feedsSection(readJson(dir, 'feeds/index.json')),
    iframesSection(inventory),
    waybackSection(dir),
    notesSection(notes, generated),
  ];
  return `${sections.map((s) => s.join('\n')).join('\n\n')}\n`;
}

function main() {
  assertNodeVersion();
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const at = argv.indexOf('--capture');
  const capture = at === -1 ? null : argv[at + 1];
  if (!capture || capture.startsWith('--') || argv.length !== 2) {
    console.error(`--capture <dir> is required, and it is the only option\n\n${USAGE}`);
    process.exit(2);
  }
  const dir = resolve(capture);
  if (!existsSync(join(dir, 'inventory.json'))) {
    console.error(`No inventory.json in ${dir}. Run capture.mjs first.`);
    process.exit(2);
  }
  writeFileSync(join(dir, 'README.md'), buildReadme(dir));
  console.log(`Wrote ${join(dir, 'README.md')}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
