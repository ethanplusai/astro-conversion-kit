import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import { parseSize, planMedia, rewriteConfig, mediaPrefix, LIVE_TEMPORARY_WARNING } from '../../skills/convert-site/scripts/media-plan.mjs';
import { contentTypeFor } from '../../skills/convert-site/scripts/media-upload.mjs';
import { signV4 } from '../../skills/convert-site/scripts/lib/stores/r2.mjs';

const SCRIPTS = resolve(import.meta.dirname, '../../skills/convert-site/scripts');
const PLAN = join(SCRIPTS, 'media-plan.mjs');
const UPLOAD = join(SCRIPTS, 'media-upload.mjs');

// Async on purpose: the stub servers live in this process and must keep answering.
function run(script, args, env = {}) {
  return new Promise((done) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
    execFile(process.execPath, [script, ...args], { env: childEnv }, (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const NO_CREDS = {
  BLOB_READ_WRITE_TOKEN: undefined,
  R2_ACCOUNT_ID: undefined,
  R2_ACCESS_KEY_ID: undefined,
  R2_SECRET_ACCESS_KEY: undefined,
  R2_BUCKET: undefined,
};

const UPLOADS = '/wp-content/uploads/2026/01/';
const FIXTURE_MEDIA = [
  ...['hero', 'roof-detail', 'team'].flatMap((n) => [`${n}.jpg`, `${n}-300x200.jpg`, `${n}-1024x683.jpg`]),
  ...['siding-sample', 'storm-clouds'].flatMap((n) => [`${n}.webp`, `${n}-300x200.webp`, `${n}-1024x683.webp`]),
  'brochure.pdf',
  'logo.svg',
].map((f) => UPLOADS + f);

let fixture;
let work;
let fixtureMediaJson;

before(async () => {
  fixture = await startFixture();
  work = mkdtempSync(join(tmpdir(), 'media-test-'));
  const entries = [];
  for (const path of FIXTURE_MEDIA) {
    const res = await fetch(fixture.origin + path, { method: 'HEAD' });
    entries.push({
      url: fixture.origin + path,
      path,
      source: ['html'],
      referencedBy: ['/'],
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: Number(res.headers.get('content-length')),
    });
  }
  fixtureMediaJson = join(work, 'media.json');
  writeFileSync(fixtureMediaJson, JSON.stringify(entries));
});

after(async () => {
  await fixture.close();
  rmSync(work, { recursive: true, force: true });
});

test('parseSize accepts MB, KB and plain byte forms', () => {
  assert.equal(parseSize('300MB'), 300 * 1024 * 1024);
  assert.equal(parseSize('25MB'), 25 * 1024 * 1024);
  assert.equal(parseSize('1KB'), 1024);
  assert.equal(parseSize('1024'), 1024);
  assert.throws(() => parseSize('lots'));
});

test('fixture media (tiny) is planned into the repo', async () => {
  const out = join(work, 'plan-repo.json');
  const res = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'vercel', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.mode, 'repo');
  assert.equal(plan.store, undefined);
  assert.equal(plan.totals.count, FIXTURE_MEDIA.length);
  const entries = JSON.parse(readFileSync(fixtureMediaJson, 'utf8'));
  assert.ok(entries.every((e) => e.status === 200 && e.bytes > 0), 'every fixture media URL answered HEAD');
  assert.equal(plan.totals.bytes, entries.reduce((sum, e) => sum + e.bytes, 0));
  assert.equal(plan.totals.largest, 13713);
  assert.deepEqual(plan.reasons, []);
  assert.equal(plan.prefix, '/wp-content/uploads/');
  assert.deepEqual(plan.thresholds, { maxTotal: 300 * 1024 * 1024, maxFile: 25 * 1024 * 1024, maxCount: 10000 });
});

test('over the total limit, the store follows the host and the reason names the limit', async () => {
  for (const [host, store] of [['vercel', 'blob'], ['cloudflare', 'r2']]) {
    const out = join(work, `plan-${host}.json`);
    const res = await run(PLAN, ['--media', fixtureMediaJson, '--host', host, '--max-total', '1KB', '--out', out]);
    assert.equal(res.code, 0, res.stderr);
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.mode, 'store');
    assert.equal(plan.store, store);
    assert.equal(plan.reasons.length, 1);
    assert.match(plan.reasons[0], /total/i);
    assert.match(plan.reasons[0], /--max-total/);
  }
});

test('file-size and count limits each give their own reason; non-200 entries do not count', () => {
  const entries = [
    { path: '/wp-content/uploads/a.jpg', status: 200, bytes: 2048 },
    { path: '/wp-content/uploads/b.jpg', status: 200, bytes: 10 },
    { path: '/wp-content/uploads/gone.jpg', status: 404, bytes: 999999 },
  ];
  const plan = planMedia(entries, { host: 'vercel', maxTotal: 1e9, maxFile: 1024, maxCount: 2 });
  assert.equal(plan.mode, 'store');
  assert.equal(plan.totals.count, 2);
  assert.equal(plan.totals.bytes, 2058);
  assert.equal(plan.totals.largest, 2048);
  assert.equal(plan.reasons.length, 2);
  assert.match(plan.reasons.join('\n'), /--max-file/);
  assert.match(plan.reasons.join('\n'), /--max-count/);
  assert.match(plan.reasons.join('\n'), /a\.jpg/);
});

test('unreferenced sizes are counted apart and named in the output; without them the plan has no such field', async () => {
  const entries = [
    { path: '/wp-content/uploads/a.jpg', status: 200, bytes: 2048 },
    { path: '/wp-content/uploads/a-150x150.jpg', status: null, bytes: null, downloaded: false, reason: 'unreferenced size' },
    { path: '/wp-content/uploads/a-768x512.jpg', status: null, bytes: null, downloaded: false, reason: 'unreferenced size' },
  ];
  const plan = planMedia(entries, { host: 'vercel' });
  assert.equal(plan.totals.count, 1);
  assert.equal(plan.unreferencedSizes, 2);
  assert.equal(planMedia(entries.slice(0, 1), { host: 'vercel' }).unreferencedSizes, undefined);

  const file = join(work, 'media-unreferenced.json');
  writeFileSync(file, JSON.stringify(entries));
  const res = await run(PLAN, ['--media', file, '--host', 'vercel', '--out', join(work, 'plan-unreferenced.json')]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^ {2}2 unreferenced sizes listed, not downloaded; pass --sizes all to the capture if old links may use them$/m);
  const plain = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'vercel', '--out', join(work, 'plan-plain.json')]);
  assert.doesNotMatch(plain.stdout, /unreferenced/);
});

test('--mode live-temporary is written with the no-credentials reason', async () => {
  const out = join(work, 'plan-live.json');
  const res = await run(PLAN, [
    '--media', fixtureMediaJson, '--host', 'cloudflare', '--max-total', '1KB', '--mode', 'live-temporary', '--out', out,
  ]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.mode, 'live-temporary');
  assert.equal(plan.store, 'r2');
  assert.ok(plan.reasons.includes('no store credentials'));
  assert.equal(plan.warning, LIVE_TEMPORARY_WARNING);
  assert.equal(
    plan.warning,
    'staging only: media is proxied from the live site; create the store and upload before DNS moves, then regenerate this config',
  );
  assert.match(res.stdout, /warning: staging only/);
});

test('store and repo plans carry no warning', () => {
  const entries = [{ path: '/wp-content/uploads/a.jpg', status: 200, bytes: 1 }];
  assert.equal(planMedia(entries, { host: 'vercel' }).warning, undefined);
  assert.equal(planMedia(entries, { host: 'vercel', maxTotal: 1 }).warning, undefined);
});

test('media-plan with a bad size or host exits 2; --help exits 0', async () => {
  const bad = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'vercel', '--max-total', 'huge', '--out', join(work, 'x.json')]);
  assert.equal(bad.code, 2);
  const host = await run(PLAN, ['--media', fixtureMediaJson, '--host', 'netlify', '--out', join(work, 'x.json')]);
  assert.equal(host.code, 2);
  const help = await run(PLAN, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
});

test('rewriteConfig: Vercel rewrite, Cloudflare block, and live-temporary at the live origin', () => {
  const live = rewriteConfig('live-temporary', 'https://live.example.com', '/wp-content/uploads/');
  assert.equal(live.source, '/wp-content/uploads/:path*');
  assert.ok(live.destination.startsWith('https://live.example.com'));
  assert.equal(live.destination, 'https://live.example.com/wp-content/uploads/:path*');
  assert.equal(live.warning, LIVE_TEMPORARY_WARNING);
  assert.deepEqual(
    JSON.parse(JSON.stringify(live)),
    { source: '/wp-content/uploads/:path*', destination: 'https://live.example.com/wp-content/uploads/:path*' },
    'the warning stays out of vercel.json',
  );

  const blob = rewriteConfig('store', 'https://abc.public.blob.vercel-storage.com/', '/wp-content/uploads/', { store: 'blob' });
  assert.deepEqual(blob, {
    source: '/wp-content/uploads/:path*',
    destination: 'https://abc.public.blob.vercel-storage.com/wp-content/uploads/:path*',
  });

  const r2 = rewriteConfig('store', '', '/wp-content/uploads/', { store: 'r2', bucket: 'site-media' });
  assert.equal(typeof r2, 'string');
  assert.match(r2, /skills\/convert-site\/templates\/cloudflare\/r2-media-function\.js/);
  assert.match(r2, /functions\/wp-content\/uploads\/\[\[path\]\]\.js/);
  assert.match(r2, /binding.*MEDIA/i);
  assert.match(r2, /site-media/);
  assert.match(r2, /\/wp-content\/uploads\//);
  assert.doesNotMatch(r2, /origin rule|host header|custom domain/i);
  assert.match(
    rewriteConfig('store', '', '/sites/default/files/', { store: 'r2' }),
    /functions\/sites\/default\/files\/\[\[path\]\]\.js/,
  );

  const liveCf = rewriteConfig('live-temporary', 'https://live.example.com', '/wp-content/uploads/', { store: 'r2' });
  assert.equal(typeof liveCf, 'string');
  assert.match(liveCf, /live\.example\.com/);
  assert.equal(liveCf.split('\n')[0], LIVE_TEMPORARY_WARNING);
  assert.match(liveCf, /^\/wp-content\/uploads\/\* https:\/\/live\.example\.com\/wp-content\/uploads\/:splat 302$/m);
  assert.doesNotMatch(liveCf, /origin rule|host header/i);
  assert.doesNotMatch(r2, /staging only/);
  assert.equal(blob.warning, undefined);

  assert.throws(() => rewriteConfig('store', 'https://media.example.com', '/wp-content/uploads/'), /store mode needs/);

  assert.equal(rewriteConfig('repo', '', '/wp-content/uploads/'), null);
});

test('media-upload --store blob with no token exits 2 naming BLOB_READ_WRITE_TOKEN', async () => {
  const res = await run(UPLOAD, ['--store', 'blob', '--dir', work, '--manifest', join(work, 'm.json'), '--prefix', '/wp-content/uploads/'], NO_CREDS);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /BLOB_READ_WRITE_TOKEN/);
  assert.equal(res.stderr.trim().split('\n').length, 1);
});

test('media-upload --store r2 with missing credentials exits 2 naming the missing variables', async () => {
  const res = await run(
    UPLOAD,
    ['--store', 'r2', '--dir', work, '--manifest', join(work, 'm.json'), '--prefix', '/wp-content/uploads/'],
    { ...NO_CREDS, R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket' },
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /R2_ACCESS_KEY_ID/);
  assert.match(res.stderr, /R2_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(res.stderr, /R2_BUCKET/);
  assert.equal(res.stderr.trim().split('\n').length, 1);
});

function makeCache(name) {
  const dir = join(work, name);
  const files = { 'a.jpg': 'aaaa', 'b.webp': 'bbbbbbbb', 'sub/c.pdf': 'cccccccccccc' };
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, 'wp-content/uploads/2026/01', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  // Outside the prefix: never uploaded.
  mkdirSync(join(dir, 'wp-content/themes'), { recursive: true });
  writeFileSync(join(dir, 'wp-content/themes/style.css'), 'body{}');
  return dir;
}

// A stand-in for the object store: records PUTs, serves HEADs of what it stored.
// holdMs delays each PUT answer, so overlapping uploads show in maxInFlight.
async function startStoreStub({ lie = false, failPuts = 0, failHeads = 0, holdMs = 0 } = {}) {
  const puts = [];
  const flight = { now: 0, max: 0 };
  const heads = [];
  const attempts = { PUT: 0, HEAD: 0 };
  const stored = new Map();
  let origin;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // Blob puts name the object in ?pathname= (as @vercel/blob does); R2 puts in the path.
      const requested = new URL(req.url, 'http://x');
      const named = requested.searchParams.get('pathname');
      const path = named !== null ? `/${named}` : decodeURIComponent(requested.pathname);
      if (req.method in attempts) attempts[req.method] += 1;
      if (req.method === 'PUT' && failPuts > 0) {
        failPuts -= 1;
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('busy');
        return;
      }
      if (req.method === 'HEAD' && failHeads > 0) {
        failHeads -= 1;
        res.writeHead(429);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        const body = Buffer.concat(chunks);
        puts.push({ path, url: req.url, headers: req.headers, bytes: body.length });
        stored.set(path, body);
        flight.now += 1;
        flight.max = Math.max(flight.max, flight.now);
        setTimeout(() => {
          flight.now -= 1;
          res.writeHead(200, { 'content-type': 'application/json', etag: `"etag-${body.length}"` });
          res.end(JSON.stringify({ url: `${origin}/public${path}`, pathname: path.slice(1) }));
        }, holdMs);
        return;
      }
      if (req.method === 'HEAD') {
        heads.push({ path, headers: req.headers });
        const body = stored.get(path.replace(/^\/public/, ''));
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': lie ? body.length + 1 : body.length, etag: `"etag-${body.length}"` });
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    puts,
    heads,
    attempts,
    flight,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

test('blob upload against a stub: 3 files, verified sizes, manifest written, second run uploads 0', async () => {
  const stub = await startStoreStub();
  try {
    const dir = makeCache('cache-blob');
    const manifest = join(work, 'manifest-blob.json');
    const token = 'vercel_blob_rw_STOREID42_SECRETVALUE123';
    const args = ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin];
    const first = await run(UPLOAD, args, { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: token });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.puts.length, 3);
    assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token), 'token never printed');

    const put = stub.puts.find((p) => p.path === '/wp-content/uploads/2026/01/a.jpg');
    assert.ok(put, 'object key is the site path');
    // The request @vercel/blob 2.8.2's put() makes: PUT <api>/?pathname=<key>, raw body.
    assert.equal(put.url, '/?pathname=wp-content%2Fuploads%2F2026%2F01%2Fa.jpg');
    assert.equal(put.bytes, 4);
    assert.equal(put.headers.authorization, `Bearer ${token}`);
    assert.equal(put.headers['x-api-version'], '13');
    assert.equal(put.headers['x-vercel-blob-store-id'], 'STOREID42');
    assert.match(put.headers['x-api-blob-request-id'], /^STOREID42:\d+:[0-9a-f]+$/);
    assert.equal(put.headers['x-api-blob-request-attempt'], '0');
    assert.equal(put.headers['x-content-type'], 'image/jpeg');
    assert.equal(put.headers['x-vercel-blob-access'], 'public');
    assert.equal(put.headers['x-add-random-suffix'], '0');
    assert.equal(put.headers['x-allow-overwrite'], '1');
    assert.equal(put.headers['x-cache-control-max-age'], '31536000');

    const entries = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(entries.length, 3);
    const a = entries.find((e) => e.path === '/wp-content/uploads/2026/01/a.jpg');
    assert.equal(a.bytes, 4);
    assert.equal(a.url, `${stub.origin}/public/wp-content/uploads/2026/01/a.jpg`);
    assert.equal(a.etag, '"etag-4"');
    assert.ok(entries.some((e) => e.path === '/wp-content/uploads/2026/01/sub/c.pdf' && e.bytes === 12));
    assert.match(first.stdout, /uploaded 3/);
    assert.deepEqual(readdirSync(work).filter((n) => n.endsWith('.tmp')), [], 'no temp manifest left behind');

    const second = await run(UPLOAD, args, { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: token });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stub.puts.length, 3, 'second run uploads nothing');
    assert.match(second.stdout, /uploaded 0/);
    assert.match(second.stdout, /skipped 3/);
  } finally {
    await stub.close();
  }
});

test('--concurrency uploads files at once; blob HEADs ask for identity so content-length is the stored size', async () => {
  const stub = await startStoreStub({ holdMs: 150 });
  try {
    const dir = makeCache('cache-concurrent');
    const manifest = join(work, 'manifest-concurrent.json');
    const args = ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin];
    const res = await run(UPLOAD, [...args, '--concurrency', '3'], { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: 'tok' });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(stub.puts.length, 3);
    assert.equal(stub.flight.max, 3, 'the three uploads overlapped');
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).length, 3);
    assert.ok(stub.heads.length === 3 && stub.heads.every((h) => h.headers['accept-encoding'] === 'identity'));
    for (const bad of ['0', '33', 'two']) {
      const refused = await run(UPLOAD, [...args, '--concurrency', bad], NO_CREDS);
      assert.equal(refused.code, 2, `--concurrency ${bad}`);
      assert.match(refused.stderr, /--concurrency needs a whole number from 1 to 32/);
    }
    assert.match((await run(UPLOAD, ['--help'])).stdout, /--concurrency/);
  } finally {
    await stub.close();
  }
});

test('a HEAD size mismatch fails with exit 1 and keeps the file out of the manifest', async () => {
  const stub = await startStoreStub({ lie: true });
  try {
    const dir = makeCache('cache-lie');
    const manifest = join(work, 'manifest-lie.json');
    const res = await run(
      UPLOAD,
      ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin],
      { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: 'tok' },
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /size mismatch/i);
    const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    assert.equal(entries.length, 0);
  } finally {
    await stub.close();
  }
});

test('signV4 matches the published S3 GET-object example', () => {
  const headers = signV4({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('r2 upload against a stub: signed PUTs to /<bucket>/<key>, verified by HEAD, resumable', async () => {
  const stub = await startStoreStub();
  try {
    const dir = makeCache('cache-r2');
    const manifest = join(work, 'manifest-r2.json');
    const secret = 'r2-secret-DO-NOT-PRINT';
    const env = { ...NO_CREDS, R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: 'media' };
    const args = ['--store', 'r2', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin];
    const first = await run(UPLOAD, args, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.puts.length, 3);
    assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret));
    const put = stub.puts.find((p) => p.path === '/media/wp-content/uploads/2026/01/b.webp');
    assert.ok(put, 'path-style /<bucket>/<key>');
    assert.match(
      put.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=[^,]*x-amz-date[^,]*,Signature=[0-9a-f]{64}$/,
    );
    assert.equal(put.headers['content-type'], 'image/webp');
    assert.match(put.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
    const entries = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(entries.length, 3);
    // The manifest url is the site path the R2 media function serves, never the private API address.
    assert.equal(entries.find((e) => e.path === '/wp-content/uploads/2026/01/b.webp').url, '/wp-content/uploads/2026/01/b.webp');
    assert.ok(entries.every((e) => e.url === e.path), JSON.stringify(entries));
    const head = stub.heads.find((h) => h.path === '/media/wp-content/uploads/2026/01/b.webp');
    assert.ok(head, 'verified by a HEAD on the API object');
    assert.match(head.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
    const second = await run(UPLOAD, args, env);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stub.puts.length, 3);
  } finally {
    await stub.close();
  }
});

test('PUT and HEAD are retried once on 503 and 429, then succeed', async () => {
  const stub = await startStoreStub({ failPuts: 1, failHeads: 1 });
  try {
    const dir = makeCache('cache-retry');
    const manifest = join(work, 'manifest-retry.json');
    const res = await run(
      UPLOAD,
      ['--store', 'blob', '--dir', dir, '--manifest', manifest, '--prefix', '/wp-content/uploads/', '--endpoint', stub.origin],
      { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: 'tok' },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(stub.attempts.PUT, 4, '3 files plus one retried PUT');
    assert.equal(stub.attempts.HEAD, 4, '3 files plus one retried HEAD');
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).length, 3);
  } finally {
    await stub.close();
  }
});

test('--media supplies the captured content type; the extension table covers common formats', async () => {
  const stub = await startStoreStub();
  try {
    const dir = makeCache('cache-types');
    const media = join(work, 'media-types.json');
    writeFileSync(
      media,
      JSON.stringify([
        {
          url: 'https://live.example.com/wp-content/uploads/2026/01/a.jpg',
          path: '/wp-content/uploads/2026/01/a.jpg',
          source: [],
          referencedBy: [],
          status: 200,
          contentType: 'image/pjpeg',
          bytes: 4,
        },
      ]),
    );
    const res = await run(
      UPLOAD,
      [
        '--store', 'blob', '--dir', dir, '--manifest', join(work, 'manifest-types.json'),
        '--prefix', '/wp-content/uploads/', '--media', media, '--endpoint', stub.origin,
      ],
      { ...NO_CREDS, BLOB_READ_WRITE_TOKEN: 'tok' },
    );
    assert.equal(res.code, 0, res.stderr);
    const type = (p) => stub.puts.find((x) => x.path === p).headers['x-content-type'];
    assert.equal(type('/wp-content/uploads/2026/01/a.jpg'), 'image/pjpeg');
    assert.equal(type('/wp-content/uploads/2026/01/b.webp'), 'image/webp', 'not in media.json: extension lookup');
  } finally {
    await stub.close();
  }
  const expected = {
    mov: 'video/quicktime',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    zip: 'application/zip',
    json: 'application/json',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  for (const [ext, type] of Object.entries(expected)) assert.equal(contentTypeFor(`file.${ext.toUpperCase()}`), type, ext);
  assert.equal(contentTypeFor('file.unknown'), 'application/octet-stream');
});

test('the media prefix is never "/": the plan exits 2 listing the top-level prefixes', async () => {
  assert.throws(
    () => mediaPrefix(['/wp-content/uploads/a.jpg', '/images/b.jpg', '/favicon.ico']),
    (err) => /\/images\//.test(err.message) && /\/wp-content\//.test(err.message) && /site root/.test(err.message),
  );
  const media = join(work, 'media-split.json');
  writeFileSync(
    media,
    JSON.stringify([
      { path: '/wp-content/uploads/a.jpg', status: 200, bytes: 10 },
      { path: '/images/b.jpg', status: 200, bytes: 10 },
    ]),
  );
  const out = join(work, 'plan-split.json');
  const res = await run(PLAN, ['--media', media, '--host', 'vercel', '--out', out]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /\/images\/.*\/wp-content\//);
  assert.ok(!existsSync(out));
});

test('the media prefix is the longest folder holding 90 % of the bytes, never a theme or plugin folder', async () => {
  const at = (path, bytes) => ({ path, status: 200, bytes });
  // Uploads plus the theme's fonts and scripts: /wp-content/ would proxy the theme too.
  assert.equal(mediaPrefix([at('/wp-content/uploads/a.jpg', 10), at('/wp-content/themes/x/font.woff2', 10)]), '/wp-content/uploads/');
  assert.equal(mediaPrefix([at('/wp-content/uploads/a.jpg', 10), at('/wp-content/plugins/p/icon.svg', 900)]), '/wp-content/uploads/');
  // Bytes, not count: 95 small files elsewhere hold under 10 % of the bytes.
  const small = Array.from({ length: 95 }, (_, i) => at(`/images/icon-${i}.svg`, 1));
  assert.equal(mediaPrefix([...small, at('/wp-content/uploads/2026/01/a.jpg', 600), at('/wp-content/uploads/2025/05/b.jpg', 400)]), '/wp-content/uploads/');
  // Count-heavy but byte-light uploads do not win against the folder that holds the bytes.
  assert.throws(() => mediaPrefix([at('/wp-content/uploads/a.jpg', 500), at('/files/b.pdf', 500)]), /90 %/);
  // Longest: a deeper folder that still holds 90 % of the bytes is chosen.
  assert.equal(mediaPrefix([at('/assets/media/big/a.mp4', 800), at('/assets/media/b.jpg', 150), at('/assets/c.jpg', 50)]), '/assets/media/');
  // Never a WordPress year or month folder: new uploads land in new ones.
  assert.equal(mediaPrefix([at('/wp-content/uploads/2026/01/a.jpg', 990), at('/wp-content/uploads/2025/01/b.jpg', 10)]), '/wp-content/uploads/');
  // Without byte counts every file weighs the same.
  assert.equal(mediaPrefix([at('/wp-content/uploads/a.jpg'), at('/wp-content/themes/t/f.woff2')]), '/wp-content/uploads/');

  // The run's shape: 874 uploads, 45 theme files; the plan lists the theme files as outside.
  const media = join(work, 'media-wp-theme.json');
  writeFileSync(media, JSON.stringify([
    ...Array.from({ length: 874 }, (_, i) => at(`/wp-content/uploads/20${10 + (i % 16)}/0${1 + (i % 9)}/img-${i}.jpg`, 2_000_000)),
    ...Array.from({ length: 45 }, (_, i) => at(`/wp-content/themes/site/assets/file-${i}.woff2`, 40_000)),
  ]));
  const out = join(work, 'plan-wp-theme.json');
  const res = await run(PLAN, ['--media', media, '--host', 'vercel', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.prefix, '/wp-content/uploads/');
  assert.equal(plan.mode, 'store');
  assert.ok(plan.reasons.some((r) => /^45 file\(s\) outside the prefix \/wp-content\/uploads\//.test(r)), plan.reasons.join('\n'));
  assert.match(res.stdout, /45 file\(s\) outside the prefix/);
});

test('files outside an explicit --prefix are listed in reasons without changing the mode', async () => {
  const media = join(work, 'media-outside.json');
  writeFileSync(
    media,
    JSON.stringify([
      { path: '/wp-content/uploads/a.jpg', status: 200, bytes: 10 },
      { path: '/images/b.jpg', status: 200, bytes: 10 },
    ]),
  );
  const out = join(work, 'plan-outside.json');
  const res = await run(PLAN, ['--media', media, '--host', 'vercel', '--prefix', '/wp-content/uploads/', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.mode, 'repo');
  assert.equal(plan.reasons.length, 1);
  assert.match(plan.reasons[0], /outside the prefix \/wp-content\/uploads\/.*\/images\/b\.jpg/);
  const root = await run(PLAN, ['--media', media, '--host', 'vercel', '--prefix', '/', '--out', out]);
  assert.equal(root.code, 2);
});

test('r2 media function: serves the object at the site path with type, etag, nosniff and a long cache, 404 when missing or malformed', async () => {
  const { onRequest } = await import('../../skills/convert-site/templates/cloudflare/r2-media-function.js');
  const objects = new Map([
    ['wp-content/uploads/2026/01/a b.jpg', { body: 'JPEGDATA', size: 8, httpEtag: '"abc"', httpMetadata: { contentType: 'image/jpeg' } }],
  ]);
  const asked = [];
  const env = { MEDIA: { async get(key) { asked.push(key); return objects.get(key) ?? null; } } };
  const call = (method, url) => onRequest({ request: new Request(url, { method }), env });

  const hit = await call('GET', 'https://site.example.com/wp-content/uploads/2026/01/a%20b.jpg');
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'image/jpeg');
  assert.equal(hit.headers.get('etag'), '"abc"');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(hit.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await hit.text(), 'JPEGDATA');
  assert.equal(asked[0], 'wp-content/uploads/2026/01/a b.jpg');

  const head = await call('HEAD', 'https://site.example.com/wp-content/uploads/2026/01/a%20b.jpg');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '8');
  assert.equal(await head.text(), '');

  const miss = await call('GET', 'https://site.example.com/wp-content/uploads/2026/01/none.jpg');
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('x-content-type-options'), 'nosniff');

  const malformed = await call('GET', 'https://site.example.com/wp-content/uploads/2026/01/bad%E0%A4%A.jpg');
  assert.equal(malformed.status, 404, 'a malformed percent-encoding is a 404, not a thrown URIError');
  assert.equal(asked.length, 3, 'the bucket is not asked for a path that does not decode');

  const post = await call('POST', 'https://site.example.com/wp-content/uploads/2026/01/a%20b.jpg');
  assert.equal(post.status, 405);
});
