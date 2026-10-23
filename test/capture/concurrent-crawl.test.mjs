// The crawl with several requests in flight writes what the one-at-a-time crawl writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';

const exec = promisify(execFile);
const CAPTURE = fileURLToPath(new URL('../../skills/capture-site/scripts/capture.mjs', import.meta.url));
const OUTPUTS = [
  'inventory.json', 'redirects.json', 'links.json', 'scripts.json', 'feeds/index.json',
  'sitemaps/index.json', 'css/manifest.json', 'js/manifest.json',
];

async function capture(concurrency, out) {
  const site = await startFixture({ delayMs: 25 });
  try {
    const started = Date.now();
    await exec(process.execPath, [CAPTURE, site.origin, '--out', out, '--delay', '0', '--concurrency', String(concurrency), '--no-wayback']);
    return { origin: site.origin, ms: Date.now() - started, maxInFlight: site.stats.maxInFlight, requests: site.requests.length };
  } finally {
    await site.close();
  }
}

// A capture's file, with the fixture's origin (a different port each run) taken out.
const read = (dir, file, origin) => readFileSync(join(dir, file), 'utf8').replaceAll(origin, 'ORIGIN');

test('a crawl with 4 in flight writes the same capture as a crawl with 1', async () => {
  const work = mkdtempSync(join(tmpdir(), 'concurrent-crawl-test-'));
  try {
    const one = join(work, 'one');
    const four = join(work, 'four');
    const serial = await capture(1, one);
    const parallel = await capture(4, four);
    assert.equal(serial.maxInFlight, 1);
    assert.ok(parallel.maxInFlight > 1, `in flight at once: ${parallel.maxInFlight}`);
    assert.ok(parallel.maxInFlight <= 4);
    assert.equal(parallel.requests, serial.requests, 'the same requests');
    for (const file of OUTPUTS) {
      assert.equal(read(four, file, parallel.origin), read(one, file, serial.origin), file);
    }
    for (const dir of ['pages', 'text', 'css', 'js', 'feeds']) {
      assert.deepEqual(readdirSync(join(four, dir)).sort(), readdirSync(join(one, dir)).sort(), dir);
      for (const name of readdirSync(join(one, dir))) {
        assert.equal(read(four, join(dir, name), parallel.origin), read(one, join(dir, name), serial.origin), join(dir, name));
      }
    }
    const meta = (dir, origin) => {
      const { startedAt, finishedAt, origin: o, canonicalOrigin, ...rest } = JSON.parse(read(dir, 'meta.json', origin));
      if (rest.notFound) rest.notFound.path = 'RANDOM';
      return rest;
    };
    assert.deepEqual(meta(four, parallel.origin), meta(one, serial.origin));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a crawl stopped by blocks with 4 in flight saves its state and resumes to the full capture', async () => {
  const work = mkdtempSync(join(tmpdir(), 'concurrent-crawl-block-test-'));
  const blocking = await startFixture({ blockAfter: 20, delayMs: 10 });
  try {
    const out = join(work, 'capture');
    await assert.rejects(
      exec(process.execPath, [CAPTURE, blocking.origin, '--out', out, '--delay', '0', '--concurrency', '4', '--no-wayback']),
      (err) => err.code === 3,
    );
    const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
    assert.equal(state.phase, 'crawl');
    assert.ok(state.queue.length > 0, 'URLs left for --resume');
    const pagesBefore = state.records.filter((r) => r.status === 200).length;
    await blocking.close();

    // The same capture folder on a fresh fixture at the same address answers again.
    const again = await startFixture({ port: Number(new URL(blocking.origin).port), delayMs: 10 });
    try {
      await exec(process.execPath, [CAPTURE, again.origin, '--out', out, '--resume', '--delay', '0', '--concurrency', '4', '--no-wayback']);
    } finally {
      await again.close();
    }
    const inventory = JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8'));
    const ok = inventory.filter((r) => r.status === 200).map((r) => r.path);
    assert.ok(ok.length > pagesBefore);
    for (const path of ['/', '/about/', '/contact/', '/services/', '/services/roofing/', '/services/siding/', '/blog/', '/hidden-page/']) {
      assert.ok(ok.includes(path), path);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
