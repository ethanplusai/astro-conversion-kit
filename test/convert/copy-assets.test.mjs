import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';

const SKILLS = resolve(import.meta.dirname, '../../skills');
const COPY = join(SKILLS, 'convert-site', 'scripts', 'copy-assets.mjs');

function run(script, args) {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const files = (dir) => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => relative(dir, join(d.parentPath, d.name))).sort()
  : []);

const CONCAT_SRC = '/_static/??/wp-content/themes/fixture/js/util.js,/wp-content/themes/fixture/js/reveal.js?m=1';
const OFF_SITE_FONT = 'https://fonts.example.com/s/display/v1/display-regular.woff2';
let root;
let origin;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'copy-assets-test-'));
  const capture = join(root, 'capture');
  const fixture = await startFixture();
  origin = fixture.origin;
  try {
    for (const [name, args] of [
      ['capture.mjs', [fixture.origin, '--out', capture, '--delay', '0', '--no-wayback']],
      ['assets.mjs', ['--capture', capture, '--delay', '0']],
      ['media.mjs', ['--capture', capture, '--delay', '0', '--download', join(root, 'cache')]],
    ]) {
      const result = await run(join(SKILLS, 'capture-site', 'scripts', name), args);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    }
  } finally {
    await fixture.close();
  }
  // A WordPress VIP concatenation and a font from a font service, as a larger site has them.
  const manifestFile = join(capture, 'js', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeFileSync(join(capture, 'js', 'concat-test.js'), 'console.log("concat");\n');
  manifest.push({ file: 'concat-test.js', src: `${origin}${CONCAT_SRC}`, kind: 'script', pages: ['/'] });
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const indexFile = join(capture, 'assets', 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  writeFileSync(join(capture, 'assets', 'fonts', 'display-regular.woff2'), 'font');
  index.push({ kind: 'font', url: OFF_SITE_FONT, file: 'assets/fonts/display-regular.woff2', status: 200, note: null });
  writeFileSync(indexFile, JSON.stringify(index));
});
after(() => rmSync(root, { recursive: true, force: true }));

// A fresh site folder holding the capture, the media download and a media plan.
function site(name, plan) {
  const dir = join(root, name);
  cpSync(join(root, 'capture'), join(dir, 'capture'), { recursive: true });
  cpSync(join(root, 'cache'), join(dir, '.conversion', 'media-cache'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'media-plan.json'), JSON.stringify(plan));
  return dir;
}
const copy = (dir, extra = []) => run(COPY, ['--capture', join(dir, 'capture'), '--site', dir, ...extra]);

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run(COPY, ['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node copy-assets\.mjs/);
});

test('copies scripts, fonts, root icons and the media outside the prefix to public/ at their live paths', async () => {
  const dir = site('store', { mode: 'store', prefix: '/wp-content/uploads/' });
  const result = await copy(dir);
  assert.equal(result.code, 0, result.stderr);
  const pub = join(dir, 'public');
  const capture = join(dir, 'capture');
  for (const entry of JSON.parse(readFileSync(join(capture, 'js', 'manifest.json'), 'utf8')).filter((e) => e.file && !e.src.includes('??'))) {
    const target = join(pub, decodeURIComponent(new URL(entry.src).pathname));
    assert.ok(readFileSync(target).equals(readFileSync(join(capture, 'js', entry.file))), entry.src);
  }
  assert.ok(existsSync(join(pub, 'wp-content/themes/fixture/js/view.js')), 'the module script');
  assert.ok(existsSync(join(pub, 'wp-content/themes/fixture/js/reveal.js')), 'the classic script');
  for (const font of ['fixture-sans.woff2', 'fixture-serif.woff2']) {
    assert.ok(existsSync(join(pub, 'wp-content/themes/fixture/fonts', font)), font);
  }
  assert.equal(readFileSync(join(pub, 'fonts', 'display-regular.woff2'), 'utf8'), 'font', 'a font service font goes under /fonts/');
  assert.ok(readFileSync(join(pub, 'favicon.ico')).equals(readFileSync(join(capture, 'assets', 'root-favicon.ico'))), 'the root favicon');
  // Nothing under the media prefix: the store or the rewrite serves it.
  assert.deepEqual(files(join(pub, 'wp-content', 'uploads')), []);
  // The concatenation is one file at /_static/concat/<sha1>.js, listed in the manifest.
  const hash = createHash('sha1').update(CONCAT_SRC).digest('hex');
  assert.equal(readFileSync(join(pub, '_static', 'concat', `${hash}.js`), 'utf8'), 'console.log("concat");\n');
  assert.deepEqual(JSON.parse(readFileSync(join(pub, '_static', 'concat', 'manifest.json'), 'utf8')), { [CONCAT_SRC]: `/_static/concat/${hash}.js` });
  assert.match(result.stdout, /scripts: \d+ \(1 concatenated\)/);
  assert.match(result.stdout, /fonts: 3/);
  assert.match(result.stdout, /root icons: 1/);
  assert.match(result.stdout, /media outside \/wp-content\/uploads\/: \d+/);

  const before = files(pub).map((f) => [f, readFileSync(join(pub, f)).toString('base64')]);
  const again = await copy(dir);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, result.stdout, 'the same counts on a second run');
  assert.deepEqual(files(pub).map((f) => [f, readFileSync(join(pub, f)).toString('base64')]), before, 'idempotent');
});

test('mode repo copies every downloaded media file, the prefix included', async () => {
  const dir = site('repo', { mode: 'repo', prefix: '/wp-content/uploads/' });
  const result = await copy(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(files(join(dir, 'public', 'wp-content', 'uploads')), files(join(dir, '.conversion', 'media-cache', 'wp-content', 'uploads')));
  assert.ok(files(join(dir, 'public', 'wp-content', 'uploads')).length > 10);
  assert.match(result.stdout, /media \(repo mode, every file\): \d+/);
});

test('a listed file missing from the capture exits 1 and names it; the rest is still copied', async () => {
  const dir = site('missing', { mode: 'store', prefix: '/wp-content/uploads/' });
  const manifest = JSON.parse(readFileSync(join(dir, 'capture', 'js', 'manifest.json'), 'utf8'));
  const reveal = manifest.find((e) => e.src.includes('reveal.js') && !e.src.includes('??'));
  rmSync(join(dir, 'capture', 'js', reveal.file));
  const result = await copy(dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`missing: .*js/${reveal.file.replace('.', '\\.')}`));
  assert.ok(existsSync(join(dir, 'public', 'wp-content/themes/fixture/js/view.js')));
});

test('media on disk without a media plan is a usage error', async () => {
  const dir = site('noplan', { mode: 'store', prefix: '/wp-content/uploads/' });
  rmSync(join(dir, 'docs', 'media-plan.json'));
  const result = await copy(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /media plan/);
});

test('a file the capture names outside the capture folder is refused with exit 1', async () => {
  const dir = site('traversal', { mode: 'store', prefix: '/wp-content/uploads/' });
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  const file = join(dir, 'capture', 'js', 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.push({ file: '../../.env', src: `${origin}/wp-content/themes/fixture/js/env.js`, kind: 'script', pages: ['/'] });
  writeFileSync(file, JSON.stringify(manifest));
  const result = await copy(dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refused: script .*env\.js: .*\.env: outside /);
  assert.ok(!existsSync(join(dir, 'public', 'wp-content/themes/fixture/js/env.js')), 'nothing written for it');
  assert.ok(existsSync(join(dir, 'public', 'wp-content/themes/fixture/js/view.js')), 'the rest is copied');
});

test('nothing under an excluded prefix is copied, and the media prefix counts without its trailing slash', async () => {
  const dir = site('excluded', { mode: 'store', prefix: '/wp-content/uploads' });
  const metaFile = join(dir, 'capture', 'meta.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  writeFileSync(metaFile, JSON.stringify({ ...meta, excluded: ['/wp-content/themes/fixture/fonts/', '/old-site'] }));
  const cache = join(dir, '.conversion', 'media-cache');
  mkdirSync(join(cache, 'old-site', 'files'), { recursive: true });
  writeFileSync(join(cache, 'old-site', 'files', 'a.pdf'), 'pdf');
  mkdirSync(join(cache, 'wp-content', 'uploads-old'), { recursive: true });
  writeFileSync(join(cache, 'wp-content', 'uploads-old', 'b.jpg'), 'jpg');
  const result = await copy(dir);
  assert.equal(result.code, 0, result.stderr);
  const pub = join(dir, 'public');
  assert.deepEqual(files(join(pub, 'wp-content', 'themes', 'fixture', 'fonts')), [], 'excluded fonts');
  assert.ok(!existsSync(join(pub, 'old-site')), 'an excluded media folder');
  assert.match(result.stdout, /excluded: \d+ \(under a prefix the capture left out: \/wp-content\/themes\/fixture\/fonts\/, \/old-site\)/);
  assert.deepEqual(files(join(pub, 'wp-content', 'uploads')), [], 'the prefix written without its slash still covers uploads/');
  assert.equal(readFileSync(join(pub, 'wp-content', 'uploads-old', 'b.jpg'), 'utf8'), 'jpg', 'but not a sibling folder that starts the same');
});

test('convert-site carries a byte-identical copy of the gates\' excluded.mjs', () => {
  assert.ok(readFileSync(join(SKILLS, 'convert-site', 'scripts', 'lib', 'excluded.mjs')).equals(readFileSync(join(SKILLS, 'parity-gates', 'scripts', 'lib', 'excluded.mjs'))));
});
