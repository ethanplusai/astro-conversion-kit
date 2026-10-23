import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixtureBaseline } from '../gates/fixtures/baseline.mjs';
import { slashRules } from '../../skills/parity-gates/scripts/build-redirects.mjs';
import { isSlashRule } from '../../skills/convert-site/scripts/prelaunch-reconcile.mjs';

const SCRIPT = resolve(import.meta.dirname, '../../skills/convert-site/scripts/prelaunch-reconcile.mjs');

function run(args, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd }, (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function git(cwd, ...args) {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }, (err) => (err ? fail(err) : done()));
  });
}

// A PNG header carrying only its size: enough for the IHDR width and height to be read.
function pngOf(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let root;
let baseline;
let plan;
let bare;
let capture;
let n = 0;

// The live fixture with three oddities planted the way a real capture records them: /services/
// has no h1, the two service pages share a title, and /about/ shows "Coming soon".
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'prelaunch-reconcile-'));
  const captured = await buildFixtureBaseline(join(root, 'fixture'));
  baseline = join(root, 'baseline');
  cpSync(captured, baseline, { recursive: true });
  const seoFile = join(baseline, 'seo.json');
  const seo = JSON.parse(readFileSync(seoFile, 'utf8'));
  seo['/services/'].h1 = [];
  seo['/services/siding/'].title = seo['/services/roofing/'].title;
  writeFileSync(seoFile, JSON.stringify(seo));
  appendFileSync(join(baseline, 'text', 'about.txt'), '\nComing soon\n');
  // The capture's assets: the favicon the home page links (an SVG), a live 404 for /favicon.ico,
  // and a 152x152 apple-touch-icon.png.
  capture = join(root, 'capture');
  mkdirSync(join(capture, 'assets'), { recursive: true });
  writeFileSync(join(capture, 'assets', 'apple-touch-icon.png'), pngOf(152, 152));
  writeFileSync(join(capture, 'assets', 'index.json'), JSON.stringify([
    { kind: 'favicon', url: 'https://live.example.com/wp-content/uploads/2026/01/favicon.svg', file: 'assets/favicon.svg', status: 200, note: null },
    { kind: 'favicon.ico', url: 'https://live.example.com/favicon.ico', file: null, status: 404, note: 'missing' },
    { kind: 'apple-touch-icon', url: 'https://live.example.com/apple-touch-icon.png', file: 'assets/apple-touch-icon.png', status: 200, note: null },
  ]));
  plan = join(root, 'plan.md');
  writeFileSync(plan, [
    '# Conversion plan', '', '## Decisions', '',
    '| Id | Date | Topic | Choice | Default | Reason | Cost if wrong |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| d1 | 2026-10-22 | one pruned site.css | one file | one file | default | none |',
    '| d2 | 2026-10-22 | missing h1 on /services/ | reproduce live | reproduce live | parity | none |',
    '| d3 | 2026-10-22 | output.titles: the two service pages share a title | reproduce live | reproduce live | parity | none |',
    '| d4 | 2026-10-22 | "Coming soon" on /about/ | reproduce live | reproduce live | parity | none |',
    '',
  ].join('\n'));
  bare = join(root, 'bare.md');
  writeFileSync(bare, '# Conversion plan\n\n## Decisions\n\n| Id | Date | Topic | Choice | Default | Reason | Cost if wrong |\n| --- | --- | --- | --- | --- | --- | --- |\n| d1 | 2026-10-22 | one pruned site.css | one file | one file | default | none |\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const failing = (id, detail, values, type = 'html') => ({ id, status: 'fail', severity: 'blocker', detail, evidence: values.map((value) => ({ type, value })) });
const passing = (id) => ({ id, status: 'pass', detail: 'no problems found', evidence: [] });

function gateFile(checks) {
  const dir = join(root, `bundle-${n += 1}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gate.json');
  writeFileSync(file, JSON.stringify({ gate: checks.some((c) => c.status === 'fail') ? 'fail' : 'pass', checks }));
  return file;
}

const reconcile = (checks, { planFile = plan, json = true, captureDir = capture, extra = [], cwd } = {}) =>
  run(['--findings', gateFile(checks), '--baseline', baseline, '--plan', planFile, '--capture', captureDir, ...extra, ...(json ? ['--json'] : [])], cwd);
const parsed = (result) => JSON.parse(result.stdout);

const SLASH_ROWS = {
  wildcards: failing('predecessor.wildcard-redirects', '1 wildcard rule stand in for urls that need their own destinations', [
    `"${slashRules('always')[0].source} -> /:path/" covers 13 old content urls: /about, /blog, …`,
  ], 'text'),
  chains: failing('predecessor.redirect-chains', '1 rule do not reach their destination in one hop', ['/about -> /about is a loop and serves nothing'], 'text'),
};

test('every slash rule build-redirects writes is recognised, whatever extensions the site adds; a doctored one is not', () => {
  for (const rules of [slashRules('always'), slashRules('always', ['foo', 'Mp3', 'x3d']), slashRules('never')]) {
    for (const r of rules) assert.ok(isSlashRule(r.source, r.destination), r.source);
  }
  const [first, second] = slashRules('always');
  assert.ok(!isSlashRule(first.source, '/elsewhere/'));
  assert.ok(!isSlashRule(second.source.replace('[Jj][Pp][Gg]', '.*'), second.destination));
  assert.ok(!isSlashRule('/blog/:path*', '/news/'));
});

test('a passing gate: nothing to reconcile, exit 0', async () => {
  const result = await reconcile([passing('output.h1')], { json: false });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^prelaunch-reconcile: 0 failing checks, 0 accepted, 0 blocking$/m);
});

test('the two predecessor slash-rule checks are accepted under the narrow rule, no decision needed', async () => {
  const result = await reconcile([SLASH_ROWS.wildcards, SLASH_ROWS.chains, passing('output.h1')], { planFile: bare });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const { accepted, blocking } = parsed(result);
  assert.deepEqual(accepted.map((a) => a.id).sort(), ['predecessor.redirect-chains', 'predecessor.wildcard-redirects']);
  assert.deepEqual(blocking, []);
  assert.ok(accepted.every((a) => a.rule === 'slash'));
});

test('a wildcard that is not a slash rule, or a real chain, blocks', async () => {
  const result = await reconcile([
    failing('predecessor.wildcard-redirects', '1 wildcard rule', ['"/blog/:path* -> /news/" covers 3 old content urls: /blog/a'], 'text'),
    failing('predecessor.redirect-chains', '2 rules do not reach', ['/about -> /about is a loop and serves nothing', '/a -> /b -> /c takes 2 hops'], 'text'),
  ]);
  assert.equal(result.code, 1);
  const { accepted, blocking } = parsed(result);
  assert.deepEqual(accepted, []);
  assert.deepEqual(blocking.map((b) => b.id).sort(), ['predecessor.redirect-chains', 'predecessor.wildcard-redirects']);
  const chains = blocking.find((b) => b.id === 'predecessor.redirect-chains');
  assert.deepEqual(chains.rows.filter((r) => !r.ok).map((r) => r.text), ['/a -> /b -> /c takes 2 hops']);
});

test('placeholders.form-id is accepted while the kit placeholder stands for the missing form id', async () => {
  const ok = await reconcile([failing('placeholders.form-id', '2 placeholder form ids in 2 files; submissions to it go nowhere', [
    'src/components/ContactForm.astro:4 — formspree.io/f/REPLACE', 'dist/contact/index.html:88 — formspree.io/f/REPLACE',
  ], 'file')], { planFile: bare });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'form id (needs you)');
  const other = await reconcile([failing('placeholders.form-id', '1 placeholder form id in 1 file', ['src/x.astro:1 — formspree.io/f/your-form-id'], 'file')]);
  assert.equal(other.code, 1);
});

test('a missing h1 that live also lacked, with its decision row, is accepted with the decision id', async () => {
  const result = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements'])]);
  assert.equal(result.code, 0, result.stdout);
  const [row] = parsed(result).accepted;
  assert.equal(row.id, 'output.h1');
  assert.equal(row.decision, 'd2');
  assert.deepEqual(row.rows.map((r) => [r.paths, r.field]), [[['/services/'], 'h1']]);
});

test('the same row without a decision blocks, and so does a value live did not have', async () => {
  const noDecision = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements'])], { planFile: bare });
  assert.equal(noDecision.code, 1);
  assert.match(parsed(noDecision).blocking[0].rows[0].reason, /no decision row/);
  const notLive = await reconcile([failing('output.h1', '1 of 14 pages affected', ['about/index.html has 2 h1 elements'])]);
  assert.equal(notLive.code, 1);
  assert.match(parsed(notLive).blocking[0].rows[0].reason, /live recorded 1/);
});

test('a shared title is accepted by a decision naming the check; a new page sharing it blocks', async () => {
  const roofing = JSON.parse(readFileSync(join(baseline, 'seo.json'), 'utf8'))['/services/roofing/'].title;
  const shared = (rels) => failing('output.titles', '1 title problem across 14 pages', [`${rels} share the title "${roofing}"`]);
  const ok = await reconcile([shared('services/roofing/index.html, services/siding/index.html')]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'd3');
  const extra = await reconcile([shared('services/roofing/index.html, services/siding/index.html, thank-you/index.html')]);
  assert.equal(extra.code, 1);
});

test('a check whose evidence was cut at the listing cap blocks: the unlisted rows cannot be compared', async () => {
  const result = await reconcile([failing('output.h1', '25 of 40 pages affected', ['services/index.html has 0 h1 elements'])]);
  assert.equal(result.code, 1);
  assert.match(parsed(result).blocking[0].rows.at(-1).reason, /only 1 of 25 rows listed/);
});

test('placeholder copy live showed is accepted; the source hit rides on the page it renders', async () => {
  const result = await reconcile([failing('placeholders.copy', '2 placeholder strings in 2 files; a visitor would read them', [
    'dist/about/index.html:40 — Coming soon', 'src/content/pages/about.md:3 — Coming soon',
  ], 'file')]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(parsed(result).accepted[0].decision, 'd4');
  const todo = await reconcile([failing('placeholders.copy', '1 placeholder string in 1 file', ['dist/about/index.html:41 — TODO'], 'file')]);
  assert.equal(todo.code, 1);
});

test('canonical, og:image and favicon rows block when live had them', async () => {
  const result = await reconcile([
    failing('output.canonical', '1 page declares a canonical that will not do what it looks like it does', ['services/index.html has no canonical link']),
    failing('output.og-image', 'none of the 1 page in the build declares an og:image', ['services/index.html'], 'file'),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(parsed(result).blocking.map((b) => b.id), ['output.canonical', 'output.og-image']);
});

test('favicon rows: accepted only on the capture evidence that live lacked the file or had the same size', async () => {
  const planFile = join(root, 'favicon-plan.md');
  writeFileSync(planFile, `${readFileSync(bare, 'utf8')}| d2 | 2026-10-22 | output.favicon-set: icons as live had them | reproduce live | reproduce live | parity | none |\n`);
  const favicon = (value) => reconcile([failing('output.favicon-set', value, [value], 'file')], { planFile });
  const ico = await favicon('favicon.ico is missing');
  assert.equal(ico.code, 0, ico.stdout);
  assert.equal(parsed(ico).accepted[0].decision, 'd2');
  // Live linked an SVG favicon, so a missing scalable icon is not what live had.
  assert.equal((await favicon('neither favicon.svg nor a favicon-<size>.png / icon-<size>.png exists')).code, 1);
  assert.equal((await favicon('apple-touch-icon.png is 152x152, not 180x180')).code, 0);
  const smaller = await favicon('apple-touch-icon.png is 120x120, not 180x180');
  assert.equal(smaller.code, 1);
  assert.match(parsed(smaller).blocking[0].rows[0].reason, /live's is 152x152/);
  // A file the capture never asked for is not evidence that live lacked it.
  const unasked = await reconcile([failing('output.favicon-set', 'favicon.ico is missing', ['favicon.ico is missing'], 'file')], { planFile, captureDir: join(root, 'no-capture') });
  assert.equal(unasked.code, 1);
  assert.match(parsed(unasked).blocking[0].rows[0].reason, /the capture never asked for \/favicon\.ico/);
});

test('a bare / in a decision row is not the home page; a backticked one is', async () => {
  const row = (topic, reason) => `| d2 | 2026-10-22 | ${topic} | reproduce live | reproduce live | ${reason} | none |\n`;
  const loose = join(root, 'slash-loose.md');
  writeFileSync(loose, `${readFileSync(bare, 'utf8')}${row('keep / drop the hero', 'keep / drop')}`);
  const home = [failing('output.h1', '1 of 14 pages affected', ['index.html has 1 h1 elements'])];
  assert.equal((await reconcile(home, { planFile: loose })).code, 1);
  const ticked = join(root, 'slash-ticked.md');
  writeFileSync(ticked, `${readFileSync(bare, 'utf8')}${row('the h1 on `/`', 'parity')}`);
  const ok = await reconcile(home, { planFile: ticked });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'd2');
});

test('hygiene.pushed is accepted only with no remote and the push on the needs-you list', async () => {
  const site = join(root, 'site-no-remote');
  mkdirSync(join(site, '.conversion'), { recursive: true });
  await git(site, 'init', '-q');
  const state = join(site, '.conversion', 'state.json');
  const pushed = [failing('hygiene.pushed', 'this branch has no upstream, so the commit being deployed exists on this machine only', ['git rev-parse --abbrev-ref --symbolic-full-name @{u} reported no upstream'], 'text')];
  writeFileSync(state, JSON.stringify({ needsYou: ['gh is not logged in: create the repo, push main and astro-rebuild, open the PR from .conversion/pr-body.md'] }));
  const ok = await reconcile(pushed, { cwd: site });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(parsed(ok).accepted[0].rule, 'no-remote');
  writeFileSync(state, JSON.stringify({ needsYou: [] }));
  assert.equal((await reconcile(pushed, { cwd: site })).code, 1, 'not on the needs-you list');
  writeFileSync(state, JSON.stringify({ needsYou: ['push main and astro-rebuild'] }));
  await git(site, 'remote', 'add', 'origin', 'https://github.com/example/site.git');
  const remote = await reconcile(pushed, { cwd: site });
  assert.equal(remote.code, 1);
  assert.match(parsed(remote).blocking[0].rows[0].reason, /has a remote/);
});

test('any other failing check blocks, a crashed one included', async () => {
  const result = await reconcile([
    failing('hygiene.pushed', 'astro-rebuild has no upstream', ['git status: no upstream'], 'text'),
    failing('output.titles', 'check crashed — boom', ['output.titles threw: boom'], 'text'),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(parsed(result).blocking.map((b) => b.id), ['hygiene.pushed', 'output.titles']);
});

test('findings.json works too, and a crash only gate.json beside it records still blocks', async () => {
  const gate = gateFile([failing('output.sitemap', 'check crashed — boom', ['output.sitemap threw: boom'], 'text'), passing('output.h1')]);
  const findings = join(gate, '..', 'findings.json');
  writeFileSync(findings, JSON.stringify([
    { id: 'output.h1', severity: 'blocker', detail: '1 of 14 pages affected', evidence: [{ type: 'html', value: 'services/index.html has 0 h1 elements' }] },
    { id: 'output.lang', severity: 'low', detail: 'advisory', evidence: [{ type: 'html', value: 'x' }] },
  ]));
  const result = await run(['--findings', findings, '--baseline', baseline, '--plan', plan, '--json']);
  assert.equal(result.code, 1);
  const out = parsed(result);
  assert.deepEqual(out.accepted.map((a) => a.id), ['output.h1']);
  assert.deepEqual(out.blocking.map((b) => b.id), ['output.sitemap']);
});

test('the plain output names each accepted row as reproduced from live, with its decision', async () => {
  const result = await reconcile([failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements']), SLASH_ROWS.chains], { json: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^accepted {2}output\.h1: \/services\/ h1 — reproduced from live \(d2\)$/m);
  assert.match(result.stdout, /^accepted {2}predecessor\.redirect-chains: \/about -> \/about is a loop and serves nothing — trailing-slash rule \(known launch-skills limitation\)$/m);
});

// A plan holding the bare d1 and the given decision rows.
function planWith(name, ...rows) {
  const file = join(root, `${name}.md`);
  writeFileSync(file, `${readFileSync(bare, 'utf8')}${rows.map(([id, topic]) => `| ${id} | 2026-10-22 | ${topic} | reproduce live | reproduce live | parity | none |\n`).join('')}`);
  return file;
}

test('a decision that only names the path does not accept a row: it must name the check or the field too', async () => {
  const h1 = [failing('output.h1', '1 of 14 pages affected', ['services/index.html has 0 h1 elements'])];
  const pathOnly = await reconcile(h1, { planFile: planWith('path-only', ['d2', 'templates: /services/ and /about/ use the page layout']) });
  assert.equal(pathOnly.code, 1, pathOnly.stdout);
  assert.match(parsed(pathOnly).blocking[0].rows[0].reason, /no decision row in the plan names output\.h1, or \/services\/ with its h1/);
  const field = await reconcile(h1, { planFile: planWith('path-field', ['d2', 'no H1 on /services/, as live']) });
  assert.equal(field.code, 0, field.stdout);
  const check = await reconcile(h1, { planFile: planWith('check-only', ['d2', 'output.h1 rows reproduce live']) });
  assert.equal(check.code, 0, check.stdout);
});

// A capture holding the live 404 page (meta.json notFound) and the root icon probe.
function notFoundCapture(name, { icons = {}, head = '<title>Page not found</title>' } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'text'), { recursive: true });
  writeFileSync(join(dir, 'pages', '404.html'), `<!doctype html><html><head>${head}</head><body><h1>Oops</h1><p>Nothing here</p></body></html>`);
  writeFileSync(join(dir, 'text', '404.txt'), 'Oops\nNothing here\n');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    notFound: { path: '/0123456789abcdef0123456789abcdef/', status: 404, snapshot: 'pages/404.html', text: 'text/404.txt' }, icons,
  }));
  return dir;
}

test('the captured 404 page is a page: its rows reproduce live when the capture shows the same', async () => {
  const captureDir = notFoundCapture('capture-404');
  const planFile = planWith('plan-404', ['d2', 'og:image on `404.html`: none, as live']);
  const og = await reconcile([failing('output.og-image', 'none of the 1 page in the build declares an og:image', ['404.html'], 'file')], { planFile, captureDir });
  assert.equal(og.code, 0, og.stdout);
  assert.deepEqual(parsed(og).accepted[0].rows[0].paths, ['404.html']);
  const withImage = notFoundCapture('capture-404-og', { head: '<title>x</title><meta property="og:image" content="https://live.example.com/card.jpg">' });
  const notLive = await reconcile([failing('output.og-image', 'none of the 1 page in the build declares an og:image', ['404.html'], 'file')], { planFile, captureDir: withImage });
  assert.equal(notLive.code, 1);
  assert.match(parsed(notLive).blocking[0].rows[0].reason, /live recorded og:image https:\/\/live\.example\.com\/card\.jpg/);
  const noCapture = await reconcile([failing('output.og-image', 'none of the 1 page in the build declares an og:image', ['404.html'], 'file')], { planFile, captureDir: join(root, 'no-capture') });
  assert.match(parsed(noCapture).blocking[0].rows[0].reason, /live has no page at \/404/);
});

test('favicon rows read meta.json icons: a root icon live answered 404 for is reproduced, one it served is not', async () => {
  const planFile = planWith('plan-icons', ['d2', 'output.favicon-set: icons as live had them']);
  const row = [failing('output.favicon-set', 'apple-touch-icon.png is missing', ['apple-touch-icon.png is missing'], 'file')];
  const none = await reconcile(row, { planFile, captureDir: notFoundCapture('capture-icons-404', { icons: { '/favicon.ico': 404, '/apple-touch-icon.png': 404 } }) });
  assert.equal(none.code, 0, none.stdout);
  const served = await reconcile(row, { planFile, captureDir: notFoundCapture('capture-icons-200', { icons: { '/favicon.ico': 404, '/apple-touch-icon.png': 200 } }) });
  assert.equal(served.code, 1);
  assert.match(parsed(served).blocking[0].rows[0].reason, /live served \/apple-touch-icon\.png/);
});

test('favicon rows read the meta.json icons objects a capture writes ({ status, file, ... })', async () => {
  // The fixture captured with --exclude: its meta.json icons say /favicon.ico was served (and saved)
  // and /apple-touch-icon.png answered 404.
  const excluded = join(root, 'excluded');
  await buildFixtureBaseline(excluded, { exclude: '/services/' });
  const { icons } = JSON.parse(readFileSync(join(excluded, 'capture', 'meta.json'), 'utf8'));
  assert.equal(icons['/favicon.ico'].status, 200);
  assert.equal(icons['/apple-touch-icon.png'].status, 404);
  const captureDir = notFoundCapture('capture-icons-objects', { icons });
  const planFile = planWith('plan-icons-objects', ['d2', 'output.favicon-set: icons as live had them']);
  const apple = await reconcile([failing('output.favicon-set', 'apple-touch-icon.png is missing', ['apple-touch-icon.png is missing'], 'file')], { planFile, captureDir });
  assert.equal(apple.code, 0, apple.stdout);
  const favicon = await reconcile([failing('output.favicon-set', 'favicon.ico is missing', ['favicon.ico is missing'], 'file')], { planFile, captureDir });
  assert.equal(favicon.code, 1, favicon.stdout);
  assert.match(parsed(favicon).blocking[0].rows[0].reason, /live served \/favicon\.ico/);
});

// A baseline whose live site published no sitemap, and a site whose dist builds the given routes.
function noSitemapSite(name, { drop = [] } = {}) {
  const base = join(root, `${name}-baseline`);
  cpSync(baseline, base, { recursive: true });
  writeFileSync(join(base, 'sitemaps.json'), '[]\n');
  const site = join(root, `${name}-site`);
  const routes = JSON.parse(readFileSync(join(base, 'routes.json'), 'utf8')).filter((r) => r.status === 200 && !drop.includes(r.path));
  for (const route of routes) {
    const file = route.path === '/' ? 'index.html' : `${route.path.replace(/^\/|\/$/g, '')}/index.html`;
    mkdirSync(join(site, 'dist', file, '..'), { recursive: true });
    writeFileSync(join(site, 'dist', file), '<!doctype html>');
  }
  return { base, site };
}

const NO_SITEMAP = failing('predecessor.coverage', '1 sitemap could not be fetched or parsed, so an unknown number of old urls were never checked', [
  'no sitemap could be fetched from https://www.fixture-roofing.test (tried robots.txt and the conventional paths)',
], 'url');

const reconcileAt = (checks, { base, site, planFile = bare }) => run(['--findings', gateFile(checks), '--baseline', base, '--plan', planFile, '--capture', capture, '--dir', site, '--json']);

test('predecessor.coverage with no live sitemap is accepted when every crawled page resolves in the build', async () => {
  const ok = await reconcileAt([NO_SITEMAP], noSitemapSite('nositemap'));
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(parsed(ok).accepted[0].rule, 'no-sitemap');

  const missing = noSitemapSite('nositemap-drop', { drop: ['/hidden-page/'] });
  const blocked = await reconcileAt([NO_SITEMAP], missing);
  assert.equal(blocked.code, 1);
  assert.match(parsed(blocked).blocking[0].rows[0].reason, /\/hidden-page\/ .*not in the build/);
  const decided = await reconcileAt([NO_SITEMAP], { ...missing, planFile: planWith('drop-hidden', ['d2', 'drop /hidden-page/ (orphan)']) });
  assert.equal(decided.code, 0, decided.stdout);
});

test('predecessor.coverage blocks when live had a sitemap, and for any other row', async () => {
  const { site } = noSitemapSite('withsitemap');
  const live = await reconcileAt([NO_SITEMAP], { base: baseline, site });
  assert.equal(live.code, 1);
  assert.match(parsed(live).blocking[0].rows[0].reason, /the capture saved a live sitemap/);
  const leftover = failing('predecessor.coverage', '1 of 14 urls on https://www.fixture-roofing.test exist neither', ['https://www.fixture-roofing.test/old/ has no destination'], 'url');
  assert.equal((await reconcileAt([leftover], noSitemapSite('leftover'))).code, 1);
});

test('output.robots-txt is accepted when every off-host Sitemap: line is one the live robots.txt carried verbatim', async () => {
  const live = join(root, 'robots-capture');
  cpSync(capture, live, { recursive: true });
  writeFileSync(join(live, 'robots.txt'), 'User-agent: *\nSitemap: https://www.fixture-roofing.test/sitemap_index.xml\nSitemap: https://sister.example.com/sitemap_index.xml\n');
  const site = join(root, 'robots-site');
  mkdirSync(join(site, 'dist'), { recursive: true });
  const build = (lines) => writeFileSync(join(site, 'dist', 'robots.txt'), `User-agent: *\nAllow: /\n\n${lines.map((l) => `Sitemap: ${l}\n`).join('')}`);
  const check = (...rows) => failing('output.robots-txt', rows.join('; '), rows, 'text');
  const at = (checks) => run(['--findings', gateFile(checks), '--baseline', baseline, '--plan', bare, '--capture', live, '--dir', site, '--json']);
  const sister = 'the Sitemap: line points at sister.example.com, not www.fixture-roofing.test';

  build(['https://www.fixture-roofing.test/sitemap-index.xml', 'https://sister.example.com/sitemap_index.xml']);
  const ok = await at([check(sister)]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(parsed(ok).accepted.map((a) => `${a.id} ${a.rule}`), ['output.robots-txt live-robots']);

  build(['https://www.fixture-roofing.test/sitemap-index.xml', 'https://sister.example.com/other-sitemap.xml']);
  const changed = await at([check(sister)]);
  assert.equal(changed.code, 1, 'a line live did not carry verbatim blocks');
  assert.match(parsed(changed).blocking[0].rows[0].reason, /other-sitemap\.xml.*not in the live robots\.txt/);

  build(['https://staging.example.com/sitemap-index.xml']);
  const staging = await at([check('the Sitemap: line points at staging.example.com, not www.fixture-roofing.test')]);
  assert.equal(staging.code, 1, 'a host live never named blocks');

  build(['https://sister.example.com/sitemap_index.xml']);
  const blocked = await at([check(sister, 'robots.txt contains "Disallow: /", which blocks the whole site')]);
  assert.equal(blocked.code, 1, 'any other robots.txt problem still blocks');
});

// A copy of the baseline with seo.json rows changed by edit(seo) and extra routes appended.
function baselineWith(name, edit, routes = []) {
  const dir = join(root, name);
  cpSync(baseline, dir, { recursive: true });
  const seo = JSON.parse(readFileSync(join(dir, 'seo.json'), 'utf8'));
  edit(seo);
  writeFileSync(join(dir, 'seo.json'), JSON.stringify(seo));
  const list = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
  writeFileSync(join(dir, 'routes.json'), JSON.stringify([...list, ...routes]));
  return dir;
}
const withBaseline = (dir, checks, opts = {}) => run(['--findings', gateFile(checks), '--baseline', dir, '--plan', opts.planFile ?? plan, '--capture', capture, ...(opts.extra ?? []), '--json']);

test('a check past the listing cap is accepted when a decision names it and the count equals live\'s', async () => {
  // 25 live pages without a description, every other page with its own.
  const many = baselineWith('baseline-many', (seo) => {
    for (const path of Object.keys(seo)) seo[path].description = `about ${path}`;
    for (let i = 1; i <= 25; i += 1) seo[`/p${i}/`] = { ...seo['/about/'], title: `Page ${i}`, description: null };
  });
  const rows = Array.from({ length: 20 }, (_, i) => `p${i + 1}/index.html has no meta description`);
  const check = (count) => failing('output.descriptions', `${count} meta description problems across 39 pages`, rows);
  const planFile = planWith('plan-many', ['d5', 'output.descriptions: 25 pages without a description on live']);
  const ok = await withBaseline(many, [check(25)], { planFile });
  assert.equal(ok.code, 0, ok.stdout);
  const [accepted] = parsed(ok).accepted;
  assert.equal(accepted.decision, 'd5');
  assert.equal(accepted.rows.length, 21);
  assert.match(accepted.rows.at(-1).text, /25 meta description problems/);
  const more = await withBaseline(many, [check(26)], { planFile });
  assert.equal(more.code, 1);
  assert.match(parsed(more).blocking[0].rows.at(-1).reason, /only 20 of 26 rows listed.*live had 25/);
  const undecided = await withBaseline(many, [check(25)], { planFile: planWith('plan-many-path', ['d5', 'description of `/p1/` kept as live']) });
  assert.equal(undecided.code, 1, 'a decision naming one row does not cover the unlisted ones');
  assert.match(parsed(undecided).blocking[0].rows.at(-1).reason, /only 20 of 25 rows listed/);
});

test('output.og-image: a missing image under the media prefix is accepted when the plan keeps media off the repo and the rewrite covers it', async () => {
  const media = JSON.parse(readFileSync(join(baseline, 'media.json'), 'utf8'));
  const image = media.find((m) => m.path.startsWith('/wp-content/uploads/') && m.path.endsWith('.jpg')).path;
  const row = (path) => failing('output.og-image', '1 og:image does not resolve', [`https://www.example.com${path} does not exist in the build (used by about/index.html)`], 'url');
  const WHOLE = { source: '/wp-content/uploads/:path*', destination: 'https://www.example.com/wp-content/uploads/:path*' };
  const site = (name, { mode, rewrite = true, rewrites = rewrite ? [WHOLE] : [], redirects = null }) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'media-plan.json'), JSON.stringify({ mode, prefix: '/wp-content/uploads/' }));
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({ rewrites }));
    if (redirects) {
      mkdirSync(join(dir, 'public'), { recursive: true });
      writeFileSync(join(dir, 'public', '_redirects'), redirects);
    }
    return ['--dir', dir];
  };
  const ok = await reconcile([row(image)], { planFile: bare, extra: site('site-live-temporary', { mode: 'live-temporary' }) });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(parsed(ok).accepted[0].decision, /media plan \(live-temporary\)/);
  const store = await reconcile([row(image)], { planFile: bare, extra: site('site-store', { mode: 'store' }), json: false });
  assert.equal(store.code, 0, store.stdout);
  assert.match(store.stdout, /served by the media rewrite/);
  const repo = await reconcile([row(image)], { planFile: bare, extra: site('site-repo', { mode: 'repo' }) });
  assert.equal(repo.code, 1, 'in repo mode the image belongs in the build');
  assert.match(parsed(repo).blocking[0].rows[0].reason, /live served this image/);
  const noRewrite = await reconcile([row(image)], { planFile: bare, extra: site('site-no-rewrite', { mode: 'store', rewrite: false }) });
  assert.equal(noRewrite.code, 1);
  const unknown = await reconcile([row('/wp-content/uploads/2026/01/not-captured.jpg')], { planFile: bare, extra: site('site-unknown', { mode: 'store' }) });
  assert.equal(unknown.code, 1, 'a path the baseline media does not list');
  // A rewrite that covers one file under the prefix, or sends the prefix to a path on this site,
  // serves nothing else under it.
  const oneFile = await reconcile([row(image)], { planFile: bare, extra: site('site-one-file', { mode: 'store', rewrites: [{ source: image, destination: `https://store.example.com${image}` }] }) });
  assert.equal(oneFile.code, 1, 'a one-file rewrite does not cover the prefix');
  const local = await reconcile([row(image)], { planFile: bare, extra: site('site-local', { mode: 'store', rewrites: [{ source: '/wp-content/uploads/:path*', destination: '/media/:path*' }] }) });
  assert.equal(local.code, 1, 'a rewrite to a path on the same site');
  const pages = await reconcile([row(image)], { planFile: bare, extra: site('site-redirects', { mode: 'live-temporary', rewrite: false, redirects: '/wp-content/uploads/* https://www.example.com/wp-content/uploads/:splat 302\n' }) });
  assert.equal(pages.code, 0, `a _redirects splat to another origin covers it\n${pages.stdout}`);
  const pagesLocal = await reconcile([row(image)], { planFile: bare, extra: site('site-redirects-local', { mode: 'live-temporary', rewrite: false, redirects: `/wp-content/uploads/* /media/:splat 200\n${image} https://www.example.com${image} 302\n` }) });
  assert.equal(pagesLocal.code, 1, 'a local splat or a one-file line does not');
});

test('output.noindex-utility-pages: accepted when live indexed the same page and a decision names it', async () => {
  const demo = baselineWith('baseline-demo', (seo) => {
    seo['/demo-gallery/'] = { ...seo['/about/'], title: 'Demo gallery', robots: 'index, follow' };
    seo['/test-page/'] = { ...seo['/about/'], title: 'Test page', robots: 'noindex, follow' };
  }, [{ path: '/demo-gallery/', status: 200, kind: 'page', template: 'page', noindex: false, snapshot: null, foundBy: ['crawl'] }]);
  const check = (rels) => failing('output.noindex-utility-pages', `${rels.length} confirmation, preview or demo page${rels.length === 1 ? '' : 's'} can be indexed`,
    rels.map((rel) => `${rel}/index.html (/${rel}) has no noindex`), 'file');
  const planFile = planWith('plan-demo', ['d6', '`/demo-gallery/` is indexable on live, kept indexable']);
  const ok = await withBaseline(demo, [check(['demo-gallery'])], { planFile });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(parsed(ok).accepted[0].decision, 'd6');
  const undecided = await withBaseline(demo, [check(['demo-gallery'])], { planFile: bare });
  assert.equal(undecided.code, 1);
  assert.match(parsed(undecided).blocking[0].rows[0].reason, /no decision row/);
  const liveNoindex = await withBaseline(demo, [check(['test-page'])], { planFile: planWith('plan-test', ['d6', 'output.noindex-utility-pages']) });
  assert.equal(liveNoindex.code, 1, 'live kept that page out of the index');
  assert.match(parsed(liveNoindex).blocking[0].rows[0].reason, /live recorded robots "noindex, follow"/);
});

test('usage errors exit 2', async () => {
  assert.equal((await run(['--findings', 'nope.json', '--baseline', baseline])).code, 2);
  assert.equal((await run(['--findings', join(root, 'missing.json'), '--baseline', baseline, '--plan', plan])).code, 2);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node prelaunch-reconcile\.mjs/);
});
