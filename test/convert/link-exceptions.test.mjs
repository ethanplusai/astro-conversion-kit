import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';

const SKILLS = resolve(import.meta.dirname, '../../skills');
const SCRIPT = join(SKILLS, 'convert-site', 'scripts', 'link-exceptions.mjs');

function run(script, args) {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
  });
}

let root;
let capture;
let baseline;
let origin;
let routes;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'link-exceptions-test-'));
  capture = join(root, 'capture');
  baseline = join(root, 'baseline');
  const fixture = await startFixture();
  origin = fixture.origin;
  try {
    for (const [name, args] of [
      ['capture-site/scripts/capture.mjs', [fixture.origin, '--out', capture, '--delay', '0', '--no-wayback']],
      ['capture-site/scripts/media.mjs', ['--capture', capture, '--delay', '0']],
      ['capture-site/scripts/templates.mjs', ['--capture', capture]],
    ]) {
      const result = await run(join(SKILLS, name), args);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    }
  } finally {
    await fixture.close();
  }
  const built = await run(join(SKILLS, 'parity-gates', 'scripts', 'build-baseline.mjs'), ['--capture', capture, '--out', baseline]);
  assert.equal(built.code, 0, built.stderr);
  routes = JSON.parse(readFileSync(join(baseline, 'routes.json'), 'utf8'));
  // The about page as a larger WordPress site writes its head, plus links to pages live answered 404.
  const about = routes.find((r) => r.path === '/about/');
  const file = join(capture, about.snapshot);
  const html = readFileSync(file, 'utf8').replace('</head>', [
    `<link rel="EditURI" type="application/rsd+xml" title="RSD" href="${origin}/xmlrpc.php?rsd">`,
    `<link rel="alternate" title="JSON" type="application/json" href="${origin}/wp-json/wp/v2/pages/5">`,
    `<link rel="alternate" title="oEmbed (JSON)" type="application/json+oembed" href="${origin}/wp-json/oembed/1.0/embed?url=${encodeURIComponent(`${origin}/about/`)}">`,
    '<link rel="alternate" type="application/rss+xml" href="https://elsewhere.example.com/wp-json/">',
    '</head>',
  ].join('\n')).replace('</body>', `<a href="${origin}/deleted-post/">gone</a> <a href="/deleted-post/">gone again</a> <a href="/old-gone/">moved</a>\n</body>`);
  writeFileSync(file, html);
  // /old-gone/ answered 404 on live but a redirects.csv row now sends it somewhere: the links gate
  // resolves it, so it needs no exception.
  const list = JSON.parse(readFileSync(join(baseline, 'routes.json'), 'utf8'));
  list.push({ path: '/old-gone/', status: 410, kind: 'other', template: 'other', noindex: false, snapshot: null, foundBy: ['crawl'] });
  writeFileSync(join(baseline, 'routes.json'), JSON.stringify(list));
  writeFileSync(join(root, 'redirects.csv'), `from,to,status,source,note\n/old-gone/,/services/,301,decision,d7\n`);
});
after(() => rmSync(root, { recursive: true, force: true }));

const generate = (out, extra = []) => run(SCRIPT, ['--baseline', baseline, '--capture', capture, '--out', out, ...extra]);

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run(SCRIPT, ['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node link-exceptions\.mjs/);
});

test('one link exception per WordPress API head link per page, and one per link to a page broken on live', async () => {
  const out = join(root, 'exceptions.json');
  const result = await generate(out, ['--date', '2026-10-23']);
  assert.equal(result.code, 0, result.stderr);
  const records = JSON.parse(readFileSync(out, 'utf8'));
  const today = '2026-10-23';
  for (const r of records) {
    assert.equal(r.field, 'link');
    assert.equal(r.approvedBy, 'kit');
    assert.equal(r.date, today);
    assert.equal(r.from, r.to, 'kept as captured');
  }
  const api = records.filter((r) => r.reason === 'WordPress API link kept as captured');
  const pages = routes.filter((r) => r.status === 200 && r.snapshot && /\.html$/.test(r.snapshot)).map((r) => r.path);
  // Every captured page carries rel="https://api.w.org/" (and the captured 404 page, built as 404.html).
  for (const path of [...pages, '/404.html']) {
    assert.ok(api.some((r) => r.path === path && r.to === `${origin}/wp-json/`), `${path} wp-json/`);
  }
  const about = api.filter((r) => r.path === '/about/').map((r) => r.to).sort();
  assert.deepEqual(about, [
    `${origin}/wp-json/`,
    `${origin}/wp-json/oembed/1.0/embed?url=${encodeURIComponent(`${origin}/about/`)}`,
    `${origin}/wp-json/wp/v2/pages/5`,
    `${origin}/xmlrpc.php?rsd`,
  ].sort());
  const broken = records.filter((r) => r.reason === 'broken on live');
  assert.deepEqual(broken.map((r) => [r.path, r.to]).sort(), [['/about/', `${origin}/deleted-post/`], ['/about/', '/deleted-post/']].sort());
  assert.ok(!records.some((r) => r.to.includes('elsewhere.example.com')), 'another host is not checked by the links gate');
  assert.ok(!records.some((r) => r.to === '/old-gone/'), 'a redirects.csv source resolves through the redirect');
  assert.match(result.stdout, new RegExp(`added ${records.length} link exceptions \\(${api.length} WordPress API, ${broken.length} broken on live\\)`));
});

test('appends to existing records and never duplicates one', async () => {
  const out = join(root, 'existing.json');
  const kept = { path: '/', field: 'title', from: 'a', to: 'b', reason: 'kept', approvedBy: 'someone', date: '2026-01-01' };
  const prior = { path: '/about/', field: 'link', from: `${origin}/wp-json/`, to: `${origin}/wp-json/`, reason: 'earlier', approvedBy: 'someone', date: '2026-01-01' };
  writeFileSync(out, JSON.stringify([kept, prior]));
  assert.equal((await generate(out)).code, 0);
  const first = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(first.slice(0, 2), [kept, prior]);
  assert.equal(first.filter((r) => r.path === '/about/' && r.to === `${origin}/wp-json/`).length, 1);
  assert.match(first[2].date, /^\d{4}-\d{2}-\d{2}$/);
  const again = await generate(out);
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), first, 'a second run adds nothing');
  assert.match(again.stdout, /added 0 link exceptions/);
});

test('a missing baseline is a usage error', async () => {
  const result = await run(SCRIPT, ['--baseline', join(root, 'nope'), '--out', join(root, 'x.json')]);
  assert.equal(result.code, 2);
});

test('a link under an excluded prefix gets no record: the links gate does not check it', async () => {
  const dir = join(root, 'baseline-excluded');
  cpSync(baseline, dir, { recursive: true });
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, excluded: ['/deleted-post', '/wp-json/'] }));
  const out = join(root, 'excluded.json');
  const result = await run(SCRIPT, ['--baseline', dir, '--capture', capture, '--out', out, '--redirects', join(root, 'redirects.csv')]);
  assert.equal(result.code, 0, result.stderr);
  const records = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(!records.some((r) => r.reason === 'broken on live'), '/deleted-post written without its slash still covers /deleted-post/');
  assert.ok(!records.some((r) => r.to.includes('/wp-json/')));
  assert.ok(records.some((r) => r.to.includes('xmlrpc.php')));
});
