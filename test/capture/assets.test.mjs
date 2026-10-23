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
