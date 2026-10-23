import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { startStub } from './helpers.mjs';
import { fingerprint } from '../../skills/capture-site/scripts/fingerprint.mjs';
import { fetchPaced, http, resetBlocked } from '../../skills/capture-site/scripts/lib/http.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/capture-site/scripts/fingerprint.mjs', import.meta.url));
const fast = (url, options = {}) => fetchPaced(url, { ...options, delayMs: 0, trusted: [url] });

let fixture;
before(async () => {
  fixture = await startFixture();
});
after(() => fixture.close());

test('the fixture fingerprints as WordPress with REST and 3 sitemaps', async () => {
  const calls = [];
  const counting = (url, options) => {
    calls.push(url);
    return fast(url, options);
  };
  const result = await fingerprint(fixture.origin, { fetch: counting });
  assert.equal(result.platform, 'wordpress');
  assert.equal(result.platformVersion, '6.6.2');
  assert.equal(result.generator, 'WordPress 6.6.2');
  assert.equal(result.theme, 'fixture');
  assert.equal(result.hasRest, true);
  assert.equal(result.hasSitemap, true);
  assert.deepEqual(
    result.sitemapUrls.map((u) => new URL(u).pathname),
    ['/page-sitemap.xml', '/post-sitemap.xml', '/category-sitemap.xml'],
  );
  assert.match(result.robots, /Sitemap: .*\/sitemap_index\.xml/);
  assert.ok(Array.isArray(result.plugins));
  assert.ok(calls.length <= 4, `used ${calls.length} requests`);
});

test('a page whose generator is Webflow fingerprints as webflow', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Home</title><meta name="generator" content="Webflow"></head><body></body></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'webflow');
    assert.equal(result.generator, 'Webflow');
    assert.equal(result.hasRest, false);
    assert.equal(result.hasSitemap, false);
    assert.deepEqual(result.sitemapUrls, []);
    assert.equal(result.robots, '');
    assert.ok(stub.requests.length <= 4);
  } finally {
    await stub.close();
  }
});

test('a Drupal 10 site is drupal with version, theme and /sitemap.xml', async () => {
  const stub = await startStub({
    '/': {
      headers: { 'X-Generator': 'Drupal 10 (https://www.drupal.org)', Server: 'nginx' },
      body: '<html><head><title>Home</title><meta name="Generator" content="Drupal 10 (https://www.drupal.org)">'
        + '<link rel="stylesheet" href="/themes/custom/acme/css/base.css">'
        + '<script src="/modules/contrib/webform/js/webform.js"></script></head>'
        + '<body><img src="/sites/default/files/hero.jpg"></body></html>',
    },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /admin/\n' },
    '/sitemap.xml': (origin) => ({
      headers: { 'Content-Type': 'application/xml' },
      body: `<urlset><url><loc>${origin}/</loc></url></urlset>`,
    }),
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, '10');
    assert.equal(result.theme, 'acme');
    assert.deepEqual(result.plugins, ['webform']);
    assert.equal(result.server, 'nginx');
    assert.deepEqual(result.sitemapUrls, [`${stub.origin}/sitemap.xml`]);
    assert.ok(!stub.requests.includes('/sitemap_index.xml'), 'Drupal goes straight to /sitemap.xml');
    assert.ok(stub.requests.length <= 4);
  } finally {
    await stub.close();
  }
});

test('a Drupal 7 site is recognised by /sites/default/files/ alone', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Home</title></head><body><img src="/sites/default/files/logo.png"></body></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, null);
  } finally {
    await stub.close();
  }
});

test('a Drupal 7 generator string gives version 7', async () => {
  const stub = await startStub({
    '/': { body: '<html><head><title>Home</title><meta name="Generator" content="Drupal 7 (http://drupal.org)"></head></html>' },
  });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'drupal');
    assert.equal(result.platformVersion, '7');
  } finally {
    await stub.close();
  }
});

test('other platforms and plain HTML', async () => {
  const cases = [
    ['<script src="https://cdn.shopify.com/s/x.js"></script>', 'shopify'],
    ['<link href="https://static1.squarespace.com/static/x.css"> Squarespace', 'squarespace'],
    ['<script src="https://static.parastorage.com/x.js"></script><!-- wix.com -->', 'wix'],
    ['<meta name="generator" content="Joomla! - Open Source Content Management">', 'joomla'],
    ['<p>hello</p>', 'static'],
  ];
  for (const [html, platform] of cases) {
    const stub = await startStub({ '/': { body: `<html><head><title>Home</title>${html}</head></html>` } });
    try {
      assert.equal((await fingerprint(stub.origin, { fetch: fast })).platform, platform, html);
    } finally {
      await stub.close();
    }
  }
});

test('an unreachable home page is unknown', async () => {
  const stub = await startStub({});
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'unknown');
  } finally {
    await stub.close();
  }
});

test('fetchPaced counts consecutive blocks and resets on success', async () => {
  const stub = await startStub({ '/ok': { body: 'ok' }, '/no': { status: 429, body: 'slow down' } });
  try {
    resetBlocked();
    await fast(`${stub.origin}/no`);
    await fast(`${stub.origin}/no`);
    assert.equal(http.blocked, 2);
    const ok = await fast(`${stub.origin}/ok`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'ok');
    assert.equal(ok.finalUrl, `${stub.origin}/ok`);
    assert.equal(http.blocked, 0);
    await fast(`${stub.origin}/no`);
    http.resetBlocked();
    assert.equal(http.blocked, 0);
  } finally {
    await stub.close();
  }
});

test('fetchPaced keeps redirects manual by default and counts network errors', async () => {
  const stub = await startStub({ '/old': { status: 301, headers: { Location: '/new' } } });
  try {
    resetBlocked();
    const res = await fast(`${stub.origin}/old`);
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/new');
  } finally {
    await stub.close();
  }
  const dead = await fast(`${stub.origin}/gone`);
  assert.equal(dead.status, 0);
  assert.equal(http.blocked, 1);
  resetBlocked();
});

test('fetchPaced returns status 0 and counts a block when the body is cut off', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '1000' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 50);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    resetBlocked();
    const res = await fast(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 0);
    assert.ok(res.error);
    assert.equal(http.blocked, 1);
  } finally {
    resetBlocked();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('fetchPaced counts 403 and 503 as blocks', async () => {
  const stub = await startStub({ '/403': { status: 403 }, '/503': { status: 503 }, '/404': { status: 404 } });
  try {
    resetBlocked();
    await fast(`${stub.origin}/403`);
    await fast(`${stub.origin}/503`);
    assert.equal(http.blocked, 2);
    await fast(`${stub.origin}/404`);
    assert.equal(http.blocked, 0, 'a 404 is not a block');
  } finally {
    resetBlocked();
    await stub.close();
  }
});

test('fetchPaced doubles the wait after a 429 and restores it after a window of successes', async () => {
  const stub = await startStub({ '/ok': { body: 'ok' }, '/no': { status: 429 } });
  const opts = { delayMs: 100, trusted: [stub.origin], windowMs: 150 };
  try {
    await fetchPaced(`${stub.origin}/no`, opts);
    let started = Date.now();
    await fetchPaced(`${stub.origin}/ok`, opts);
    const doubled = Date.now() - started;
    await new Promise((done) => setTimeout(done, 160));
    await fetchPaced(`${stub.origin}/ok`, opts);
    started = Date.now();
    await fetchPaced(`${stub.origin}/ok`, opts);
    const normal = Date.now() - started;
    assert.ok(doubled >= 190, `waited ${doubled} ms after a 429`);
    assert.ok(normal >= 90 && normal < 180, `waited ${normal} ms after a success`);
  } finally {
    resetBlocked();
    await stub.close();
  }
});

test('fetchPaced returns a Buffer for a binary content type', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const stub = await startStub({ '/a.jpg': { headers: { 'Content-Type': 'image/jpeg' }, body: bytes } });
  try {
    const res = await fast(`${stub.origin}/a.jpg`);
    assert.ok(Buffer.isBuffer(res.body));
    assert.deepEqual(res.body, bytes);
  } finally {
    await stub.close();
  }
});

test('fingerprint stops after the home page when it is blocked or unreachable', async () => {
  const stub = await startStub({ '/': { status: 429 } });
  try {
    const result = await fingerprint(stub.origin, { fetch: fast });
    assert.equal(result.platform, 'unknown');
    assert.equal(result.homeStatus, 429);
    assert.deepEqual(stub.requests, ['/']);
  } finally {
    resetBlocked();
    await stub.close();
  }
  const calls = [];
  const result = await fingerprint(stub.origin, {
    fetch: (url, options) => {
      calls.push(url);
      return fast(url, options);
    },
  });
  assert.equal(result.homeStatus, 0);
  assert.equal(result.platform, 'unknown');
  assert.equal(calls.length, 1);
  resetBlocked();
});

test('fetchPaced waits delayMs between requests to the same host', async () => {
  const stub = await startStub({ '/': { body: 'x' } });
  try {
    await fetchPaced(`${stub.origin}/`, { delayMs: 0, trusted: [stub.origin] });
    const started = Date.now();
    await fetchPaced(`${stub.origin}/`, { delayMs: 150, trusted: [stub.origin] });
    assert.ok(Date.now() - started >= 140);
  } finally {
    await stub.close();
  }
});

test('the CLI prints JSON with --json', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, fixture.origin, '--json', '--delay', '0']);
  const result = JSON.parse(stdout);
  assert.equal(result.platform, 'wordpress');
  assert.equal(result.sitemapUrls.length, 3);
});

test('the CLI prints help and rejects a missing origin', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, '--help']);
  assert.match(stdout, /Usage: node fingerprint\.mjs <origin>/);
  await assert.rejects(run(process.execPath, [SCRIPT]), (err) => err.code === 2);
});

test('the CLI exits 3 when the site blocks and 2 when it is unreachable', async () => {
  const stub = await startStub({ '/': { status: 429 } });
  try {
    await assert.rejects(
      run(process.execPath, [SCRIPT, stub.origin, '--delay', '0']),
      (err) => err.code === 3 && /blocking/.test(err.stderr),
    );
  } finally {
    await stub.close();
  }
  await assert.rejects(
    run(process.execPath, [SCRIPT, stub.origin, '--delay', '0']),
    (err) => err.code === 2 && /Could not reach/.test(err.stderr),
  );
});

test('a bot challenge on the home page stops the fingerprint: SiteGround and Cloudflare', async () => {
  for (const [host, provider, cause] of [
    ['siteground', 'SiteGround', /202 .*\/\.well-known\/sgcaptcha\//],
    ['cloudflare', 'Cloudflare', /403 with cf-mitigated: challenge/],
  ]) {
    const site = await startFixture({ challenge: host });
    try {
      const result = await fingerprint(site.origin, { fetch: fast });
      assert.equal(result.challenge.provider, provider);
      assert.match(result.challenge.cause, cause);
      assert.equal(result.platform, 'unknown');
      assert.deepEqual(result.sitemapUrls, []);
      assert.deepEqual(site.requests, ['/'], 'nothing after the home page');

      await assert.rejects(run(process.execPath, [SCRIPT, site.origin, '--delay', '0']), (err) => {
        assert.equal(err.code, 3);
        assert.match(err.stderr, new RegExp(`^blocked: ${provider} anti-bot challenge \\(`, 'm'));
        assert.match(err.stderr, cause);
        return true;
      });
    } finally {
      resetBlocked();
      await site.close();
    }
  }
});

test('a tiny untitled 200 home page is a challenge named by the site host', async () => {
  const stub = await startStub({ '/': { body: '<html><body><script src="/check.js"></script></body></html>' } });
  try {
    await assert.rejects(
      run(process.execPath, [SCRIPT, stub.origin, '--delay', '0']),
      (err) => err.code === 3 && /^blocked: 127\.0\.0\.1 anti-bot challenge \(200 with a \d+-byte page and no title\)/m.test(err.stderr),
    );
  } finally {
    await stub.close();
  }
});

test('fingerprint reports every sitemap robots.txt names, and lists each one it did not expand', async () => {
  const result = await fingerprint(fixture.origin, { fetch: fast });
  assert.deepEqual(result.robotsSitemaps.map((u) => new URL(u).pathname), ['/sitemap_index.xml']);
  // A Sitemap: line on another host is listed apart and never fetched or expanded.
  assert.deepEqual(result.otherHostSitemaps, ['http://other.example.com/sitemap_index.xml']);
  assert.ok(result.sitemapUrls.every((u) => new URL(u).origin === fixture.origin), result.sitemapUrls.join(' '));

  const xml = (body) => (origin) => ({ headers: { 'Content-Type': 'application/xml' }, body: body(origin) });
  const stub = await startStub({
    '/': { body: '<html><head><title>Home</title></head></html>' },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'Sitemap: /missing-sitemap.xml\nSitemap: /wp-sitemap.xml\n' },
    '/wp-sitemap.xml': xml((o) => `<sitemapindex><sitemap><loc>${o}/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>`),
  });
  try {
    const found = await fingerprint(stub.origin, { fetch: fast });
    assert.deepEqual(found.robotsSitemaps.map((u) => new URL(u).pathname), ['/missing-sitemap.xml', '/wp-sitemap.xml']);
    assert.ok(found.sitemapUrls.some((u) => new URL(u).pathname === '/wp-sitemap.xml'), found.sitemapUrls.join(' '));
    const { stdout } = await run(process.execPath, [SCRIPT, stub.origin, '--delay', '0']);
    assert.match(stdout, /^robots:\s+.*\/missing-sitemap\.xml/m);
    assert.match(stdout, /\/wp-sitemap\.xml/);
  } finally {
    await stub.close();
  }
});
