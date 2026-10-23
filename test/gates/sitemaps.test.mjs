import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';
import { checkSitemaps } from '../../skills/parity-gates/scripts/verify/sitemaps.mjs';

let root;
let baseline;
let capture;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'sitemaps-gate-'));
  baseline = await buildFixtureBaseline(root);
  capture = join(root, 'capture');
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const sitemaps = (dist, args = [], origin = ['--origin', DIST_ORIGIN]) =>
  runGate('sitemaps', ['--dist', dist, '--baseline', baseline, '--capture', capture, ...origin, ...args], { cwd: root });

// 12 indexable pages (13 at 200 less the noindex /private-page/), the /feed/ feed and the one
// robots.txt Sitemap: line.
test('dist-good passes: the sitemap lists exactly the indexable routes and the feed matches', async () => {
  const result = await sitemaps(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sitemaps: 14 checked, 0 failed$/m);
});

test('a sitemap URL on another origin fails', async () => {
  const result = await sitemaps(good, ['--paths', '/about/'], []);
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`/about/ sitemap: expected "[^"]+/about/", got "${DIST_ORIGIN}/about/"`));
});

test('a page left out of the sitemap fails; an extra one fails', async () => {
  const dist = makeDist(join(root, 'dist-sitemap'), { bad: ['sitemap-missing-page'] });
  edit(dist, 'sitemap-0.xml', '</urlset>', `<url><loc>${DIST_ORIGIN}/private-page/</loc></url></urlset>`);
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ sitemap: expected "https:\/\/www\.example\.com\/about\/", got null$/m);
  assert.match(result.stdout, /^ {2}\/private-page\/ sitemap: expected null, got "https:\/\/www\.example\.com\/private-page\/"$/m);
  assert.match(result.stdout, /^sitemaps: 14 checked, 2 failed$/m);
});

test('a single sitemap.xml is read when there is no sitemap index', async () => {
  const dist = makeDist(join(root, 'dist-single'));
  rmSync(join(dist, 'sitemap-index.xml'));
  renameSync(join(dist, 'sitemap-0.xml'), join(dist, 'sitemap.xml'));
  edit(dist, 'robots.txt', 'sitemap-index.xml', 'sitemap.xml');
  const result = await sitemaps(dist);
  assert.equal(result.code, 0, result.stdout);
  rmSync(join(dist, 'sitemap.xml'));
  const none = await sitemaps(dist);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /\/ sitemap: expected "sitemap-index\.xml", got null/);
});

test("WordPress's sitemap_index.xml, kept at its live URL, is read as the sitemap index", async () => {
  const dist = makeDist(join(root, 'dist-wp-index'));
  renameSync(join(dist, 'sitemap-index.xml'), join(dist, 'sitemap_index.xml'));
  edit(dist, 'robots.txt', 'sitemap-index.xml', 'sitemap_index.xml');
  const result = await sitemaps(dist);
  assert.equal(result.code, 0, result.stdout);
});

// A baseline whose sitemaps.json records WordPress core's sitemap names.
function wpBaseline() {
  const copy = join(root, 'baseline-wp-core');
  cpSync(baseline, copy, { recursive: true });
  writeFileSync(join(copy, 'sitemaps.json'), JSON.stringify(['wp-sitemap-posts-page-1.xml', 'wp-sitemap.xml']));
  return copy;
}
// dist with WordPress core's wp-sitemap.xml index and one child holding Astro's sitemap-0.xml URLs.
function wpCoreDist(name) {
  const dist = makeDist(join(root, name));
  writeFileSync(join(dist, 'wp-sitemap-posts-page-1.xml'), readFileSync(join(dist, 'sitemap-0.xml')));
  writeFileSync(
    join(dist, 'wp-sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${DIST_ORIGIN}/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>\n`,
  );
  return dist;
}

test("a live sitemap name from baseline/sitemaps.json (WordPress core's wp-sitemap.xml) is read as an index", async () => {
  const dist = wpCoreDist('dist-wp-core');
  rmSync(join(dist, 'sitemap-index.xml'));
  rmSync(join(dist, 'sitemap-0.xml'));
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${DIST_ORIGIN}/wp-sitemap.xml\n`);
  const base = ['--dist', dist, '--capture', capture, '--origin', DIST_ORIGIN];
  const result = await runGate('sitemaps', [...base, '--baseline', wpBaseline()], { cwd: root });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sitemaps: 14 checked, 0 failed$/m, '12 pages, the feed and the robots.txt line');
  const unknown = await runGate('sitemaps', [...base, '--baseline', baseline], { cwd: root });
  assert.equal(unknown.code, 1, 'a name the live site did not have is not read');
  assert.match(unknown.stdout, /\/ sitemap: expected "sitemap-index\.xml", got null/);
});

test('every top sitemap in dist must list every page: one that misses a page fails, named', async () => {
  const dist = wpCoreDist('dist-two-tops');
  edit(dist, 'wp-sitemap-posts-page-1.xml', `<url><loc>${DIST_ORIGIN}/about/</loc></url>`, '');
  const result = await runGate('sitemaps', ['--dist', dist, '--capture', capture, '--origin', DIST_ORIGIN, '--baseline', wpBaseline()], { cwd: root });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/about\/ sitemap wp-sitemap\.xml: expected "https:\/\/www\.example\.com\/about\/", got null$/m);
  assert.doesNotMatch(result.stdout, /sitemap sitemap-index\.xml/);
});

test('a Sitemap: line on another host passes only when the live robots.txt carried it verbatim', async () => {
  const dist = makeDist(join(root, 'dist-robots-other-host'));
  const own = `User-agent: *\nSitemap: ${DIST_ORIGIN}/sitemap-index.xml\n`;
  // The fixture's live robots.txt names its sister site's sitemap (capture/robots.txt).
  assert.match(readFileSync(join(capture, 'robots.txt'), 'utf8'), /^Sitemap: http:\/\/other\.example\.com\/sitemap_index\.xml$/m);
  writeFileSync(join(dist, 'robots.txt'), `${own}Sitemap: http://other.example.com/sitemap_index.xml\n`);
  const carried = await sitemaps(dist);
  assert.equal(carried.code, 0, carried.stdout);
  assert.match(carried.stdout, /^sitemaps: 15 checked, 0 failed$/m);

  writeFileSync(join(dist, 'robots.txt'), `${own}Sitemap: http://other.example.com/staging-sitemap.xml\n`);
  const notLive = await sitemaps(dist);
  assert.equal(notLive.code, 1);
  assert.match(notLive.stdout, /^ {2}\/robots\.txt sitemap line: expected "https:\/\/www\.example\.com\/staging-sitemap\.xml", got "http:\/\/other\.example\.com\/staging-sitemap\.xml"$/m);
  assert.match(notLive.stdout, /^sitemaps: 15 checked, 1 failed$/m);

  const noRobots = join(root, 'capture-no-robots');
  cpSync(capture, noRobots, { recursive: true });
  rmSync(join(noRobots, 'robots.txt'));
  writeFileSync(join(dist, 'robots.txt'), `${own}Sitemap: http://other.example.com/sitemap_index.xml\n`);
  const unknown = await runGate('sitemaps', ['--dist', dist, '--baseline', baseline, '--capture', noRobots, '--origin', DIST_ORIGIN], { cwd: root });
  assert.equal(unknown.code, 1, 'without the captured robots.txt the line is not known to be live');
});

test('a carried Sitemap: line on the site\'s own host is never skipped: with --origin staging it still fails', async () => {
  const dist = makeDist(join(root, 'dist-robots-own-host'));
  const live = readFileSync(join(capture, 'robots.txt'), 'utf8');
  const ownLine = [...live.matchAll(/^Sitemap:\s*(\S+)$/gm)].map((m) => m[1]).find((u) => !u.includes('other.example.com'));
  assert.ok(ownLine, 'the fixture robots.txt names its own sitemap');
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nSitemap: ${ownLine}\n`);
  const result = await runGate('sitemaps', ['--dist', dist, '--baseline', baseline, '--capture', capture, '--origin', 'https://staging.example.com'], { cwd: root });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /\/robots\.txt sitemap line: expected "https:\/\/staging\.example\.com\//);
});

test('a robots.txt Sitemap: line must point at a file in dist', async () => {
  const dist = makeDist(join(root, 'dist-robots'));
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nSitemap: ${DIST_ORIGIN}/sitemap-index.xml\nSitemap: ${DIST_ORIGIN}/sitemap_index.xml\n`);
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/robots\.txt sitemap line: expected "a file in dist", got "https:\/\/www\.example\.com\/sitemap_index\.xml"$/m);
  assert.match(result.stdout, /^sitemaps: 15 checked, 1 failed$/m);
  writeFileSync(join(dist, 'robots.txt'), 'User-agent: *\nSitemap: https://other.example.org/sitemap-index.xml\n');
  const foreign = await sitemaps(dist);
  assert.equal(foreign.code, 1);
  assert.match(foreign.stdout, /^ {2}\/robots\.txt sitemap line: expected "https:\/\/www\.example\.com\/sitemap-index\.xml", got "https:\/\/other\.example\.org\/sitemap-index\.xml"$/m);
});

test('a sitemap index pointing at a missing child sitemap fails', async () => {
  const dist = makeDist(join(root, 'dist-no-child'));
  rmSync(join(dist, 'sitemap-0.xml'));
  const result = await sitemaps(dist, ['--paths', '/about/']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/sitemap-0\.xml sitemap: expected "sitemap-0\.xml", got null/);
});

test('a missing feed fails', async () => {
  const dist = makeDist(join(root, 'dist-no-feed'), { bad: ['missing-feed'] });
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/feed\/ feed: expected "feed\/index\.xml", got null$/m);
});

test('a feed with fewer items than the captured feed fails', async () => {
  const dist = makeDist(join(root, 'dist-feed-item'), { bad: ['dropped-feed-item'] });
  const result = await sitemaps(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/feed\/ items: expected 3, got 2$/m);
});

test('--paths limits the check', async () => {
  const dist = makeDist(join(root, 'dist-paths'), { bad: ['missing-feed'] });
  const result = await sitemaps(dist, ['--paths', '/services/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^sitemaps: 3 checked, 0 failed$/m);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await sitemaps(good, ['--bogus'])).code, 2);
  assert.equal((await sitemaps(good, ['--capture', join(root, 'nope')])).code, 2);
  assert.equal((await sitemaps(good, [], ['--origin', 'not a url'])).code, 2);
  assert.equal((await runGate('sitemaps', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('sitemaps', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--capture/);
});

test('a sitemap URL with lower-case percent escapes matches the page (RFC 3986: %c3 is %C3)', () => {
  const dist = mkdtempSync(join(root, 'dist-escapes-'));
  const origin = 'https://www.example.com';
  writeFileSync(join(dist, 'sitemap.xml'), `<urlset><url><loc>${origin}/caf%c3%a9/</loc></url></urlset>`);
  const routes = [{ path: '/caf%C3%A9/', status: 200, kind: 'page' }];
  assert.deepEqual(checkSitemaps({ dist, capture, routes, compareOrigin: origin }).failures, []);
  writeFileSync(join(dist, 'sitemap.xml'), `<urlset><url><loc>${origin}/cafe/</loc></url></urlset>`);
  assert.equal(checkSitemaps({ dist, capture, routes, compareOrigin: origin }).failures.length, 2, 'another URL still fails');
});
