#!/usr/bin/env node
// Reconcile a failing pre-launch gate with the live site: a failing check is accepted only when
// every row it names reproduces what the baseline recorded for live and docs/plan.md holds the
// decision that kept it, plus the narrow rules (the kit's form-id placeholder, the predecessor
// checks that misread the trailing-slash rules, a live site with no sitemap). Everything else blocks.
// Pure: reads files only. Exit codes: 0 nothing blocks, 1 something blocks, 2 usage or input error.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { pageHead } from './lib/page-head.mjs';

const HELP = `Usage: node prelaunch-reconcile.mjs --findings <pre-launch bundle>/gate.json
                                  --baseline baseline --plan docs/plan.md
                                  [--capture capture] [--dir .] [--dist <dir>/dist]
                                  [--state .conversion/state.json] [--media-plan <file>] [--json]

Reads the pre-launch bundle (gate.json, or findings.json with gate.json beside it) and sorts
every failing check into accepted or blocking.

A check is accepted only when every row it names (path and field: title, description, h1,
canonical, og:image, favicon, placeholder text) equals what baseline/seo.json, baseline/text/,
baseline/routes.json, baseline/media.json, capture/assets/index.json or capture/meta.json
recorded for live, and a row of the Decisions table in --plan names the check id, or names the
row's path and its field ("h1", "title", "og:image", "favicon", the placeholder string, ...);
a row that only names the path, such as a templates decision, accepts nothing. The home page "/"
counts only when written \`/\`. The build's 404.html is the captured 404 page (meta.json
notFound, its head read from the snapshot), named in a decision as \`404.html\`. A missing icon
counts as live's only when the capture asked for it (its link, or the /favicon.ico and
/apple-touch-icon.png probe in meta.json icons) and live answered something other than 200; an
icon's size only when live's file has the same size.
Narrow rules that need no decision:
  placeholders.form-id            every hit is the kit's placeholder formspree.io/f/REPLACE
                                  (the form id is still on the needs-you list)
  predecessor.wildcard-redirects  every row is one of the kit's trailing-slash rules
  predecessor.redirect-chains     every row is a slash-only loop (/about -> /about)
  predecessor.coverage            the row is "no sitemap could be fetched", the capture saved no
                                  live sitemap (baseline/sitemaps.json, capture/sitemaps/index.json),
                                  and every page the crawl found at 200 (baseline/routes.json) is
                                  built in --dist or named on a decision row
  hygiene.pushed                  --dir has no git remote and a needs-you item in --state says
                                  to push (no PR can be opened until the person pushes)
  output.robots-txt               every row is "the Sitemap: line points at <host>, ..." and each
                                  Sitemap: line on that host in <dist>/robots.txt is one the live
                                  robots.txt (capture/robots.txt) carried verbatim (a sister
                                  site's sitemap the default build keeps, as live had it)
  output.og-image                 a row "<image> does not exist in the build" whose path the
                                  baseline media lists, under the media prefix of a media plan in
                                  mode store or live-temporary, with the whole prefix sent to
                                  another origin: a <dir>/vercel.json rewrite whose source is the
                                  prefix plus a parameter (/:path*) and whose destination is an
                                  absolute URL, a _redirects line (<dist> or <dir>/public)
                                  "<prefix>* <absolute URL> 200|302", or a Pages Function
                                  under <dir>/functions/: the rewrite serves it
output.noindex-utility-pages rows are pages: accepted when live had the same page indexable
(no noindex in baseline/seo.json) and a decision names the check, or the page and "noindex",
"robots" or "indexable".
pre-launch lists at most 20 rows per check, and none of its outputs (gate.json, findings.json,
report.md) holds the rest. A check cut at that cap is accepted only when every listed row is, a
decision row names the check id, and the count in its summary equals live's: pages without a
title or description plus titles or descriptions shared by indexable pages (output.titles,
output.descriptions), pages without exactly one h1 (output.h1), indexable demo, preview,
test or confirmation pages (output.noindex-utility-pages), from baseline/seo.json. Any other
cut check blocks (the unlisted rows cannot be compared), and so does any other failing check, a
crashed one included.

  --findings <file>  gate.json or findings.json from pre-launch's --out bundle (required)
  --baseline <dir>   the baseline folder (required)
  --plan <file>      docs/plan.md with its Decisions table (required)
  --capture <dir>    the capture folder: assets/index.json, meta.json, sitemaps/index.json,
                     robots.txt and the 404 page (default: capture)
  --dir <dir>        the site repository, for hygiene.pushed (default: .)
  --dist <dir>       the build, for predecessor.coverage and output.robots-txt (default: <dir>/dist)
  --state <file>     the run state with needsYou (default: .conversion/state.json)
  --media-plan <file>  the media plan, for output.og-image (default: <dir>/docs/media-plan.json)
  --json             print { failing, accepted[], blocking[] } instead of lines
  --help             show this help

Exit codes: 0 nothing blocks, 1 a failing check blocks, 2 usage or input error.`;

// The shapes of parity-gates' slashRules() (build-redirects.mjs), with @@ where the extension
// alternation goes: each extension in any letter case ([Jj][Pp][Gg], digits as written). Copied,
// not imported, because this skill is copied on its own; a test checks every rule it writes.
const SLASH_SHAPES = [
  ['/:path((?!\\.well-known(?:/|$))(?!(?:[^/]+/)*[^/]+\\.(?:@@)$)(?:[^/]+/)*[^/]+)', '/:path/'],
  ['/:path((?:[^/]+/)*[^/]+\\.(?:@@))/', '/:path'],
  ['/:path(.+)/', '/:path'],
];
const EXTENSION = '(?:\\[[A-Z][a-z]\\]|[0-9])+';
const SLASH_PATTERNS = SLASH_SHAPES.map(([source, destination]) => ({
  source: new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('@@', `${EXTENSION}(?:\\|${EXTENSION})*`)}$`),
  destination,
}));

export function isSlashRule(source, destination) {
  return SLASH_PATTERNS.some((p) => p.destination === destination && p.source.test(source));
}

const FORM_PLACEHOLDER = /^formspree\.io\/f\/REPLACE$/i;

// A url path compared without its trailing slash, as pre-launch compares them.
export function normalizePath(input) {
  let path = String(input ?? '').split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // kept as written
  }
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

// The url path a build file serves: index.html is /, x/index.html is /x, x.html is /x.
function relPath(rel) {
  const r = rel.trim().replace(/^\/+/, '');
  if (r === 'index.html') return '/';
  if (r.endsWith('/index.html')) return normalizePath(r.slice(0, -'/index.html'.length));
  if (r.endsWith('.html')) return normalizePath(r.slice(0, -'.html'.length));
  return normalizePath(r);
}

function pathnameOf(value) {
  try {
    return new URL(value, 'http://x.invalid').pathname;
  } catch {
    return null;
  }
}
function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
// The same url: equal, or the same path where both name a host and the hosts agree.
const sameUrl = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b
  || (pathnameOf(a) !== null && pathnameOf(a) === pathnameOf(b) && (hostOf(a) === null || hostOf(b) === null || hostOf(a) === hostOf(b))));
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const empty = (v) => v === null || v === undefined || String(v).trim() === '';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------------------- the inputs

// The Sitemap: URLs a robots.txt text names.
const sitemapLines = (text) => [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);

// The size a PNG's IHDR records, or null.
function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  } catch {
    return null;
  }
}

export function loadBaseline(dir, captureDir = null) {
  const read = (name, fallback) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : fallback);
  if (!existsSync(join(dir, 'seo.json'))) throw new Error(`${join(dir, 'seo.json')} not found`);
  const seo = read('seo.json');
  const routes = read('routes.json', []);
  const media = read('media.json', []);
  const byNormal = new Map(Object.keys(seo).map((p) => [normalizePath(p), p]));
  const snapshots = new Map(routes.filter((r) => r.snapshot).map((r) => [r.path, r.snapshot]));
  const files = new Set([...routes.map((r) => r.path), ...media.map((m) => m.path)]);
  const mediaPaths = new Set(media.map((m) => m.path));
  // Sizes listed but never requested (downloaded: false) have no live status.
  const requestedMedia = new Set(media.filter((m) => m.downloaded !== false).map((m) => m.path));
  const assetsFile = captureDir ? join(captureDir, 'assets', 'index.json') : null;
  const assets = assetsFile && existsSync(assetsFile) ? JSON.parse(readFileSync(assetsFile, 'utf8')) : [];
  const assetAt = (path) => assets.find((a) => a.url && pathnameOf(a.url) === path) ?? null;
  const captured = (name, fallback) => {
    const file = captureDir ? join(captureDir, name) : null;
    return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  };
  const meta = captured('meta.json', {});
  const icons = meta.icons ?? {};
  // The captured 404 page (meta.json notFound) is not a route; its head is read from its snapshot.
  const notFoundFile = meta.notFound?.snapshot ? join(captureDir, meta.notFound.snapshot) : null;
  const notFound = notFoundFile && existsSync(notFoundFile) ? pageHead(readFileSync(notFoundFile, 'utf8')) : null;
  const allSeo = notFound ? { ...seo, [NOT_FOUND]: notFound } : seo;
  return {
    // The baseline's own spelling of a build path, or null when live had no such page. The build's
    // 404.html is the captured 404 page.
    page(path) {
      if (notFound && String(path).trim().replace(/^\/+/, '') === NOT_FOUND) return NOT_FOUND;
      return byNormal.get(normalizePath(path)) ?? null;
    },
    seo: (page) => allSeo[page],
    text(page) {
      if (page === NOT_FOUND) {
        const file = meta.notFound?.text ? join(captureDir, meta.notFound.text) : null;
        return file && existsSync(file) ? readFileSync(file, 'utf8') : '';
      }
      const snapshot = snapshots.get(page);
      if (!snapshot) return '';
      const file = join(dir, 'text', snapshot.replace(/^pages\//, '').replace(/\.html$/, '.txt'));
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    has: (path) => files.has(path),
    // What live answered for a site file: 200, another status, or null when nothing asked.
    liveStatus(path) {
      const route = routes.find((r) => r.path === path);
      if (route) return route.status;
      if (requestedMedia.has(path)) return 200;
      if (mediaPaths.has(path)) return null;
      // meta.json icons: { status, file, contentType, bytes } per path (a bare status in older captures).
      return assetAt(path)?.status ?? icons[path]?.status ?? icons[path] ?? null;
    },
    // The size of live's PNG at path, from the capture's saved asset.
    livePngSize(path) {
      const asset = assetAt(path);
      return asset?.status === 200 && asset.file ? pngSize(join(captureDir, asset.file)) : null;
    },
    servedIcon: (pattern) => [...files].some((p) => pattern.test(p)) || assets.some((a) => a.status === 200 && a.url && pattern.test(pathnameOf(a.url) ?? '')),
    anyFile: (pattern) => [...files].some((p) => pattern.test(p)),
    isMedia: (path) => mediaPaths.has(path),
    pagesWithOgImage: (image) => Object.keys(allSeo).filter((p) => sameUrl(allSeo[p].og?.image, image)),
    // The Sitemap: URLs of the live robots.txt the capture saved, [] without it.
    liveSitemapLines: () => {
      const file = captureDir ? join(captureDir, 'robots.txt') : null;
      return file && existsSync(file) ? sitemapLines(readFileSync(file, 'utf8')) : [];
    },
    // Whether live published a sitemap: one the capture saved (baseline/sitemaps.json) or one
    // capture/sitemaps/index.json records answering 200.
    hadSitemap: () => read('sitemaps.json', []).length > 0 || captured(join('sitemaps', 'index.json'), []).some((s) => s.status === 200),
    // The pages the crawl found answering 200 (not media).
    crawled: () => routes.filter((r) => r.status === 200 && r.kind !== 'media').map((r) => r.path),
    // Every page live served, the captured 404 page included, as [path, seo row].
    pages: () => Object.entries(allSeo),
  };
}

const NOT_FOUND = '404.html';

// [{ id, text, topic }] from the Decisions table rows (| dN | date | topic | … |).
export function loadDecisions(planFile) {
  return readFileSync(planFile, 'utf8').split('\n')
    .map((line) => /^\|\s*(d\d+)\s*\|(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: m[2], topic: (m[2].split('|')[1] ?? '').trim() }));
}

// A row names a path or a check id as a whole token. The home page "/" is a token only when it is
// written `/`, or opens the Topic column (`/ …`): a spaced slash ("keep / drop") is prose.
function names(decision, name) {
  if (name === '/') return decision.text.includes('`/`') || /^\/(\s|$)/.test(decision.topic);
  return new RegExp(`(^|[\\s(\`'"])${escape(name)}(?=$|[\\s)\`'",;:.])`).test(decision.text);
}

function decisionNaming(decisions, wanted) {
  const tokens = [...new Set(wanted.filter(Boolean))];
  return decisions.find((d) => tokens.some((t) => names(d, t)))?.id ?? null;
}

// How a decision row names a row's field: the word for it ("h1", "title", "og:image", ...).
const FIELD_WORDS = {
  title: /\btitles?\b/i,
  description: /\bdescriptions?\b/i,
  h1: /\bh1s?\b/i,
  canonical: /\bcanonical/i,
  'og:image': /\bog:image\b|\bog-image\b|\bog image\b|\bshare image\b/i,
  favicon: /favicon|\bicons?\b|apple-touch-icon|manifest/i,
  'placeholder text': /placeholder/i,
  robots: /\bnoindex\b|\brobots\b|\bindexable\b|\bindexed\b/i,
};

// The decision accepting a row: one that names the check id, or names the row's path and its
// field (for placeholder text, the placeholder string itself counts as the field). A row that
// merely names the path, such as a templates decision listing pages, accepts nothing.
function decisionFor(decisions, check, row) {
  const byCheck = decisionNaming(decisions, [check]);
  if (byCheck) return byCheck;
  const paths = [...new Set([...row.paths, ...row.paths.map(normalizePath)])];
  const shown = row.field === 'placeholder text' ? / — (.+)$/.exec(row.text)?.[1] : null;
  const fieldNamed = (d) => FIELD_WORDS[row.field]?.test(d.text) || (shown && d.text.toLowerCase().includes(shown.toLowerCase()));
  return decisions.find((d) => fieldNamed(d) && paths.some((p) => names(d, p)))?.id ?? null;
}

// The failing checks, as { id, detail, evidence[] }: gate.json's fail checks, or findings.json's
// blocker findings plus any fail check (a crash) only the gate.json beside it records.
export function loadFailing(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const fromGate = (gate) => gate.checks.filter((c) => c.status === 'fail').map(({ id, detail, evidence }) => ({ id, detail: detail ?? '', evidence: evidence ?? [] }));
  if (data && Array.isArray(data.checks)) return fromGate(data);
  if (!Array.isArray(data)) throw new Error(`${file} is neither pre-launch's gate.json nor its findings.json`);
  const byId = new Map();
  for (const f of data.filter((x) => x.severity === 'blocker')) {
    const entry = byId.get(f.id) ?? { id: f.id, detail: f.detail ?? '', evidence: [] };
    entry.evidence.push(...(f.evidence ?? []));
    byId.set(f.id, entry);
  }
  const sibling = join(dirname(file), 'gate.json');
  if (existsSync(sibling)) {
    for (const check of fromGate(JSON.parse(readFileSync(sibling, 'utf8')))) if (!byId.has(check.id)) byId.set(check.id, check);
  }
  return [...byId.values()];
}

// ------------------------------------------------------------------------------- the rows

// A row on a page: the baseline page it names, or a failing row when live had no such page.
function onPage(base, rel, field, text, compare) {
  const page = base.page(rel) === NOT_FOUND ? NOT_FOUND : base.page(relPath(rel));
  if (page === null) return { text, field, paths: [relPath(rel)], ok: false, reason: `live has no page at ${relPath(rel)}` };
  const reason = compare(base.seo(page), page);
  return { text, field, paths: [page], ok: reason === null, reason };
}

function headRows(field, label) {
  return (base, value) => {
    let m = new RegExp(`^(\\S+) has no ${label}$`).exec(value);
    if (m) return [onPage(base, m[1], field, value, (seo) => (empty(seo[field]) ? null : `live recorded ${field} "${seo[field]}"`))];
    m = new RegExp(`^(.+) share the ${label} "(.*)"$`).exec(value);
    if (m) return m[1].split(', ').map((rel) => onPage(base, rel, field, value, (seo) => (same(seo[field], m[2]) ? null : `live recorded ${field} "${seo[field]}"`)));
    return null;
  };
}

const ROWS = {
  'output.titles': headRows('title', 'title'),
  'output.descriptions': headRows('description', 'meta description'),
  'output.h1': (base, value) => {
    const m = /^(\S+) has (\d+) h1 elements$/.exec(value);
    if (!m) return null;
    return [onPage(base, m[1], 'h1', value, (seo) => ((seo.h1 ?? []).length === Number(m[2]) ? null : `live recorded ${(seo.h1 ?? []).length}`))];
  },
  'output.canonical': (base, value) => {
    const check = (rel, test) => [onPage(base, rel, 'canonical', value, (seo) => (test(seo.canonical) ? null : `live recorded canonical ${seo.canonical ?? 'none'}`))];
    let m = /^(\S+) has no canonical link$/.exec(value);
    if (m) return check(m[1], (c) => empty(c));
    m = /^(\S+) has a relative canonical "(.*)"; /.exec(value) ?? /^(\S+) has a canonical that is not a url: "(.*)"$/.exec(value);
    if (m) return check(m[1], (c) => c === m[2]);
    m = /^(\S+) canonicalises to (\S+), not \S+$/.exec(value);
    if (m) return check(m[1], (c) => { try { return new URL(c).hostname === m[2]; } catch { return false; } });
    m = /^(\S+) serves \S+ but canonicalises to (\S+)$/.exec(value);
    if (m) return check(m[1], (c) => !empty(c) && normalizePath(pathnameOf(c)) === m[2]);
    m = /^(\S+) has \d+ canonical links; /.exec(value);
    if (m) return check(m[1], () => false);
    return null;
  },
  'output.og-image': (base, value, detail, env) => {
    if (detail.startsWith('none of the')) return [onPage(base, value, 'og:image', value, (seo) => (empty(seo.og?.image) ? null : `live recorded og:image ${seo.og.image}`))];
    let m = /^(\S+) does not exist in the build \(used by (.+)\)$/.exec(value);
    if (m) {
      const path = pathnameOf(m[1]);
      if (base.isMedia(path)) {
        const served = rewriteServes(env, path);
        if (served) return [{ text: value, field: 'og:image', paths: [], ok: true, reason: null, decision: served, note: 'served by the media rewrite' }];
        return [{ text: value, field: 'og:image', paths: [], ok: false, reason: 'live served this image' }];
      }
      return m[2].split(', ').map((rel) => onPage(base, rel, 'og:image', value, (seo) => (sameUrl(seo.og?.image, m[1]) ? null : `live recorded og:image ${seo.og?.image ?? 'none'}`)));
    }
    m = /^(\S+) is (an SVG|not a recognised image|a \S+ whose dimensions|\d+x\d+)/.exec(value);
    if (m) {
      const pages = base.pagesWithOgImage(m[1]);
      return [{ text: value, field: 'og:image', paths: pages, ok: pages.length > 0, reason: pages.length ? null : 'live used no such og:image' }];
    }
    return null;
  },
  'output.noindex-utility-pages': (base, value) => {
    const m = /^(\S+) \((\S+)\) has no noindex$/.exec(value);
    if (!m) return null;
    return [onPage(base, m[1], 'robots', value, (seo) => (/\bnoindex\b/i.test(seo.robots ?? '') ? `live recorded robots "${seo.robots}"` : null))];
  },
  'output.favicon-set': (base, value) => {
    const row = (paths, ok, reason) => [{ text: value, field: 'favicon', paths, ok, reason: ok ? null : reason }];
    let m = /^(\S+) is missing$/.exec(value);
    if (m) {
      const path = `/${m[1]}`;
      const status = base.liveStatus(path);
      if (status === null) return row([path], false, `the capture never asked for ${path}, so it cannot say live lacked it`);
      return row([path], status !== 200, `live served ${path}`);
    }
    if (value.startsWith('neither favicon.svg nor')) return row(['/favicon.svg'], !base.servedIcon(/^\/(?:.*\/)?(favicon\.svg|(favicon|icon)-[\w.]*\.png)$/i), 'live served a scalable or sized icon');
    m = /^apple-touch-icon\.png is (\d+x\d+)/.exec(value);
    if (m) {
      const live = base.livePngSize('/apple-touch-icon.png');
      return row(['/apple-touch-icon.png'], live === m[1], live ? `live's is ${live}` : 'the capture holds no apple-touch-icon.png to compare');
    }
    if (value === 'no page links to a web app manifest') return row([], !base.anyFile(/(\.webmanifest|manifest\.json)$/), 'live served a manifest');
    return null;
  },
};

// The media plan's word for an image the build does not hold but the media rewrite serves: the
// plan keeps media off the repo (store or live-temporary), the path is under its prefix, and a
// rewrite for the prefix is configured. null otherwise.
function rewriteServes(env, path) {
  const plan = env.mediaPlan;
  if (!plan || !['store', 'live-temporary'].includes(plan.mode) || typeof plan.prefix !== 'string') return null;
  const prefix = `/${plan.prefix.replace(/^\/+|\/+$/g, '')}/`;
  if (!path.startsWith(prefix)) return null;
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  let vercel = [];
  try {
    vercel = JSON.parse(read(join(env.dir, 'vercel.json')) ?? '{}').rewrites ?? [];
  } catch {
    vercel = [];
  }
  const redirects = [join(env.dist, '_redirects'), join(env.dir, 'public', '_redirects')].map(read).filter(Boolean).join('\n');
  // The whole prefix (a parameter or splat right after it), sent to another origin: the store or
  // live. A one-file rewrite under the prefix, or one to a path on this site, serves nothing else.
  const offOrigin = (destination) => /^https?:\/\//i.test(String(destination ?? '').trim());
  const wholePrefix = (source) => typeof source === 'string' && source.startsWith(prefix) && /^(?::[A-Za-z_]\w*|\*)/.test(source.slice(prefix.length));
  const covered = vercel.some((r) => wholePrefix(r?.source) && offOrigin(r.destination))
    || redirects.split('\n').some((line) => {
      const [from, to, status] = line.trim().split(/\s+/);
      return from === `${prefix}*` && offOrigin(to) && ['200', '302'].includes(status);
    })
    || existsSync(join(env.dir, 'functions', ...prefix.split('/').filter(Boolean), '[[path]].js'));
  return covered ? `media plan (${plan.mode})` : null;
}

// Live's count for a check pre-launch cut at its listing cap, from baseline/seo.json, or null
// when the check has no count to compare.
const UTILITY_PATH = /thank|thanks|confirm|success|demo|preview|test/i;
const isNoindex = (seo) => /\bnoindex\b/i.test(seo.robots ?? '');
function headCount(base, field) {
  let count = 0;
  const groups = new Map();
  for (const [, seo] of base.pages()) {
    if (empty(seo[field])) {
      count += 1;
      continue;
    }
    if (isNoindex(seo)) continue;
    const key = String(seo[field]).trim().toLowerCase();
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return count + [...groups.values()].filter((n) => n > 1).length;
}
const LIVE_COUNTS = {
  'output.titles': (base) => headCount(base, 'title'),
  'output.descriptions': (base) => headCount(base, 'description'),
  'output.h1': (base) => base.pages().filter(([, seo]) => (seo.h1 ?? []).length !== 1).length,
  'output.noindex-utility-pages': (base) => base.pages().filter(([path, seo]) => path !== NOT_FOUND && UTILITY_PATH.test(path) && !isNoindex(seo)).length,
};

// placeholders.copy: a page row is live when its baseline text, title or description shows the
// same string; a source row is live when a live page row matched the same string.
function placeholderRows(base, evidence) {
  const rows = evidence.map(({ value }) => {
    const m = /^(.+):(\d+) — (.+)$/.exec(value);
    if (!m) return { text: value, field: 'placeholder text', paths: [], ok: false, reason: 'row not understood' };
    const [, label, , match] = m;
    const rel = label.split('/').slice(1).join('/');
    if (label.endsWith('.html') && base.page(relPath(rel)) !== null) {
      return onPage(base, rel, 'placeholder text', value, (seo, page) => {
        const shown = [base.text(page), seo.title ?? '', seo.description ?? ''].join('\n').toLowerCase();
        return shown.includes(match.toLowerCase()) ? null : `live did not show "${match}"`;
      });
    }
    return { text: value, field: 'placeholder text', match, paths: [], ok: null };
  });
  for (const row of rows.filter((r) => r.ok === null)) {
    const pages = rows.filter((r) => r.ok === true && same(/ — (.+)$/.exec(r.text)?.[1], row.match));
    row.paths = pages.flatMap((r) => r.paths);
    row.ok = pages.length > 0;
    row.reason = row.ok ? null : `no live page shows "${row.match}"`;
    delete row.match;
  }
  return rows;
}

// --------------------------------------------------------------------------- the reconciliation

const listedCount = (detail) => Number((/^(\d+)\b/.exec(detail) ?? /^none of the (\d+)\b/.exec(detail) ?? [])[1] ?? 0);

// No remote: `git remote` in dir prints nothing (a folder git does not know counts as no remote).
function hasRemote(dir) {
  try {
    return execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
  } catch {
    return false;
  }
}

function needsYou(stateFile) {
  try {
    return (JSON.parse(readFileSync(stateFile, 'utf8')).needsYou ?? []).map((n) => (typeof n === 'string' ? n : `${n.item ?? ''} ${n.command ?? ''}`));
  } catch {
    return [];
  }
}

function narrow(check, env, base, decisions) {
  const values = check.evidence.map((e) => String(e.value));
  if (check.id === 'hygiene.pushed') {
    const text = values[0] ?? check.detail;
    if (hasRemote(env.dir)) return { ok: false, rows: [{ text, ok: false, reason: `${env.dir} has a remote: push the branch` }] };
    const listed = needsYou(env.state).some((n) => /\bpush/i.test(n));
    return {
      ok: listed,
      rule: 'no-remote',
      decision: 'push (needs you)',
      rows: [{ text, ok: listed, reason: listed ? null : `no needs-you item in ${env.state} says to push` }],
    };
  }
  if (values.length === 0) return null;
  if (check.id === 'placeholders.form-id') {
    const ok = values.every((v) => FORM_PLACEHOLDER.test(/ — (.+)$/.exec(v)?.[1] ?? ''));
    return { ok, rule: 'form-id', decision: 'form id (needs you)', rows: values.map((text) => ({ text, ok, reason: ok ? null : 'not the kit placeholder formspree.io/f/REPLACE' })) };
  }
  if (check.id === 'predecessor.wildcard-redirects') {
    const rows = values.map((text) => {
      const pair = /^"(.+) -> (\S+)" covers /.exec(text);
      const ok = Boolean(pair) && isSlashRule(pair[1], pair[2]);
      return { text, ok, reason: ok ? null : 'not one of the kit trailing-slash rules' };
    });
    return { ok: rows.every((r) => r.ok), rule: 'slash', decision: null, rows };
  }
  if (check.id === 'predecessor.redirect-chains') {
    const rows = values.map((text) => {
      const m = /^(\S+) -> (.+) is a loop and serves nothing$/.exec(text);
      const ok = Boolean(m) && m[2].split(' -> ').every((hop) => hop === m[1]);
      return { text, ok, reason: ok ? null : 'not a slash-only redirect' };
    });
    return { ok: rows.every((r) => r.ok), rule: 'slash', decision: null, rows };
  }
  if (check.id === 'output.robots-txt') {
    const live = new Set(base.liveSitemapLines());
    const robotsFile = join(env.dist, 'robots.txt');
    const built = existsSync(robotsFile) ? sitemapLines(readFileSync(robotsFile, 'utf8')) : [];
    const rows = values.map((text) => {
      const host = /^the Sitemap: line points at (\S+), not /.exec(text)?.[1];
      if (!host) return { text, ok: false, reason: 'not an off-host Sitemap: line' };
      // pre-launch names the hostname (no port).
      const lines = built.filter((url) => URL.canParse(url) && new URL(url).hostname === host);
      const missing = lines.filter((url) => !live.has(url));
      if (lines.length === 0) return { text, ok: false, reason: `no Sitemap: line on ${host} in ${robotsFile}` };
      if (missing.length) return { text, ok: false, reason: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the live robots.txt (capture/robots.txt)` };
      return { text, ok: true, reason: null };
    });
    return { ok: rows.every((r) => r.ok), rule: 'live-robots', decision: null, rows };
  }
  if (check.id === 'predecessor.coverage') {
    const rows = values.map((text) => noSitemapRow(text, base, decisions, env));
    const ids = [...new Set(rows.flatMap((r) => r.decisions ?? []))];
    for (const r of rows) delete r.decisions;
    return { ok: rows.every((r) => r.ok), rule: 'no-sitemap', decision: ids.join(', ') || null, rows };
  }
  return undefined;
}

// The file the build serves for a url path, as pre-launch resolves it (plus a feed's index.xml).
function inBuild(dist, path) {
  const bare = normalizePath(path).slice(1);
  const candidates = bare === '' ? ['index.html'] : [bare, `${bare}.html`, `${bare}/index.html`, `${bare}/index.htm`, `${bare}/index.xml`];
  return candidates.some((c) => existsSync(join(dist, c)) && statSync(join(dist, c)).isFile());
}

// predecessor.coverage when live publishes no sitemap: pre-launch has no list of old urls, so the
// crawl stands in for it. Accepted only when the capture saved no live sitemap and every page the
// crawl found answering 200 is built at its path, or named on a decision row.
function noSitemapRow(text, base, decisions, env) {
  if (!/^no sitemap could be fetched from /.test(text)) return { text, ok: false, reason: 'not the no-sitemap row' };
  if (base.hadSitemap()) return { text, ok: false, reason: 'the capture saved a live sitemap; make it reachable for pre-launch' };
  const ids = [];
  const missing = [];
  for (const path of base.crawled()) {
    if (inBuild(env.dist, path)) continue;
    const id = decisionNaming(decisions, [path, normalizePath(path)]);
    if (id) ids.push(id);
    else missing.push(path);
  }
  if (missing.length) {
    const listed = missing.slice(0, 10).join(', ') + (missing.length > 10 ? `, and ${missing.length - 10} more` : '');
    return { text, ok: false, reason: `${listed} ${missing.length === 1 ? 'is' : 'are'} crawled from live but not in the build (${env.dist}) and on no decision row` };
  }
  return { text, ok: true, reason: null, decisions: ids };
}

// The row standing for the rows pre-launch did not list: accepted when a decision names the check
// and live had the same count (LIVE_COUNTS).
function cappedRow(check, count, base, decisions) {
  const listed = check.evidence.length;
  const decision = decisionNaming(decisions, [check.id]);
  const live = LIVE_COUNTS[check.id]?.(base) ?? null;
  if (decision && live === count) {
    return { text: check.detail, field: 'count', paths: [], ok: true, reason: null, decision, note: `${count} rows, ${listed} listed: live had ${live} too` };
  }
  let why = 'the rest cannot be compared with live';
  if (live !== null && decision) why = `live had ${live}, so the count does not match`;
  else if (live !== null) why = `no decision row names ${check.id} (live had ${live})`;
  return { text: check.detail, paths: [], ok: false, reason: `only ${listed} of ${count} rows listed; ${why}` };
}

export function reconcile(failing, base, decisions, env = { dir: '.', dist: 'dist', state: join('.conversion', 'state.json') }) {
  const accepted = [];
  const blocking = [];
  for (const check of failing) {
    const special = narrow(check, env, base, decisions);
    if (special !== undefined) {
      if (special?.ok) accepted.push({ id: check.id, rule: special.rule, decision: special.decision, rows: special.rows });
      else blocking.push({ id: check.id, detail: check.detail, rows: special?.rows ?? [] });
      continue;
    }
    const parse = ROWS[check.id];
    let rows;
    if (check.id === 'placeholders.copy') rows = placeholderRows(base, check.evidence);
    else if (parse) {
      rows = check.evidence.flatMap(({ value }) => parse(base, String(value), check.detail, env)
        ?? [{ text: String(value), paths: [], ok: false, reason: 'row not understood' }]);
    }
    if (!rows || rows.length === 0) {
      blocking.push({ id: check.id, detail: check.detail, rows: [] });
      continue;
    }
    for (const row of rows.filter((r) => r.ok && !r.decision)) {
      row.decision = decisionFor(decisions, check.id, row);
      if (row.decision === null) {
        row.ok = false;
        const where = row.paths.length ? `, or ${row.paths.join(' or ')} with its ${row.field}` : '';
        row.reason = `no decision row in the plan names ${check.id}${where}`;
      }
    }
    const count = listedCount(check.detail);
    if (count > check.evidence.length) rows.push(cappedRow(check, count, base, decisions));
    if (rows.every((r) => r.ok)) {
      accepted.push({ id: check.id, rule: 'live', decision: [...new Set(rows.map((r) => r.decision))].join(', '), rows });
    } else blocking.push({ id: check.id, detail: check.detail, rows });
  }
  return { failing: failing.length, accepted, blocking };
}

function lines(result) {
  const out = [`prelaunch-reconcile: ${result.failing} failing checks, ${result.accepted.length} accepted, ${result.blocking.length} blocking`];
  for (const a of result.accepted) {
    for (const r of a.rows) {
      if (a.rule === 'slash') out.push(`accepted  ${a.id}: ${r.text} — trailing-slash rule (known launch-skills limitation)`);
      else if (a.rule === 'form-id') out.push(`accepted  ${a.id}: ${r.text} — form id pending (needs you)`);
      else if (a.rule === 'no-remote') out.push(`accepted  ${a.id}: ${r.text} — no remote yet; the push is on the needs-you list`);
      else if (a.rule === 'live-robots') out.push(`accepted  ${a.id}: ${r.text} — the live robots.txt carried this Sitemap: line`);
      else if (a.rule === 'no-sitemap') out.push(`accepted  ${a.id}: ${r.text} — live publishes no sitemap; every page the crawl found is built${a.decision ? ` or decided (${a.decision})` : ''}`);
      else if (r.note) out.push(`accepted  ${a.id}: ${r.text} — ${r.note} (${r.decision})`);
      else out.push(`accepted  ${a.id}: ${r.paths.join(', ') || r.text} ${r.field} — reproduced from live (${r.decision})`);
    }
  }
  for (const b of result.blocking) {
    const bad = b.rows.filter((r) => !r.ok);
    if (bad.length === 0) out.push(`blocking  ${b.id}: ${b.detail}`);
    for (const r of bad) out.push(`blocking  ${b.id}: ${r.text} — ${r.reason}`);
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '--json') opts[arg.slice(2)] = true;
    else if (['--findings', '--baseline', '--plan', '--capture', '--dir', '--dist', '--state', '--media-plan'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`unexpected argument "${arg}"`);
  }
  return opts;
}

function main() {
  assertNodeVersion();
  let opts;
  let result;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    for (const name of ['findings', 'baseline', 'plan']) if (!opts[name]) throw new Error(`--${name} is required`);
    for (const name of ['findings', 'plan']) if (!existsSync(opts[name])) throw new Error(`${opts[name]} not found`);
    const dir = opts.dir ?? '.';
    const planFile = opts['media-plan'] ?? join(dir, 'docs', 'media-plan.json');
    if (opts['media-plan'] && !existsSync(planFile)) throw new Error(`${planFile} not found`);
    const mediaPlan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : null;
    result = reconcile(loadFailing(opts.findings), loadBaseline(opts.baseline, opts.capture ?? 'capture'), loadDecisions(opts.plan), {
      dir,
      dist: opts.dist ?? join(dir, 'dist'),
      state: opts.state ?? join(dir, '.conversion', 'state.json'),
      mediaPlan,
    });
  } catch (err) {
    console.error(`prelaunch-reconcile: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  console.log(opts.json ? JSON.stringify(result, null, 2) : lines(result));
  process.exitCode = result.blocking.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
