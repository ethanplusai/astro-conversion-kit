import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { buildRedirects, buildRoutes } from '../../skills/parity-gates/scripts/build-baseline.mjs';

const exec = promisify(execFile);
const script = (path) => fileURLToPath(new URL(`../../skills/${path}`, import.meta.url));

async function run(path, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script(path), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const build = (args) => run('parity-gates/scripts/build-baseline.mjs', args);

let root;
let capture;
let baseline;
let built;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'build-baseline-test-'));
  capture = join(root, 'capture');
  baseline = join(root, 'baseline');
  const fixture = await startFixture();
  try {
    // REST on (the default), so /hidden-page/ and /private-page/ are in the inventory; the seeds
    // give the capture a redirect chain and a slash redirect besides the shortlinks.
    const steps = [
      ['capture-site/scripts/capture.mjs', [fixture.origin, '--out', capture, '--delay', '0', '--no-wayback', '--seed', '/old-services', '--seed', '/about']],
      ['capture-site/scripts/media.mjs', ['--capture', capture, '--delay', '0']],
      ['capture-site/scripts/templates.mjs', ['--capture', capture]],
    ];
    for (const [name, args] of steps) {
      const result = await run(name, args);
      assert.equal(result.code, 0, result.stderr);
    }
  } finally {
    // The builder runs with the fixture closed: it never touches the network.
    await fixture.close();
  }
  built = await build(['--capture', capture, '--out', baseline]);
});
after(() => rmSync(root, { recursive: true, force: true }));

test('builds from the capture without a network and exits 0', () => {
  assert.equal(built.code, 0, built.stderr);
  for (const file of ['routes.json', 'seo.json', 'redirects.json', 'media.json', 'forms.json', 'scripts.json', 'js.json', 'counts.json']) {
    assert.ok(existsSync(join(baseline, file)), `baseline/${file} written`);
  }
  assert.ok(existsSync(join(root, 'redirects.csv')), 'redirects.csv written beside the baseline');
});

// Measured on the fixture: 14 HTML records (13 pages answering 200, /deleted-post/ 404), the
// /feed/ feed and the brochure PDF linked from every page's footer: 15 routes at 200, one 404.
test('routes: every captured page, feed and linked file, with kind, template and noindex', () => {
  const routes = readJson(baseline, 'routes.json');
  assert.equal(routes.length, 16);
  assert.equal(routes.filter((r) => r.status === 200).length, 15);
  assert.deepEqual(routes.filter((r) => r.status === 404).map((r) => r.path), ['/deleted-post/']);
  for (const r of routes) {
    assert.deepEqual(Object.keys(r), ['path', 'status', 'kind', 'template', 'noindex', 'snapshot', 'foundBy']);
  }
  const by = Object.fromEntries(routes.map((r) => [r.path, r]));
  assert.equal(by['/private-page/'].noindex, true);
  assert.equal(by['/about/'].noindex, false);
  // The REST dump decides page or post; /blog/ is a WordPress page even with an archive body.
  assert.equal(by['/about/'].kind, 'page');
  assert.equal(by['/blog/'].kind, 'page');
  assert.equal(by['/storm-season-prep/'].kind, 'post');
  assert.equal(by['/category/news/'].kind, 'archive');
  assert.equal(by['/feed/'].kind, 'feed');
  assert.equal(by['/wp-content/uploads/2026/01/brochure.pdf'].kind, 'file');
  assert.equal(by['/deleted-post/'].kind, 'other');
  assert.equal(by['/'].template, 'home');
  assert.equal(by['/private-page/'].template, 'page');
  assert.equal(by['/contact/'].template, 'page-2');
  assert.equal(by['/storm-season-prep/'].template, 'single-post');
  assert.equal(by['/deleted-post/'].template, 'other');
  assert.equal(by['/feed/'].template, 'other');
  assert.equal(by['/contact/'].snapshot, 'pages/contact.html');
  assert.equal(by['/feed/'].snapshot, 'feeds/feed.xml');
  assert.equal(by['/wp-content/uploads/2026/01/brochure.pdf'].snapshot, null);
  assert.deepEqual(by['/hidden-page/'].foundBy, ['rest', 'crawl']);
  assert.deepEqual(by['/feed/'].foundBy, ['crawl']);
});

// Measured: /about/ is the fixture page whose og:title differs from its <title>.
test('seo: head fields per page answering 200', () => {
  const seo = readJson(baseline, 'seo.json');
  assert.equal(Object.keys(seo).length, 13);
  assert.ok(!('/deleted-post/' in seo));
  const about = seo['/about/'];
  assert.deepEqual(Object.keys(about), ['title', 'description', 'canonical', 'robots', 'lang', 'h1', 'h2', 'og', 'twitter', 'jsonLd']);
  assert.equal(about.title, 'About Us | Fixture Roofing & Siding');
  assert.equal(about.og.title, 'Meet the Fixture Roofing crew');
  assert.notEqual(about.og.title, about.title);
  assert.equal(seo['/private-page/'].robots, 'noindex, nofollow');
  assert.equal(seo['/contact/'].lang, 'en-US');
  assert.deepEqual(seo['/contact/'].h1, ['Contact']);
});

// Measured: 12 unverified shortlinks (/?p=2 ... /?p=23), the two seeds and the middle hop of the
// /old-services -> /old-services/ -> /services/ chain.
test('redirects: capture redirects and shortlinks, as JSON and as redirects.csv', () => {
  const redirects = readJson(baseline, 'redirects.json');
  assert.equal(redirects.length, 15);
  // Shortlinks keep verified, so the redirects gate can tell an unverified one apart.
  for (const r of redirects) {
    const keys = r.source === 'shortlink' ? ['from', 'to', 'status', 'source', 'verified'] : ['from', 'to', 'status', 'source'];
    assert.deepEqual(Object.keys(r), keys);
  }
  assert.deepEqual(redirects.find((r) => r.from === '/old-services'), { from: '/old-services', to: '/services/', status: 301, source: 'seed' });
  // The chain's middle hop is a redirect of its own, straight to the final target.
  assert.deepEqual(redirects.find((r) => r.from === '/old-services/'), { from: '/old-services/', to: '/services/', status: 301, source: 'seed' });
  assert.deepEqual(redirects.find((r) => r.from === '/?p=6'), { from: '/?p=6', to: '/contact/', status: 301, source: 'shortlink', verified: false });

  const lines = readFileSync(join(root, 'redirects.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], 'from,to,status,source,note');
  assert.equal(lines.length, 16);
  assert.ok(lines.includes('/old-services,/services/,301,seed,'));
  assert.ok(lines.includes('/old-services/,/services/,301,seed,hop of /old-services'));
  assert.ok(lines.includes('/?p=6,/contact/,301,shortlink,unverified shortlink'));
});

test('buildRedirects: every intermediate hop redirects to the final target, unless it is a built route', () => {
  const { redirects, csvRows } = buildRedirects(
    [
      { from: '/a', to: '/d/', status: 301, source: 'crawl', hops: ['/b', '/c/'] },
      { from: '/x', to: '/z/', status: 302, source: 'seed', hops: ['/y/'] },
      { from: '/m', to: '/n/', status: 301, source: 'seed', hops: ['/m/'] },
      { from: '/m/', to: '/n/', status: 301, source: 'crawl', hops: [] },
      { from: '/loop', to: '/loop/', status: 301, source: 'crawl', hops: ['/loop/'], error: 'loop' },
    ],
    { routes: new Set(['/y/']) },
  );
  assert.deepEqual(redirects.map((r) => `${r.from}>${r.to}`), ['/a>/d/', '/b>/d/', '/c/>/d/', '/x>/z/', '/m>/n/', '/m/>/n/', '/loop>/loop/']);
  assert.deepEqual(redirects.find((r) => r.from === '/b'), { from: '/b', to: '/d/', status: 301, source: 'crawl' });
  assert.deepEqual(csvRows.find((row) => row[0] === '/c/'), ['/c/', '/d/', 301, 'crawl', 'hop of /a']);
  // /m/ is captured as a redirect of its own: it keeps its own row and gets no hop row.
  assert.deepEqual(csvRows.find((row) => row[0] === '/m/'), ['/m/', '/n/', 301, 'crawl', '']);
});

test('redirects: a shortlink with no target is left out and named on stderr', async (t) => {
  const copy = join(root, 'capture-null');
  const out = join(root, 'null', 'baseline');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(capture, copy, { recursive: true });
  const redirects = readJson(copy, 'redirects.json');
  redirects.push({ from: '/?p=99', to: null, status: null, source: 'shortlink', verified: false, hops: [] });
  redirects.push({ from: '/?p=98', to: '/about/', status: 301, source: 'shortlink', verified: true, hops: [] });
  writeFileSync(join(copy, 'redirects.json'), JSON.stringify(redirects));
  const result = await build(['--capture', copy, '--out', out, '--csv', join(root, 'null', 'r.csv')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\/\?p=99/);
  assert.ok(!readJson(out, 'redirects.json').some((r) => r.from === '/?p=99'));
  const csv = readFileSync(join(root, 'null', 'r.csv'), 'utf8');
  assert.ok(!csv.includes('/?p=99'));
  assert.ok(csv.includes('/?p=98,/about/,301,shortlink,\n'), 'a verified shortlink has no note');
});

test('media, forms, scripts and text', () => {
  const media = readJson(baseline, 'media.json');
  assert.equal(media.length, 20);
  const brochure = media.find((m) => m.path.endsWith('/brochure.pdf'));
  assert.deepEqual(brochure, {
    path: '/wp-content/uploads/2026/01/brochure.pdf',
    bytes: brochure.bytes,
    contentType: 'application/pdf',
    referencedBy: brochure.referencedBy,
  });
  assert.ok(brochure.referencedBy.length > 0 && brochure.referencedBy.every((p) => p.startsWith('/')), 'the pages that link it');
  for (const m of media) assert.deepEqual(Object.keys(m), ['path', 'bytes', 'contentType', 'referencedBy']);

  const forms = readJson(baseline, 'forms.json');
  assert.deepEqual(Object.keys(forms), ['/blog/', '/contact/']);
  assert.equal(forms['/blog/'][0].method, 'get');
  assert.deepEqual(forms['/blog/'][0].fields.map((f) => f.name), ['s']);
  assert.equal(forms['/contact/'].length, 1);
  assert.equal(forms['/contact/'][0].method, 'post');
  assert.deepEqual(forms['/contact/'][0].fields.map((f) => f.name), ['name', 'email', 'message', 'website']);

  const scripts = readJson(baseline, 'scripts.json');
  assert.deepEqual(Object.keys(scripts).sort(), ['ga4', 'gtm']);
  assert.deepEqual(Object.keys(scripts.ga4), ['id', 'ids', 'pages', 'keep']);
  assert.equal(scripts.ga4.id, 'G-FIXTURE1');
  assert.equal(scripts.gtm.keep, true);
  assert.ok(scripts.gtm.pages.includes('/contact/'));

  assert.deepEqual(readdirSync(join(baseline, 'text')).sort(), readdirSync(join(capture, 'text')).sort());
  assert.equal(readFileSync(join(baseline, 'text', 'contact.txt'), 'utf8'), readFileSync(join(capture, 'text', 'contact.txt'), 'utf8'));
});

test('js.json lists the saved same-origin scripts from capture/js/, [] when the capture has none', async (t) => {
  const origin = readJson(baseline, 'meta.json').origin;
  const modules = `${origin}/wp-includes/js/script-modules`;
  const home = (src, n) => ({ src, file: `js/${n}.js`, pages: ['/'] });
  assert.deepEqual(readJson(baseline, 'js.json'), [
    home(`${modules}/interactivity/index.min.js?ver=6.6.2`, 1),
    home(`${origin}/wp-content/themes/fixture/js/util.js`, 2),
    home(`${origin}/wp-content/themes/fixture/js/view.js?ver=1.4.2`, 3),
    {
      src: `${origin}/wp-content/themes/fixture/js/reveal.js?ver=1.4.2`,
      file: 'js/4.js',
      pages: readJson(baseline, 'routes.json').filter((r) => r.status === 200 && ['page', 'post', 'archive'].includes(r.kind)).map((r) => r.path).sort(),
    },
    home(`${modules}/a11y/index.min.js?ver=6.6.2`, 5),
  ]);
  const copy = join(root, 'no-js');
  const out = join(root, 'no-js-out', 'baseline');
  t.after(() => {
    rmSync(copy, { recursive: true, force: true });
    rmSync(join(root, 'no-js-out'), { recursive: true, force: true });
  });
  cpSync(capture, copy, { recursive: true });
  rmSync(join(copy, 'js'), { recursive: true });
  const result = await build(['--capture', copy, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readJson(out, 'js.json'), []);
});

test("sitemaps.json lists the live site's sitemap file names the capture saved", () => {
  assert.deepEqual(readJson(baseline, 'sitemaps.json'), ['category-sitemap.xml', 'page-sitemap.xml', 'post-sitemap.xml', 'sitemap_index.xml']);
});

test('an unreferenced size (downloaded: false) is kept in baseline/media.json with its reason, and counted apart', async (t) => {
  const listed = join(root, 'capture-listed');
  const out = join(root, 'baseline-listed');
  cpSync(capture, listed, { recursive: true });
  t.after(() => rmSync(listed, { recursive: true, force: true }));
  const media = readJson(capture, 'media.json');
  const extra = { url: 'x', path: '/wp-content/uploads/2026/01/hero-150x150.jpg', source: ['rest'], referencedBy: [], status: null, contentType: null, bytes: null, downloaded: false, reason: 'unreferenced size' };
  writeFileSync(join(listed, 'media.json'), JSON.stringify([...media, extra]));
  const result = await build(['--capture', listed, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /20 media \(1 unreferenced size listed, not downloaded\)/);
  const baselineMedia = readJson(out, 'media.json');
  assert.equal(baselineMedia.length, 21);
  assert.deepEqual(baselineMedia.at(-1), { path: extra.path, bytes: null, contentType: null, referencedBy: [], downloaded: false, reason: 'unreferenced size' });
  const counts = readJson(out, 'counts.json');
  assert.equal(counts.media, 20);
  assert.equal(counts.unreferencedSizes, 1);
  assert.equal((await build(['--out', out, '--check'])).code, 0, 'the counts check holds');
  // Without such entries nothing changes: no unreferencedSizes key, no extra fields.
  assert.equal(readJson(baseline, 'counts.json').unreferencedSizes, undefined);
  assert.equal(readFileSync(join(baseline, 'media.json'), 'utf8').includes('downloaded'), false);
});

test('counts.json sums the baseline', () => {
  assert.deepEqual(readJson(baseline, 'counts.json'), {
    routes: 16,
    byStatus: { 200: 15, 404: 1 },
    byTemplate: { archive: 2, home: 1, other: 3, page: 6, 'page-2': 1, 'single-post': 3 },
    redirects: { seed: 3, shortlink: 12 },
    media: 20,
    forms: 2,
    scripts: 2,
  });
});

test('--check passes on the built baseline and exits 1 after a route is deleted', async (t) => {
  const passed = await build(['--out', baseline, '--check']);
  assert.equal(passed.code, 0, passed.stderr);

  const copy = join(root, 'drift');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(baseline, copy, { recursive: true });
  const routes = readJson(copy, 'routes.json').filter((r) => r.path !== '/hidden-page/');
  writeFileSync(join(copy, 'routes.json'), JSON.stringify(routes));
  const drifted = await build(['--out', copy, '--check']);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stdout, /routes: expected 16, got 15/);
});

test('meta.json records the capture origin, times and platform', () => {
  const meta = readJson(baseline, 'meta.json');
  const captured = readJson(capture, 'meta.json');
  assert.deepEqual(Object.keys(meta), ['origin', 'canonicalOrigin', 'capturedAt', 'builtAt', 'platform']);
  assert.equal(meta.origin, captured.origin);
  assert.equal(meta.canonicalOrigin, captured.canonicalOrigin);
  assert.equal(meta.capturedAt, captured.finishedAt);
  assert.ok(!Number.isNaN(Date.parse(meta.builtAt)));
  assert.equal(meta.platform, 'wordpress');
  // The absolute URLs in seo.json are on this origin.
  assert.ok(readJson(baseline, 'seo.json')['/contact/'].canonical.startsWith(meta.canonicalOrigin));
});

for (const [file, script] of [['media.json', 'media.mjs'], ['templates.json', 'templates.mjs']]) {
  test(`a capture without ${file} exits 2 and says to run ${script}`, async (t) => {
    const copy = join(root, `no-${file}`);
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(capture, copy, { recursive: true });
    rmSync(join(copy, file));
    const result = await build(['--capture', copy, '--out', join(copy, '..', `no-${file}-baseline`)]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`run ${script.replace('.', '\\.')} first`));
    assert.ok(!existsSync(join(root, `no-${file}-baseline`)), 'nothing written');
  });
}

test('a capture without feeds or scripts warns and still builds; without wp-rest it is silent', async (t) => {
  const copy = join(root, 'sparse');
  const out = join(root, 'sparse-out', 'baseline');
  t.after(() => {
    rmSync(copy, { recursive: true, force: true });
    rmSync(join(root, 'sparse-out'), { recursive: true, force: true });
  });
  cpSync(capture, copy, { recursive: true });
  for (const p of ['feeds', 'scripts.json', 'wp-rest']) rmSync(join(copy, p), { recursive: true });
  const result = await build(['--capture', copy, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const warnings = result.stderr.trim().split('\n');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /warning: no feeds\/index\.json/);
  assert.match(warnings[1], /warning: no scripts\.json/);
  assert.deepEqual(readJson(out, 'scripts.json'), {});
});

test('--out pointing at the capture folder exits 2 and leaves the capture alone', async () => {
  const result = await build(['--capture', capture, '--out', capture]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /capture folder/);
  assert.ok(existsSync(join(capture, 'text', 'contact.txt')));
  assert.ok(!existsSync(join(capture, 'routes.json')));
});

test('usage errors exit 2', async () => {
  assert.equal((await build(['--capture', join(root, 'missing'), '--out', join(root, 'x')])).code, 2);
  assert.equal((await build(['--bogus'])).code, 2);
  const help = await build(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--check/);
});

test('a capture with no page that answered 200 exits 2 and writes nothing', async (t) => {
  const copy = join(root, 'no-pages');
  const out = join(root, 'no-pages-baseline');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(capture, copy, { recursive: true });
  const inventory = readJson(copy, 'inventory.json').map((r) => ({ ...r, status: r.status === 200 ? 'challenge' : r.status }));
  writeFileSync(join(copy, 'inventory.json'), JSON.stringify(inventory));
  const result = await build(['--capture', copy, '--out', out]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no page .*answered 200/i);
  assert.ok(!existsSync(out), 'nothing written');
});

test('a "suspect-challenge" page stays a route with that status, so the routes gate asks for a decision', () => {
  const routes = buildRoutes({
    inventory: [{ path: '/empty/', status: 'suspect-challenge', snapshot: null, bodyClasses: [] }],
    feeds: [], media: [], templates: [], rest: {}, foundBy: {},
  });
  assert.deepEqual(routes.map((r) => `${r.path}:${r.status}`), ['/empty/:suspect-challenge']);
});
