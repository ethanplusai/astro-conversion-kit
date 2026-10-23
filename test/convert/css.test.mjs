import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as csstree from 'css-tree';
import { startFixture } from '../fixture/serve.mjs';
import { mergeRanges } from '../../skills/convert-site/scripts/css-coverage.mjs';
import { mediaTested, pruneCss, rewriteRef, variantPath } from '../../skills/convert-site/scripts/css-prune.mjs';
import { stateBases } from '../../skills/convert-site/scripts/lib/state-selectors.mjs';
import { scopeInlineRules } from '../../skills/convert-site/scripts/lib/inline-scope.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPTS = join(ROOT, 'skills', 'convert-site', 'scripts');
const VISUAL = join(ROOT, 'skills', 'visual-review', 'scripts');
const SITE = join(ROOT, 'test', 'fixture', 'site');
const THEME = 'wp-content/themes/fixture/style.css';
const THEME_TEXT = readFileSync(join(SITE, THEME), 'utf8');
const TMP = join(ROOT, 'test', 'tmp', 'css');
const COVERAGE = join(TMP, 'coverage.json');
const LEFTOVER = [
  '.woocommerce-cart', '.woocommerce-checkout', '.elementor-section', '.elementor-widget-container',
  '.wp-block-cover', '.wp-block-pullquote', '.wp-block-table', '.sidebar-widget', '.widget_calendar',
  '.comment-respond', '.comment-list', '.pagination', '.sticky-post', '.author-bio', '.related-posts',
  '.newsletter-popup', '.cookie-notice', '.testimonial-slider', '.pricing-table', '.map-embed',
  '.gallery-columns-4', '.legacy-header-v1',
];

// Async on purpose: the fixture server lives in this process and must keep answering.
function run(script, args) {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}
const coverageCli = (args) => run(join(SCRIPTS, 'css-coverage.mjs'), args);
const pruneCli = (args) => run(join(SCRIPTS, 'css-prune.mjs'), args);

let fixture;
let themeUrl;
before(async () => {
  fixture = await startFixture();
  themeUrl = `${fixture.origin}/${THEME}?ver=1.4.2`;
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const inventory = join(TMP, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{ path: '/', status: 200 }, { path: '/contact/', status: 200 }]));
  const result = await coverageCli([
    '--base', fixture.origin, '--routes', inventory, '--widths', '390,768,1440', '--out', COVERAGE, '--delay', '0',
  ]);
  assert.equal(result.code, 0, result.stderr);
});
after(() => fixture.close());

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const overlaps = (ranges, start, end) => ranges.some(([a, b]) => a < end && b > start);

// A capture/css folder holding the theme stylesheet (plus any extra files),
// optionally with its manifest.
function captureCss(name, { file = '1.css', manifest = true, extra = [] } = {}) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), THEME_TEXT);
  for (const entry of extra) writeFileSync(join(dir, entry.file), entry.text);
  const entries = [{ file, href: themeUrl, pages: ['/'] }, ...extra.map(({ file: f, href }) => ({ file: f, href, pages: ['/'] }))];
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries));
  return dir;
}

const FONT_URL = 'url("/wp-content/themes/fixture/fonts/fixture-sans.woff2")';

test('mergeRanges sorts and merges overlapping and touching ranges', () => {
  assert.deepEqual(mergeRanges([[10, 20], [0, 5], [15, 30], [30, 31], [40, 41]]), [[0, 5], [10, 31], [40, 41]]);
});

test('css-coverage --help exits 0, and a missing --base exits 2', async () => {
  const help = await coverageCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--routes/);
  const bad = await coverageCli(['--routes', '/', '--out', join(TMP, 'x.json')]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--base/);
});

test('coverage reports the theme stylesheet with merged used ranges across routes', () => {
  const coverage = readJson(COVERAGE);
  const entry = coverage[themeUrl];
  assert.ok(entry, `keys: ${Object.keys(coverage).join(', ')}`);
  assert.equal(entry.text, THEME_TEXT);
  assert.ok(entry.usedRanges.length > 0);
  assert.deepEqual(entry.usedRanges, mergeRanges(entry.usedRanges), 'ranges are already merged');
  const at = (selector) => {
    const start = THEME_TEXT.indexOf(selector);
    return [start, THEME_TEXT.indexOf('}', start) + 1];
  };
  assert.ok(overlaps(entry.usedRanges, ...at('.site-header {')), 'home rule used');
  assert.ok(overlaps(entry.usedRanges, ...at('.contact-form label')), 'contact-only rule used');
  assert.ok(!overlaps(entry.usedRanges, ...at('.woocommerce-cart')), 'leftover rule unused');
});

test('coverage keys inline <style> blocks as inline:<n> with the pages they appear on', async () => {
  const html = '<!doctype html><style>.used { color: red; } .unused { color: blue; }</style><p class="used">x</p>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const out = join(TMP, 'inline.json');
  try {
    const result = await coverageCli([
      '--base', `http://127.0.0.1:${server.address().port}`, '--routes', '/,/b/', '--widths', '390', '--out', out, '--delay', '0',
    ]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    server.close();
  }
  const coverage = readJson(out);
  assert.deepEqual(Object.keys(coverage), ['inline:1']);
  const { text, usedRanges, pages } = coverage['inline:1'];
  assert.deepEqual(pages, ['/', '/b/']);
  assert.ok(overlaps(usedRanges, text.indexOf('.used'), text.indexOf('.used') + 5));
  assert.ok(!overlaps(usedRanges, text.indexOf('.unused'), text.indexOf('.unused') + 7));
});

test('an inline <style> block ending in a sourceURL comment is still keyed inline:<n> with its pages', () => {
  // WordPress 6.9+ ends each inline block with /*# sourceURL=<file> */ and Chromium then
  // reports the block under that URL instead of the page's.
  const coverage = readJson(COVERAGE);
  assert.ok(!Object.keys(coverage).some((key) => key.includes('/fake/')), `keys: ${Object.keys(coverage).join(', ')}`);
  const marked = Object.entries(coverage).filter(([, entry]) => entry.text.includes('sourceURL=http://127.0.0.1/fake/style-index.css'));
  assert.equal(marked.length, 1);
  const [key, entry] = marked[0];
  assert.match(key, /^inline:\d+$/);
  assert.deepEqual(entry.pages, ['/', '/contact/']);
  const at = entry.text.indexOf(':root{');
  assert.ok(overlaps(entry.usedRanges, at, at + 6), 'the :root rule is used');
});

test('coverage hovers the first link a person could point at, not a clipped skip link', async () => {
  const html = '<!doctype html><style>.skip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }'
    + ' .real:hover { color: red; }</style><a class="skip" href="#main">Skip</a><p><a class="real" href="/x/">Real</a></p>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const out = join(TMP, 'hover.json');
  try {
    const result = await coverageCli([
      '--base', `http://127.0.0.1:${server.address().port}`, '--routes', '/', '--widths', '390', '--out', out, '--delay', '0',
    ]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    server.close();
  }
  const { text, usedRanges } = readJson(out)['inline:1'];
  const start = text.indexOf('.real:hover');
  assert.ok(overlaps(usedRanges, start, text.indexOf('}', start) + 1), 'the hover rule of the visible link is used');
});

test('pruning removes the unused rules, keeps pseudo rules and @font-face, and copies kept source as written', async () => {
  const out = join(TMP, 'site.css');
  const report = join(TMP, 'prune-report.json');
  const result = await pruneCli(['--single-sheet', '--css', captureCss('capture-css'), '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  for (const selector of LEFTOVER) assert.ok(!css.includes(selector), `${selector} removed`);
  for (const kept of [
    'a:hover, a:focus { color: #7a2414; text-decoration: none; }',
    '.button:hover { background: #7a2414; color: #fff; }',
    '.skip-link:focus {',
    '.menu-item-has-children:hover .sub-menu { display: block; }',
    '.contact-form label { display: block; font-weight: 600; }',
    '@media (max-width: 640px) {\n  .site-header { flex-direction: column; gap: 12px; }\n  .hero h1 { font-size: 1.75rem; }\n}',
  ]) {
    assert.ok(css.includes(kept), `${kept} kept verbatim`);
  }
  assert.equal(css.match(/@font-face/g).length, 2);
  assert.ok(css.includes(`src: ${FONT_URL} format("woff2");`), 'font url rewritten root-relative');
  const errors = [];
  csstree.parse(css, { onParseError: (err) => errors.push(err.message) });
  assert.deepEqual(errors, []);

  const summary = readJson(report);
  assert.deepEqual(Object.keys(summary).sort(), ['after', 'before', 'keptBecause', 'mode', 'pageSheets', 'removedRules', 'uncoveredInline', 'unmatched', 'unparsed', 'unresolvedImports']);
  assert.deepEqual(summary.pageSheets, []);
  assert.deepEqual(Object.keys(summary.keptBecause).sort(), ['atRule', 'pseudo', 'state', 'untestedMedia']);
  assert.deepEqual(summary.unmatched, []);
  assert.ok(summary.removedRules >= 20, `removedRules ${summary.removedRules}`);
  assert.equal(summary.before, Buffer.byteLength(THEME_TEXT));
  assert.equal(summary.after, statSync(out).size);
  assert.ok(summary.after < summary.before);
});

test('without a manifest, coverage URLs match files by basename and still resolve url()', async () => {
  const out = join(TMP, 'basename.css');
  const report = join(TMP, 'basename-report.json');
  const dir = captureCss('capture-basename', { file: 'style.css', manifest: false });
  const result = await pruneCli(['--single-sheet', '--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no manifest\.json/);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.site-header'));
  assert.ok(!css.includes('.woocommerce-cart'));
  assert.ok(css.includes(FONT_URL));
});

test('coverage keys match the manifest on path and query whatever their origin', async () => {
  const moved = join(TMP, 'coverage-other-origin.json');
  const coverage = readJson(COVERAGE);
  const rekeyed = Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key.replace(fixture.origin, 'https://staging.example.com'), value]));
  writeFileSync(moved, JSON.stringify(rekeyed));
  const out = join(TMP, 'other-origin.css');
  const result = await pruneCli(['--single-sheet', '--css', captureCss('capture-other-origin'), '--coverage', moved, '--out', out, '--report', join(TMP, 'other-origin.json')]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.site-header {'));
  assert.ok(!css.includes('.woocommerce-cart'));
});

test('a file with no matching coverage is kept whole and the exit code is 1', async () => {
  const pluginCss = '.plugin-widget { color: red; }\n.plugin-other { color: blue; }\n';
  const dir = captureCss('capture-unmatched', {
    extra: [{ file: '2.css', href: `${fixture.origin}/wp-content/plugins/widget/widget.css`, text: pluginCss }],
  });
  const out = join(TMP, 'unmatched.css');
  const report = join(TMP, 'unmatched-report.json');
  const result = await pruneCli(['--single-sheet', '--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /2\.css/);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('.plugin-widget { color: red; }'));
  assert.ok(css.includes('.plugin-other { color: blue; }'));
  assert.ok(!css.includes('.woocommerce-cart'), 'the matched file is still pruned');
  assert.deepEqual(readJson(report).unmatched, ['2.css']);
});

test('inline <style> blocks of a real capture are matched to their pages: pruned under a comment naming them, and never "unmatched"', async () => {
  const out = join(TMP, 'capture-inline');
  rmSync(out, { recursive: true, force: true });
  const captured = await run(join(ROOT, 'skills', 'capture-site', 'scripts', 'capture.mjs'), [
    fixture.origin, '--out', out, '--delay', '0', '--no-rest', '--no-wayback',
  ]);
  assert.equal(captured.code, 0, captured.stderr);
  const inline = readJson(join(out, 'css', 'manifest.json')).filter((entry) => entry.inline);
  // WordPress-style: both pages carry the same two blocks, the contact page one more, so each
  // page has its own inline file and the shared blocks' coverage belongs to both.
  assert.deepEqual(inline.map((entry) => entry.pages), [['/'], ['/contact/']]);
  const css = join(TMP, 'inline-site.css');
  const report = join(TMP, 'inline-report.json');
  const result = await pruneCli(['--single-sheet', '--css', join(out, 'css'), '--coverage', COVERAGE, '--out', css, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const summary = readJson(report);
  assert.deepEqual(summary.unmatched, []);
  assert.deepEqual(summary.uncoveredInline, []);
  const text = readFileSync(css, 'utf8');
  const root = ':root{--wp--preset--color--black: #000000;';
  let from = 0;
  for (const [path, entry] of [['/', inline[0]], ['/contact/', inline[1]]]) {
    const comment = text.indexOf(`/* inline <style> blocks of ${path} (${entry.file}) */\n${root}`, from);
    assert.ok(comment !== -1, `${path}: ${text.slice(-900)}`);
    from = comment + 1;
  }
  for (const gone of ['img.wp-smiley', '.has-vivid-red-color', '.wpcf7-not-valid-tip']) assert.ok(!text.includes(gone), `${gone} removed`);
  assert.ok(!text.includes('.woocommerce-cart'), 'the theme sheet is still pruned');
});

test('per-page inline rules that collide (same selector, other declarations) go to that page\'s own sheet, never the global one', async () => {
  // Block themes print core-block-supports with counter classes: .wp-elements-1 on the home page
  // and on /contact/ styles different elements. Merged into one sheet, the last page would win.
  const out = join(TMP, 'capture-collide');
  rmSync(out, { recursive: true, force: true });
  const captured = await run(join(ROOT, 'skills', 'capture-site', 'scripts', 'capture.mjs'), [
    fixture.origin, '--out', out, '--delay', '0', '--no-rest', '--no-wayback',
  ]);
  assert.equal(captured.code, 0, captured.stderr);
  const [home, contact] = readJson(join(out, 'css', 'manifest.json')).filter((entry) => entry.inline);
  const css = join(TMP, 'collide', 'site.css');
  const pagesOut = join(TMP, 'collide', 'pages');
  const report = join(TMP, 'collide', 'report.json');
  // A previous run's sheet for a page set that no longer exists goes; other files stay.
  mkdirSync(pagesOut, { recursive: true });
  writeFileSync(join(pagesOut, 'inline-stale.css'), '.old { color: red; }\n');
  writeFileSync(join(pagesOut, 'notes.css'), '/* not ours */\n');
  const result = await pruneCli(['--single-sheet', '--css', join(out, 'css'), '--coverage', COVERAGE, '--out', css, '--report', report, '--pages-out', pagesOut]);
  assert.equal(result.code, 0, result.stderr);
  const homeRule = '.wp-elements-1 { scroll-margin-top: 16px; }';
  const contactRule = '.wp-elements-1 { scroll-margin-top: 48px; }';
  const global = readFileSync(css, 'utf8');
  assert.ok(!global.includes('.wp-elements-1'), global.slice(-600));
  assert.ok(global.includes(':root{--wp--preset--color--black'), 'blocks the pages share stay in the global sheet');
  const homeSheet = readFileSync(join(pagesOut, home.file), 'utf8');
  const contactSheet = readFileSync(join(pagesOut, contact.file), 'utf8');
  assert.ok(homeSheet.includes(homeRule) && !homeSheet.includes(contactRule), homeSheet);
  assert.ok(contactSheet.includes(contactRule) && !contactSheet.includes(homeRule), contactSheet);
  assert.ok(!homeSheet.includes(':root{'), 'shared rules are not repeated per page');
  assert.deepEqual(readdirSync(pagesOut).sort(), [contact.file, home.file, 'notes.css'].sort(), 'stale inline-*.css removed');
  assert.deepEqual(readJson(report).pageSheets, [
    { file: home.file, pages: ['/'], rules: 1 },
    { file: contact.file, pages: ['/contact/'], rules: 1 },
  ]);
});

test('scopeInlineRules splits colliding rules inside @media, takes their counter class along, and leaves agreeing files unchanged', () => {
  const a = '.x { color: red; }\n@media (min-width: 600px) {\n  .wp-container-2 { gap: 1px; }\n  .y { margin: 0; }\n}\n.wp-container-2 > * { flex: 1; }';
  const b = '.x { color: red; }\n@media (min-width: 600px) {\n  .wp-container-2 { gap: 9px; }\n}';
  const c = '.x {  color: red; }';
  const split = scopeInlineRules([{ name: 'a', css: a }, { name: 'b', css: b }, { name: 'c', css: c }]);
  assert.deepEqual(split.get('a'), {
    shared: '.x { color: red; }\n@media (min-width: 600px) {\n  .y { margin: 0; }\n}',
    own: '@media (min-width: 600px) {\n  .wp-container-2 { gap: 1px; }\n}\n.wp-container-2 > * { flex: 1; }',
    rules: 2,
  });
  assert.equal(split.get('b').own, '@media (min-width: 600px) {\n  .wp-container-2 { gap: 9px; }\n}');
  assert.equal(split.get('b').shared, '.x { color: red; }');
  assert.deepEqual(split.get('c'), { shared: c, own: '', rules: 0 }, 'whitespace alone is no collision');
});

test('scopeInlineRules spreads only the classes outside :not/:where/:is/:has, so a shared button rule stays shared', () => {
  // WordPress's shapes: global-styles' button rule on every page, block-supports' counter rule per page.
  const button = ':root :where(.wp-element-button, .wp-block-button__link){background-color: #32373c;}';
  const elements = (color) => `.wp-elements-1 a:where(:not(.wp-element-button)){color: ${color};}`;
  const split = scopeInlineRules([
    { name: 'a', css: `${button}\n${elements('#fff')}` },
    { name: 'b', css: `${button}\n${elements('#000')}` },
    { name: 'c', css: button },
  ]);
  for (const name of ['a', 'b', 'c']) assert.ok(split.get(name).shared.includes(button), `${name} keeps the button rule shared`);
  assert.equal(split.get('a').own, elements('#fff'));
  assert.equal(split.get('b').own, elements('#000'));
  assert.deepEqual(split.get('c'), { shared: button, own: '', rules: 0 }, 'the file with no collision gets no page sheet');
});

test('scopeInlineRules: the same rule repeated in one file is no collision with that rule once in another', () => {
  const split = scopeInlineRules([{ name: 'a', css: '.x { color: red; }\n.x { color: red; }' }, { name: 'b', css: '.x { color: red; }' }]);
  assert.equal(split.get('a').rules, 0);
  assert.equal(split.get('b').rules, 0);
});

test('an inline file no coverage saw is kept whole and listed, without failing the run', async () => {
  const dir = captureCss('capture-inline-uncovered');
  writeFileSync(join(dir, 'inline-about.css'), '.about-only { color: red; }\n');
  const manifest = readJson(join(dir, 'manifest.json'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify([...manifest, { file: 'inline-about.css', inline: true, pages: ['/about/'] }]));
  const out = join(TMP, 'inline-uncovered.css');
  const report = join(TMP, 'inline-uncovered.json');
  const result = await pruneCli(['--single-sheet', '--css', dir, '--coverage', COVERAGE, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(readFileSync(out, 'utf8').includes('/* inline <style> blocks of /about/ (inline-about.css) */\n.about-only { color: red; }'));
  assert.deepEqual(readJson(report).unmatched, []);
  assert.deepEqual(readJson(report).uncoveredInline, ['inline-about.css']);
});

test('an @import of a captured sheet is replaced by that sheet\'s pruned rules, in place and once; an uncaptured one is kept and reported', async () => {
  const origin = 'https://www.example.com';
  const dir = join(TMP, 'capture-imports');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = {
    // /old.css redirected to /new/main.css, so its relative imports resolve under /new/.
    '1.css': '@import "part.css";\n@import url("print.css") print;\n@import url("https://cdn.example.com/blocked.css");\n@import "missing.css";\n'
      + '.main { margin: 0; }\n.main-unused { margin: 1px; }\n',
    '2.css': '@import "deep.css" layer(base);\n.part { padding: 0; }\n.part-unused { padding: 1px; }\n',
    '3.css': '.print-only { display: none; }\n',
    '4.css': '.deep { color: red; }\n.deep-unused { color: blue; }\n',
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  const main = `${origin}/old.css`;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify([
    { file: '1.css', href: main, finalUrl: `${origin}/new/main.css`, pages: ['/'] },
    { file: '2.css', href: `${origin}/new/part.css`, pages: ['/'], importedBy: [main] },
    { file: '3.css', href: `${origin}/new/print.css`, pages: ['/'], importedBy: [main] },
    { file: null, href: 'https://cdn.example.com/blocked.css', pages: ['/'], status: 'blocked-address', importedBy: [main] },
    { file: null, href: `${origin}/new/missing.css`, pages: ['/'], status: 404, importedBy: [main] },
    { file: '4.css', href: `${origin}/new/deep.css`, pages: ['/'], importedBy: [`${origin}/new/part.css`] },
  ]));
  const used = (text, selector) => {
    const at = text.indexOf(selector);
    return { text, usedRanges: [[at, text.indexOf('}', at) + 1]] };
  };
  // Coverage names a redirected sheet by where it ended up; the print sheet was never applied.
  const coverageFile = join(TMP, 'imports-coverage.json');
  writeFileSync(coverageFile, JSON.stringify({
    [`${origin}/new/main.css`]: used(files['1.css'], '.main {'),
    [`${origin}/new/part.css`]: used(files['2.css'], '.part {'),
    [`${origin}/new/print.css`]: { text: files['3.css'], usedRanges: [] },
    [`${origin}/new/deep.css`]: used(files['4.css'], '.deep {'),
  }));
  const out = join(TMP, 'imports.css');
  const report = join(TMP, 'imports-report.json');
  const result = await pruneCli(['--single-sheet', '--css', dir, '--coverage', coverageFile, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(out, 'utf8'), [
    '@import url("https://cdn.example.com/blocked.css");',
    '@import "/new/missing.css";',
    '@layer base {\n.deep { color: red; }\n}',
    '.part { padding: 0; }',
    '@media print {\n.print-only { display: none; }\n}',
    '.main { margin: 0; }',
    '',
  ].join('\n'));
  const summary = readJson(report);
  assert.deepEqual(summary.unresolvedImports, [
    { file: '1.css', href: 'https://cdn.example.com/blocked.css', reason: 'blocked-address' },
    { file: '1.css', href: `${origin}/new/missing.css`, reason: '404' },
  ]);
  assert.deepEqual(summary.unmatched, []);
  assert.equal(summary.keptBecause.untestedMedia, 1, 'the print sheet is kept whole: no width tests it');
  assert.match(result.stderr, /unresolved import in 1\.css: https:\/\/cdn\.example\.com\/blocked\.css \(blocked-address\)/);
});

test('rewriteRef makes same-origin references root-relative and leaves the rest alone', () => {
  const href = 'https://www.example.com/wp-content/themes/x/style.css?ver=2';
  const site = 'https://www.example.com';
  assert.equal(rewriteRef('fonts/a.woff2', href, site), '/wp-content/themes/x/fonts/a.woff2');
  assert.equal(rewriteRef('../img/b.png?v=1#frag', href, site), '/wp-content/themes/img/b.png?v=1#frag');
  assert.equal(rewriteRef('https://www.example.com/c.png', href, site), '/c.png');
  assert.equal(rewriteRef('https://cdn.example.com/d.woff2', href, site), null);
  assert.equal(rewriteRef('//cdn.example.com/e.woff2', href, site), null);
  assert.equal(rewriteRef('data:image/png;base64,AAAA', href, site), null);
  assert.equal(rewriteRef('#gradient', href, site), null);
  assert.equal(rewriteRef('/already/root.png', href, site), null);
  assert.equal(rewriteRef('fonts/f.woff2', 'https://cdn.example.com/lib/g.css', site), 'https://cdn.example.com/lib/fonts/f.woff2');
  assert.equal(rewriteRef('img/h.png', '/about/', site), '/about/img/h.png', 'inline block resolved against its page');
  assert.equal(rewriteRef('img/h.png', undefined, site), null);
});

test('pruneCss rewrites url() and @import in every form and hoists @layer, @import and @namespace', () => {
  const text = [
    '@layer base, theme;',
    '@import "parts/a.css";',
    "@import url('parts/b.css') screen;",
    '@namespace svg url(http://www.w3.org/2000/svg);',
    '.logo { background: url(img/logo.svg); }',
    ".hero { background-image: url('../uploads/hero.jpg'), url(\"data:image/gif;base64,R0lGOD\"); }",
  ].join('\n');
  const result = pruneCss(text, [[0, text.length]], { base: 'https://www.example.com/wp-content/themes/x/style.css', siteOrigin: 'https://www.example.com' });
  assert.deepEqual(result.header, {
    layers: ['@layer base, theme;'],
    imports: ['@import "/wp-content/themes/x/parts/a.css";', "@import url('/wp-content/themes/x/parts/b.css') screen;"],
    namespaces: ['@namespace svg url(http://www.w3.org/2000/svg);'],
  });
  assert.equal(result.css, [
    '.logo { background: url(/wp-content/themes/x/img/logo.svg); }',
    ".hero { background-image: url('/wp-content/themes/uploads/hero.jpg'), url(\"data:image/gif;base64,R0lGOD\"); }",
  ].join('\n'));
  const inline = pruneCss('.a { background: url(pic.png); }', [[0, 10]], { base: '/about/', siteOrigin: 'https://www.example.com' });
  assert.equal(inline.css, '.a { background: url(/about/pic.png); }');
});

test('mediaTested says whether any tested width satisfies a query', () => {
  assert.equal(mediaTested('(max-width: 640px)'), true);
  assert.equal(mediaTested('screen and (min-width: 1200px)'), true);
  assert.equal(mediaTested('(width >= 700px) and (width < 800px)'), true);
  assert.equal(mediaTested('(700px <= width <= 800px)'), true);
  assert.equal(mediaTested('(width >= 600px) and (width < 700px)'), false);
  assert.equal(mediaTested('(min-width: 2000px)'), false);
  assert.equal(mediaTested('print'), false);
  assert.equal(mediaTested('(min-resolution: 2dppx)'), false, 'unknown features count as untested');
  assert.equal(mediaTested('print, (max-width: 400px)'), true);
  assert.equal(mediaTested('(min-width: 500px) and (max-width: 600px)', [390, 1440]), false);
});

test('pruneCss keeps exceptions and untested media, drops @media blocks left empty, and keeps comments inside rules', () => {
  const text = [
    '.used { color: red; /* brand red */ }',
    '.gone { color: blue; }',
    '@keyframes spin { to { transform: rotate(1turn); } }',
    '@supports (display: grid) { .x { display: grid; } }',
    '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }',
    '@media (min-width: 900px) { .z { color: green; } }',
    '@media (max-width: 800px) { .used { color: black; } .w { color: gray; } }',
    '@media print { .p { color: black; } }',
    '@media (min-width: 2000px) { .big { width: 1900px; } }',
    '.card:not(.big) { margin: 0; }',
    'li:nth-child(2n) { color: teal; }',
    '.q::after { content: ""; }',
    'input:disabled { opacity: 0.5; }',
  ].join('\n');
  const used = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('.used', from);
    if (at === -1) break;
    used.push([at, text.indexOf('}', at) + 1]);
    from = at + 1;
  }
  const result = pruneCss(text, used);
  for (const kept of [
    '.used { color: red; /* brand red */ }',
    '@keyframes spin { to { transform: rotate(1turn); } }',
    '@supports (display: grid) { .x { display: grid; } }',
    '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }',
    '@media (max-width: 800px) {\n  .used { color: black; }\n}',
    '@media print { .p { color: black; } }',
    '@media (min-width: 2000px) { .big { width: 1900px; } }',
    '.card:not(.big) { margin: 0; }',
    'li:nth-child(2n) { color: teal; }',
    '.q::after { content: ""; }',
    'input:disabled { opacity: 0.5; }',
  ]) {
    assert.ok(result.css.includes(kept), `${kept} kept`);
  }
  for (const gone of ['.gone', 'min-width: 900px', '.w {']) assert.ok(!result.css.includes(gone), `${gone} removed`);
  assert.equal(result.removedRules, 3);
  assert.deepEqual(result.keptBecause, { pseudo: 4, atRule: 3, untestedMedia: 2, state: 0 });
});

test('the home page with the pruned stylesheet at another path matches the original pixel for pixel', async () => {
  const copyRoot = join(TMP, 'site');
  cpSync(SITE, copyRoot, { recursive: true });
  // The pruned file lives at /assets/site.css, so its font references only work if they were rewritten.
  rmSync(join(copyRoot, THEME));
  mkdirSync(join(copyRoot, 'assets'), { recursive: true });
  writeFileSync(join(copyRoot, 'assets', 'site.css'), readFileSync(join(TMP, 'site.css')));
  const home = join(copyRoot, 'index.html');
  const html = readFileSync(home, 'utf8');
  const original = `{{ORIGIN}}/${THEME}?ver=1.4.2`;
  assert.ok(html.includes(original));
  writeFileSync(home, html.replace(original, '{{ORIGIN}}/assets/site.css'));
  const copy = await startFixture({ root: copyRoot });
  try {
    const shoot = (base, out) => run(join(VISUAL, 'shoot.mjs'), [
      '--base', base, '--routes', '/', '--widths', '390,1440', '--out', out, '--delay', '0', '--wait', '0',
    ]);
    for (const [base, out] of [[fixture.origin, join(TMP, 'shots-a')], [copy.origin, join(TMP, 'shots-b')]]) {
      const shot = await shoot(base, out);
      assert.equal(shot.code, 0, shot.stderr);
    }
  } finally {
    await copy.close();
  }
  const diffOut = join(TMP, 'shots-diff');
  const diff = await run(join(VISUAL, 'diff.mjs'), [
    '--a', join(TMP, 'shots-a'), '--b', join(TMP, 'shots-b'), '--out', diffOut, '--threshold', '0.5',
  ]);
  assert.equal(diff.code, 0, diff.stdout + diff.stderr);
  const rows = readJson(join(diffOut, 'diff.json'));
  assert.deepEqual(rows.map((row) => row.width).sort((a, b) => a - b), [390, 1440]);
  for (const row of rows) assert.equal(row.percent, 0, `${row.route} at ${row.width}`);
});

// A mobile menu the way jquery.com builds one: a toggle adds a class the stylesheet depends on,
// so the open state exists only after a click. Coverage of the closed page never sees it.
const MENU_CSS = [
  '#menu-top { display: none; }',
  '#menu-top.menu-open { display: block; }',
  '.accordion.is-open .panel { display: block; }',
  '.ghost.is-open { color: red; }',
  '.never-used { color: blue; }',
  '',
].join('\n');
const MENU_HTML = '<!doctype html><link rel="stylesheet" href="/s.css">'
  + '<button class="menu-toggle" aria-controls="menu-top" aria-expanded="false">Menu</button>'
  + '<ul id="menu-top"><li><a href="/x/">X</a></li></ul>'
  + '<div class="accordion"><div class="panel">Panel</div></div>'
  + '<a data-toggle="away" href="/elsewhere/">Away</a>'
  + '<script>document.querySelector(".menu-toggle").addEventListener("click", (e) => {'
  + ' const m = document.getElementById("menu-top"); m.classList.toggle("menu-open");'
  + ' e.currentTarget.setAttribute("aria-expanded", String(m.classList.contains("menu-open"))); });</script>';

// Coverage of the menu page; also counts the page loads, so a toggle that is a link cannot navigate away.
async function menuCoverage(name) {
  const loads = [];
  const server = createServer((req, res) => {
    loads.push(req.url);
    if (req.url === '/s.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(MENU_CSS);
      return;
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(req.url === '/' ? MENU_HTML : 'gone');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = join(TMP, `${name}.json`);
  try {
    const result = await coverageCli(['--base', origin, '--routes', '/', '--widths', '390', '--out', out, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    server.close();
  }
  return { coverage: readJson(out), file: out, sheet: `${origin}/s.css`, loads };
}

const ruleAt = (text, selector) => {
  const start = text.indexOf(selector);
  return [start, text.indexOf('}', start) + 1];
};

test('coverage clicks menu toggles, so the open-menu rule a click adds is used, and no toggle navigates away', async () => {
  const { coverage, sheet, loads } = await menuCoverage('menu');
  const entry = coverage[sheet];
  assert.ok(entry, Object.keys(coverage).join(', '));
  assert.ok(overlaps(entry.usedRanges, ...ruleAt(MENU_CSS, '#menu-top.menu-open')), 'the open state was seen');
  assert.ok(!overlaps(entry.usedRanges, ...ruleAt(MENU_CSS, '.never-used')));
  assert.ok(!loads.includes('/elsewhere/'), loads.join(', '));
});

test('coverage records state rules whose element is on the page as stateRanges', async () => {
  const { coverage, sheet } = await menuCoverage('menu-state');
  const { stateRanges } = coverage[sheet];
  assert.ok(Array.isArray(stateRanges), 'stateRanges recorded');
  assert.ok(overlaps(stateRanges, ...ruleAt(MENU_CSS, '.accordion.is-open .panel')), '.accordion .panel is on the page');
  assert.ok(!overlaps(stateRanges, ...ruleAt(MENU_CSS, '.ghost.is-open')), 'no .ghost on the page');
  assert.ok(!overlaps(stateRanges, ...ruleAt(MENU_CSS, '.never-used')), 'not a state rule');
});

test('the pruned stylesheet keeps the open-menu and state rules and says how many it kept for state', async () => {
  const { file } = await menuCoverage('menu-prune');
  const dir = join(TMP, 'capture-menu');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.css'), MENU_CSS);
  const out = join(TMP, 'menu.css');
  const report = join(TMP, 'menu-report.json');
  const result = await pruneCli(['--single-sheet', '--css', dir, '--coverage', file, '--out', out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('#menu-top.menu-open { display: block; }'), css);
  assert.ok(css.includes('.accordion.is-open .panel { display: block; }'), css);
  assert.ok(!css.includes('.ghost'), css);
  assert.ok(!css.includes('.never-used'), css);
  assert.equal(readJson(report).keptBecause.state, 1);
  assert.match(result.stdout, /kept for state: 1 rules/);
});

test('pruneCss keeps an unused rule that a state range covers', () => {
  const result = pruneCss(MENU_CSS, [ruleAt(MENU_CSS, '#menu-top {')], { stateRanges: [ruleAt(MENU_CSS, '#menu-top.menu-open')] });
  assert.ok(result.css.includes('#menu-top.menu-open { display: block; }'));
  assert.ok(!result.css.includes('.accordion'));
  assert.equal(result.keptBecause.state, 1);
});

test('stateBases strips state classes, attributes and pseudos down to the element they style', () => {
  const bases = (selector) => stateBases(csstree.parse(selector, { context: 'selectorList', positions: true }));
  assert.deepEqual(bases('#menu-top.menu-open'), ['#menu-top']);
  assert.deepEqual(bases('body.nav-open .site-nav > li'), ['body .site-nav > li']);
  assert.deepEqual(bases('.open > .sub-menu, .plain'), ['* > .sub-menu']);
  assert.deepEqual(bases('button[aria-expanded="true"] + .panel'), ['button + .panel']);
  assert.deepEqual(bases('.tab.is-active:hover'), ['.tab']);
  assert.deepEqual(bases('details[open] summary'), ['details summary']);
  assert.deepEqual(bases('.plain .rule'), []);
});

// --- per-sheet mode (the default) ----------------------------------------------------------

const SITE_ORIGIN = 'https://www.example.com';

// Used ranges covering the rules that start with each of the given selectors.
function usedRules(text, selectors) {
  return selectors.map((selector) => {
    const at = text.indexOf(`${selector} {`);
    assert.ok(at !== -1, `${selector} in ${text}`);
    return [at, text.indexOf('}', at) + 1];
  });
}

// A capture folder the way capture.mjs leaves it: css/ (numbered sheets and the manifest),
// pages/<slug>.html snapshots and inventory.json. pages: [{ path, slug, head }], head being the
// page's <head> stylesheet markup in order. sheets: [{ file, href, text }].
function pageCapture(name, { sheets, pages }) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'css'), { recursive: true });
  mkdirSync(join(dir, 'pages'), { recursive: true });
  for (const sheet of sheets) writeFileSync(join(dir, 'css', sheet.file), sheet.text);
  const linking = (href) => pages.filter((page) => page.head.includes(new URL(href).pathname)).map((page) => page.path);
  writeFileSync(join(dir, 'css', 'manifest.json'), JSON.stringify(sheets.map(({ file, href }) => ({ file, href, pages: linking(href), status: 200 }))));
  const inventory = pages.map(({ path, slug, head }) => {
    writeFileSync(join(dir, 'pages', `${slug}.html`), `<!doctype html><html><head><title>${slug}</title>\n${head}\n</head><body><p class="x">${slug}</p></body></html>`);
    return { url: `${SITE_ORIGIN}${path}`, path, status: 200, finalUrl: `${SITE_ORIGIN}${path}`, snapshot: `pages/${slug}.html` };
  });
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inventory));
  return dir;
}

const THEME_A = '.a-home { color: red; }\n.a-about { color: green; }\n.a-unused { color: blue; }\n';
const BLOCKS_B = '.b-home { margin: 0; }\n.b-unused { margin: 1px; }\n';
const PRINT = 'a, a:visited { text-decoration: underline; }\n.print-only { display: block; }\n';
const HOME_STYLE = '\n.s-home { padding: 0; }\n.s-home-unused { padding: 1px; }\n';
const SHARED_STYLE = '.layout { max-width: 640px; }\n.layout-unused { max-width: 1px; }';
const ABOUT_STYLE = '.wp-container-1 { max-width: 900px; }';

function twoSheetCapture(name) {
  const dir = pageCapture(name, {
    sheets: [
      { file: '1.css', href: `${SITE_ORIGIN}/wp-content/themes/t/a.css?ver=1.2`, text: THEME_A },
      { file: '2.css', href: `${SITE_ORIGIN}/wp-includes/css/b.css`, text: BLOCKS_B },
      { file: '3.css', href: `${SITE_ORIGIN}/wp-content/themes/t/print.css`, text: PRINT },
    ],
    pages: [
      { path: '/', slug: 'home', head: [
        '<link rel="stylesheet" href="/wp-content/themes/t/a.css?ver=1.2" media="all">',
        `<style id="home-inline-css">${HOME_STYLE}</style>`,
        '<link rel="stylesheet" href="https://www.example.com/wp-includes/css/b.css">',
        `<style>${SHARED_STYLE}</style>`,
      ].join('\n') },
      { path: '/about/', slug: 'about', head: [
        `<style>${SHARED_STYLE}</style>`,
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
        '<link rel="stylesheet" href="/wp-content/themes/t/print.css" media="print">',
        '<link rel="stylesheet" href="/wp-content/themes/t/a.css?ver=1.2" media="all">',
        `<style>${ABOUT_STYLE}</style>`,
      ].join('\n') },
    ],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({
    // A rule only /about/ uses is used all the same: coverage merges every page's ranges.
    [`${SITE_ORIGIN}/wp-content/themes/t/a.css?ver=1.2`]: { text: THEME_A, usedRanges: usedRules(THEME_A, ['.a-home', '.a-about']) },
    [`${SITE_ORIGIN}/wp-includes/css/b.css`]: { text: BLOCKS_B, usedRanges: usedRules(BLOCKS_B, ['.b-home']) },
    // Chromium applies no print rule on screen: coverage sees nothing used in the print sheet.
    [`${SITE_ORIGIN}/wp-content/themes/t/print.css`]: { text: PRINT, usedRanges: [] },
    'inline:1': { text: HOME_STYLE, usedRanges: usedRules(HOME_STYLE, ['.s-home']), pages: ['/'] },
    'inline:2': { text: SHARED_STYLE, usedRanges: usedRules(SHARED_STYLE, ['.layout']), pages: ['/', '/about/'] },
    'inline:3': { text: ABOUT_STYLE, usedRanges: [[0, ABOUT_STYLE.length]], pages: ['/about/'] },
  }));
  return { dir, coverage };
}

const perSheetCli = (dir, coverage, extra = []) => pruneCli([
  '--css', join(dir, 'css'), '--coverage', coverage, '--report', join(dir, 'report.json'),
  '--public', join(dir, 'public'), '--inline-out', join(dir, 'inline'), ...extra,
]);

test('per-sheet: each linked sheet is pruned on its own at its live path, inline blocks per page, and each page keeps its head order', async () => {
  const { dir, coverage } = twoSheetCapture('per-sheet');
  const pub = join(dir, 'public');
  const inlineOut = join(dir, 'inline');
  mkdirSync(inlineOut, { recursive: true });
  writeFileSync(join(inlineOut, 'inline-stale-1.css'), '.old { color: red; }\n');
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);

  // Live paths, query string dropped from the file name.
  const a = readFileSync(join(pub, 'wp-content', 'themes', 't', 'a.css'), 'utf8');
  assert.ok(a.includes('.a-home { color: red; }') && a.includes('.a-about { color: green; }'), a);
  assert.ok(!a.includes('.a-unused'), 'an unused rule is removed');
  const b = readFileSync(join(pub, 'wp-includes', 'css', 'b.css'), 'utf8');
  assert.equal(b, '.b-home { margin: 0; }\n', 'one sheet\'s rules never land in another');
  // A print sheet: coverage is screen-only, so it is kept whole and its link keeps media="print".
  assert.equal(readFileSync(join(pub, 'wp-content', 'themes', 't', 'print.css'), 'utf8'), PRINT);

  const summary = readJson(join(dir, 'report.json'));
  assert.equal(summary.mode, 'per-sheet');
  assert.equal(summary.siteCss, null, 'nothing is left for a global site.css');
  assert.deepEqual(summary.sheets.map(({ href, file }) => ({ href, file })), [
    { href: `${SITE_ORIGIN}/wp-content/themes/t/a.css?ver=1.2`, file: join(pub, 'wp-content', 'themes', 't', 'a.css') },
    { href: `${SITE_ORIGIN}/wp-includes/css/b.css`, file: join(pub, 'wp-includes', 'css', 'b.css') },
    { href: `${SITE_ORIGIN}/wp-content/themes/t/print.css`, file: join(pub, 'wp-content', 'themes', 't', 'print.css') },
  ]);
  for (const sheet of summary.sheets) {
    assert.deepEqual(Object.keys(sheet).sort(), ['bytesAfter', 'bytesBefore', 'file', 'href', 'rulesRemoved']);
    assert.equal(sheet.bytesAfter, statSync(sheet.file).size);
  }
  assert.deepEqual(summary.sheets.map((s) => s.rulesRemoved), [1, 1, 0]);
  assert.deepEqual(summary.external, ['https://fonts.googleapis.com/css2?family=Inter']);

  // Each page's own order, links root-relative with their query, inline blocks as files.
  assert.deepEqual(summary.heads['/'], [
    { kind: 'link', href: '/wp-content/themes/t/a.css?ver=1.2', media: 'all' },
    { kind: 'inline', file: 'inline-home-1.css' },
    { kind: 'link', href: '/wp-includes/css/b.css' },
    { kind: 'inline', file: 'inline-home-2.css' },
  ]);
  assert.deepEqual(summary.heads['/about/'], [
    { kind: 'inline', file: 'inline-home-2.css' },
    { kind: 'link', href: 'https://fonts.googleapis.com/css2?family=Inter' },
    { kind: 'link', href: '/wp-content/themes/t/print.css', media: 'print' },
    { kind: 'link', href: '/wp-content/themes/t/a.css?ver=1.2', media: 'all' },
    { kind: 'inline', file: 'inline-about-2.css' },
  ]);
  assert.deepEqual(readdirSync(inlineOut).sort(), ['inline-about-2.css', 'inline-home-1.css', 'inline-home-2.css'], 'stale inline files removed');
  assert.equal(readFileSync(join(inlineOut, 'inline-home-1.css'), 'utf8'), '.s-home { padding: 0; }\n');
  assert.equal(readFileSync(join(inlineOut, 'inline-home-2.css'), 'utf8'), '.layout { max-width: 640px; }\n');
  assert.equal(readFileSync(join(inlineOut, 'inline-about-2.css'), 'utf8'), `${ABOUT_STYLE}\n`);
  assert.deepEqual(summary.inline.map(({ file, pages }) => ({ file, pages })), [
    { file: 'inline-home-1.css', pages: ['/'] },
    { file: 'inline-home-2.css', pages: ['/', '/about/'] },
    { file: 'inline-about-2.css', pages: ['/about/'] },
  ]);
  assert.deepEqual(summary.pageSheets, [], 'each page keeps its own blocks, so nothing collides');
  assert.deepEqual(summary.unmatched, []);
  assert.deepEqual(summary.unparsed, []);
  assert.match(result.stdout, /wrote 3 sheet\(s\) at their live paths under .*public and 3 inline block file\(s\) to .*inline; no site\.css/);
});

test('per-sheet: identical sheets under two paths (a multisite) keep their own coverage, never each other\'s', async () => {
  const text = '.c-block { margin-bottom: 2rem; }\n.b-gallery { margin-bottom: 0; }\n';
  const main = `${SITE_ORIGIN}/wp-content/themes/x/style.css`;
  const sub = `${SITE_ORIGIN}/president/wp-content/themes/x/style.css`;
  const dir = pageCapture('multisite', {
    sheets: [{ file: '1.css', href: main, text }, { file: '2.css', href: sub, text }],
    pages: [
      { path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/x/style.css">' },
      { path: '/president/', slug: 'president', head: '<link rel="stylesheet" href="/president/wp-content/themes/x/style.css">' },
    ],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({
    [main]: { text, usedRanges: usedRules(text, ['.c-block']) },
    [sub]: { text, usedRanges: usedRules(text, ['.b-gallery']) },
  }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  const pub = join(dir, 'public');
  assert.equal(readFileSync(join(pub, 'wp-content', 'themes', 'x', 'style.css'), 'utf8'), '.c-block { margin-bottom: 2rem; }\n');
  assert.equal(readFileSync(join(pub, 'president', 'wp-content', 'themes', 'x', 'style.css'), 'utf8'), '.b-gallery { margin-bottom: 0; }\n');
});

test('a sheet css-tree cannot parse is kept byte for byte and listed under unparsed, without changing the exit code', async () => {
  const broken = `${'@media screen{'.repeat(20000)}.deep { color: red; }`;
  const href = `${SITE_ORIGIN}/wp-content/plugins/mc/embed.css`;
  const dir = pageCapture('unparsed', {
    sheets: [{ file: '1.css', href, text: broken }],
    pages: [{ path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/plugins/mc/embed.css">' }],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [href]: { text: broken, usedRanges: [] } }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'public', 'wp-content', 'plugins', 'mc', 'embed.css'), 'utf8'), broken);
  const { unparsed } = readJson(join(dir, 'report.json'));
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].href, href);
  assert.match(unparsed[0].error, /call stack/);
  assert.equal(result.stderr.trim().split('\n').filter((line) => line.includes('could not parse')).length, 1, result.stderr);
});

test('--single-sheet wraps a sheet linked with a media attribute in that @media and keeps a print sheet whole', async () => {
  const { dir, coverage } = twoSheetCapture('single-media');
  const out = join(dir, 'site.css');
  const result = await pruneCli(['--single-sheet', '--css', join(dir, 'css'), '--coverage', coverage, '--out', out, '--report', join(dir, 'r.json')]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes(`@media print {\n${PRINT.trimEnd()}\n}`), css);
  assert.ok(!/@media all/.test(css), 'media="all" adds no wrapper');
  assert.equal(readJson(join(dir, 'r.json')).mode, 'single-sheet');
});

test('--single-sheet keeps a media-linked sheet\'s hoisted @import and @layer lines at the top, in order, the @import under the link\'s media', async () => {
  const href = `${SITE_ORIGIN}/wp-content/themes/t/print.css`;
  const text = '@layer base;\n@import url("https://cdn.example.org/p.css");\n@import url("https://cdn.example.org/q.css") screen;\n.print-only { display: block; }\n';
  const theme = '.t { color: red; }\n';
  const dir = pageCapture('single-hoist', {
    sheets: [{ file: '1.css', href: `${SITE_ORIGIN}/wp-content/themes/t/a.css`, text: theme }, { file: '2.css', href, text }],
    pages: [{ path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/t/a.css">\n<link rel="stylesheet" href="/wp-content/themes/t/print.css" media="print">' }],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [`${SITE_ORIGIN}/wp-content/themes/t/a.css`]: { text: theme, usedRanges: [[0, theme.length]] }, [href]: { text, usedRanges: [] } }));
  const out = join(dir, 'site.css');
  const result = await pruneCli(['--single-sheet', '--css', join(dir, 'css'), '--coverage', coverage, '--out', out, '--report', join(dir, 'r.json')]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(out, 'utf8'), [
    '@layer base;',
    '@import url("https://cdn.example.org/p.css") print;',
    '@import url("https://cdn.example.org/q.css") screen;',
    '.t { color: red; }',
    '@media print {\n.print-only { display: block; }\n}',
    '',
  ].join('\n'));
  assert.match(result.stderr, /q\.css.*has its own media list.*print/);
});

test('a malformed url() is left as written, never rewritten', () => {
  const result = pruneCss('.a { b: url(}', [[0, 13]], { base: 'https://www.example.com/x/a.css', siteOrigin: 'https://www.example.com' });
  assert.equal(result.css, '.a { b: url(}');
});

// --- one path, several queries; sheets only an @import reaches; host variants ------------------

const T = `${SITE_ORIGIN}/wp-content/themes/t`;
const deep = (rules) => `${'@media screen{'.repeat(20000)}${rules}`;
const usedOf = (text, selectors) => ({ text, usedRanges: usedRules(text, selectors) });

test('per-sheet: one pathname under two queries with the same bytes is one file pruned with both coverages', async () => {
  const text = '.a { color: red; }\n.b { color: green; }\n.c { color: blue; }\n';
  const dir = pageCapture('same-path-same-bytes', {
    sheets: [{ file: '1.css', href: `${T}/style.css?ver=1`, text }, { file: '2.css', href: `${T}/style.css?ver=2`, text }],
    pages: [
      { path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=1">' },
      { path: '/about/', slug: 'about', head: '<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=2">' },
    ],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [`${T}/style.css?ver=1`]: usedOf(text, ['.a']), [`${T}/style.css?ver=2`]: usedOf(text, ['.b']) }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  const file = join(dir, 'public', 'wp-content', 'themes', 't', 'style.css');
  assert.equal(readFileSync(file, 'utf8'), '.a { color: red; }\n.b { color: green; }\n');
  const summary = readJson(join(dir, 'report.json'));
  assert.deepEqual(summary.sheets.map(({ href, file: f }) => ({ href, file: f })), [{ href: `${T}/style.css?ver=1`, file }, { href: `${T}/style.css?ver=2`, file }]);
  assert.deepEqual(summary.heads['/about/'], [{ kind: 'link', href: '/wp-content/themes/t/style.css?ver=2' }]);
});

test('per-sheet: one pathname under two queries with other bytes keeps both, the second at a query-named path its pages link', async () => {
  const one = '.a { color: red; }\n.x { color: blue; }\n';
  const two = '.b { color: green; }\n.y { color: blue; }\n';
  const dir = pageCapture('same-path-other-bytes', {
    sheets: [{ file: '1.css', href: `${T}/style.css?ver=1`, text: one }, { file: '2.css', href: `${T}/style.css?ver=2`, text: two }],
    pages: [
      { path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=1">' },
      { path: '/about/', slug: 'about', head: '<link rel="stylesheet" href="/wp-content/themes/t/style.css?ver=2">' },
    ],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [`${T}/style.css?ver=1`]: usedOf(one, ['.a']), [`${T}/style.css?ver=2`]: usedOf(two, ['.b']) }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  const folder = join(dir, 'public', 'wp-content', 'themes', 't');
  assert.equal(readFileSync(join(folder, 'style.css'), 'utf8'), '.a { color: red; }\n');
  assert.equal(readFileSync(join(folder, 'style.ver-2.css'), 'utf8'), '.b { color: green; }\n');
  assert.equal(variantPath('/wp-content/themes/t/style.css', '?ver=2'), '/wp-content/themes/t/style.ver-2.css');
  const summary = readJson(join(dir, 'report.json'));
  assert.deepEqual(summary.sheets.map((s) => s.file), [join(folder, 'style.css'), join(folder, 'style.ver-2.css')]);
  assert.deepEqual(summary.heads['/'], [{ kind: 'link', href: '/wp-content/themes/t/style.css?ver=1' }]);
  assert.deepEqual(summary.heads['/about/'], [{ kind: 'link', href: '/wp-content/themes/t/style.ver-2.css?ver=2' }]);
});

test('per-sheet: a sheet only an @import reaches is written at its live path when its parent keeps the @import (an unparsable parent or child)', async () => {
  const child = '.c1 { color: red; }\n.c2 { color: blue; }\n';
  const parentBroken = `@import url("child.css");\n${deep('.p { color: red; }')}`;
  const parent = '@import url("child2.css");\n.p { color: red; }\n';
  const child2Broken = deep('.q { background: url(img/q.png); }');
  const dir = pageCapture('import-only', {
    sheets: [
      { file: '1.css', href: `${T}/broken-parent.css`, text: parentBroken },
      { file: '2.css', href: `${T}/child.css`, text: child },
      { file: '3.css', href: `${T}/parent.css`, text: parent },
      { file: '4.css', href: `${T}/child2.css`, text: child2Broken },
    ],
    pages: [{ path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/t/broken-parent.css">\n<link rel="stylesheet" href="/wp-content/themes/t/parent.css">' }],
  });
  const manifest = readJson(join(dir, 'css', 'manifest.json'));
  manifest[1].importedBy = [`${T}/broken-parent.css`];
  manifest[3].importedBy = [`${T}/parent.css`];
  writeFileSync(join(dir, 'css', 'manifest.json'), JSON.stringify(manifest));
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({
    [`${T}/broken-parent.css`]: { text: parentBroken, usedRanges: [] },
    [`${T}/child.css`]: usedOf(child, ['.c1']),
    [`${T}/parent.css`]: usedOf(parent, ['.p']),
    [`${T}/child2.css`]: { text: child2Broken, usedRanges: [] },
  }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  const folder = join(dir, 'public', 'wp-content', 'themes', 't');
  assert.equal(readFileSync(join(folder, 'broken-parent.css'), 'utf8'), parentBroken, 'the unparsable parent is kept byte for byte');
  assert.equal(readFileSync(join(folder, 'child.css'), 'utf8'), '.c1 { color: red; }\n', 'its child is served at its live path, pruned with its own coverage');
  assert.equal(readFileSync(join(folder, 'parent.css'), 'utf8'), '@import url("/wp-content/themes/t/child2.css");\n.p { color: red; }\n', 'an unparsable child stays an @import');
  assert.equal(readFileSync(join(folder, 'child2.css'), 'utf8'), child2Broken, 'and is served byte for byte at its live path, its relative url()s intact');
  const { sheets, unparsed } = readJson(join(dir, 'report.json'));
  assert.deepEqual(sheets.map((s) => s.href), [`${T}/broken-parent.css`, `${T}/parent.css`, `${T}/child.css`, `${T}/child2.css`]);
  assert.deepEqual(unparsed.map((u) => u.href), [`${T}/broken-parent.css`, `${T}/child2.css`]);
});

test('--single-sheet: an unparsable imported sheet inlined byte for byte has its relative url()s made root-relative first', async () => {
  const parent = '@import url("sub/child.css");\n.p { color: red; }\n';
  const child = deep('.q { background: url(img/q.png); } .r { background: url("../r.png"); }');
  const dir = pageCapture('single-unparsed-child', {
    sheets: [{ file: '1.css', href: `${T}/parent.css`, text: parent }, { file: '2.css', href: `${T}/sub/child.css`, text: child }],
    pages: [{ path: '/', slug: 'home', head: '<link rel="stylesheet" href="/wp-content/themes/t/parent.css">' }],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [`${T}/parent.css`]: usedOf(parent, ['.p']), [`${T}/sub/child.css`]: { text: child, usedRanges: [] } }));
  const out = join(dir, 'site.css');
  const result = await pruneCli(['--single-sheet', '--css', join(dir, 'css'), '--coverage', coverage, '--out', out, '--report', join(dir, 'r.json')]);
  assert.equal(result.code, 0, result.stderr);
  const css = readFileSync(out, 'utf8');
  assert.ok(css.includes('url(/wp-content/themes/t/sub/img/q.png)'), css.slice(-200));
  assert.ok(css.includes('url("/wp-content/themes/t/r.png")'), css.slice(-200));
  assert.ok(!css.includes('url(img/q.png)'));
});

test('per-sheet: a link to the site under another scheme or the www/apex variant is the site\'s own sheet, served from public/', async () => {
  const text = '.a { color: red; }\n.b { color: blue; }\n';
  const dir = pageCapture('host-variants', {
    sheets: [{ file: '1.css', href: `${T}/a.css`, text }],
    pages: [{ path: '/', slug: 'home', head: '<link rel="stylesheet" href="http://example.com/wp-content/themes/t/a.css">' }],
  });
  const coverage = join(dir, 'coverage.json');
  writeFileSync(coverage, JSON.stringify({ [`${T}/a.css`]: usedOf(text, ['.a']) }));
  const result = await perSheetCli(dir, coverage);
  assert.equal(result.code, 0, result.stderr);
  const summary = readJson(join(dir, 'report.json'));
  assert.deepEqual(summary.heads['/'], [{ kind: 'link', href: '/wp-content/themes/t/a.css' }]);
  assert.deepEqual(summary.external, []);
  assert.equal(readFileSync(join(dir, 'public', 'wp-content', 'themes', 't', 'a.css'), 'utf8'), '.a { color: red; }\n');
});

test('css-prune usage: --out needs --single-sheet, and per-sheet mode needs the capture\'s inventory', async () => {
  const { dir, coverage } = twoSheetCapture('usage');
  const out = await perSheetCli(dir, coverage, ['--out', join(dir, 'site.css')]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--out is for --single-sheet/);
  rmSync(join(dir, 'inventory.json'));
  const bare = await perSheetCli(dir, coverage);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /inventory\.json/);
});
