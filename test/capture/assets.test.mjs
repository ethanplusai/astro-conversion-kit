import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startStub } from './helpers.mjs';

const exec = promisify(execFile);
const ASSETS = fileURLToPath(new URL('../../skills/capture-site/scripts/assets.mjs', import.meta.url));

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [ASSETS, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// A capture folder with one home page and one stylesheet, written by hand.
function tinyCapture(origin, html, css) {
  const dir = mkdtempSync(join(tmpdir(), 'assets-test-'));
  mkdirSync(join(dir, 'pages'));
  mkdirSync(join(dir, 'css'));
  writeFileSync(join(dir, 'pages/home.html'), html);
  writeFileSync(join(dir, 'css/1.css'), css);
  writeFileSync(join(dir, 'css/manifest.json'), JSON.stringify([{ file: '1.css', href: `${origin}/style.css`, pages: ['/'] }]));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ origin, canonicalOrigin: origin }));
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify([{ url: `${origin}/`, path: '/', status: 200, snapshot: 'pages/home.html' }]));
  return dir;
}

const FONT_CSS = "@font-face{font-family:A;src:url(/fonts/big.woff2) format('woff2')}@font-face{font-family:B;src:url(/fonts/small.woff2)}";

test('assets.mjs streams fonts to disk and records one over --max-file-bytes as "too-large"', async () => {
  const site = await startStub({
    '/logo.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' },
    '/fonts/big.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(4000, 2) },
    '/fonts/small.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(10, 3) },
  });
  const dir = tinyCapture(site.origin, '<html><body><header><img src="/logo.svg"></header></body></html>', FONT_CSS);
  try {
    const result = await run(['--capture', dir, '--delay', '0', '--max-file-bytes', '1000']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8'));
    const big = index.find((e) => e.url === `${site.origin}/fonts/big.woff2`);
    const small = index.find((e) => e.url === `${site.origin}/fonts/small.woff2`);
    assert.equal(big.status, 'too-large');
    assert.equal(big.file, null);
    assert.equal(small.file, 'assets/fonts/small.woff2');
    assert.deepEqual(readFileSync(join(dir, 'assets/fonts/small.woff2')), Buffer.alloc(10, 3));
    assert.deepEqual(readdirSync(join(dir, 'assets/fonts')), ['small.woff2'], 'no partial file is left');
    assert.equal(readFileSync(join(dir, 'assets/logo.svg'), 'utf8'), '<svg/>');
    assert.match(result.stderr, /too-large/);
    assert.match((await run(['--help'])).stdout, /--max-file-bytes/);
    assert.equal((await run(['--capture', dir, '--max-file-bytes', '0'])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
});

test('assets.mjs does not request a logo on another port of 127.0.0.1', async () => {
  const other = await startStub({ '/logo.png': { headers: { 'Content-Type': 'image/png' }, body: 'png' } });
  const site = await startStub({});
  const dir = tinyCapture(site.origin, `<html><body><header><img src="${other.origin}/logo.png"></header></body></html>`, '');
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8'));
    const logo = index.find((e) => e.kind === 'logo');
    assert.equal(logo.status, 'blocked-address');
    assert.equal(existsSync(join(dir, 'assets/logo.png')), false);
    assert.deepEqual(other.requests, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await other.close();
    await site.close();
  }
});

test('assets.mjs skips css manifest entries that were not saved (file: null) and reads a sheet against its final URL', async () => {
  const site = await startStub({
    '/logo.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' },
    '/new/fonts/moved.woff2': { headers: { 'Content-Type': 'font/woff2' }, body: Buffer.alloc(10, 4) },
  });
  const dir = tinyCapture(site.origin, '<html><body><header><img src="/logo.svg"></header></body></html>', '@font-face{font-family:M;src:url(fonts/moved.woff2)}');
  writeFileSync(join(dir, 'css/manifest.json'), JSON.stringify([
    { file: null, href: `${site.origin}/gone.css`, pages: ['/'], status: 404 },
    { file: '1.css', href: `${site.origin}/old.css`, finalUrl: `${site.origin}/new/main.css`, pages: ['/'] },
  ]));
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readFileSync(join(dir, 'assets/fonts/moved.woff2')), Buffer.alloc(10, 4));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
});

// Runs assets.mjs on a one-page capture of `header` and returns the logo's index entry and bytes.
async function pickLogo(site, body) {
  const dir = tinyCapture(site.origin, `<html><body>${body}</body></html>`, '');
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const logo = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8')).find((e) => e.kind === 'logo');
    return { ...logo, bytes: logo.file ? readFileSync(join(dir, logo.file), 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('assets.mjs prefers an image named logo, then an inline logo <svg>, then the home link image, over the first <img>', async () => {
  const svg = { headers: { 'Content-Type': 'image/svg+xml' } };
  const site = await startStub({
    '/theme/avatar-placeholder.svg': { ...svg, body: '<svg>avatar</svg>' },
    '/theme/sxsw-logo.svg': { ...svg, body: '<svg>logo</svg>' },
    '/theme/brand.svg': { ...svg, body: '<svg>brand</svg>' },
    '/theme/mark.svg': { ...svg, body: '<svg>mark</svg>' },
  });
  const avatar = '<div class="account"><img src="/theme/avatar-placeholder.svg" alt=""></div>';
  try {
    const named = await pickLogo(site, `<header>${avatar}<a href="/"><img src="/theme/sxsw-logo.svg" alt="SXSW"></a></header>`);
    assert.equal(named.url, `${site.origin}/theme/sxsw-logo.svg`);
    assert.equal(named.bytes, '<svg>logo</svg>');

    const byAlt = await pickLogo(site, `<header>${avatar}<img src="/theme/brand.svg" alt="Brand logo"></header>`);
    assert.equal(byAlt.url, `${site.origin}/theme/brand.svg`);

    const scoped = await pickLogo(site, `${avatar}<div id="site-logo-wrap"><img src="/theme/mark.svg" class="custom-logo"></div>`);
    assert.equal(scoped.url, `${site.origin}/theme/mark.svg`, 'a [id*=logo] element is searched too');

    const inline = await pickLogo(site, `<header>${avatar}<a href="/"><svg viewBox="0 0 10 10" aria-label="Site logo"><path d="M0 0h10v10z"/></svg></a></header>`);
    assert.equal(inline.url, null);
    assert.equal(inline.file, 'assets/logo.svg');
    assert.equal(inline.status, 200);
    assert.match(inline.note, /inline <svg>/);
    assert.equal(inline.bytes, '<svg viewBox="0 0 10 10" aria-label="Site logo" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"></path></svg>\n');

    const titled = await pickLogo(site, `<header>${avatar}<svg class="mark"><title>Logo</title><circle r="1"/></svg></header>`);
    assert.equal(titled.file, 'assets/logo.svg');
    assert.match(titled.bytes, /<title>Logo<\/title>/);

    const home = await pickLogo(site, `<header>${avatar}<a href="${site.origin}/"><img src="/theme/brand.svg"></a></header>`);
    assert.equal(home.url, `${site.origin}/theme/brand.svg`, 'the image in the home link');

    const first = await pickLogo(site, `<header>${avatar}<img src="/theme/brand.svg"></header>`);
    assert.equal(first.url, `${site.origin}/theme/avatar-placeholder.svg`, 'with no other clue, the first <img> as before');
  } finally {
    await site.close();
  }
});

test('assets.mjs ranks the header before other logo elements, does not read "logout" as a logo, and notes a <use>-only svg', async () => {
  const img = { headers: { 'Content-Type': 'image/png' } };
  const site = await startStub({
    '/uploads/brand.png': { ...img, body: 'brand' },
    '/uploads/acme-logo.png': { ...img, body: 'acme' },
    '/uploads/footer-logo-white.png': { ...img, body: 'white' },
    '/theme/logout-icon.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg>out</svg>' },
    '/theme/site-logo.svg': { headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg>logo</svg>' },
  });
  try {
    const footer = '<footer><div class="sponsor-logos"><img src="/uploads/acme-logo.png" alt="Acme logo"></div><div class="footer-logo"><img src="/uploads/footer-logo-white.png"></div></footer>';
    const header = await pickLogo(site, `<header><a href="/"><img src="/uploads/brand.png" alt="SXSW"></a></header><main></main>${footer}`);
    assert.equal(header.url, `${site.origin}/uploads/brand.png`, 'the header brand image beats footer logos');

    const outside = await pickLogo(site, `<header><nav>menu</nav></header>${footer}`);
    assert.equal(outside.url, `${site.origin}/uploads/acme-logo.png`, 'with no header image, other logo elements are searched');

    const logout = await pickLogo(site, '<header><a class="menu-logout" href="/logout"><img src="/theme/logout-icon.svg" class="logout"></a><img src="/theme/site-logo.svg"></header>');
    assert.equal(logout.url, `${site.origin}/theme/site-logo.svg`);

    const camel = await pickLogo(site, '<header><img src="/uploads/brand.png" alt="avatar"><img src="/theme/site-logo.svg" class="headerLogo"></header>');
    assert.equal(camel.url, `${site.origin}/theme/site-logo.svg`, 'a camelCase class names the logo');

    const used = await pickLogo(site, '<svg style="display:none"><symbol id="brand"><path d="M0 0"/></symbol></svg><header><svg class="logo"><use href="#brand"/></svg></header>');
    assert.equal(used.file, 'assets/logo.svg');
    assert.match(used.note, /uses a symbol defined elsewhere on the page/);
    const drawn = await pickLogo(site, '<header><svg class="logo"><path d="M0 0"/></svg></header>');
    assert.doesNotMatch(drawn.note, /symbol/);
  } finally {
    await site.close();
  }
});

test('assets.mjs saves the web manifest, and the root icons meta.json icons saw answer 200', async () => {
  const site = await startStub({
    '/site.webmanifest': { headers: { 'Content-Type': 'application/manifest+json' }, body: '{"name":"x"}' },
    '/favicon.ico': { headers: { 'Content-Type': 'image/x-icon' }, body: 'ico' },
    '/apple-touch-icon.png': { headers: { 'Content-Type': 'image/png' }, body: 'png' },
  });
  const dir = tinyCapture(site.origin, '<html><head><link rel="manifest" href="/site.webmanifest"></head><body></body></html>', '');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, icons: { '/favicon.ico': 200, '/apple-touch-icon.png': 404 } }));
  try {
    const result = await run(['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(dir, 'assets/index.json'), 'utf8'));
    const manifest = index.find((e) => e.kind === 'manifest');
    assert.equal(manifest.url, `${site.origin}/site.webmanifest`);
    assert.equal(readFileSync(join(dir, manifest.file), 'utf8'), '{"name":"x"}');
    const root = index.find((e) => e.kind === 'root-favicon');
    assert.equal(readFileSync(join(dir, root.file), 'utf8'), 'ico');
    assert.ok(!index.some((e) => e.kind === 'root-apple-touch-icon'));
    assert.ok(!site.requests.includes('/apple-touch-icon.png'), 'a root icon live answered 404 for is not asked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
});
