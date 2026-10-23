import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';

const HERO = '/wp-content/uploads/2026/01/hero.jpg';

let root;
let baseline;
let good;
let media;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'media-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
  media = JSON.parse(readFileSync(join(baseline, 'media.json'), 'utf8'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const FONT = '/wp-content/themes/fixture/fonts/';
const UPLOADS = '/wp-content/uploads/';
const gate = (dist, args = [], cwd = root, indexable = '') =>
  runGate('media', ['--dist', dist, '--baseline', baseline, ...args], { cwd, env: { PUBLIC_INDEXABLE: indexable } });

const record = (fields) => ({ reason: 'test', approvedBy: 'client', date: '2026-10-22', ...fields });
function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return file;
}

// A site root with docs/media-plan.json saying `mode` (and `prefix` when given).
function siteWithPlan(name, mode, prefix) {
  const dir = join(root, name);
  writeJson(join(dir, 'docs', 'media-plan.json'), { mode, totals: { count: media.length }, ...(prefix ? { prefix } : {}) });
  return dir;
}

test('dist-good passes: every baseline media file is built with the same bytes', async () => {
  const result = await gate(good);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^media: ${media.length} checked, 0 failed$`, 'm'));
});

test('a 1-byte drift fails with both sizes', async () => {
  const bad = makeDist(join(root, 'dist-drift'), { bad: ['media-drift'] });
  const result = await gate(bad);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/wp-content\/uploads\/2026\/01\/hero\.jpg media: expected 13713, got 13714$/m);
  assert.match(result.stdout, /^media: \d+ checked, 1 failed$/m);
});

test('dist is authoritative; public/ is read only when there is no dist', async () => {
  const dist = makeDist(join(root, 'dist-missing'));
  const site = join(root, 'site-public');
  cpSync(dist, join(site, 'public'), { recursive: true });
  rmSync(join(dist, HERO));
  const failed = await gate(dist, [], site);
  assert.equal(failed.code, 1, 'a file only in public/ does not count once dist exists');
  assert.match(failed.stdout, /hero\.jpg media: expected 13713, got null/);
  const passed = await gate(join(site, 'no-dist'), [], site);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.equal((await gate(join(site, 'no-dist'), ['--public', 'nope'], site)).code, 2);
});

test('a media exception records the new size; a stale one fails', async () => {
  const bad = makeDist(join(root, 'dist-drift-exception'), { bad: ['media-drift'] });
  const exceptions = writeJson(join(root, 'media-exceptions.json'), [record({ path: HERO, field: 'media', from: 13713, to: 13714 })]);
  const passed = await gate(bad, ['--exceptions', exceptions]);
  assert.equal(passed.code, 0, passed.stdout);
  const stale = writeJson(join(root, 'media-stale.json'), [record({ path: HERO, field: 'media', from: 999, to: 13714 })]);
  const failed = await gate(good, ['--exceptions', stale]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /hero\.jpg exception: .*"no longer matches the baseline"/);
});

test('store mode reads media-manifest.json instead of dist', async () => {
  const site = siteWithPlan('site-store', 'store');
  const manifest = media.map(({ path, bytes }) => ({ path, bytes, url: `https://cdn.example.com${path}`, etag: 'x' }));
  writeJson(join(site, 'media-manifest.json'), manifest);
  const empty = join(root, 'dist-empty');
  mkdirSync(empty, { recursive: true });
  const passed = await gate(empty, [], site);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);

  writeJson(join(site, 'short-manifest.json'), manifest.filter((m) => m.path !== HERO).concat({ ...manifest[0], path: HERO, bytes: 1 }));
  const failed = await gate(empty, ['--media-manifest', 'short-manifest.json'], site);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /hero\.jpg media: expected 13713, got 1/);

  assert.equal((await gate(empty, ['--media-manifest', 'none.json'], site)).code, 2);
});

test('live-temporary mode checks nothing, says so, and counts every file as skipped', async () => {
  const site = siteWithPlan('site-live', 'live-temporary');
  const result = await gate(good, [], site);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, new RegExp(`^media: 0 checked, 0 failed, ${media.length} skipped \\(served from live\\)$`, 'm'));
  const json = JSON.parse((await gate(good, ['--json'], site)).stdout);
  assert.equal(json.checked, 0);
  assert.equal(json.skipped, media.length);
  assert.equal(json.failed, 0);
});

test('repo mode checks every file in dist, whatever PUBLIC_INDEXABLE says', async () => {
  const site = siteWithPlan('site-repo', 'repo', UPLOADS);
  for (const indexable of ['', 'true']) {
    const result = await gate(good, [], site, indexable);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^media: ${media.length} checked, 0 failed$`, 'm'));
  }
});

test('store mode: the manifest covers the prefix, dist covers the files outside it', async () => {
  const site = siteWithPlan('site-store-prefix', 'store', UPLOADS);
  const inside = media.filter((m) => m.path.startsWith(UPLOADS));
  const outside = media.filter((m) => !m.path.startsWith(UPLOADS));
  assert.ok(inside.length > 0 && outside.length > 0, 'the fixture has media on both sides of the prefix');
  writeJson(join(site, 'media-manifest.json'), inside.map(({ path, bytes }) => ({ path, bytes, url: path })));
  for (const indexable of ['', 'true']) {
    const passed = await gate(good, [], site, indexable);
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, new RegExp(`^media: ${media.length} checked, 0 failed$`, 'm'));
  }
  const noFonts = makeDist(join(root, 'dist-store-no-font'));
  rmSync(join(noFonts, outside[0].path.slice(1)));
  const failed = await gate(noFonts, [], site);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, new RegExp(`^ {2}${outside[0].path} media: expected ${outside[0].bytes}, got null$`, 'm'));
  assert.match(failed.stdout, /^media: \d+ checked, 1 failed$/m);
  // The manifest is not read for a path outside the prefix, even when it lists one.
  writeJson(join(site, 'all-manifest.json'), media.map(({ path, bytes }) => ({ path, bytes, url: path })));
  assert.equal((await gate(noFonts, ['--media-manifest', 'all-manifest.json'], site)).code, 1);
});

test('live-temporary mode: the prefix is skipped (served from live), files outside it are checked in dist', async () => {
  const site = siteWithPlan('site-live-prefix', 'live-temporary', UPLOADS);
  const outside = media.filter((m) => !m.path.startsWith(UPLOADS));
  const passed = await gate(good, [], site);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, new RegExp(`^media: ${outside.length} checked, 0 failed, ${media.length - outside.length} skipped \\(served from live\\)$`, 'm'));
  const noFonts = makeDist(join(root, 'dist-live-no-font'));
  rmSync(join(noFonts, outside[0].path.slice(1)));
  const failed = await gate(noFonts, [], site);
  assert.equal(failed.code, 1);
  assert.ok(outside[0].path.startsWith(FONT));
  assert.match(failed.stdout, new RegExp(`^ {2}${outside[0].path} media: expected ${outside[0].bytes}, got null$`, 'm'));
});

test('live-temporary mode fails every file on a release build (PUBLIC_INDEXABLE=true)', async () => {
  for (const [name, prefix] of [['site-live-release', UPLOADS], ['site-live-release-all', undefined]]) {
    const site = siteWithPlan(name, 'live-temporary', prefix);
    const result = await gate(good, [], site, 'true');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`^ {2}${media[0].path} media: expected "served by the build", got "release build may not serve media from the live site"$`, 'm'));
    assert.match(result.stdout, new RegExp(`^media: ${media.length} checked, ${media.length} failed$`, 'm'));
  }
});

test('--paths limits the check', async () => {
  const bad = makeDist(join(root, 'dist-drift-paths'), { bad: ['media-drift'] });
  const result = await gate(bad, ['--paths', '/wp-content/themes/*']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^media: 2 checked, 0 failed$/m);
});

test('--paths with page paths checks the media those pages reference', async () => {
  const onHome = media.filter((m) => (m.referencedBy ?? []).includes('/'));
  assert.ok(onHome.some((m) => m.path === HERO), 'the home page references the hero image');
  const ok = await gate(good, ['--paths', '/']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, new RegExp(`^media: ${onHome.length} checked, 0 failed$`, 'm'));
  const bad = makeDist(join(root, 'dist-drift-pages'), { bad: ['media-drift'] });
  const result = await gate(bad, ['--paths', '/,/about/']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /hero\.jpg media: expected 13713, got 13714/);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await gate(good, ['--bogus'])).code, 2);
  assert.equal((await gate(good, ['--media-plan', 'missing-plan.json'])).code, 2);
  assert.equal((await gate(good, [], siteWithPlan('site-unknown', 'cloud'))).code, 2);
  assert.equal((await runGate('media', ['--dist', good, '--baseline', join(root, 'nope')], { cwd: root })).code, 2);
  const help = await runGate('media', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--media-plan/);
  assert.match(help.stdout, /--media-manifest/);
});

test('a file with downloaded: false (an unreferenced size) is skipped and counted, never a failure', async () => {
  const listed = join(root, 'baseline-listed');
  cpSync(baseline, listed, { recursive: true });
  const extra = { path: `${UPLOADS}2026/01/hero-150x150.jpg`, bytes: null, contentType: null, referencedBy: [], downloaded: false, reason: 'unreferenced size' };
  writeFileSync(join(listed, 'media.json'), JSON.stringify([...media, extra]));
  const run = (args = []) => runGate('media', ['--dist', good, '--baseline', listed, ...args], { cwd: root, env: { PUBLIC_INDEXABLE: '' } });
  const result = await run();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}skipped: 1 unreferenced size \(listed in media\.json, not downloaded\)$/m);
  assert.match(result.stdout, new RegExp(`^media: ${media.length} checked, 0 failed, 1 skipped \\(unreferenced size\\)$`, 'm'));
  const plain = await gate(good);
  assert.doesNotMatch(plain.stdout, /unreferenced/);
  const json = JSON.parse((await run(['--json'])).stdout);
  assert.equal(json.skipped, 1);
  assert.equal(json.failed, 0);
});
