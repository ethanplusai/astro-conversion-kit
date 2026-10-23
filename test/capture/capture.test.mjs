import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/capture-site/scripts/capture.mjs', import.meta.url));
const SITE = fileURLToPath(new URL('../fixture/site/', import.meta.url));
const README = fileURLToPath(new URL('../../skills/capture-site/scripts/readme.mjs', import.meta.url));
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  dirs.push(dir);
  return dir;
};
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

// A stand-in for the Wayback CDX API, so no test ever contacts web.archive.org. It answers any
// query with the queried host's home page plus two paths the fixture does not have (or `paths`).
let cdx;
function startCdx(paths = ['/old-team/', '/2019/05/summer-sale/']) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const host = new URL(req.url, 'http://cdx').searchParams.get('url').replace(/\/\*$/, '');
    const rows = [['original'], [`http://${host}/`], ...paths.map((p) => [`http://${host}${p}`])];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({
        endpoint: `http://127.0.0.1:${server.address().port}/cdx/search/cdx`,
        requests,
        close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
      }));
  });
}

// Runs capture.mjs with --no-wayback unless `wayback` names a CDX endpoint to use instead.
async function capture(args, { wayback } = {}) {
  try {
    const env = wayback ? { ...process.env, CAPTURE_WAYBACK_CDX: wayback, CAPTURE_WAYBACK_RETRY_MS: '0' } : process.env;
    const flags = wayback || args.includes('--help') || args.includes('--no-wayback') ? [] : ['--no-wayback'];
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args, ...flags], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function readme(dir) {
  const { stdout } = await exec(process.execPath, [README, '--capture', dir]);
  assert.match(stdout, /Wrote/);
  const text = readFileSync(join(dir, 'README.md'), 'utf8');
  return text.slice(text.indexOf('## Notes'));
}

let fixture;
let full;
let fullRun;
let fullRequests;
before(async () => {
  cdx = await startCdx();
  fixture = await startFixture();
  full = tempDir();
  fullRun = await capture([fixture.origin, '--out', full, '--delay', '0', '--seed', '/old-services'], { wayback: cdx.endpoint });
  fullRequests = [...fixture.requests];
});
after(async () => {
  await fixture.close();
  await cdx.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('a full capture inventories 13 pages and the sitemap 404', () => {
  assert.equal(fullRun.code, 0, fullRun.stderr);
  const inventory = readJson(full, 'inventory.json');
  assert.equal(inventory.length, 14);
  assert.equal(inventory.filter((r) => r.status === 200).length, 13);
  const deleted = inventory.find((r) => r.path === '/deleted-post/');
  assert.equal(deleted.status, 404);
  assert.deepEqual(deleted.foundBy, ['sitemap']);
  const hiddenFromSitemaps = inventory.find((r) => r.path === '/private-page/');
  assert.equal(hiddenFromSitemaps.status, 200);
  // Only REST knows the noindex page; once fetched, its own canonical link adds 'crawl'.
  assert.deepEqual(hiddenFromSitemaps.foundBy, ['rest', 'crawl']);
  assert.ok(!readJson(full, 'links.json').internal['/private-page/'], 'no page links to it');
  assert.ok(!inventory.some((r) => r.path === '/feed/'), 'feeds are not pages');

  const hidden = inventory.find((r) => r.path === '/hidden-page/');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.foundBy, ['rest', 'crawl']);
  const home = inventory.find((r) => r.path === '/');
  assert.deepEqual(home.foundBy, ['sitemap', 'rest', 'crawl']);
  assert.equal(home.snapshot, 'pages/home.html');
  assert.equal(home.finalUrl, `${fixture.origin}/`);
  assert.ok(home.text.length > 0);
});

test('redirect chains collapse to their final target and shortlinks are recorded', () => {
  const redirects = readJson(full, 'redirects.json');
  const old = redirects.find((r) => r.from === '/old-services');
  assert.deepEqual(old, { from: '/old-services', to: '/services/', status: 301, source: 'seed', hops: ['/old-services/'] });
  const short = redirects.find((r) => r.from === '/?p=7');
  assert.deepEqual(short, { from: '/?p=7', to: '/services/', status: 301, source: 'shortlink', verified: false, hops: [] });
  assert.ok(!fullRequests.some((url) => url.includes('?p=')), 'shortlinks are not requested by default');
  const services = readJson(full, 'inventory.json').find((r) => r.path === '/services/');
  assert.equal(services.shortlink, '/?p=7');
  const meta = readJson(full, 'meta.json');
  assert.equal(meta.canonicalOrigin, fixture.origin);
  assert.ok(meta.finishedAt);
});

test('--verify-shortlinks requests each shortlink and records where it goes', async () => {
  const out = tempDir();
  const before = fixture.requests.length;
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--verify-shortlinks']);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(fixture.requests.slice(before).includes('/?p=7'));
  const redirects = readJson(out, 'redirects.json');
  const short = redirects.find((r) => r.from === '/?p=7');
  assert.deepEqual(short, { from: '/?p=7', to: '/services/', status: 301, source: 'shortlink', verified: true, hops: [] });
  assert.ok(redirects.filter((r) => r.source === 'shortlink').every((r) => r.verified));
  assert.equal(readJson(out, 'inventory.json').length, 14);
});

test('a page that is always 403 is recorded with its status, not treated as a block', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body><a href="/forbidden/">f</a></body></html>' },
    '/forbidden/': { status: 403, body: '<html><head><title>Page</title></head><body>no</body></html>' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const inventory = readJson(out, 'inventory.json');
    assert.deepEqual(inventory.map((r) => `${r.path}:${r.status}`), ['/:200', '/forbidden/:403']);
    assert.equal(stub.requests.filter((u) => u === '/forbidden/').length, 3);
  } finally {
    await stub.close();
  }
});

test('a URL that keeps answering 503 is recorded with its status and attempts; the rest is captured and the README lists it', async () => {
  const site = await startFixture({ alwaysStatus: { '/flaky/': 503 } });
  try {
    const out = tempDir();
    const run = await capture([site.origin, '--out', out, '--delay', '0', '--no-rest', '--seed', '/flaky/']);
    assert.equal(run.code, 0, run.stderr);
    const inventory = readJson(out, 'inventory.json');
    const flaky = inventory.find((r) => r.path === '/flaky/');
    assert.equal(flaky.status, 503);
    assert.equal(flaky.attempts, 3);
    assert.equal(site.requests.filter((u) => u === '/flaky/').length, 3);
    assert.equal(inventory.filter((r) => r.status === 200).length, 12, 'every other page is captured');
    assert.equal(readJson(out, 'state.json').phase, 'done');
    assert.ok(readJson(out, 'meta.json').finishedAt);
    assert.match(await readme(out), /^- Still failing after retries: \/flaky\/ \(503 after 3 attempts\)$/m);
  } finally {
    await site.close();
  }
});

test('a URL that keeps answering 429 is given up; three different URLs failing in a row stop the run with exit 3', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body><a href="/a/">a</a> <a href="/slow/">s</a></body></html>' },
    '/a/': { body: '<html><head><title>Page</title></head><body>a</body></html>' },
    '/slow/': { status: 429, body: 'slow down' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:200', '/a/:200', '/slow/:429']);
    assert.equal(stub.requests.filter((u) => u === '/slow/').length, 3);
  } finally {
    await stub.close();
  }

  const failing = { status: 503, body: 'unavailable' };
  const busy = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body><a href="/s1/">1</a> <a href="/s2/">2</a> <a href="/s3/">3</a> <a href="/ok/">ok</a></body></html>' },
    '/s1/': failing,
    '/s2/': failing,
    '/s3/': failing,
    '/ok/': { body: '<html><head><title>Page</title></head><body>ok</body></html>' },
  });
  try {
    const out = tempDir();
    const run = await capture([busy.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    const state = readJson(out, 'state.json');
    assert.equal(state.phase, 'crawl');
    // Each failing URL used up its 3 tries (the page that answered in between was captured)
    // before it counted towards the streak; all three go back on the queue with fresh tries.
    assert.deepEqual(state.queue.map((q) => `${new URL(q.url).pathname}:${q.attempts}`), ['/s1/:0', '/s2/:0', '/s3/:0']);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/ok/']);
    for (const path of ['/s1/', '/s2/', '/s3/']) assert.equal(busy.requests.filter((u) => u === path).length, 3, path);

    // Still failing on the resume: given up and recorded this time, so the resume finishes.
    const resumed = await capture([busy.origin, '--out', out, '--delay', '0', '--resume']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:200', '/ok/:200', '/s1/:503', '/s2/:503', '/s3/:503']);
    assert.equal(readJson(out, 'state.json').phase, 'done');
  } finally {
    await busy.close();
  }
});

test('a gzipped sitemap too large once decoded is a discoveryErrors entry "too-large", not fatal', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body>home</body></html>' },
    '/robots.txt': { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Sitemap: /big.xml.gz\n' },
    '/big.xml.gz': { headers: { 'Content-Type': 'application/x-gzip' }, body: gzipSync(Buffer.alloc(20 * 1024 * 1024 + 1, ' ')) },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const errors = readJson(out, 'meta.json').discoveryErrors.map((e) => `${new URL(e.url).pathname}:${e.status}`);
    assert.ok(errors.includes('/big.xml.gz:too-large'), errors.join(' '));
  } finally {
    await stub.close();
  }
});

test('a sitemap that keeps answering 503 is noted in discoveryErrors, not fatal', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body>home</body></html>' },
    '/robots.txt': { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Sitemap: /busy-sitemap.xml\n' },
    '/busy-sitemap.xml': { status: 503 },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/']);
    const errors = readJson(out, 'meta.json').discoveryErrors.map((e) => `${new URL(e.url).pathname}:${e.status}`);
    assert.ok(errors.includes('/busy-sitemap.xml:503'), errors.join(' '));
  } finally {
    await stub.close();
  }
});

test('a sitemap robots.txt names that answers 404 is recorded in sitemaps/index.json and discoveryErrors', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body>home</body></html>' },
    '/robots.txt': { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Sitemap: /wp-sitemap.xml\n' },
    '/wp-sitemap.xml': { status: 404, body: 'not found' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const errors = readJson(out, 'meta.json').discoveryErrors.map((e) => `${new URL(e.url).pathname}:${e.status}`);
    assert.deepEqual(errors, ['/wp-sitemap.xml:404']);
    const index = readJson(out, 'sitemaps/index.json');
    assert.deepEqual(index.find((e) => e.url === `${stub.origin}/wp-sitemap.xml`), { url: `${stub.origin}/wp-sitemap.xml`, status: 404, file: null });
  } finally {
    await stub.close();
  }
});

test('the capture asks for /favicon.ico and /apple-touch-icon.png once and records their status in meta.json icons', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body>home</body></html>' },
    '/favicon.ico': { status: 200, headers: { 'Content-Type': 'image/x-icon' }, body: 'ico' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'meta.json').icons, { '/favicon.ico': 200, '/apple-touch-icon.png': 404 });
    const asked = stub.requests.filter((u) => u === '/favicon.ico' || u === '/apple-touch-icon.png');
    assert.deepEqual(asked.sort(), ['/apple-touch-icon.png', '/favicon.ico']);
    const again = await capture([stub.origin, '--out', out, '--delay', '0', '--resume']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(stub.requests.filter((u) => u === '/favicon.ico').length, 1, 'asked once per capture');
  } finally {
    await stub.close();
  }
});

test('robots.txt and sitemaps that always answer 403 are noted, not fatal', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title></head><body>home</body></html>' },
    '/robots.txt': { status: 403 },
    '/sitemap_index.xml': { status: 403 },
    '/sitemap.xml': { status: 403 },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/']);
    const meta = readJson(out, 'meta.json');
    assert.deepEqual(
      meta.discoveryErrors.map((e) => `${new URL(e.url).pathname}:${e.status}`),
      ['/robots.txt:403', '/sitemap_index.xml:403', '/sitemap.xml:403'],
    );
    assert.equal(readJson(out, 'state.json').phase, 'done');
  } finally {
    await stub.close();
  }
});

test('a blocked --verify-shortlinks pass resumes without the flag', async () => {
  const probe = await startFixture();
  const port = Number(new URL(probe.origin).port);
  const plainOut = tempDir();
  assert.equal((await capture([probe.origin, '--out', plainOut, '--delay', '0'])).code, 0);
  const crawlRequests = probe.requests.length;
  await probe.close();

  const out = tempDir();
  const blocking = await startFixture({ port, blockAfter: crawlRequests + 1 });
  const stopped = await capture([blocking.origin, '--out', out, '--delay', '0', '--verify-shortlinks']);
  await blocking.close();
  assert.equal(stopped.code, 3, stopped.stderr);
  const state = readJson(out, 'state.json');
  assert.equal(state.options.verifyShortlinks, true);
  assert.ok(state.verifyQueue.length > 0);
  assert.equal(readJson(out, 'meta.json').finishedAt, null);

  const open = await startFixture({ port });
  const resumed = await capture([open.origin, '--out', out, '--delay', '0', '--resume']);
  await open.close();
  assert.equal(resumed.code, 0, resumed.stderr);
  const shortlinks = readJson(out, 'redirects.json').filter((r) => r.source === 'shortlink');
  assert.equal(shortlinks.length, 12, 'one per captured page, including the REST-only private page');
  assert.ok(shortlinks.every((r) => r.verified && r.status === 301), JSON.stringify(shortlinks));
  assert.deepEqual(readJson(out, 'state.json').verifyQueue, []);
});

test('only HTML and hreflang alternates are followed; feeds go to feeds/, wp-json is never requested', async () => {
  const head = `<link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/2">
    <link rel="alternate" type="application/json+oembed" href="/wp-json/oembed/1.0/embed?url=x">
    <link rel="alternate" type="text/xml+oembed" href="/oembed.xml?url=x">
    <link rel="alternate" type="application/rss+xml" href="/news-feed/">
    <link rel="alternate" hreflang="fr" href="/fr/">`;
  const stub = await startStub({
    '/': { body: `<html><head><title>Page</title>${head}</head><body><a href="/wp-json/">api</a></body></html>` },
    '/fr/': { body: '<html><head><title>Page</title></head><body>bonjour</body></html>' },
    '/news-feed/': { headers: { 'Content-Type': 'application/rss+xml' }, body: '<rss version="2.0"></rss>' },
  });
  try {
    const out = tempDir();
    // --no-rest: this page looks like WordPress, and the REST dump is the one thing that may
    // request /wp-json/ on purpose.
    const run = await capture([stub.origin, '--out', out, '--delay', '0', '--no-rest']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!stub.requests.some((u) => u.startsWith('/wp-json') || u.includes('oembed')), stub.requests.join(' '));
    assert.ok(stub.requests.includes('/fr/'));
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/fr/']);
    assert.deepEqual(readJson(out, 'feeds/index.json').map((f) => f.path), ['/news-feed/']);
  } finally {
    await stub.close();
  }
});

test('a URL linked with lower- and upper-case percent escapes is captured once', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Home</title></head><body><a href="/caf%c3%a9/">a</a> <a href="/caf%C3%A9/">b</a> <a href="/na%c3%afve/">c</a></body></html>' },
    '/caf%C3%A9/': { body: '<html><head><title>Cafe</title></head><body>cafe</body></html>' },
    // A redirect that only changes the escapes' case lands on the same page.
    '/na%C3%AFve/': { status: 301, headers: { Location: '/na%c3%afve/' } },
    '/na%c3%afve/': { body: '<html><head><title>Naive</title></head><body>naive</body></html>' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0', '--no-rest']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!stub.requests.includes('/caf%c3%a9/'), stub.requests.join(' '));
    assert.equal(stub.requests.filter((u) => u === '/caf%C3%A9/').length, 1);
    const inventory = readJson(out, 'inventory.json');
    assert.deepEqual(inventory.map((r) => [r.path, r.status]), [['/', 200], ['/caf%C3%A9/', 200], ['/na%C3%AFve/', 200]]);
    assert.deepEqual(readJson(out, 'redirects.json'), []);
  } finally {
    await stub.close();
  }
});

test('an unreachable site exits 3 so it can be resumed', async () => {
  const stub = await startStub({});
  await stub.close();
  const out = tempDir();
  const run = await capture([stub.origin, '--out', out, '--delay', '0']);
  assert.equal(run.code, 3, run.stderr);
  assert.equal(readJson(out, 'state.json').phase, 'discover');
});

test('snapshots, text, robots, sitemaps, feeds, links and scripts are written', () => {
  assert.ok(existsSync(join(full, 'pages/home.html')));
  assert.match(readFileSync(join(full, 'text/home.txt'), 'utf8'), /Roofs and siding built to last/);
  assert.ok(existsSync(join(full, 'pages/deleted-post.html')));
  assert.match(readFileSync(join(full, 'robots.txt'), 'utf8'), /Sitemap:/);
  for (const name of ['sitemap_index.xml', 'page-sitemap.xml', 'post-sitemap.xml', 'category-sitemap.xml']) {
    assert.ok(existsSync(join(full, 'sitemaps', name)), name);
  }
  const index = readJson(full, 'sitemaps/index.json');
  assert.deepEqual(index.find((e) => e.url.endsWith('/page-sitemap.xml')), { url: `${fixture.origin}/page-sitemap.xml`, status: 200, file: 'sitemaps/page-sitemap.xml' });
  assert.deepEqual(readJson(full, 'meta.json').icons, { '/favicon.ico': 404, '/apple-touch-icon.png': 404 });
  assert.match(readFileSync(join(full, 'feeds/feed.xml'), 'utf8'), /<rss/);
  assert.deepEqual(readJson(full, 'feeds/index.json').map((f) => f.path), ['/feed/']);

  const links = readJson(full, 'links.json');
  assert.deepEqual(links.internal['/hidden-page/'], ['/']);
  assert.ok(links.internal['/wp-content/uploads/2026/01/brochure.pdf'].length > 0);

  const scripts = readJson(full, 'scripts.json');
  assert.equal(scripts.ga4.id, 'G-FIXTURE1');
  assert.equal(scripts.gtm.id, 'GTM-FIXTURE');
  assert.ok(scripts.ga4.pages.includes('/'));
  assert.ok(!('other' in scripts));

  const state = readJson(full, 'state.json');
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.queue, []);
});

test('a blocked crawl exits 3 with a resumable state, and --resume finishes it', async () => {
  const probe = await startFixture();
  const { port } = new URL(probe.origin);
  await probe.close();

  const out = tempDir();
  // 6 discovery requests, 6 REST requests (5 types and the optional users), then 6 crawl requests.
  const blocking = await startFixture({ port: Number(port), blockAfter: 18 });
  const stopped = await capture([blocking.origin, '--out', out, '--delay', '0', '--seed', '/old-services']);
  await blocking.close();
  assert.equal(stopped.code, 3, stopped.stderr);
  assert.match(stopped.stderr, /--resume/);
  const state = readJson(out, 'state.json');
  assert.equal(state.phase, 'crawl');
  assert.ok(state.queue.length > 0);
  assert.ok(state.records.length > 0, 'some pages were captured before the block');
  assert.ok(state.records.every((r) => !('text' in r) && !('jsonLd' in r)), 'text and JSON-LD stay on disk');

  const open = await startFixture({ port: Number(port) });
  const resumed = await capture([open.origin, '--out', out, '--delay', '0', '--resume']);
  await open.close();
  assert.equal(resumed.code, 0, resumed.stderr);
  const paths = (dir) => readJson(dir, 'inventory.json').map((r) => r.path).sort();
  assert.deepEqual(paths(out), paths(full));
  assert.equal(readJson(out, 'inventory.json').length, 14);
  const froms = readJson(out, 'redirects.json').map((r) => r.from);
  assert.equal(new Set(froms).size, froms.length, 'no duplicate redirects');
  assert.deepEqual(froms, readJson(full, 'redirects.json').map((r) => r.from));
  const home = readJson(out, 'inventory.json').find((r) => r.path === '/');
  assert.match(home.text, /Roofs and siding/, 'text of a page captured before the block is read back');
  assert.ok(readJson(out, 'redirects.json').some((r) => r.from === '/old-services'));
});

test('the REST dump is saved and its paths join the inventory; --no-rest skips it', async () => {
  for (const type of ['pages', 'posts', 'media', 'categories', 'tags']) {
    assert.ok(existsSync(join(full, 'wp-rest', `${type}.json`)), type);
  }
  const posts = readJson(full, 'inventory.json').filter((r) => r.bodyClasses.includes('single-post'));
  assert.equal(posts.length, 3);
  assert.ok(posts.every((r) => r.foundBy.includes('rest')));
  assert.ok(!fullRequests.some((u) => u.startsWith('/wp-json/') && !u.startsWith('/wp-json/wp/v2/')), 'only the v2 lists');

  const out = tempDir();
  const before = fixture.requests.length;
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--no-rest']);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(!fixture.requests.slice(before).some((u) => u.startsWith('/wp-json')));
  assert.ok(!existsSync(join(out, 'wp-rest')));
  const inventory = readJson(out, 'inventory.json');
  assert.equal(inventory.length, 13);
  assert.ok(!inventory.some((r) => r.path === '/private-page/'));
  assert.ok(inventory.every((r) => !r.foundBy.includes('rest')));
});

test('Wayback paths the crawl did not find are written as unverified', () => {
  assert.equal(readFileSync(join(full, 'wayback-unverified.txt'), 'utf8'), '/2019/05/summer-sale/\n/old-team/\n');
  assert.deepEqual(readJson(full, 'meta.json').wayback, { status: 'ok', paths: 2 });
  const host = new URL(fixture.origin).host;
  assert.ok(cdx.requests.some((u) => u.includes(`url=${host}/*`)));
});

test('a Wayback failure is recorded in meta.json and never fails the capture; --no-wayback skips it', async () => {
  const closed = await startCdx();
  await closed.close();
  const out = tempDir();
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--no-rest'], { wayback: closed.endpoint });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readFileSync(join(out, 'wayback-unverified.txt'), 'utf8'), '');
  const meta = readJson(out, 'meta.json');
  assert.equal(meta.wayback.status, 'failed');
  assert.match(meta.wayback.error, /ECONNREFUSED|fetch failed/);
  assert.match(await readme(out), /^- Wayback: the CDX listing failed \(.+\), so no archived paths were checked$/m);
  // A listing refused for its size (the HTTP layer answers "too-large") is named as such.
  writeFileSync(join(out, 'meta.json'), JSON.stringify({ ...meta, wayback: { status: 'failed', error: 'the Wayback CDX API answered too-large' } }));
  assert.match(await readme(out), /^- Wayback: the CDX listing was refused for size \(too-large\), so no archived paths were checked/m);

  const skipped = tempDir();
  const before = cdx.requests.length;
  const quiet = await capture([fixture.origin, '--out', skipped, '--delay', '0', '--no-rest', '--no-wayback']);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(cdx.requests.length, before, 'no CDX request');
  assert.ok(!existsSync(join(skipped, 'wayback-unverified.txt')));
  assert.deepEqual(readJson(skipped, 'meta.json').wayback, { status: 'skipped' });
});

test('a Wayback listing that fails once is asked again once before it is recorded as failed', async () => {
  const site = await startStub({ '/': { body: '<html><head><title>Home</title></head><body>home</body></html>' } });
  let asked = 0;
  let failures = 1; // the next answers that fail
  const flaky = createServer((req, res) => {
    asked += 1;
    const host = new URL(req.url, 'http://cdx').searchParams.get('url').replace(/\/\*$/, '');
    if (failures > 0) {
      failures -= 1;
      res.writeHead(504);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([['original'], [`http://${host}/old/`]]));
  });
  await new Promise((done) => flaky.listen(0, '127.0.0.1', done));
  try {
    const out = tempDir();
    const run = await capture([site.origin, '--out', out, '--delay', '0'], { wayback: `http://127.0.0.1:${flaky.address().port}/cdx` });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(asked, 2, 'one retry');
    assert.deepEqual(readJson(out, 'meta.json').wayback, { status: 'ok', paths: 1 });
    assert.equal(readFileSync(join(out, 'wayback-unverified.txt'), 'utf8'), '/old/\n');

    asked = 0;
    failures = 2; // both tries fail: recorded as failed, the capture still succeeds
    const failed = tempDir();
    const again = await capture([site.origin, '--out', failed, '--delay', '0'], { wayback: `http://127.0.0.1:${flaky.address().port}/cdx` });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(asked, 2, 'asked twice, never a third time');
    assert.equal(readJson(failed, 'meta.json').wayback.status, 'failed');
    assert.match(readJson(failed, 'meta.json').wayback.error, /504/);
  } finally {
    await site.close();
    await new Promise((done) => { flaky.closeAllConnections(); flaky.close(done); });
  }
});

test('stylesheets and <style> blocks are saved under css/ with a manifest', async () => {
  const shared = '<style>.a { color: red; }</style>';
  const page = (styles) =>
    `<html><head><title>Page</title><link rel="stylesheet" href="/s/main.css?ver=2">${styles}</head><body><a href="/one/">1</a> <a href="/two/">2</a></body></html>`;
  const stub = await startStub({
    '/': { body: page(`${shared}<style>.b { color: blue; }</style>`) },
    '/one/': { body: page(`${shared}<style>.b { color: blue; }</style>`) },
    '/two/': { body: page('<link rel="stylesheet" href="/s/missing.css"><style>.c { margin: 0; }</style>') },
    '/s/main.css?ver=2': { headers: { 'Content-Type': 'text/css' }, body: 'body { margin: 0; }' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const manifest = readJson(out, 'css/manifest.json');
    assert.deepEqual(manifest, [
      { file: '1.css', href: `${stub.origin}/s/main.css?ver=2`, pages: ['/', '/one/', '/two/'] },
      { file: 'inline-home.css', inline: true, pages: ['/', '/one/'] },
      { file: null, href: `${stub.origin}/s/missing.css`, pages: ['/two/'], status: 404 },
      { file: 'inline-two.css', inline: true, pages: ['/two/'] },
    ]);
    assert.equal(readFileSync(join(out, 'css/1.css'), 'utf8'), 'body { margin: 0; }');
    assert.equal(readFileSync(join(out, 'css/inline-home.css'), 'utf8'), '.a { color: red; }\n.b { color: blue; }\n');
    assert.equal(readFileSync(join(out, 'css/inline-two.css'), 'utf8'), '.c { margin: 0; }\n');
    assert.deepEqual(readdirSync(join(out, 'css')).sort(), ['1.css', 'inline-home.css', 'inline-two.css', 'manifest.json']);
    assert.equal(stub.requests.filter((u) => u === '/s/main.css?ver=2').length, 1, 'each stylesheet is fetched once');
  } finally {
    await stub.close();
  }
});

test('@import is followed into css/, on the site and on other hosts, cycle-safe, each sheet recording its importer', async () => {
  const remote = await startStub({ '/fonts.css': { headers: { 'Content-Type': 'text/css' }, body: '.remote { color: red; }' } });
  // A copy of the fixture where the about page also links an editor stylesheet that imports a
  // stylesheet on another host and a part that imports it back. (Added to the copy only: the
  // gates build their dist from the fixture's own files.)
  const root = tempDir();
  cpSync(SITE, root, { recursive: true });
  const about = join(root, 'about', 'index.html');
  const link = '<link rel="stylesheet" href="{{ORIGIN}}/wp-content/themes/fixture/css/editor.css">';
  writeFileSync(about, readFileSync(about, 'utf8').replace('</head>', `${link}\n</head>`));
  const css = join(root, 'wp-content/themes/fixture/css');
  mkdirSync(join(css, 'parts'), { recursive: true });
  writeFileSync(join(css, 'editor.css'), `@import url("${remote.origin}/fonts.css");\n@import url("parts/base.css");\n.editor-note { color: #444; }\n`);
  writeFileSync(join(css, 'parts', 'base.css'), '@import "../editor.css" screen;\n.editor-base { margin: 0; }\n');
  const site = await startFixture({ root });
  try {
    const out = tempDir();
    // The address guard refuses another host on a loopback address; the only other host a
    // capture trusts is the CDX endpoint, so pointing CAPTURE_WAYBACK_CDX at the stand-in makes
    // it a reachable "other host" here (its CDX request answers 404, which is never fatal).
    const run = await capture([site.origin, '--out', out, '--delay', '0', '--no-rest'], { wayback: `${remote.origin}/cdx` });
    assert.equal(run.code, 0, run.stderr);
    const theme = `${site.origin}/wp-content/themes/fixture`;
    const manifest = readJson(out, 'css/manifest.json');
    const entry = (href) => manifest.find((e) => e.href === href);
    const linked = entry(`${theme}/css/editor.css`);
    const part = entry(`${theme}/css/parts/base.css`);
    const other = entry(`${remote.origin}/fonts.css`);
    assert.deepEqual(linked.pages, ['/about/']);
    assert.deepEqual(linked.importedBy, [part.href], 'the cycle back is recorded, not followed again');
    assert.deepEqual(part.importedBy, [linked.href]);
    assert.deepEqual(part.pages, ['/about/'], 'an imported sheet serves the pages of its importer');
    assert.deepEqual(other.importedBy, [linked.href]);
    assert.deepEqual(other.pages, ['/about/']);
    assert.ok(!('importedBy' in entry(`${theme}/style.css?ver=1.4.2`)));
    assert.match(readFileSync(join(out, 'css', part.file), 'utf8'), /\.editor-base/);
    assert.equal(readFileSync(join(out, 'css', other.file), 'utf8'), '.remote { color: red; }');
    assert.equal(site.requests.filter((u) => u === '/wp-content/themes/fixture/css/editor.css').length, 1);
    assert.equal(site.requests.filter((u) => u === '/wp-content/themes/fixture/css/parts/base.css').length, 1);
    assert.equal(remote.requests.filter((u) => u === '/fonts.css').length, 1);

    // Untrusted, the same import goes through the guard: listed with its refusal, never requested.
    const guarded = tempDir();
    const asked = remote.requests.length;
    const plain = await capture([site.origin, '--out', guarded, '--delay', '0', '--no-rest']);
    assert.equal(plain.code, 0, plain.stderr);
    const refused = readJson(guarded, 'css/manifest.json').find((e) => e.href === `${remote.origin}/fonts.css`);
    assert.deepEqual(refused, { file: null, href: `${remote.origin}/fonts.css`, pages: ['/about/'], status: 'blocked-address', importedBy: [linked.href] });
    assert.equal(remote.requests.length, asked);
  } finally {
    await site.close();
    await remote.close();
  }
});

test('a redirected stylesheet records its final URL, and its @import resolves against it', async () => {
  const css = (body) => ({ headers: { 'Content-Type': 'text/css' }, body });
  const stub = await startStub({
    '/': { body: '<html><head><title>Page</title><link rel="stylesheet" href="/old.css"></head><body>moved</body></html>' },
    '/old.css': { status: 301, headers: { Location: '/new/main.css' } },
    '/new/main.css': css('@import "part.css";\n.main { margin: 0; }'),
    '/new/part.css': css('.part { margin: 0; }'),
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'css/manifest.json'), [
      { file: '1.css', href: `${stub.origin}/old.css`, finalUrl: `${stub.origin}/new/main.css`, pages: ['/'] },
      { file: '2.css', href: `${stub.origin}/new/part.css`, pages: ['/'], importedBy: [`${stub.origin}/old.css`] },
    ]);
  } finally {
    await stub.close();
  }
});

test('@import is followed 5 levels deep; a deeper sheet is listed "too-deep" and not requested', async () => {
  const routes = { '/': { body: '<html><head><title>Page</title><link rel="stylesheet" href="/d0.css"></head><body>deep</body></html>' } };
  for (let n = 0; n <= 7; n += 1) {
    routes[`/d${n}.css`] = { headers: { 'Content-Type': 'text/css' }, body: `@import "d${n + 1}.css";\n.d${n} { margin: 0; }` };
  }
  const stub = await startStub(routes);
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const manifest = readJson(out, 'css/manifest.json');
    assert.deepEqual(manifest.map((e) => `${new URL(e.href).pathname}:${e.file ? 'saved' : e.status}`), [
      '/d0.css:saved', '/d1.css:saved', '/d2.css:saved', '/d3.css:saved', '/d4.css:saved', '/d5.css:saved', '/d6.css:too-deep',
    ]);
    assert.deepEqual(manifest[6].importedBy, [`${stub.origin}/d5.css`]);
    assert.ok(!stub.requests.includes('/d6.css'));
  } finally {
    await stub.close();
  }
});

test('module scripts, the import map and modulepreload files land in js/ with their kind', () => {
  const manifest = readJson(full, 'js/manifest.json');
  const theme = `${fixture.origin}/wp-content/themes/fixture/js`;
  const modules = `${fixture.origin}/wp-includes/js/script-modules`;
  assert.deepEqual(manifest.map(({ src, kind, pages }) => ({ src, kind, pages })), [
    { src: `${modules}/interactivity/index.min.js?ver=6.6.2`, kind: 'importmap', pages: ['/'] },
    { src: `${theme}/util.js`, kind: 'importmap', pages: ['/'] },
    { src: `${theme}/view.js?ver=1.4.2`, kind: 'module', pages: ['/'] },
    { src: `${theme}/reveal.js?ver=1.4.2`, kind: 'script', pages: manifest[3].pages },
    { src: `${modules}/a11y/index.min.js?ver=6.6.2`, kind: 'modulepreload', pages: ['/'] },
  ]);
  for (const entry of manifest) {
    assert.ok(entry.file, entry.src);
    assert.ok(readFileSync(join(full, 'js', entry.file), 'utf8').length > 0, entry.src);
  }
  assert.match(readFileSync(join(full, 'js', manifest[0].file), 'utf8'), /export const store/);
  assert.match(readFileSync(join(full, 'js', manifest[2].file), 'utf8'), /@wordpress\/interactivity/);
});

test('first-party <script src> files are saved under js/ with a manifest; vendors and inline code are not', async () => {
  const page = (extra) =>
    `<html><head><title>Page</title><script src="https://www.googletagmanager.com/gtag/js?id=G-X1"></script><script>var inline = 1;</script></head>`
    + `<body><a href="/one/">1</a><script src="/js/site.js?ver=3"></script>${extra}</body></html>`;
  const stub = await startStub({
    '/': { body: page('') },
    '/one/': { body: page('<script src="/js/gone.js"></script>') },
    '/js/site.js?ver=3': { headers: { 'Content-Type': 'text/javascript' }, body: 'document.body.className += " js";' },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'js/manifest.json'), [
      { file: '1.js', src: `${stub.origin}/js/site.js?ver=3`, kind: 'script', pages: ['/', '/one/'] },
      { file: null, src: `${stub.origin}/js/gone.js`, kind: 'script', pages: ['/one/'], status: 404 },
    ]);
    assert.equal(readFileSync(join(out, 'js/1.js'), 'utf8'), 'document.body.className += " js";');
    assert.deepEqual(readdirSync(join(out, 'js')).sort(), ['1.js', 'manifest.json']);
    assert.equal(stub.requests.filter((u) => u === '/js/site.js?ver=3').length, 1, 'each script is fetched once');
  } finally {
    await stub.close();
  }
});

test('js/: an on-site redirect is followed, an off-site one is not, a file over 5 MB is not saved, and the manifest is always written', async () => {
  const page = (scripts) => `<html><head><title>Page</title></head><body>${scripts.map((s) => `<script src="${s}"></script>`).join('')}</body></html>`;
  const stub = await startStub({
    '/': { body: page(['/js/moved.js', '/js/away.js', '/js/huge.js']) },
    '/js/moved.js': { status: 301, headers: { Location: '/js/new.js' } },
    '/js/new.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'var moved = 1;' },
    '/js/away.js': (origin) => ({ status: 302, headers: { Location: origin.replace('127.0.0.1', 'localhost') + '/elsewhere.js' } }),
    '/js/huge.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'x'.repeat(5 * 1024 * 1024 + 1) },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'js/manifest.json'), [
      { file: '1.js', src: `${stub.origin}/js/moved.js`, kind: 'script', pages: ['/'] },
      { file: null, src: `${stub.origin}/js/away.js`, kind: 'script', pages: ['/'], status: 'off-site' },
      { file: null, src: `${stub.origin}/js/huge.js`, kind: 'script', pages: ['/'], status: 'too-large' },
    ]);
    assert.equal(readFileSync(join(out, 'js/1.js'), 'utf8'), 'var moved = 1;');
    assert.deepEqual(readdirSync(join(out, 'js')).sort(), ['1.js', 'manifest.json']);
    assert.ok(!stub.requests.includes('/elsewhere.js'), 'the off-site target is never requested');
  } finally {
    await stub.close();
  }

  const none = await startStub({ '/': { body: '<html><head><title>Page</title></head><body><p>No scripts.</p></body></html>' } });
  try {
    const out = tempDir();
    const run = await capture([none.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readJson(out, 'js/manifest.json'), []);
  } finally {
    await none.close();
  }
});

test('--seed-file, --seed and --include-query given on --resume are honoured', async () => {
  const out = tempDir();
  const first = await capture([fixture.origin, '--out', out, '--delay', '0', '--no-rest', '--max', '3']);
  assert.equal(first.code, 0, first.stderr);
  const seeds = join(out, 'seeds.txt');
  writeFileSync(seeds, '# old URLs from the previous host\n/old-services\n\n  /about  \n');
  const before = fixture.requests.length;
  const resumed = await capture([
    fixture.origin, '--out', out, '--delay', '0', '--resume', '--seed-file', seeds, '--seed', '/contact/?utm=1', '--include-query',
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const requested = fixture.requests.slice(before);
  for (const path of ['/old-services', '/about', '/contact/?utm=1']) assert.ok(requested.includes(path), path);
  const redirects = readJson(out, 'redirects.json');
  assert.deepEqual(redirects.find((r) => r.from === '/old-services'), { from: '/old-services', to: '/services/', status: 301, source: 'seed', hops: ['/old-services/'] });
  assert.deepEqual(redirects.find((r) => r.from === '/about'), { from: '/about', to: '/about/', status: 301, source: 'seed', hops: [] });
  const contact = readJson(out, 'inventory.json').find((r) => r.path === '/contact/?utm=1');
  assert.equal(contact?.status, 200);
  assert.ok(contact.foundBy.includes('seed'), contact.foundBy);
  const options = readJson(out, 'meta.json').options;
  assert.equal(options.includeQuery, true);
  assert.deepEqual(options.seeds, ['/old-services', '/about', '/contact/?utm=1']);

  const missing = await capture([fixture.origin, '--out', tempDir(), '--seed-file', join(out, 'no-such-file.txt')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no-such-file\.txt/);
});

test('the Wayback second pass verifies archived paths on a finished capture and the README notes the results', async () => {
  const archive = await startCdx(['/old-services', '/old-team/']);
  try {
    const out = tempDir();
    const first = await capture([fixture.origin, '--out', out, '--delay', '0', '--no-rest'], { wayback: archive.endpoint });
    assert.equal(first.code, 0, first.stderr);
    const list = join(out, 'wayback-unverified.txt');
    assert.equal(readFileSync(list, 'utf8'), '/old-services\n/old-team/\n');
    assert.match(await readme(out), /Wayback second pass: 0 of 2 archived paths verified/);

    const asked = archive.requests.length;
    const second = await capture([fixture.origin, '--out', out, '--delay', '0', '--resume', '--seed-file', list], { wayback: archive.endpoint });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(archive.requests.length, asked, 'the Wayback Machine is not asked again');
    assert.equal(readFileSync(list, 'utf8'), '/old-services\n/old-team/\n', 'the list is kept as it was');
    const redirect = readJson(out, 'redirects.json').find((r) => r.from === '/old-services');
    assert.deepEqual(redirect, { from: '/old-services', to: '/services/', status: 301, source: 'seed', hops: ['/old-services/'] });
    const gone = readJson(out, 'inventory.json').find((r) => r.path === '/old-team/');
    assert.equal(gone.status, 404);
    assert.deepEqual(gone.foundBy, ['seed']);
    assert.ok(readJson(out, 'meta.json').finishedAt);
    assert.equal(readJson(out, 'state.json').phase, 'done');

    const notes = await readme(out);
    assert.match(notes, /Wayback second pass: 2 of 2 archived paths verified/);
    assert.match(notes, /^ {2}- \/old-services: 301 to \/services\/ \(via \/old-services\/\)$/m);
    assert.match(notes, /^ {2}- \/old-team\/: 404$/m);
    // Notes written by hand survive a regeneration, and the generated lines are not repeated.
    const file = join(out, 'README.md');
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\nChecked by hand.\n`);
    const again = await readme(out);
    assert.equal(again.split('Wayback second pass').length, 2, again);
    assert.ok(again.endsWith('Checked by hand.\n'), again);
  } finally {
    await archive.close();
  }
});

test('--max 3 fetches exactly 3 pages', async () => {
  const out = tempDir();
  const run = await capture([fixture.origin, '--out', out, '--delay', '0', '--max', '3']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readJson(out, 'inventory.json').length, 3);
});

test('usage errors exit 2 and --help prints usage', async () => {
  const help = await capture(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node capture\.mjs <origin> --out <dir>/);
  assert.match(help.stdout, /--no-wayback/);
  assert.match(help.stdout, /--seed-file <path>/);
  assert.match(help.stdout, /CAPTURE_WAYBACK_CDX/);
  assert.match(help.stdout, /media\.mjs/);
  assert.equal((await capture([fixture.origin])).code, 2, 'missing --out');
  assert.equal((await capture(['not-a-url', '--out', tempDir()])).code, 2);
  assert.equal((await capture([fixture.origin, '--out', tempDir(), '--resume'])).code, 2, 'nothing to resume');
});

test('a host that answers every request with a bot challenge stops the capture at the home page: SiteGround and Cloudflare', async () => {
  for (const [host, provider, cause] of [
    ['siteground', 'SiteGround', /202 .*\/\.well-known\/sgcaptcha\//],
    ['cloudflare', 'Cloudflare', /403 with cf-mitigated: challenge/],
  ]) {
    const site = await startFixture({ challenge: host });
    try {
      const out = tempDir();
      const run = await capture([site.origin, '--out', out, '--delay', '0']);
      assert.equal(run.code, 3, run.stderr);
      assert.match(run.stderr, new RegExp(`^blocked: ${provider} anti-bot challenge \\(`, 'm'));
      assert.match(run.stderr, cause);
      assert.match(run.stderr, /--resume/);
      assert.doesNotMatch(run.stdout, /Captured/);
      assert.deepEqual(site.requests, ['/'], 'one request, no retries');
      const inventory = readJson(out, 'inventory.json');
      assert.deepEqual(inventory.map((r) => `${r.path}:${r.status}`), ['/:challenge']);
      assert.match(inventory[0].challenge, cause);
      assert.equal(inventory[0].snapshot, null, 'never saved as a page');
      assert.equal(readJson(out, 'state.json').phase, 'discover');
      assert.equal(readJson(out, 'meta.json').challenge.provider, provider);
      const notes = await readme(out);
      assert.match(notes, new RegExp(`^- Stopped by a ${provider} anti-bot challenge at / \\(`, 'm'));
      assert.match(notes, cause);
    } finally {
      await site.close();
    }
  }
});

test('a challenge partway through the crawl stops it with the URL queued; --resume once allowed finishes without the challenge row', async () => {
  let allowed = false;
  const titled = (title, links = '') => `<html><head><title>${title}</title></head><body>${links}</body></html>`;
  const stub = await startStub({
    '/': { body: titled('Home', '<a href="/a/">a</a> <a href="/b/">b</a>') },
    '/a/': { body: titled('A') },
    '/b/': () => (allowed
      ? { body: titled('B') }
      : { status: 202, body: '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fb%2F"></head></html>' }),
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    assert.match(run.stderr, /^blocked: SiteGround anti-bot challenge \(/m);
    assert.equal(stub.requests.filter((u) => u === '/b/').length, 1, 'a challenge is not retried');
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:200', '/a/:200', '/b/:challenge']);
    const state = readJson(out, 'state.json');
    assert.equal(state.phase, 'crawl');
    assert.equal(new URL(state.queue[0].url).pathname, '/b/');

    allowed = true;
    const resumed = await capture([stub.origin, '--out', out, '--delay', '0', '--resume']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:200', '/a/:200', '/b/:200']);
    assert.equal(readJson(out, 'meta.json').challenge, null);
  } finally {
    await stub.close();
  }
});

test('a capture where no page answers 200 exits 3, not 0', async () => {
  const stub = await startStub({});
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    assert.match(run.stderr, /no page answered 200/);
    assert.match(run.stderr, /--seed/);
    assert.doesNotMatch(run.stdout, /Captured/);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:404']);
  } finally {
    await stub.close();
  }
});

test('the live 404 page is captured once, from a path that cannot exist, as pages/404.html and meta.json notFound', () => {
  const meta = readJson(full, 'meta.json');
  assert.equal(meta.notFound.status, 404);
  assert.match(meta.notFound.path, /^\/[0-9a-f]{32}\/$/);
  assert.equal(meta.notFound.snapshot, 'pages/404.html');
  assert.equal(meta.notFound.text, 'text/404.txt');
  assert.equal(fullRequests.filter((u) => u === meta.notFound.path).length, 1);
  assert.match(readFileSync(join(full, 'pages/404.html'), 'utf8'), /<title>Page not found \| Fixture Roofing &amp; Siding<\/title>/);
  assert.match(readFileSync(join(full, 'text/404.txt'), 'utf8'), /\S/);
  assert.ok(!readJson(full, 'inventory.json').some((r) => r.path === meta.notFound.path), 'the probe is not a route');
});

test('a site that answers 200 or redirects for a missing path records that, with no 404 page', async () => {
  const titled = (title) => `<html><head><title>${title}</title></head><body>${title}</body></html>`;
  for (const [fallback, expected] of [
    [{ body: titled('Home again') }, { status: 200, snapshot: null }],
    [{ status: 302, headers: { Location: '/' } }, { status: 302, location: '/', snapshot: null }],
  ]) {
    // Any path the stub does not know answers `fallback`, the way a soft-404 site does.
    const site = await startStub(new Proxy({ '/': { body: titled('Home') } }, {
      get: (routes, key) => routes[key] ?? (/^\/[0-9a-f]{32}\/$/.test(key) ? fallback : undefined),
    }));
    try {
      const out = tempDir();
      const run = await capture([site.origin, '--out', out, '--delay', '0']);
      assert.equal(run.code, 0, run.stderr);
      const { notFound } = readJson(out, 'meta.json');
      assert.equal(notFound.status, expected.status);
      assert.equal(notFound.snapshot, expected.snapshot);
      if (expected.location) assert.equal(notFound.location, expected.location);
      assert.ok(!existsSync(join(out, 'pages/404.html')));
    } finally {
      await site.close();
    }
  }
});

test('every sitemap robots.txt names is fetched, saved under sitemaps/ and crawled, even one named nowhere else', async () => {
  const urlset = (origin, paths) => `<urlset>${paths.map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`;
  const xml = (body) => (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: body(origin) });
  const titled = (title) => `<html><head><title>${title}</title></head><body>${title}</body></html>`;
  const stub = await startStub({
    '/': { body: titled('Home') },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\r\nSitemap: /sitemap_index.xml\r\nsitemap: /wp-sitemap.xml\r\n' },
    '/sitemap_index.xml': xml((o) => `<sitemapindex><sitemap><loc>${o}/page-sitemap.xml</loc></sitemap></sitemapindex>`),
    '/page-sitemap.xml': xml((o) => urlset(o, ['/'])),
    '/wp-sitemap.xml': xml((o) => `<sitemapindex><sitemap><loc>${o}/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>`),
    '/wp-sitemap-posts-page-1.xml': xml((o) => urlset(o, ['/only-here/'])),
    '/only-here/': { body: titled('Only here') },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    for (const name of ['sitemap_index.xml', 'page-sitemap.xml', 'wp-sitemap.xml', 'wp-sitemap-posts-page-1.xml']) {
      assert.ok(existsSync(join(out, 'sitemaps', name)), name);
    }
    const onlyHere = readJson(out, 'inventory.json').find((r) => r.path === '/only-here/');
    assert.equal(onlyHere?.status, 200);
    assert.deepEqual(onlyHere.foundBy, ['sitemap']);
    const fp = readJson(out, 'state.json').fingerprint;
    assert.deepEqual(fp.robotsSitemaps.map((u) => new URL(u).pathname), ['/sitemap_index.xml', '/wp-sitemap.xml']);
    for (const path of ['/sitemap_index.xml', '/wp-sitemap.xml', '/page-sitemap.xml', '/wp-sitemap-posts-page-1.xml']) {
      assert.equal(stub.requests.filter((u) => u === path).length, 1, `${path} is requested once`);
    }
  } finally {
    await stub.close();
  }
});

test('a sitemap robots.txt names on another host is recorded as skipped, never fetched, and leaves the site files intact', () => {
  assert.match(readFileSync(join(full, 'robots.txt'), 'utf8'), /^Sitemap: http:\/\/other\.example\.com\/sitemap_index\.xml$/m);
  const index = readJson(full, 'sitemaps/index.json');
  assert.deepEqual(index.find((e) => e.url.startsWith('http://other.example.com/')), {
    url: 'http://other.example.com/sitemap_index.xml', host: 'other.example.com', skipped: 'other host',
  });
  const own = index.filter((e) => e.url.startsWith(fixture.origin) && e.file);
  assert.deepEqual(own.map((e) => e.file).sort(), [
    'sitemaps/category-sitemap.xml', 'sitemaps/page-sitemap.xml', 'sitemaps/post-sitemap.xml', 'sitemaps/sitemap_index.xml',
  ]);
  assert.match(readFileSync(join(full, 'sitemaps/sitemap_index.xml'), 'utf8'), new RegExp(`${fixture.origin}/page-sitemap\\.xml`));
  assert.ok(!readJson(full, 'meta.json').discoveryErrors.some((e) => e.url.includes('other.example.com')), 'a skipped sitemap is not an error');
});

test('a foreign sitemap named first in robots.txt is skipped, never requested, and the site sitemap is still read', async () => {
  const xml = (body) => (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: body(origin) });
  const titled = (title) => `<html><head><title>${title}</title></head><body>${title}</body></html>`;
  const other = await startStub({
    '/sitemap_index.xml': xml(() => '<sitemapindex><sitemap><loc>http://other.example.com/page-sitemap.xml</loc></sitemap></sitemapindex>'),
  });
  const otherUrl = `${other.origin.replace('127.0.0.1', 'localhost')}/sitemap_index.xml`;
  const stub = await startStub({
    '/': { body: titled('Home') },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: `Sitemap: ${otherUrl}\nSitemap: /sitemap_index.xml\n` },
    '/sitemap_index.xml': xml((o) => `<sitemapindex><sitemap><loc>${o}/page-sitemap.xml</loc></sitemap></sitemapindex>`),
    '/page-sitemap.xml': xml((o) => `<urlset><url><loc>${o}/</loc></url><url><loc>${o}/listed/</loc></url></urlset>`),
    '/listed/': { body: titled('Listed') },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(other.requests, [], 'the other host is never asked');
    const index = readJson(out, 'sitemaps/index.json');
    assert.deepEqual(index.find((e) => e.url === otherUrl), { url: otherUrl, host: new URL(otherUrl).host, skipped: 'other host' });
    assert.deepEqual(index.filter((e) => !e.skipped).map((e) => e.file).sort(), ['sitemaps/page-sitemap.xml', 'sitemaps/sitemap_index.xml']);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => r.path), ['/', '/listed/']);
    assert.deepEqual(readJson(out, 'meta.json').discoveryErrors, []);
  } finally {
    await stub.close();
    await other.close();
  }
});

test('two sitemap URLs with one file name are saved under different names, never overwritten', async () => {
  const xml = (body) => (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: body(origin) });
  const titled = (title) => `<html><head><title>${title}</title></head><body>${title}</body></html>`;
  const urlset = (origin, path) => `<urlset><url><loc>${origin}${path}</loc></url></urlset>`;
  const stub = await startStub({
    '/': { body: titled('Home') },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'Sitemap: /sitemap_index.xml\n' },
    '/sitemap_index.xml': xml((o) => `<sitemapindex><sitemap><loc>${o}/en/page-sitemap.xml</loc></sitemap><sitemap><loc>${o}/es/page-sitemap.xml</loc></sitemap></sitemapindex>`),
    '/en/page-sitemap.xml': xml((o) => urlset(o, '/en/')),
    '/es/page-sitemap.xml': xml((o) => urlset(o, '/es/')),
    '/en/': { body: titled('English') },
    '/es/': { body: titled('Spanish') },
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const index = readJson(out, 'sitemaps/index.json');
    const fileOf = (path) => index.find((e) => e.url === `${stub.origin}${path}`).file;
    assert.equal(fileOf('/en/page-sitemap.xml'), 'sitemaps/page-sitemap.xml');
    assert.equal(fileOf('/es/page-sitemap.xml'), 'sitemaps/page-sitemap-es.xml');
    assert.match(readFileSync(join(out, 'sitemaps/page-sitemap.xml'), 'utf8'), /\/en\//);
    assert.match(readFileSync(join(out, 'sitemaps/page-sitemap-es.xml'), 'utf8'), /\/es\//);
  } finally {
    await stub.close();
  }
});

const untitled = { body: '<html><body><p>tiny</p></body></html>' };
const titledPage = (title, links = '') => ({ body: `<html><head><title>${title}</title></head><body>${links}</body></html>` });

test('a tiny untitled page as the first HTML response stops the capture as a challenge', async () => {
  const stub = await startStub({ '/': untitled });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    assert.match(run.stderr, /^blocked: 127\.0\.0\.1 anti-bot challenge \(200 with a \d+-byte page and no title\)/m);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:challenge']);
  } finally {
    await stub.close();
  }
});

test('a single tiny untitled page mid-crawl is recorded "suspect-challenge" with a README note, and the crawl goes on', async () => {
  const stub = await startStub({
    '/': titledPage('Home', '<a href="/empty/">e</a> <a href="/b/">b</a>'),
    '/empty/': untitled,
    '/b/': titledPage('B'),
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    const inventory = readJson(out, 'inventory.json');
    assert.deepEqual(inventory.map((r) => `${r.path}:${r.status}`), ['/:200', '/b/:200', '/empty/:suspect-challenge']);
    const suspect = inventory.find((r) => r.path === '/empty/');
    assert.equal(suspect.snapshot, null);
    assert.match(suspect.challenge, /no title/);
    assert.equal(readJson(out, 'meta.json').challenge, null);
    assert.match(await readme(out), /^- Suspected bot challenge, not captured: \/empty\/ \(200 with a \d+-byte page and no title\)/m);
  } finally {
    await stub.close();
  }
});

test('three tiny untitled pages in a row stop the capture; all three are queued again for --resume', async () => {
  const stub = await startStub({
    '/': titledPage('Home', '<a href="/a/">a</a> <a href="/b/">b</a> <a href="/c/">c</a> <a href="/d/">d</a>'),
    '/a/': untitled,
    '/b/': untitled,
    '/c/': untitled,
    '/d/': titledPage('D'),
  });
  try {
    // One at a time nothing after /c/ is asked for; with 4 in flight /d/ may already have been
    // fetched ahead, but it is not recorded and stays queued.
    for (const concurrency of ['1', '4']) {
      stub.requests.length = 0;
      const out = tempDir();
      const run = await capture([stub.origin, '--out', out, '--delay', '0', '--concurrency', concurrency]);
      assert.equal(run.code, 3, run.stderr);
      assert.match(run.stderr, /^blocked: 127\.0\.0\.1 anti-bot challenge \(/m);
      assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:200', '/a/:challenge', '/b/:challenge', '/c/:challenge']);
      const state = readJson(out, 'state.json');
      assert.deepEqual(state.queue.map((q) => new URL(q.url).pathname), ['/a/', '/b/', '/c/', '/d/']);
      if (concurrency === '1') assert.ok(!stub.requests.includes('/d/'), 'the crawl stopped');
    }
  } finally {
    await stub.close();
  }
});

test('a real tiny untitled home page stops the capture once; on --resume it is a suspect and --seed supplies real pages', async () => {
  const stub = await startStub({ '/': untitled, '/real/': titledPage('Real') });
  try {
    const out = tempDir();
    const first = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(first.code, 3, first.stderr);
    assert.match(first.stderr, /--seed/);
    const again = await capture([stub.origin, '--out', out, '--delay', '0', '--resume', '--seed', '/real/']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`), ['/:suspect-challenge', '/real/:200']);
  } finally {
    await stub.close();
  }
});

test('three real tiny untitled pages stop the capture once; on --resume they are suspects and the crawl goes on', async () => {
  const stub = await startStub({
    '/': titledPage('Home', '<a href="/a/">a</a> <a href="/b/">b</a> <a href="/c/">c</a> <a href="/d/">d</a>'),
    '/a/': untitled,
    '/b/': untitled,
    '/c/': untitled,
    '/d/': titledPage('D'),
  });
  try {
    const out = tempDir();
    assert.equal((await capture([stub.origin, '--out', out, '--delay', '0'])).code, 3);
    const again = await capture([stub.origin, '--out', out, '--delay', '0', '--resume']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(
      readJson(out, 'inventory.json').map((r) => `${r.path}:${r.status}`),
      ['/:200', '/a/:suspect-challenge', '/b/:suspect-challenge', '/c/:suspect-challenge', '/d/:200'],
    );
  } finally {
    await stub.close();
  }
});

test('suspects reached through redirects are recorded and queued again under the same URL', async () => {
  const hop = (to) => ({ status: 301, headers: { Location: to } });
  const stub = await startStub({
    '/': titledPage('Home', '<a href="/r1/">1</a> <a href="/r2/">2</a> <a href="/r3/">3</a>'),
    '/r1/': hop('/t1/'),
    '/r2/': hop('/t2/'),
    '/r3/': hop('/t3/'),
    '/t1/': untitled,
    '/t2/': untitled,
    '/t3/': untitled,
  });
  try {
    const out = tempDir();
    const run = await capture([stub.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 3, run.stderr);
    const rows = readJson(out, 'inventory.json').filter((r) => r.status === 'challenge').map((r) => r.path);
    const queued = readJson(out, 'state.json').queue.slice(0, 3).map((q) => new URL(q.url).pathname);
    assert.deepEqual(queued, ['/t1/', '/t2/', '/r3/']);
    assert.deepEqual(rows.sort(), [...queued].sort());
  } finally {
    await stub.close();
  }
});

test('a 404 probe that is blocked leaves notFound unset, so a resume asks again', async () => {
  let answer = { status: 503, headers: { 'Content-Type': 'text/plain' }, body: 'busy' };
  const site = await startStub(new Proxy({ '/': titledPage('Home') }, {
    get: (routes, key) => routes[key] ?? (/^\/[0-9a-f]{32}\/$/.test(key) ? answer : undefined),
  }));
  try {
    const out = tempDir();
    const run = await capture([site.origin, '--out', out, '--delay', '0']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(readJson(out, 'meta.json').notFound, null);
    answer = { status: 404, body: '<html><head><title>Not found</title></head><body>Gone</body></html>' };
    const again = await capture([site.origin, '--out', out, '--delay', '0', '--resume']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(readJson(out, 'meta.json').notFound.status, 404);
    assert.ok(existsSync(join(out, 'pages/404.html')));
  } finally {
    await site.close();
  }
});
