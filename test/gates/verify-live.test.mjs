import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { makeDist } from './fixtures/make-dist.mjs';
import { createVerifier, REQUEST_TIMEOUT_MS } from '../../skills/parity-gates/scripts/verify-live.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/parity-gates/scripts/verify-live.mjs', import.meta.url));

async function verifyLive(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const TYPES = { '.html': 'text/html', '.xml': 'application/xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

// A static host for a built dist/, the way a deploy serves it: the baseline's redirects (or the
// given ones) answered in one hop, <path>/index.html or index.xml for directory paths, 404 for anything else.
// `noindex` adds X-Robots-Tag: noindex to every response, `blockAfter` answers 429 from then on.
// `sso` answers every request the way Vercel Authentication does without a bypass: a 302 to
// vercel.com/sso-api. `headers` records each request's headers.
function serveDist(dist, { redirects, noindex = false, blockAfter = Infinity, sso = false } = {}) {
  const root = resolve(dist);
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    const url = new URL(req.url, 'http://host');
    const extra = noindex ? { 'X-Robots-Tag': 'noindex' } : {};
    if (headers.length > blockAfter) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      return res.end('Too Many Requests');
    }
    if (sso) {
      res.writeHead(302, { Location: `https://vercel.com/sso-api?url=${encodeURIComponent(url.href)}&nonce=x`, 'X-Robots-Tag': 'noindex' });
      return res.end();
    }
    const rule = redirects.find((r) => r.from === `${url.pathname}${url.search}`) ?? redirects.find((r) => r.from === url.pathname);
    if (rule) {
      res.writeHead(rule.status, { Location: rule.to, ...extra });
      return res.end();
    }
    const target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const candidates = url.pathname.endsWith('/') ? [join(target, 'index.html'), join(target, 'index.xml')] : [target];
    let body;
    let file;
    for (const candidate of candidates) {
      try {
        if (candidate.startsWith(root + sep) && statSync(candidate).isFile()) [file, body] = [candidate, readFileSync(candidate)];
      } catch {
        // not built
      }
      if (body) break;
    }
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/html', ...extra });
      return res.end('<h1>Not found</h1>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length, ...extra });
    return res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({
        origin: `http://127.0.0.1:${server.address().port}`,
        headers,
        close: () => new Promise((closed) => {
          server.closeAllConnections();
          server.close(closed);
        }),
      }),
    );
  });
}

let root;
let baseline;
let good;
let baselineRedirects;
const servers = [];
async function serve(dist, options = {}) {
  const host = await serveDist(dist, { redirects: baselineRedirects, ...options });
  servers.push(host);
  return host;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'verify-live-'));
  baseline = await buildFixtureBaseline(root);
  // The host serves what build-redirects writes: the no-op query row (/?p=2 -> /) is left out.
  baselineRedirects = JSON.parse(readFileSync(join(baseline, 'redirects.json'), 'utf8')).filter((r) => r.from !== '/?p=2');
  good = makeDist(join(root, 'dist-good'));
});
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true });
});

const live = (base, args = []) => verifyLive(['--base', base, '--baseline', baseline, '--delay', '0', ...args]);

// 15 routes at 200 (13 pages, the feed, the brochure PDF), 15 redirects (the no-op /?p=2 -> /
// answers 200 in place), the sitemap, 20 media.
test('a dist-good build served live passes every check', async () => {
  const host = await serve(good);
  const result = await live(host.origin);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^verify-live: 51 checked, 0 failed$/m);
  assert.match(result.stdout, /^ {2}ok route \/hidden-page\/$/m);
  assert.match(result.stdout, /^ {2}ok redirect \/old-services -> \/services\/$/m);
});

test('a route missing from the deploy fails, naming it', async () => {
  const host = await serve(makeDist(join(root, 'dist-missing'), { bad: ['missing-page'] }));
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL route \/hidden-page\/ status: expected 200, got 404$/m);
  assert.match(result.stdout, /^verify-live: 51 checked, 1 failed$/m);
});

test('--bypass is sent as x-vercel-protection-bypass on every request', async () => {
  const host = await serve(good);
  const result = await live(host.origin, ['--bypass', 'secret-value']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(host.headers.length, 51);
  assert.ok(host.headers.every((h) => h['x-vercel-protection-bypass'] === 'secret-value'));
});

test('X-Robots-Tag noindex must be present iff --expect-noindex', async () => {
  const open = await serve(good);
  const staging = await serve(good, { noindex: true });
  const expectMissing = await live(open.origin, ['--expect-noindex']);
  assert.equal(expectMissing.code, 1);
  assert.match(expectMissing.stdout, /^ {2}FAIL route \/about\/ x-robots-tag: expected "noindex \(header or meta robots\)", got null$/m);
  assert.equal((await live(staging.origin, ['--expect-noindex'])).code, 0);
  const leaked = await live(staging.origin);
  assert.equal(leaked.code, 1);
  assert.match(leaked.stdout, /^ {2}FAIL route \/ x-robots-tag: expected null, got "noindex"$/m);
});

test('a redirect that takes two hops fails; a failing unverified shortlink fails as unverified live', async () => {
  const redirects = [
    ...baselineRedirects.filter((r) => r.from !== '/old-services' && r.from !== '/?p=10'),
    { from: '/old-services', to: '/old-services/', status: 301 },
    { from: '/old-services/', to: '/services/', status: 301 },
  ];
  const host = await serve(good, { redirects });
  const text = await live(host.origin);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /^ {2}FAIL redirect \/\?p=10 status \(unverified live\): expected 301, got 200$/m);
  const result = await live(host.origin, ['--json']);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.failed, 2);
  assert.deepEqual(json.failures, [
    { check: 'redirect', path: '/?p=10', field: 'status', expected: 301, actual: 200, unverified: true },
    { check: 'redirect', path: '/old-services', field: 'location', expected: '/services/', actual: '/old-services/' },
  ]);
  assert.deepEqual(json.skipped, []);
});

test('a query redirect whose target is its own path must answer 200 in place', async () => {
  const host = await serve(good);
  const result = await live(host.origin);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^ {2}ok redirect \/\?p=2 \(no-op, served in place\)$/m);
  const missing = await serve(makeDist(join(root, 'dist-noop-redirected')), { redirects: [{ from: '/?p=2', to: '/elsewhere/', status: 301 }] });
  const failed = await live(missing.origin, ['--json']);
  const json = JSON.parse(failed.stdout);
  assert.deepEqual(json.failures.filter((f) => f.path === '/?p=2'), [{ check: 'redirect', path: '/?p=2', field: 'status', expected: 200, actual: 301, unverified: true }]);
});

test('without --expect-noindex, a meta robots noindex fails unless the live page said noindex', async () => {
  const staging = await serve(makeDist(join(root, 'dist-release-meta'), { staging: true }));
  const result = await live(staging.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL route \/about\/ robots: expected "no noindex \(the live page is indexable\)", got "noindex, nofollow"$/m);
  assert.doesNotMatch(result.stdout, /FAIL route \/private-page\//, 'the live noindex page may say noindex');
  assert.equal((await live((await serve(good)).origin)).code, 0);
});

test('with --expect-noindex, a meta robots noindex on the page stands in for the header', async () => {
  const staging = await serve(makeDist(join(root, 'dist-staging-meta'), { staging: true }));
  const result = await live(staging.origin, ['--expect-noindex']);
  assert.equal(result.code, 0, result.stdout);
  const plain = await live((await serve(good)).origin, ['--expect-noindex']);
  assert.equal(plain.code, 1);
  assert.match(plain.stdout, /^ {2}FAIL route \/about\/ x-robots-tag: expected "noindex \(header or meta robots\)", got null$/m);
});

test('a baseline media entry with downloaded: false is never sampled (the build does not serve it)', async () => {
  const listed = join(root, 'baseline-listed');
  cpSync(baseline, listed, { recursive: true });
  const media = JSON.parse(readFileSync(join(baseline, 'media.json'), 'utf8'));
  const extra = { path: '/wp-content/uploads/2026/01/hero-150x150.jpg', bytes: null, contentType: null, referencedBy: [], downloaded: false, reason: 'unreferenced size' };
  writeFileSync(join(listed, 'media.json'), JSON.stringify([...media, extra]));
  const host = await serve(good);
  const result = await verifyLive(['--base', host.origin, '--baseline', listed, '--delay', '0']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^verify-live: 51 checked, 0 failed$/m);
  assert.doesNotMatch(result.stdout, /hero-150x150\.jpg (?!skipped)/);
});

test('a media file whose size changed fails', async () => {
  const dist = makeDist(join(root, 'dist-media'));
  writeFileSync(join(dist, 'wp-content/uploads/2026/01/logo.svg'), '<svg/>');
  const host = await serve(dist);
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL media \/wp-content\/uploads\/2026\/01\/logo\.svg bytes: expected 354, got 6$/m);
});

test('--media-manifest checks each sampled object at its url against the manifest bytes', async () => {
  const host = await serve(good);
  const manifest = join(root, 'media-manifest.json');
  writeFileSync(manifest, JSON.stringify([
    { path: '/wp-content/uploads/2026/01/hero.jpg', bytes: 13713, url: `${host.origin}/wp-content/uploads/2026/01/hero.jpg` },
    { path: '/wp-content/uploads/2026/01/team.jpg', bytes: 1, url: `${host.origin}/wp-content/uploads/2026/01/team.jpg` },
  ]));
  const result = await live(host.origin, ['--media-manifest', manifest, '--json']);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.checked, 33);
  assert.deepEqual(json.failures, [{ check: 'media', path: '/wp-content/uploads/2026/01/team.jpg', field: 'bytes', expected: 1, actual: 13704 }]);
});

test('--media-manifest: a url that is a site path is requested at <base><path>', async () => {
  const host = await serve(good);
  const manifest = join(root, 'media-manifest-paths.json');
  writeFileSync(manifest, JSON.stringify([
    { path: '/wp-content/uploads/2026/01/hero.jpg', bytes: 13713, url: '/wp-content/uploads/2026/01/hero.jpg' },
    { path: '/wp-content/uploads/2026/01/team.jpg', bytes: 13704, url: '/media/team.jpg' },
  ]));
  const result = await live(host.origin, ['--media-manifest', manifest, '--json']);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.failures, [{ check: 'media', path: '/wp-content/uploads/2026/01/team.jpg', field: 'status', expected: 200, actual: 404 }]);
});

// A host that accepts every connection and never answers.
function serveSilence() {
  const server = createServer(() => {});
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const host = {
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((closed) => {
          server.closeAllConnections();
          server.close(closed);
        }),
      };
      servers.push(host);
      done(host);
    });
  });
}

test('every request carries a 30 s timeout signal', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  const signals = [];
  const fetchImpl = async (url, options) => {
    signals.push(options.signal);
    return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const verifier = createVerifier({ base: 'https://deploy.example.com', delay: 0, fetchImpl });
  await verifier.route({ path: '/', kind: 'page' }, { expectNoindex: false });
  await verifier.sitemap();
  await verifier.media({ path: '/a.jpg', bytes: 13 });
  assert.equal(signals.length, 3);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('a request that times out is a failure, not a block: the run goes on', async () => {
  const silent = await serveSilence();
  const lines = [];
  const verifier = createVerifier({ base: silent.origin, delay: 0, timeout: 100, out: (line) => lines.push(line) });
  for (const path of ['/', '/about/', '/contact/', '/blog/']) await verifier.route({ path, kind: 'page' }, { expectNoindex: false });
  await verifier.redirect({ from: '/old', to: '/new/', status: 301 }, new Set());
  await verifier.media({ path: '/a.jpg', bytes: 1 });
  const results = verifier.results();
  assert.equal(results.checked, 6);
  assert.equal(results.failed, 6);
  assert.deepEqual(results.failures[0], { check: 'route', path: '/', field: 'timeout', expected: 'a response within 0.1 s', actual: 'timed out' });
  assert.deepEqual(results.failures.map((f) => `${f.check} ${f.path} ${f.field}`), [
    'route / timeout', 'route /about/ timeout', 'route /contact/ timeout', 'route /blog/ timeout', 'redirect /old timeout', 'media /a.jpg timeout',
  ]);
  assert.match(lines.join('\n'), /^ {2}FAIL route \/about\/ timeout: expected "a response within 0\.1 s", got "timed out"$/m);
});

test("WordPress's /sitemap_index.xml counts as the sitemap", async () => {
  const dist = makeDist(join(root, 'dist-wp-sitemap'));
  renameSync(join(dist, 'sitemap-index.xml'), join(dist, 'sitemap_index.xml'));
  const host = await serve(dist);
  const result = await live(host.origin);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^ {2}ok sitemap \/sitemap_index\.xml$/m);
});

test('a missing sitemap fails', async () => {
  const dist = makeDist(join(root, 'dist-no-sitemap'));
  rmSync(join(dist, 'sitemap-index.xml'));
  const host = await serve(dist);
  const result = await live(host.origin);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}FAIL sitemap \/sitemap-index\.xml status: expected 200, got 404$/m);
});

test('--sample N checks N routes, always / and one route per template', async () => {
  const host = await serve(good);
  const routes = JSON.parse(readFileSync(join(baseline, 'routes.json'), 'utf8')).filter((r) => r.status === 200);
  const templates = new Set(routes.map((r) => r.template));
  const result = await live(host.origin, ['--sample', '8', '--json']);
  assert.equal(result.code, 0, result.stdout);
  const json = JSON.parse(result.stdout);
  const skipped = json.skipped.filter((s) => s.check === 'route').map((s) => s.path);
  assert.equal(skipped.length, routes.length - 8);
  const checked = routes.filter((r) => !skipped.includes(r.path));
  assert.ok(checked.some((r) => r.path === '/'));
  assert.deepEqual(new Set(checked.map((r) => r.template)), templates);
  assert.equal(json.checked, 8 + 15 + 1 + 20);
});

test('three consecutive 429s stop the run with exit 3', async () => {
  const host = await serve(good, { blockAfter: 2 });
  const result = await live(host.origin);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /verify-live: stopped after 3 consecutive blocked responses \(429\)/);
  assert.equal(host.headers.length, 5);
});

test('a 302 to vercel.com/sso-api stops the run at the first answer with exit 3, naming deployment protection', async () => {
  const host = await serve(good, { sso: true });
  const result = await live(host.origin, ['--expect-noindex']);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(host.headers.length, 1);
  assert.doesNotMatch(result.stdout, /FAIL/);
  assert.match(result.stdout, /^verify-live: 0 checked, 0 failed$/m);
  assert.ok(
    result.stdout.split('\n').includes(
      `verify-live: deployment protection: ${host.origin}/ redirected to vercel.com/sso-api; use the project's production alias (public by default), or pass --bypass if staging was deliberately protected`,
    ),
    result.stdout,
  );
  const json = JSON.parse((await live(host.origin, ['--json'])).stdout);
  assert.match(json.stopped, /^deployment protection: /);
  assert.equal(json.checked, 0);
});

test('a redirect elsewhere on vercel.com is an ordinary redirect, not protection', async () => {
  const redirects = [...baselineRedirects.filter((r) => r.from !== '/old-services'), { from: '/old-services', to: 'https://vercel.com/docs', status: 301 }];
  const host = await serve(good, { redirects });
  const result = await live(host.origin);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /^ {2}FAIL redirect \/old-services location: expected "\/services\/", got "https:\/\/vercel\.com\/docs"$/m);
});

test('--help exits 0; a missing --base or baseline exits 2', async () => {
  const help = await verifyLive(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--expect-noindex/);
  assert.equal((await verifyLive(['--baseline', baseline])).code, 2);
  assert.equal((await verifyLive(['--base', 'http://127.0.0.1:1', '--baseline', join(root, 'nope')])).code, 2);
  assert.equal((await verifyLive(['--base', 'not a url', '--baseline', baseline])).code, 2);
});
