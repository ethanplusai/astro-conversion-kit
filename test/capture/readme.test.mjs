import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';

const exec = promisify(execFile);
const script = (name) => fileURLToPath(new URL(`../../skills/capture-site/scripts/${name}`, import.meta.url));
const SITE = fileURLToPath(new URL('../fixture/site/', import.meta.url));
const THEME_CSS = join(SITE, 'wp-content/themes/fixture/style.css');

async function run(name, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script(name), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// The files the media step writes, as small hand-made samples, for captures made without it.
function writeMediaSamples(dir, origin) {
  const upload = (name) => `${origin}/wp-content/uploads/2026/01/${name}`;
  const media = [
    { url: upload('hero.jpg'), path: '/wp-content/uploads/2026/01/hero.jpg', source: ['srcset', 'og'], referencedBy: ['/'], status: 200, contentType: 'image/jpeg', bytes: 120000 },
    { url: upload('team.jpg'), path: '/wp-content/uploads/2026/01/team.jpg', source: ['srcset'], referencedBy: ['/about/'], status: 200, contentType: 'image/jpeg', bytes: 90000 },
    { url: upload('logo.svg'), path: '/wp-content/uploads/2026/01/logo.svg', source: ['html'], referencedBy: ['/', '/about/'], status: 200, contentType: 'image/svg+xml', bytes: 1200 },
    { url: upload('team-150x150.jpg'), path: '/wp-content/uploads/2026/01/team-150x150.jpg', source: ['rest'], referencedBy: [], status: null, contentType: null, bytes: null, downloaded: false, reason: 'unreferenced size' },
  ];
  writeFileSync(join(dir, 'media.json'), `${JSON.stringify(media, null, 2)}\n`);
  mkdirSync(join(dir, 'css'), { recursive: true });
  cpSync(THEME_CSS, join(dir, 'css', '1.css'));
  const manifest = [{ file: '1.css', href: `${origin}/wp-content/themes/fixture/style.css?ver=1.4.2`, pages: ['/', '/about/'] }];
  writeFileSync(join(dir, 'css', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'wayback-unverified.txt'), '');
}

let fixture;
let dir;
let bare;
let missing;
let assets;
let bareAssets;
let missingAssets;
let readme;
let bareReadme;
let missingReadme;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'readme-test-'));
  bare = mkdtempSync(join(tmpdir(), 'readme-bare-test-'));
  missing = mkdtempSync(join(tmpdir(), 'readme-missing-test-'));
  fixture = await startFixture();
  const crawl = await run('capture.mjs', [fixture.origin, '--out', dir, '--delay', '0', '--no-rest', '--no-wayback', '--seed', '/private-page/']);
  assert.equal(crawl.code, 0, crawl.stderr);
  cpSync(dir, bare, { recursive: true });
  // The bare capture has no media step output and no stylesheets, so every "not captured" line shows.
  rmSync(join(bare, 'css'), { recursive: true, force: true });
  rmSync(join(bare, 'media.json'), { force: true });
  cpSync(dir, missing, { recursive: true });
  writeMediaSamples(dir, fixture.origin);
  // A stylesheet naming a font the site does not have.
  mkdirSync(join(missing, 'css'), { recursive: true });
  writeFileSync(join(missing, 'css', '1.css'), '@font-face { font-family: Gone; src: url("fonts/gone.woff2") format("woff2"); }\n');
  const gone = [{ file: '1.css', href: `${fixture.origin}/wp-content/themes/fixture/style.css`, pages: ['/'] }];
  writeFileSync(join(missing, 'css', 'manifest.json'), JSON.stringify(gone));

  for (const d of [dir, bare, missing]) {
    const t = await run('templates.mjs', ['--capture', d]);
    assert.equal(t.code, 0, t.stderr);
  }
  assets = await run('assets.mjs', ['--capture', dir, '--delay', '0']);
  bareAssets = await run('assets.mjs', ['--capture', bare, '--delay', '0']);
  missingAssets = await run('assets.mjs', ['--capture', missing, '--delay', '0']);
  for (const d of [dir, bare, missing]) {
    const r = await run('readme.mjs', ['--capture', d]);
    assert.equal(r.code, 0, r.stderr);
  }
  readme = readFileSync(join(dir, 'README.md'), 'utf8');
  bareReadme = readFileSync(join(bare, 'README.md'), 'utf8');
  missingReadme = readFileSync(join(missing, 'README.md'), 'utf8');
});
after(async () => {
  await fixture.close();
  for (const d of [dir, bare, missing]) rmSync(d, { recursive: true, force: true });
});

const sameBytes = (saved, original) => assert.ok(readFileSync(saved).equals(readFileSync(original)), saved);

test('assets.mjs saves the logo, the favicon and both fonts byte for byte', () => {
  assert.equal(assets.code, 0, assets.stderr);
  sameBytes(join(dir, 'assets', 'logo.svg'), join(SITE, 'wp-content/uploads/2026/01/logo.svg'));
  sameBytes(join(dir, 'assets', 'favicon.svg'), join(SITE, 'wp-content/uploads/2026/01/logo.svg'));
  for (const font of ['fixture-sans.woff2', 'fixture-serif.woff2']) {
    sameBytes(join(dir, 'assets', 'fonts', font), join(SITE, 'wp-content/themes/fixture/fonts', font));
  }
  assert.match(assets.stdout, /apple-touch-icon: none/);
});

test('assets.mjs without captured CSS still saves the logo and says fonts were not captured', () => {
  assert.equal(bareAssets.code, 0, bareAssets.stderr);
  assert.ok(existsSync(join(bare, 'assets', 'logo.svg')));
  assert.ok(!existsSync(join(bare, 'assets', 'fonts')));
  assert.match(bareAssets.stdout, /fonts: not captured/);
});

test('the README covers templates, vendors, indexing and the Wayback check', () => {
  assert.match(readme, /^# Capture of http:\/\/127\.0\.0\.1:\d+/m);
  assert.match(readme, /Platform: wordpress 6\.6\.2/);
  assert.match(readme, /Theme: fixture/);
  assert.match(readme, /^## Templates$/m);
  assert.match(readme, /\| home \| 1 \| \/ \|/);
  assert.match(readme, /\| archive \| 2 \| /);
  assert.match(readme, /G-FIXTURE1/);
  assert.match(readme, /GTM-FIXTURE/);
  assert.match(readme, /meta noindex: 1/);
  assert.match(readme, /\/private-page\//);
  assert.match(readme, /\| seed \| 1 \|/, 'foundBy counts');
  // Eleven linked pages plus the seeded noindex page, each with its own ?p= shortlink.
  assert.match(readme, /\| shortlink \| 12 \| 12 unverified \|/, 'redirects by source');
  assert.match(readme, /Media files: 3, 206\.3 KB/);
  assert.match(readme, /Unreferenced sizes: 1 \(listed only, not downloaded; media\.mjs --sizes all fetches them\)/);
  assert.doesNotMatch(readme, /Not 200/, 'a size listed only is not a broken file');
  assert.match(readme, /Largest: \/wp-content\/uploads\/2026\/01\/hero\.jpg \(117\.2 KB\)/);
  assert.match(readme, /\/contact\/.*name, email, message, website/);
  assert.match(readme, /\/feed\//);
  assert.match(readme, /Iframes: none/);
  assert.match(readme, /Wayback unverified: 0/);
  assert.match(readme, /^- logo: assets\/logo\.svg$/m);
  assert.match(readme, /^- font: assets\/fonts\/fixture-serif\.woff2$/m);
  assert.match(readme, /^- apple-touch-icon: none on the site$/m);
  assert.match(readme, /## Notes\n*$/);
});

test('a missing asset is a warning, not a failure, and the README lists it as missing', () => {
  assert.equal(missingAssets.code, 0, missingAssets.stderr);
  assert.match(missingAssets.stderr, /Warning: font missing: http:\/\/127\.0\.0\.1:\d+\/wp-content\/themes\/fixture\/fonts\/gone\.woff2 returned 404/);
  assert.ok(existsSync(join(missing, 'assets', 'logo.svg')));
  assert.match(missingReadme, /^- font: missing: \S+\/gone\.woff2 returned 404$/m);
});

test('re-running readme.mjs keeps what was written under ## Notes', async () => {
  const note = 'The contact form posts to a plugin endpoint; check it by hand.';
  writeFileSync(join(dir, 'README.md'), `${readme.trimEnd()}\n\n${note}\n`);
  const again = await run('readme.mjs', ['--capture', dir]);
  assert.equal(again.code, 0, again.stderr);
  const text = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.ok(text.endsWith(`## Notes\n\n${note}\n`), text.slice(-200));
  assert.equal(text.split(note).length, 2, 'the note appears once');
});

test('the README says plainly what was not captured', () => {
  assert.match(bareReadme, /Media: not captured/);
  assert.match(bareReadme, /Wayback unverified: not captured/);
  assert.match(bareReadme, /^- fonts: not captured/m);
  assert.match(bareReadme, /^## Templates$/m);
});
