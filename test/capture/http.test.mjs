import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { fetchPaced, isBlockedAddress, resetBlocked } from '../../skills/capture-site/scripts/lib/http.mjs';
import { startStub } from './helpers.mjs';

const exec = promisify(execFile);
const CAPTURE = fileURLToPath(new URL('../../skills/capture-site/scripts/capture.mjs', import.meta.url));

// A server whose handler gets (req, res) directly, for streaming, stalling and encoding.
async function startRaw(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

test('isBlockedAddress refuses loopback, private, link-local and metadata addresses', () => {
  for (const ip of [
    '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.1.1', '0.0.0.0', '::1', '::', 'fc00::1', 'fd12:3456::1',
    'fd00:ec2::254', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '1.1.1.1', '2606:4700::1111', 'fec0::1', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('isBlockedAddress looks inside IPv6 forms that carry an IPv4 address, and refuses CGNAT and multicast', () => {
  for (const ip of [
    '::127.0.0.1', '::a00:1', // IPv4-compatible
    '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', // IPv4-translated
    '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', // NAT64
    '2002:7f00:1::', '2002:c0a8:101::1', // 6to4
    '100.64.0.1', '100.127.255.255', // CGNAT
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', // multicast, reserved, broadcast
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['::8.8.8.8', '::ffff:0:808:808', '64:ff9b::8.8.8.8', '2002:808:808::1', '100.63.255.255', '100.128.0.1', '223.255.255.255']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('a host that does not resolve is a network error, without a request', async () => {
  resetBlocked();
  const res = await fetchPaced('http://nonexistent.invalid/x', { delayMs: 0, trusted: ['http://example.com'] });
  assert.equal(res.status, 0);
  assert.ok(res.error);
  resetBlocked();
});

test('fetchPaced refuses a loopback host it was not told to trust, without a request', async () => {
  const stub = await startStub({ '/x': { body: 'secret' } });
  try {
    const refused = await fetchPaced(`${stub.origin}/x`, { delayMs: 0 });
    assert.equal(refused.status, 'blocked-address');
    assert.match(refused.error, /127\.0\.0\.1/);
    const named = await fetchPaced(`http://localhost:${new URL(stub.origin).port}/x`, { delayMs: 0, trusted: ['http://example.com'] });
    assert.equal(named.status, 'blocked-address', 'a name that resolves to loopback is refused too');
    assert.deepEqual(stub.requests, []);
    const ok = await fetchPaced(`${stub.origin}/x`, { delayMs: 0, trusted: [stub.origin] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'secret');
  } finally {
    await stub.close();
  }
});

test('the trusted origin covers its own port only, and redirects into a refused address are refused', async () => {
  const inner = await startStub({ '/meta': { body: 'metadata' } });
  const outer = await startStub({
    '/hop': { status: 302, headers: { Location: `${inner.origin}/meta` } },
  });
  try {
    const other = await fetchPaced(`${inner.origin}/meta`, { delayMs: 0, trusted: [outer.origin] });
    assert.equal(other.status, 'blocked-address', 'another port on the same address is another host');
    const hop = await fetchPaced(`${outer.origin}/hop`, { delayMs: 0, redirect: 'follow', trusted: [outer.origin] });
    assert.equal(hop.status, 'blocked-address');
    assert.equal(hop.finalUrl, `${inner.origin}/meta`);
    assert.deepEqual(inner.requests, []);
    const manual = await fetchPaced(`${outer.origin}/hop`, { delayMs: 0, trusted: [outer.origin] });
    assert.equal(manual.status, 302, 'a manual redirect is handed back; the next request is guarded');
  } finally {
    await inner.close();
    await outer.close();
  }
});

test('fetchPaced follows redirects by hand on the trusted host', async () => {
  const stub = await startStub({
    '/a': { status: 301, headers: { Location: '/b' } },
    '/b': { status: 302, headers: { Location: '/c' } },
    '/c': { body: 'end' },
  });
  try {
    const res = await fetchPaced(`${stub.origin}/a`, { delayMs: 0, redirect: 'follow', trusted: [stub.origin] });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'end');
    assert.equal(res.finalUrl, `${stub.origin}/c`);
  } finally {
    await stub.close();
  }
});

test('a text body over the cap is "too-large", decoded size included', async () => {
  const big = 'x'.repeat(5000);
  const server = await startRaw((req, res) => {
    if (req.url === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(big);
    } else if (req.url === '/gzip') {
      const packed = gzipSync(big);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': packed.length });
      res.end(packed);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': big.length });
      res.end(big);
    }
  });
  const opts = { delayMs: 0, trusted: [server.origin], maxBytes: 1000 };
  try {
    resetBlocked();
    for (const path of ['/plain', '/gzip', '/declared']) {
      const res = await fetchPaced(`${server.origin}${path}`, opts);
      assert.equal(res.status, 'too-large', path);
      assert.equal(res.body, '');
    }
    const fits = await fetchPaced(`${server.origin}/gzip`, { ...opts, maxBytes: 5000 });
    assert.equal(fits.status, 200);
    assert.equal(fits.body, big);
  } finally {
    resetBlocked();
    await server.close();
  }
});

test('toFile streams the body to disk; over the cap nothing is left behind', async () => {
  const bytes = Buffer.alloc(4096, 7);
  const server = await startRaw((req, res) => {
    res.writeHead(req.url === '/missing.bin' ? 404 : 200, { 'Content-Type': 'application/octet-stream' });
    res.write(bytes.subarray(0, 2048));
    setTimeout(() => res.end(bytes.subarray(2048)), 20);
  });
  const dir = mkdtempSync(join(tmpdir(), 'http-stream-test-'));
  const opts = { delayMs: 0, trusted: [server.origin] };
  try {
    const file = join(dir, 'a', 'file.bin');
    const res = await fetchPaced(`${server.origin}/file.bin`, { ...opts, toFile: file });
    assert.equal(res.status, 200);
    assert.equal(res.bytes, 4096);
    assert.equal(res.body, '');
    assert.deepEqual(readFileSync(file), bytes);

    const capped = join(dir, 'b', 'file.bin');
    const over = await fetchPaced(`${server.origin}/file.bin`, { ...opts, toFile: capped, maxBytes: 3000 });
    assert.equal(over.status, 'too-large');
    assert.deepEqual(readdirSync(join(dir, 'b')), []);

    const missing = join(dir, 'c', 'missing.bin');
    const notFound = await fetchPaced(`${server.origin}/missing.bin`, { ...opts, toFile: missing });
    assert.equal(notFound.status, 404);
    assert.equal(existsSync(missing), false, 'only a 200 is saved');

    const counted = await fetchPaced(`${server.origin}/file.bin`, { ...opts, discardBody: true });
    assert.equal(counted.status, 200);
    assert.equal(counted.bytes, 4096);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('a download that stalls is aborted by the idle timeout and leaves no file', async () => {
  const server = await startRaw((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '10000' });
    res.write(Buffer.alloc(100));
    // then nothing: the connection stays open
  });
  const dir = mkdtempSync(join(tmpdir(), 'http-idle-test-'));
  try {
    resetBlocked();
    const started = Date.now();
    const res = await fetchPaced(`${server.origin}/slow.bin`, {
      delayMs: 0, trusted: [server.origin], idleMs: 200, timeoutMs: 10_000, toFile: join(dir, 'slow.bin'),
    });
    assert.equal(res.status, 0);
    assert.match(res.error, /no data/);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    resetBlocked();
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('capture refuses a stylesheet on another port of 127.0.0.1 while the origin on 127.0.0.1 is fetched', async () => {
  const other = await startStub({ '/evil.css': { headers: { 'Content-Type': 'text/css' }, body: 'body{}' } });
  const site = await startStub({
    '/': {
      body: `<html><head><title>Home</title><link rel="stylesheet" href="${other.origin}/evil.css"><link rel="stylesheet" href="/own.css"></head><body><p>Hi</p></body></html>`,
    },
    '/own.css': { headers: { 'Content-Type': 'text/css' }, body: 'p{color:red}' },
  });
  const work = mkdtempSync(join(tmpdir(), 'capture-ssrf-test-'));
  try {
    const out = join(work, 'capture');
    await exec(process.execPath, [CAPTURE, site.origin, '--out', out, '--delay', '0', '--no-wayback']);
    const manifest = JSON.parse(readFileSync(join(out, 'css', 'manifest.json'), 'utf8'));
    const evil = manifest.find((e) => e.href === `${other.origin}/evil.css`);
    const own = manifest.find((e) => e.href === `${site.origin}/own.css`);
    assert.equal(evil.status, 'blocked-address');
    assert.equal(evil.file, null);
    assert.ok(own.file, 'the origin stylesheet is saved');
    assert.deepEqual(other.requests, []);
    assert.ok(site.requests.includes('/'));
  } finally {
    rmSync(work, { recursive: true, force: true });
    await other.close();
    await site.close();
  }
});
