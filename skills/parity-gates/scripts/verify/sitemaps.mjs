#!/usr/bin/env node
// Sitemaps gate: every top sitemap in dist (Astro's sitemap-index.xml, sitemap_index.xml or
// sitemap.xml, or a live sitemap name recorded in baseline/sitemaps.json such as WordPress's
// wp-sitemap.xml) lists exactly the indexable pages, posts and archives the baseline recorded at
// 200, on the build's origin; every robots.txt Sitemap: line points at a file in dist (or is a
// line on another host that the captured live robots.txt carried verbatim); and every
// feed the live site served is built with as many items as the captured feed.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { feedFiles, firstExisting, originOf, PAGE_KINDS, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'sitemaps';
const OPTIONS = {
  capture: { type: 'string', default: 'capture', description: 'the capture folder, for the captured feeds and robots.txt' },
  origin: { type: 'string', default: '', description: 'the origin the sitemap URLs must be on (default: canonicalOrigin in baseline/meta.json)' },
};
const NOTES = `
Expected in the sitemap: every page, post and archive route at 200 without noindex. The sitemap
files read are sitemap-index.xml, sitemap_index.xml, sitemap.xml and every live sitemap name in
baseline/sitemaps.json (wp-sitemap.xml, sitemap_index.xml, page-sitemap.xml, ...), each one that
exists in dist. A sitemap index is followed to its child sitemaps in dist. Each file that no
other index lists as a child is a top sitemap, and each top sitemap (with its children) must list
exactly the expected pages; with more than one, a failure names it ("sitemap wp-sitemap.xml").
Every "Sitemap:" line of dist/robots.txt must be a URL on the origin (--origin, else
canonicalOrigin) naming a file in dist, or a line the live robots.txt carried verbatim: a URL
on another host (a sister site's sitemap) passes when <capture>/robots.txt, the live file the
capture saved, has a Sitemap: line with exactly that URL. No live request is made; without
<capture>/robots.txt every other-host line fails.
Feed items are <item> (RSS) or <entry> (Atom).
`;
const TOP = ['sitemap-index.xml', 'sitemap_index.xml', 'sitemap.xml'];
const isIndex = (xml) => /<sitemapindex[\s>]/.test(xml);

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function locs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => unescapeXml(m[1]));
}

export const itemCount = (xml) => (xml.match(/<(?:item|entry)[\s>]/g) ?? []).length;

const pathOf = (loc) => {
  try {
    return decode(new URL(loc).pathname);
  } catch {
    return loc;
  }
};

// { roots: [{ name, urls }], failures }: every sitemap file of TOP and `names` present in dist,
// grouped under the top sitemaps (those no present index lists), an index followed to its
// children in dist. roots is null when no sitemap file exists.
export function readSitemaps(dist, names = []) {
  const candidates = [...new Set([...TOP, ...names])].filter((name) => existsSync(join(dist, name)));
  if (!candidates.length) return { roots: null, failures: [{ path: '/', field: 'sitemap', expected: TOP[0], actual: null }] };
  const xmlOf = new Map(candidates.map((name) => [name, readFileSync(join(dist, name), 'utf8')]));
  const childrenOf = (name) => (isIndex(xmlOf.get(name)) ? locs(xmlOf.get(name)).map((loc) => pathOf(loc).replace(/^\/+/, '')) : []);
  const children = new Set(candidates.flatMap(childrenOf));
  const failures = [];
  const reported = new Set();
  const roots = candidates.filter((name) => !children.has(name)).map((name) => {
    if (!isIndex(xmlOf.get(name))) return { name, urls: locs(xmlOf.get(name)) };
    const urls = [];
    for (const file of childrenOf(name)) {
      if (!file || !existsSync(join(dist, file))) {
        if (!reported.has(file)) failures.push({ path: `/${file}`, field: 'sitemap', expected: file, actual: null });
        reported.add(file);
        continue;
      }
      urls.push(...locs(readFileSync(join(dist, file), 'utf8')));
    }
    return { name, urls };
  });
  return { roots, failures };
}

const sitemapLines = (text) => [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);

// The Sitemap: URLs of the live robots.txt the capture saved (<capture>/robots.txt), [] without it.
export function liveSitemapLines(capture) {
  const file = capture ? join(capture, 'robots.txt') : null;
  return file && existsSync(file) ? sitemapLines(readFileSync(file, 'utf8')) : [];
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
};

// Every "Sitemap:" line of dist/robots.txt is a URL on compareOrigin naming a file in dist, or a
// URL on another host (never the site's own, `ownOrigins`, www or not) that the live robots.txt
// carried verbatim (`live`, its Sitemap: URLs).
export function robotsSitemapFailures(dist, compareOrigin, live = [], ownOrigins = []) {
  const file = join(dist, 'robots.txt');
  if (!existsSync(file)) return { checked: 0, failures: [] };
  const lines = sitemapLines(readFileSync(file, 'utf8'));
  const carried = new Set(live);
  const ownHosts = new Set([compareOrigin, ...ownOrigins].map(hostOf).filter(Boolean));
  const failures = [];
  for (const url of lines) {
    const origin = originOf(url);
    const path = pathOf(url);
    const rel = path.replace(/^\/+/, '');
    if (origin !== compareOrigin && carried.has(url) && !ownHosts.has(hostOf(url))) continue;
    if (origin !== compareOrigin) failures.push({ path: '/robots.txt', field: 'sitemap line', expected: `${compareOrigin}${origin ? new URL(url).pathname : ''}`, actual: url });
    else if (!rel || !existsSync(join(dist, rel)) || !statSync(join(dist, rel)).isFile()) {
      failures.push({ path: '/robots.txt', field: 'sitemap line', expected: 'a file in dist', actual: url });
    }
  }
  return { checked: lines.length, failures };
}

// %e2 and %E2 are the same octet (RFC 3986 6.2.2.1), so URLs compare with upper-case escapes.
const upperEscapes = (url) => url?.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase()) ?? null;

export function checkSitemaps({ dist, capture, routes, compareOrigin, ownOrigins = [], sitemaps = [], paths = () => true }) {
  const pages = routes.filter((r) => r.status === 200 && PAGE_KINDS.has(r.kind) && !r.noindex && paths(r.path));
  const feeds = routes.filter((r) => r.status === 200 && r.kind === 'feed' && paths(r.path));
  const { roots, failures } = readSitemaps(dist, sitemaps);
  const expected = new Set(pages.map((r) => decode(r.path)));
  for (const { name, urls } of roots ?? []) {
    const field = roots.length > 1 ? `sitemap ${name}` : 'sitemap';
    const listed = new Map();
    for (const url of urls) if (!listed.has(pathOf(url))) listed.set(pathOf(url), url);
    for (const path of expected) {
      const want = `${compareOrigin}${new URL(path, compareOrigin).pathname}`;
      const got = listed.get(path) ?? null;
      if (upperEscapes(got) !== want) failures.push({ path, field, expected: want, actual: got });
    }
    for (const [path, url] of listed) {
      if (!expected.has(path) && paths(path)) failures.push({ path, field, expected: null, actual: url });
    }
  }
  const robots = paths('/robots.txt') ? robotsSitemapFailures(dist, compareOrigin, liveSitemapLines(capture), ownOrigins) : { checked: 0, failures: [] };
  failures.push(...robots.failures);
  for (const feed of feeds) {
    const candidates = feedFiles(feed.path);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path: feed.path, field: 'feed', expected: candidates[0], actual: null });
      continue;
    }
    const captured = feed.snapshot ? join(capture, feed.snapshot) : null;
    if (!captured || !existsSync(captured)) {
      failures.push({ path: feed.path, field: 'baseline', expected: feed.snapshot ?? 'a captured feed', actual: null });
      continue;
    }
    const want = itemCount(readFileSync(captured, 'utf8'));
    const got = itemCount(readFileSync(join(dist, file), 'utf8'));
    if (want !== got) failures.push({ path: feed.path, field: 'items', expected: want, actual: got });
  }
  return { checked: pages.length + feeds.length + robots.checked, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  if (args.origin && !originOf(args.origin)) {
    process.stderr.write(`${NAME}: --origin must be a URL such as https://www.example.com, got ${args.origin}\n`);
    process.exit(2);
  }
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'meta.json']);
  const routes = readJson(join(args.baseline, 'routes.json'));
  const meta = readJson(join(args.baseline, 'meta.json'));
  const compareOrigin = originOf(args.origin) ?? originOf(meta.canonicalOrigin ?? '') ?? originOf(meta.origin ?? '');
  if (!compareOrigin) {
    process.stderr.write(`${NAME}: ${join(args.baseline, 'meta.json')} has no canonicalOrigin or origin; rebuild the baseline\n`);
    process.exit(2);
  }
  const hasFeeds = routes.some((r) => r.status === 200 && r.kind === 'feed' && args.paths(r.path));
  if (hasFeeds && !(existsSync(args.capture) && statSync(args.capture).isDirectory())) {
    process.stderr.write(`${NAME}: not found: ${args.capture} (the capture, for its feeds; pass --capture)\n`);
    process.exit(2);
  }
  const sitemapsFile = join(args.baseline, 'sitemaps.json');
  const sitemaps = existsSync(sitemapsFile) ? readJson(sitemapsFile) : [];
  const ownOrigins = [meta.canonicalOrigin, meta.origin].map((o) => originOf(o ?? '')).filter(Boolean);
  const results = checkSitemaps({ dist: args.dist, capture: args.capture, routes, compareOrigin, ownOrigins, sitemaps, paths: args.paths });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
