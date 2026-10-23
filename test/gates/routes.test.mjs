import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';
// css-prune names the file; the gate must accept the same name.
import { variantPath } from '../../skills/convert-site/scripts/css-prune.mjs';

const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'routes-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const routes = (dist, args = []) => runGate('routes', ['--dist', dist, '--baseline', baseline, ...args], { cwd: root });

// 13 pages answering 200 plus the /feed/ feed; the brochure PDF is a file route for the media gate.
test('dist-good passes: every page and the feed is built, nothing extra', async () => {
  const result = await routes(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^routes: 14 checked, 0 failed$/m);
});

test('dist-bad fails and lists the missing and the extra page', async () => {
  const bad = makeDist(join(root, 'dist-bad'), { bad: ['missing-page', 'extra-page'] });
  const result = await routes(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/hidden-page\/ file: expected "hidden-page\/index\.html", got null/);
  assert.match(result.stdout, /\/extra-page\/ extra: expected null, got "extra-page\/index\.html"/);
  assert.match(result.stdout, /^routes: 14 checked, 2 failed$/m);
});

test('--allow-extra accepts a listed extra path', async () => {
  const extra = makeDist(join(root, 'dist-extra'), { bad: ['extra-page'] });
  assert.equal((await routes(extra)).code, 1);
  const allowed = await routes(extra, ['--allow-extra', '/extra-page/']);
  assert.equal(allowed.code, 0, allowed.stdout);
});

test('the launch icon set and web app manifest at the root are not extras; other root files are', async () => {
  const dist = makeDist(join(root, 'dist-icons'));
  for (const file of ['favicon.ico', 'favicon.svg', 'favicon-32x32.png', 'icon-192.png', 'apple-touch-icon.png', 'site.webmanifest', 'manifest.webmanifest']) {
    writeFileSync(join(dist, file), 'x');
  }
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  writeFileSync(join(dist, 'notes.txt'), 'x');
  mkdirSync(join(dist, 'icons'), { recursive: true });
  writeFileSync(join(dist, 'icons', 'favicon.ico'), 'x');
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/notes\.txt extra: expected null, got "notes\.txt"/);
  assert.match(failed.stdout, /\/icons\/favicon\.ico extra/);
});

test("the capture's same-origin scripts (baseline/js.json) may be built at their live paths; other scripts are extras", async () => {
  const dist = makeDist(join(root, 'dist-theme-js'));
  mkdirSync(join(dist, 'wp-content', 'themes', 'fixture', 'js'), { recursive: true });
  writeFileSync(join(dist, 'wp-content', 'themes', 'fixture', 'js', 'reveal.js'), 'x');
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  writeFileSync(join(dist, 'wp-content', 'themes', 'fixture', 'js', 'other.js'), 'x');
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/wp-content\/themes\/fixture\/js\/other\.js extra/);
  assert.doesNotMatch(failed.stdout, /reveal\.js/);
});

test("the capture's same-origin stylesheets (baseline/css.json) may be built at their live paths; other stylesheets are extras", async () => {
  const dist = makeDist(join(root, 'dist-theme-css'));
  mkdirSync(join(dist, 'wp-content', 'themes', 'fixture'), { recursive: true });
  writeFileSync(join(dist, 'wp-content', 'themes', 'fixture', 'style.css'), 'x');
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  writeFileSync(join(dist, 'wp-content', 'themes', 'fixture', 'other.css'), 'x');
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/wp-content\/themes\/fixture\/other\.css extra/);
  assert.doesNotMatch(failed.stdout, /style\.css/);
});

test("a captured sheet served at css-prune's query-named path (a second sheet with the same pathname) is not an extra", async () => {
  const sheet = readJson(baseline, 'css.json').find((s) => new URL(s.href).search);
  const { pathname, search } = new URL(sheet.href);
  const dist = makeDist(join(root, 'dist-theme-css-variant'));
  const file = join(dist, ...variantPath(pathname, search).split('/').filter(Boolean));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'x');
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
});

test("sitemaps at the live site's root names (sitemap_index.xml, page-sitemap.xml) are not extras", async () => {
  const dist = makeDist(join(root, 'dist-wp-sitemaps'));
  for (const file of ['sitemap_index.xml', 'page-sitemap.xml', 'post-sitemap.xml', 'category-sitemap.xml']) writeFileSync(join(dist, file), '<x/>');
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  mkdirSync(join(dist, 'old'), { recursive: true });
  writeFileSync(join(dist, 'old', 'page-sitemap.xml'), '<x/>');
  writeFileSync(join(dist, 'old-sitemap.xml'), '<x/>');
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/old\/page-sitemap\.xml extra/);
  assert.match(failed.stdout, /\/old-sitemap\.xml extra/, 'a sitemap name the live site never had is an extra');
  assert.match(failed.stdout, /^routes: \d+ checked, 2 failed$/m);
});

test("a live site with no sitemap: Astro's sitemap-index.xml and sitemap-0.xml are not extras, a robots-named wp-sitemap.xml live never served is", async () => {
  const bare = join(root, 'baseline-no-sitemap');
  cpSync(baseline, bare, { recursive: true });
  writeFileSync(join(bare, 'sitemaps.json'), '[]\n');
  const dist = makeDist(join(root, 'dist-astro-sitemap'));
  for (const file of ['sitemap-index.xml', 'sitemap-0.xml']) writeFileSync(join(dist, file), '<x/>');
  const passed = await runGate('routes', ['--dist', dist, '--baseline', bare], { cwd: root });
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  writeFileSync(join(dist, 'wp-sitemap.xml'), '<x/>');
  const failed = await runGate('routes', ['--dist', dist, '--baseline', bare], { cwd: root });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/wp-sitemap\.xml extra/);
});

test('a noindex route that lost its robots meta fails', async () => {
  const dist = makeDist(join(root, 'dist-noindex'), { bad: ['lost-noindex'] });
  const result = await routes(dist);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/private-page\/ robots: expected "noindex", got null/);
});

test('a build.format "file" build is read as <path>.html', async () => {
  const dist = makeDist(join(root, 'dist-file'), { bad: ['file-format'] });
  const result = await routes(dist);
  assert.equal(result.code, 0, result.stdout);
  const missing = makeDist(join(root, 'dist-file-missing'), { bad: ['file-format'] });
  rmSync(join(missing, 'about.html'));
  const failed = await routes(missing);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/about\/ file: expected "about\.html", got null/);
});

test('in a file layout, extras are named by their served path for --allow-extra and --paths', async () => {
  const dist = makeDist(join(root, 'dist-file-extra'), { bad: ['extra-page', 'file-format'] });
  mkdirSync(join(dist, 'extra-feed'));
  writeFileSync(join(dist, 'extra-feed', 'index.xml'), '<rss></rss>');
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\/extra-page\/ extra: expected null, got "extra-page\.html"/);
  assert.match(failed.stdout, /\/extra-feed\/ extra: expected null, got "extra-feed\/index\.xml"/);
  const allowed = await routes(dist, ['--allow-extra', '/extra-page/,/extra-feed/']);
  assert.equal(allowed.code, 0, allowed.stdout);
  const limited = await routes(dist, ['--paths', '/about/']);
  assert.equal(limited.code, 0, limited.stdout);
});

test('a mixed ("preserve") layout passes; only the page that is really missing fails', async () => {
  const dist = makeDist(join(root, 'dist-preserve'));
  renameSync(join(dist, 'about', 'index.html'), join(dist, 'about.html'));
  const passed = await routes(dist);
  assert.equal(passed.code, 0, passed.stdout);
  rmSync(join(dist, 'contact', 'index.html'));
  const failed = await routes(dist);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^routes: 14 checked, 1 failed$/m);
  assert.match(failed.stdout, /\/contact\/ file: expected "contact\/index\.html", got null/);
});

test('a page at a baseline redirect source is not an extra', async () => {
  const dist = makeDist(join(root, 'dist-redirect-page'));
  mkdirSync(join(dist, 'old-services'));
  writeFileSync(join(dist, 'old-services', 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0;url=/services/">');
  const result = await routes(dist);
  assert.equal(result.code, 0, result.stdout);
});

// A copy of the baseline whose routes.json also holds the given rows.
function baselineWith(name, rows) {
  const dir = join(root, name);
  cpSync(baseline, dir, { recursive: true });
  const list = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
  const route = (path, status) => ({ path, status, kind: 'other', template: 'other', noindex: false, snapshot: null, foundBy: ['crawl'] });
  writeFileSync(join(dir, 'routes.json'), JSON.stringify([...list, ...rows.map(([path, status]) => route(path, status))]));
  return dir;
}
const record = (fields) => ({ field: 'routes', reason: 'test', approvedBy: 'client', date: '2026-10-22', ...fields });
const UNCAPTURED = [['/down/', 503], ['/dead/', 0], ['/moved/', 301], ['/gone/', 410], ['/missing/', 404]];

test('a route captured at a status other than 200, 3xx, 404 or 410 fails as not captured', async () => {
  const dir = baselineWith('baseline-uncaptured', UNCAPTURED);
  const result = await runGate('routes', ['--dist', good, '--baseline', dir], { cwd: root });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/down\/ status: expected "200, 3xx, 404 or 410", got "not captured: 503"$/m);
  assert.match(result.stdout, /^ {2}\/dead\/ status: expected "200, 3xx, 404 or 410", got "not captured: 0"$/m);
  assert.doesNotMatch(result.stdout, /\/(moved|gone|missing)\//);
  assert.match(result.stdout, /^ {2}2 routes not captured \(status other than 200, 3xx, 404 or 410\): 2 failed, 0 skipped, 0 replaced$/m);
  assert.match(result.stdout, /^routes: 16 checked, 2 failed$/m);
});

test('a routes exception skips an uncaptured route or names its built replacement; a stale one fails', async () => {
  const dir = baselineWith('baseline-uncaptured-ok', UNCAPTURED);
  const gate = (exceptions) => {
    const file = join(root, `routes-exceptions-${exceptions.length}-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify(exceptions));
    return runGate('routes', ['--dist', good, '--baseline', dir, '--exceptions', file], { cwd: root });
  };
  const passed = await gate([record({ path: '/down/', from: '503', to: 'skip' }), record({ path: '/dead/', from: '0', to: '/about/' })]);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /^ {2}\/down\/ skipped: not captured: 503 \(exception: skip\)$/m);
  assert.match(passed.stdout, /^ {2}2 routes not captured \(status other than 200, 3xx, 404 or 410\): 0 failed, 1 skipped, 1 replaced$/m);
  assert.match(passed.stdout, /^routes: 16 checked, 0 failed, 1 skipped \(not captured, exception skip\)$/m);

  const unbuilt = await gate([record({ path: '/down/', from: '503', to: 'skip' }), record({ path: '/dead/', from: '0', to: '/nowhere/' })]);
  assert.equal(unbuilt.code, 1);
  assert.match(unbuilt.stdout, /^ {2}\/dead\/ file: expected "nowhere\/index\.html", got null$/m);

  const stale = await gate([
    record({ path: '/down/', from: '503', to: 'skip' }),
    record({ path: '/dead/', from: '0', to: 'skip' }),
    record({ path: '/about/', from: '503', to: 'skip' }),
    record({ path: '/down/', from: '500', to: 'skip' }),
  ]);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /^ {2}\/about\/ exception: .*"no longer matches the baseline"$/m);
  assert.match(stale.stdout, /^ {2}\/down\/ exception: expected \{"field":"routes","from":"500","to":"skip"\}.*"no longer matches the baseline"$/m);
});

test('--paths limits the check', async () => {
  const bad = makeDist(join(root, 'dist-bad-paths'), { bad: ['missing-page'] });
  const result = await routes(bad, ['--paths', '/about/,/services/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /routes: 4 checked, 0 failed/);
});

test('--json prints the gate summary', async () => {
  const bad = makeDist(join(root, 'dist-bad-json'), { bad: ['extra-page'] });
  const result = await routes(bad, ['--json']);
  assert.equal(result.code, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.gate, 'routes');
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].path, '/extra-page/');
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await routes(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('routes', ['--dist', join(root, 'nope'), '--baseline', baseline], { cwd: root })).code, 2);
  assert.equal((await runGate('routes', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('routes', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--allow-extra/);
});
