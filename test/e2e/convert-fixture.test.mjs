// The convert-site run on the fixture, phase by phase as skills/convert-site/SKILL.md and
// references/phases.md write it (test/e2e/lib/run.mjs), each phase's proof asserted below.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture } from '../fixture/serve.mjs';
import * as R from './lib/run.mjs';

// One site folder per process, so two runs (two worktrees, or a run and a rebase) never share one.
const SITE = join(R.TMP, 'e2e', `site-${process.pid}`);
const results = {};
let fixture;

before(async () => {
  fixture = await startFixture();
  const live = fixture.origin;
  const site = SITE;
  results.intake = await R.intake({ site, live });
  results.capture = await R.capture({ site, live });
  results.plan = await R.plan({ site });
  results.scaffold = await R.scaffold({ site, live, trailingSlash: results.plan.trailingSlash });
  results.baseline = await R.baseline({ site });
  results.build = await R.build({ site, live });
  results.gates = await R.gates({ site });
  results.visual = await R.visual({ site, live });
  await R.components({ site });
  results.prelaunch = await R.prelaunch({ site, live });
  results.suggestions = await R.suggestions({ site });
  results.pr = await R.pr({ site, results });
});

after(async () => {
  await fixture?.close();
  R.cleanUp(SITE);
});

const shown = (result) => `${result.command} exited ${result.code}\n${result.stdout}\n${result.stderr}`;
const ok = (result) => assert.equal(result.code, 0, shown(result));
const file = (...parts) => join(SITE, ...parts);

test('1 intake: the answers and the needs-you list are in state', () => {
  const { intake, needsYou } = R.state(SITE);
  assert.equal(intake.hosting, 'vercel');
  assert.equal(intake.platform, 'wordpress');
  assert.ok(needsYou.length >= 3);
  assert.equal(results.intake.preflight.tools.gh.present, false, 'no CLI is reachable from the run');
});

test('2 capture: into SITE before the scaffold, Notes written, coverage and templates in capture/', () => {
  for (const f of ['README.md', 'templates.json', 'css-coverage.json', 'inventory.json', 'js/manifest.json']) assert.ok(existsSync(file('capture', f)), f);
  assert.match(readFileSync(file('capture', 'README.md'), 'utf8'), /## Notes\n[\s\S]*Lighthouse:/);
  assert.ok(R.readJson(file('capture', 'inventory.json')).every((r) => typeof r.status === 'number'));
  assert.ok(existsSync(file('.conversion', 'media-cache', 'wp-content', 'uploads', '2026', '01', 'og-card.jpg')), 'media downloaded into .conversion/media-cache');
});

test('3 plan: every decision recorded, the media plan drafted under .conversion/', () => {
  assert.equal(results.plan.trailingSlash, 'always');
  assert.equal(results.plan.mediaPlan.mode, 'repo');
  assert.deepEqual(results.plan.decisions, results.plan.decisions.map((_, i) => `d${i + 1}`));
});

test('4 scaffold: init-site around capture/ and .conversion/; main holds the one scaffold commit', () => {
  ok(results.scaffold.build);
  assert.deepEqual(results.scaffold.mainLog.length, 1);
  assert.match(results.scaffold.mainLog[0], /chore: scaffold from astro-conversion-kit/);
  assert.equal(results.scaffold.branch, 'astro-rebuild');
  assert.ok(existsSync(file('docs', 'media-plan.json')) && !existsSync(file('.conversion', 'media-plan.json')));
  assert.match(readFileSync(file('docs', 'plan.md'), 'utf8'), /\| d1 \| .* \| CSS per live sheet \|/);
  assert.match(readFileSync(file('.gitignore'), 'utf8'), /^\/\.conversion\/media-cache\/$/m);
});

test('5 baseline: written, js.json lists the theme scripts and modules, --check passes', () => {
  ok(results.baseline.check);
  assert.deepEqual(R.readJson(file('baseline', 'js.json')).map((s) => new URL(s.src).pathname), [
    '/wp-includes/js/script-modules/interactivity/index.min.js',
    '/wp-content/themes/fixture/js/util.js',
    '/wp-content/themes/fixture/js/view.js',
    '/wp-content/themes/fixture/js/reveal.js',
    '/wp-includes/js/script-modules/a11y/index.min.js',
  ]);
});

test('6 build: the seven gates pass on the templates and then on every path; the design lock holds', () => {
  for (const [gate, result] of Object.entries(results.build.templateGates)) assert.equal(result.code, 0, `${gate} (templates)\n${shown(result)}`);
  for (const [gate, result] of Object.entries(results.build.allGates)) assert.equal(result.code, 0, `${gate} (every path)\n${shown(result)}`);
  ok(results.build.lock.diff);
  ok(results.build.lock.styles);
  for (const f of ['Header.astro', 'Nav.astro', 'Footer.astro']) assert.ok(existsSync(file('src', 'components', f)), f);
  assert.ok(existsSync(file('src', 'pages', '[...path].astro')));
  assert.match(R.readJson(file('vercel.json')).rewrites.map((r) => `${r.source} ${r.destination}`).join(), /\/feed\/ \/feed\/index\.xml/);
  // Each page's head CSS as live has it: one link per live sheet (root-relative, its query and
  // media kept) and its <style> blocks, in live's order, before the per-page head content.
  const headCss = (html) => [...html.split('</head>')[0].matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>|<style\b[^>]*>/g)].map(({ 0: tag, index }) => {
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1];
    const media = /\bmedia="([^"]*)"/.exec(tag)?.[1];
    return { tag: href ? `link ${href.replace(fixture.origin, '')} ${media ?? ''}` : 'style', index };
  });
  const routes = R.readJson(file('baseline', 'routes.json'));
  for (const [path, page] of [['/', 'index.html'], ['/about/', join('about', 'index.html')], ['/contact/', join('contact', 'index.html')]]) {
    const built = readFileSync(file('dist', page), 'utf8');
    const live = headCss(readFileSync(file('capture', routes.find((r) => r.path === path).snapshot), 'utf8'));
    const sheets = headCss(built);
    assert.ok(live.some((s) => s.tag.startsWith('link')), `${path}: live links a stylesheet`);
    if (path !== '/about/') assert.ok(live.some((s) => s.tag === 'style'), `${path}: live has head <style> blocks`);
    assert.deepEqual(sheets.map((s) => s.tag), live.map((s) => s.tag), `${path}: the live head CSS order`);
    const perPage = built.indexOf('property="og:');
    assert.ok(perPage > 0, `${page}: the page's og tags are in the head`);
    assert.ok(sheets.every((s) => s.index < perPage), `${page}: the stylesheets come before the per-page head content`);
  }
  // The theme sheet is served pruned at its live path, and no site.css is linked.
  const theme = readFileSync(file('dist', 'wp-content', 'themes', 'fixture', 'style.css'), 'utf8');
  assert.ok(theme.length < readFileSync(file('capture', 'css', '1.css'), 'utf8').length, 'the theme sheet is pruned');
  assert.ok(!readFileSync(file('dist', 'index.html'), 'utf8').includes('/_astro/site.'), 'no site.css link');
});

test('7 gates: npm run verify passes the staging build and verify:release the release build', () => {
  ok(results.gates.staging);
  assert.match(results.gates.staging.stdout, /^All 10 gates passed$/m);
  assert.match(results.gates.staging.stdout, /^headers: 4 checked, 0 failed$/m);
  assert.match(results.gates.stagingAbout, /<meta name="robots" content="noindex, nofollow">/);
  ok(results.gates.release);
  assert.match(results.gates.release.stdout, /^All 10 gates passed$/m);
});

test('8 visual: every template at 390, 768 and 1440, and every page at 390 and 1440, within 0.5 %', () => {
  const { templateSet, diffAll, sheetAll, check } = results.visual;
  ok(templateSet.diff);
  ok(templateSet.styles);
  ok(diffAll);
  const templates = R.readJson(file('capture', 'templates.json'));
  const rows = R.readJson(file('review', 'diff', 'diff.json'));
  assert.equal(rows.length, templates.length * R.WIDTHS.length);
  for (const row of [...rows, ...R.readJson(file('review', 'diff-all', 'diff.json'))]) assert.ok(row.pass && row.percent <= 0.5, `${row.route}/${row.width}: ${row.percent} %`);
  assert.equal(R.readJson(file('review', 'diff-all', 'diff.json')).length, templates.reduce((n, t) => n + t.paths.length, 0) * 2);
  ok(sheetAll);
  ok(check);
  assert.match(check.stdout, /^review:check passed$/m);
  assert.ok(existsSync(file('review', 'index.html')) && existsSync(file('review', 'all.html')));
});

test('9 components: skipped, off by default', () => {
  assert.equal(R.state(SITE).phases.components.result, 'skipped: off by default');
});

// pre-launch with --predecessor-url fails two checks that read the kit's trailing-slash
// normalisation wrongly (upstream, in the launch skills): the slash rules count as wildcards, and
// the live /about -> /about/ redirect looks like a loop once trailing slashes are ignored.
// prelaunch-reconcile accepts exactly those two under its narrow rule, and the robots.txt check
// that flags the sister site's Sitemap: line live carried (kept as captured), and exits 0.
test('10 prelaunch: prelaunch-reconcile exits 0, accepting only the two slash-rule checks and the live robots line; verify-live passes staging and release', () => {
  ok(results.prelaunch.reconcile);
  const { accepted, blocking } = JSON.parse(results.prelaunch.reconcile.stdout);
  assert.deepEqual(blocking, []);
  assert.deepEqual(accepted.map((a) => `${a.id} ${a.rule}`).sort(), ['output.robots-txt live-robots', 'predecessor.redirect-chains slash', 'predecessor.wildcard-redirects slash'], shown(results.prelaunch.preLaunch));
  assert.deepEqual(accepted.find((a) => a.id === 'output.robots-txt').rows.map((r) => r.text), ['the Sitemap: line points at other.example.com, not 127.0.0.1']);
  const failing = results.prelaunch.gate.checks.filter((c) => c.status === 'fail');
  const chains = failing.find((c) => c.id === 'predecessor.redirect-chains');
  assert.deepEqual(chains.evidence.map((e) => e.value), ['/about -> /about is a loop and serves nothing']);
  const wildcards = failing.find((c) => c.id === 'predecessor.wildcard-redirects');
  assert.ok(wildcards.evidence.every((e) => e.value.startsWith('"/:path(')), 'only the slash rules');
  ok(results.prelaunch.stagingLive);
  assert.match(results.prelaunch.stagingLive.stdout, /^verify-live: \d+ checked, 0 failed$/m);
  ok(results.prelaunch.releaseLive);
  assert.equal(results.prelaunch.audit.code, 0, shown(results.prelaunch.audit));
  // Staging's robots.txt blocks everything, so the audit crawls only with --ignore-robots. The
  // fixture's content links are absolute to the live origin (as WordPress writes them), so on
  // staging they are off-origin and dropped: the crawl reaches the pages linked relatively.
  const crawl = R.readJson(file('review', 'launch-audit', 'crawl.json'));
  assert.ok(crawl.pages.some((p) => p.status === 200 && new URL(p.url).pathname === '/'), JSON.stringify(crawl.pages));
  assert.ok(crawl.dropped.some((d) => d.reason === 'off-origin'), 'absolute live links are named as dropped');
  assert.ok(existsSync(file('docs', 'launch', 'audit-baseline.json')));
});

test('11 suggestions: gates.json collected, docs/suggestions.md with the fixture findings and "From the review"', () => {
  assert.equal(results.suggestions.gatesJson.length, 10);
  assert.ok(results.suggestions.gatesJson.every((g) => g.failed === 0));
  const { items } = R.readJson(file('suggestions.json'));
  const paths = (id) => items.filter((i) => i.id === id).map((i) => i.path);
  assert.deepEqual(paths('shortcode-leftovers'), ['/choosing-siding-colors/']);
  assert.deepEqual(paths('missing-alt'), ['/']);
  assert.deepEqual(paths('orphan-pages'), ['/hidden-page/']);
  assert.deepEqual(paths('redirect-chains'), ['/old-services']);
  assert.deepEqual(paths('broken-links'), ['/deleted-post/']);
  assert.ok(paths('no-webp').includes('/wp-content/uploads/2026/01/hero-1024x683.jpg'));
  assert.match(readFileSync(file('docs', 'suggestions.md'), 'utf8'), /## From the review\n[^#]*$/);
});

test('12 pr: review:check and the gates pass once more, the body is written, astro-rebuild is pushed; every phase has finished', () => {
  ok(results.pr.verify);
  ok(results.pr.check);
  assert.match(results.pr.check.stdout, /^review:check passed$/m);
  assert.match(readFileSync(file('.conversion', 'pr-body.md'), 'utf8'), /## Gate output\n\n```\n[\s\S]*All 10 gates passed/);
  const { phases } = R.state(SITE);
  assert.deepEqual(Object.keys(phases), R.PHASES);
  for (const name of R.PHASES) assert.ok(phases[name].finishedAt, `${name} finished`);
  assert.ok(readdirSync(`${SITE}-remote.git`).includes('refs'));
});
