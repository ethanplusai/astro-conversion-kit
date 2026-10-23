import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(ROOT, 'skills', 'visual-review', 'scripts', 'sheet.mjs');
const TMP = join(ROOT, 'test', 'tmp', 'sheet');
// Routes are folder names, as shoot.mjs writes them: a template name or a path slug.
const ROUTES = [{ route: 'home', folder: 'home' }, { route: 'about', folder: 'about' }];
const WIDTHS = [390, 1440];

function writePng(file, rgb) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
}

function writeShots(dir, rgb) {
  const manifest = [];
  for (const { route, folder } of ROUTES) {
    for (const width of WIDTHS) {
      const file = `${folder}/${width}.png`;
      writePng(join(dir, file), rgb);
      manifest.push({ route, width, file, heightPx: 4, bannerClosed: false });
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function run(args) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      done({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

let liveManifest;
let newManifest;
let diff;
const styles = [
  { route: 'about', path: '/about/', width: 1440, selector: 'h1', property: 'font-size', live: '32px', new: '40px', pass: false },
  { route: 'about', path: '/about/', width: 1440, selector: 'h1', property: 'margin-top', live: '21.44px', new: '26.8px', pass: false },
  { route: 'about', path: '/about/', width: 1440, selector: 'p', property: 'line-height', live: '25.6px', new: '25.6px', pass: true },
  { route: 'home', path: '/', width: 390, selector: 'a', property: 'color', live: 'rgb(178, 60, 40)', new: 'rgb(0, 0, 0)', pass: false },
  // A route-width pair with no screenshots or diff: still listed, under a style-only card.
  { route: 'blog', path: '/blog/', width: 768, selector: 'h2', property: 'color', live: 'rgb(0, 0, 0)', new: 'rgb(1, 1, 1)', pass: false },
];

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  liveManifest = writeShots(join(TMP, 'live'), [255, 255, 255]);
  newManifest = writeShots(join(TMP, 'new'), [250, 250, 250]);
  diff = [];
  for (const { route, folder } of ROUTES) {
    for (const width of WIDTHS) {
      writePng(join(TMP, 'diff', folder, `${width}.png`), [255, 0, 0]);
      const pass = !(route === 'home' && width === 1440);
      diff.push({ route, width, percent: pass ? 0.1 : 3.25, pass, heightA: 4, heightB: 4 });
    }
  }
  delete diff[diff.length - 1].percent;
  writeFileSync(join(TMP, 'diff', 'diff.json'), JSON.stringify(diff));
  writeFileSync(join(TMP, 'styles.json'), JSON.stringify(styles));
});
after(() => rmSync(TMP, { recursive: true, force: true }));

// The page files the index links, in its order, and the html of each.
function pagesOf(out) {
  const index = readFileSync(out, 'utf8');
  const links = [...index.matchAll(/<a href="([^"]+\.html)">/g)].map((m) => m[1]);
  return { index, pages: links.map((href) => ({ href, file: join(dirname(out), decodeURI(href)), html: readFileSync(join(dirname(out), decodeURI(href)), 'utf8') })) };
}
// Every <img src> of a page resolves, from the page's folder, to a file on disk.
function imagesOf(page) {
  return [...page.html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
}

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node sheet\.mjs/);
});

test('a missing diff.json is a usage error', async () => {
  const { code } = await run(['--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'nope.json'), '--out', join(TMP, 'x.html')]);
  assert.equal(code, 2);
});

test('the contact sheet is an index plus one page per route, every image linked by path and every failing row marked', async () => {
  const out = join(TMP, 'index.html');
  const { code, stderr, stdout } = await run([
    '--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'diff', 'diff.json'),
    '--styles', join(TMP, 'styles.json'), '--out', out,
  ]);
  assert.equal(code, 0, stderr);
  const { index, pages } = pagesOf(out);
  assert.match(index, /^<!doctype html>/i);
  assert.deepEqual(pages.map((p) => p.href), ['index-pages/home.html', 'index-pages/about.html', 'index-pages/blog.html']);
  assert.match(stdout, /3 route pages/);
  assert.doesNotMatch(index, /<img\b/, 'the index holds no images');
  const all = pages.map((p) => p.html).join('\n');
  assert.doesNotMatch(index + all, /data:image/, 'no image is inlined');
  const images = pages.flatMap((page) => imagesOf(page).map((src) => join(dirname(page.file), decodeURI(src))));
  assert.equal(images.length, liveManifest.length + newManifest.length + diff.length);
  for (const file of images) assert.ok(existsSync(file), `${file} exists`);
  for (const page of pages) {
    assert.match(page.html, /^<!doctype html>/i);
    assert.match(page.html, /<a href="\.\.\/index\.html">/, 'each page links back to the index');
  }
  const failingRows = diff.filter((d) => !d.pass).length + styles.filter((s) => !s.pass).length;
  assert.equal((all.match(/\bFAIL\b/g) ?? []).length, failingRows);
  assert.match(index, new RegExp(`${failingRows} failing rows`));
  assert.match(all, /3\.25\s*%/);
  assert.match(index, /3\.25\s*%/, 'the index shows each pair\'s percent');
  assert.match(all, /margin-top/);
  assert.doesNotMatch(all, /line-height/, 'passing style rows are not listed');
  assert.equal((all.match(/style only/g) ?? []).length, 1, 'only the route without screenshots is style only');
  const page = (route) => pages.find((p) => p.html.includes(`<h2><code>${route}</code></h2>`)).html;
  const rowsOf = (route) => page(route).split('<div class="row').slice(1);
  const about1440 = rowsOf('about').find((row) => /<h3>1440 px/.test(row));
  assert.match(about1440, /<img\b/, 'the about 1440 row has its screenshots');
  assert.match(about1440, /font-size/, 'its style failures sit beneath the pair');
  assert.match(about1440, /margin-top/);
  const home390 = rowsOf('home').find((row) => /<h3>390 px/.test(row));
  assert.match(home390, /<img\b/);
  assert.match(home390, /rgb\(178, 60, 40\)/);
  const blog = rowsOf('blog');
  assert.equal(blog.length, 1);
  assert.match(blog[0], /style only/);
  assert.doesNotMatch(blog[0], /<img\b/);
  assert.doesNotMatch(index + all, /NaN/);
  assert.match(all, /n\/a/);
});

test('200 page pairs stream to small files: no page holds more than its route, no image is inlined', async () => {
  const dir = join(TMP, 'many');
  const manifest = [];
  const pairs = [];
  writePng(join(dir, 'one.png'), [255, 255, 255]);
  for (let i = 0; i < 100; i += 1) {
    for (const width of [390, 1440]) {
      const file = `page-${i}/${width}.png`;
      for (const side of ['live', 'new', 'diff']) {
        mkdirSync(join(dir, side, `page-${i}`), { recursive: true });
        cpSync(join(dir, 'one.png'), join(dir, side, file));
      }
      manifest.push({ route: `page-${i}`, width, file, heightPx: 4, bannerClosed: false });
      pairs.push({ route: `page-${i}`, width, percent: i % 10 === 0 ? 1.5 : 0, pass: i % 10 !== 0, heightA: 4, heightB: 4 });
    }
  }
  for (const side of ['live', 'new']) writeFileSync(join(dir, side, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'diff', 'diff.json'), JSON.stringify(pairs));
  const out = join(dir, 'all.html');
  const { code, stderr } = await run(['--live', join(dir, 'live'), '--new', join(dir, 'new'), '--diff', join(dir, 'diff', 'diff.json'), '--out', out]);
  assert.equal(code, 0, stderr);
  const { index, pages } = pagesOf(out);
  assert.equal(pages.length, 100);
  assert.ok(pages.every((p) => p.href.startsWith('all-pages/')));
  assert.match(index, /20 failing rows/);
  assert.ok(statSync(out).size < 200_000, `index is ${statSync(out).size} bytes`);
  for (const page of pages) {
    assert.ok(statSync(page.file).size < 20_000, `${page.href} is ${statSync(page.file).size} bytes`);
    assert.equal(imagesOf(page).length, 6);
    for (const src of imagesOf(page)) assert.ok(existsSync(join(dirname(page.file), decodeURI(src))), src);
  }
});

test('a rerun removes the route pages it wrote that are no longer in the set, and nothing else', async () => {
  const dir = join(TMP, 'rerun');
  const out = join(dir, 'review.html');
  const args = (live, next, diffFile) => ['--live', live, '--new', next, '--diff', diffFile, '--out', out];
  const first = await run(args(join(TMP, 'live'), join(TMP, 'new'), join(TMP, 'diff', 'diff.json')));
  assert.equal(first.code, 0, first.stderr);
  const pagesDir = join(dir, 'review-pages');
  assert.ok(existsSync(join(pagesDir, 'about.html')));
  writeFileSync(join(pagesDir, 'notes.html'), 'mine');
  // The same shots without the about route.
  for (const side of ['live', 'new']) {
    cpSync(join(TMP, side), join(dir, side), { recursive: true });
    const file = join(dir, side, 'manifest.json');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).filter((e) => e.route !== 'about')));
  }
  cpSync(join(TMP, 'diff'), join(dir, 'diff'), { recursive: true });
  writeFileSync(join(dir, 'diff', 'diff.json'), JSON.stringify(diff.filter((d) => d.route !== 'about')));
  const second = await run(args(join(dir, 'live'), join(dir, 'new'), join(dir, 'diff', 'diff.json')));
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /removed 1 route page no longer in the set/);
  assert.ok(!existsSync(join(pagesDir, 'about.html')), 'the stale route page is gone');
  assert.ok(existsSync(join(pagesDir, 'home.html')));
  assert.equal(readFileSync(join(pagesDir, 'notes.html'), 'utf8'), 'mine', 'a file the sheet never wrote is kept');
  assert.deepEqual(pagesOf(out).pages.map((p) => p.href), ['review-pages/home.html']);
});

test('without --styles the sheet still renders, failing diff rows only', async () => {
  const out = join(TMP, 'plain.html');
  const { code } = await run([
    '--live', join(TMP, 'live'), '--new', join(TMP, 'new'), '--diff', join(TMP, 'diff', 'diff.json'), '--out', out,
  ]);
  assert.equal(code, 0);
  const html = pagesOf(out).pages.map((p) => p.html).join('\n');
  assert.equal((html.match(/\bFAIL\b/g) ?? []).length, 1);
});
