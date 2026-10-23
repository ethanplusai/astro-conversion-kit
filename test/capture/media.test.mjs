import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture/serve.mjs';
import { cssImports, cssUrls } from '../../skills/capture-site/scripts/lib/css-urls.mjs';
import { srcsetUrls } from '../../skills/capture-site/scripts/media.mjs';

const exec = promisify(execFile);
const CAPTURE = fileURLToPath(new URL('../../skills/capture-site/scripts/capture.mjs', import.meta.url));
const MEDIA = fileURLToPath(new URL('../../skills/capture-site/scripts/media.mjs', import.meta.url));
const SITE = fileURLToPath(new URL('../fixture/site', import.meta.url));
const THEME = '/wp-content/themes/fixture/style.css';
const UPLOADS = '/wp-content/uploads/2026/01/';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function run(script, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

let fixture;
let work;
let cap;
let dl;
let mediaRun;
before(async () => {
  fixture = await startFixture();
  work = mkdtempSync(join(tmpdir(), 'media-capture-test-'));
  cap = join(work, 'capture');
  dl = join(work, 'download');
  const captured = await run(CAPTURE, [fixture.origin, '--out', cap, '--delay', '0', '--no-wayback']);
  assert.equal(captured.code, 0, captured.stderr);
  mediaRun = await run(MEDIA, ['--capture', cap, '--download', dl, '--delay', '0']);
});
after(async () => {
  await fixture.close();
  rmSync(work, { recursive: true, force: true });
});

test('cssUrls finds the two fonts in the theme CSS, resolved against the stylesheet', () => {
  const base = `${fixture.origin}${THEME}?ver=1.4.2`;
  assert.deepEqual(cssUrls(readFileSync(join(SITE, THEME), 'utf8'), base), [
    `${fixture.origin}/wp-content/themes/fixture/fonts/fixture-sans.woff2`,
    `${fixture.origin}/wp-content/themes/fixture/fonts/fixture-serif.woff2`,
  ]);
});

test('cssImports lists every @import target, url() or string, resolved against the stylesheet', () => {
  const css = [
    '/* @import "commented.css"; */',
    '@import url("parts/grid.css");',
    "@import 'print.css' print;",
    '@import url(https://fonts.example.com/css?family=Sans) layer(fonts);',
    '@import "parts/grid.css";',
    '.a { background: url(img/a.png); }',
  ].join('\n');
  assert.deepEqual(cssImports(css, 'https://www.example.com/wp-content/themes/x/style.css?ver=2'), [
    'https://www.example.com/wp-content/themes/x/parts/grid.css',
    'https://www.example.com/wp-content/themes/x/print.css',
    'https://fonts.example.com/css?family=Sans',
  ]);
  assert.deepEqual(cssImports('@import url("data:text/css,a{}"); @import "javascript:x";', 'https://www.example.com/'), []);
});

test('cssUrls keeps image and font url()s only, never a data: URI', () => {
  // The fixture theme has no background image or data: URI, so this CSS adds them.
  const css = [
    '@import url("parts/grid.css");',
    '.hero { background-image: url(../../uploads/2026/01/hero.jpg), url("data:image/gif;base64,R0lGOD"); }',
    ".icon { background: url('img/Sprite.PNG?v=2#top') no-repeat; }",
    '@font-face { src: url(fonts/old.eot?#iefix) format("embedded-opentype"), url(fonts/old.woff) format("woff"); }',
    '.behaviour { behavior: url(htc/pie.htc); } .js { x: url(app.js); }',
    '.again { background: url(../../uploads/2026/01/hero.jpg); }',
    '/* url(commented-out.png) */',
  ].join('\n');
  assert.deepEqual(cssUrls(css, 'https://www.example.com/wp-content/themes/x/style.css'), [
    'https://www.example.com/wp-content/uploads/2026/01/hero.jpg',
    'https://www.example.com/wp-content/themes/x/img/Sprite.PNG?v=2',
    'https://www.example.com/wp-content/themes/x/fonts/old.eot',
    'https://www.example.com/wp-content/themes/x/fonts/old.woff',
  ]);
  assert.deepEqual(cssUrls('a { color: red; }', 'https://www.example.com/'), []);
  assert.deepEqual(cssUrls('a { background: url(x.png) ', 'https://www.example.com/'), ['https://www.example.com/x.png'], 'unclosed CSS still parses');
});

test('the capture saves the theme stylesheet and a CSS manifest', () => {
  const manifest = readJson(join(cap, 'css/manifest.json'));
  // One stylesheet, then the <style> blocks of the two pages that carry them (each page its own set).
  assert.deepEqual(manifest.slice(1), [
    { file: 'inline-home.css', inline: true, pages: ['/'] },
    { file: 'inline-contact.css', inline: true, pages: ['/contact/'] },
  ]);
  assert.equal(manifest[0].file, '1.css');
  assert.equal(manifest[0].href, `${fixture.origin}${THEME}?ver=1.4.2`);
  const pages = readJson(join(cap, 'inventory.json')).filter((r) => r.status === 200).map((r) => r.path).sort();
  assert.deepEqual(manifest[0].pages, pages);
  assert.equal(readFileSync(join(cap, 'css/1.css'), 'utf8'), readFileSync(join(SITE, THEME), 'utf8'));
});

test('media.json lists every media file with its sources, pages, type and size', () => {
  assert.equal(mediaRun.code, 0, mediaRun.stderr);
  const media = readJson(join(cap, 'media.json'));
  // 20 = 15 images (5 originals x 3 sizes, all in the REST media list) + brochure.pdf + logo.svg
  // (the header logo, which is also the favicon) + the two WOFF2 fonts the theme CSS loads +
  // og-card.jpg (the 1200x630 og:image). The fixture has no separate favicon file and no CSS
  // background image.
  assert.equal(media.length, 20, media.map((m) => m.path).join('\n'));
  for (const m of media) {
    assert.equal(m.status, 200, m.path);
    assert.ok(m.bytes > 0, m.path);
    assert.ok(m.contentType, m.path);
    assert.equal(m.url, fixture.origin + m.path);
  }
  const by = (path) => media.find((m) => m.path === path);
  const sorted = media.map((m) => m.path);
  assert.deepEqual(sorted, [...sorted].sort(), 'sorted by path');

  assert.deepEqual(by(`${UPLOADS}hero.jpg`).source, ['srcset', 'rest']);
  assert.deepEqual(by(`${UPLOADS}og-card.jpg`).source, ['og']);
  assert.deepEqual(by(`${UPLOADS}brochure.pdf`).source, ['html', 'rest']);
  assert.deepEqual(by(`${UPLOADS}logo.svg`).source, ['html']);
  assert.equal(by(`${UPLOADS}logo.svg`).contentType, 'image/svg+xml');
  assert.deepEqual(by('/wp-content/themes/fixture/fonts/fixture-serif.woff2').source, ['css']);
  assert.deepEqual(by('/wp-content/themes/fixture/fonts/fixture-sans.woff2').source, ['html', 'css'], 'preloaded and in CSS');
  assert.equal(by('/wp-content/themes/fixture/fonts/fixture-sans.woff2').contentType, 'font/woff2');
  assert.ok(by(`${UPLOADS}hero.jpg`).referencedBy.includes('/'));
  assert.ok(by('/wp-content/themes/fixture/fonts/fixture-serif.woff2').referencedBy.includes('/contact/'));

  const images = media.filter((m) => m.path.startsWith(UPLOADS) && /\.(jpg|webp)$/.test(m.path) && !m.path.endsWith('/og-card.jpg'));
  assert.equal(images.length, 15);
  assert.ok(images.every((m) => m.source.includes('rest')), 'the REST media list names every size');
});

test('the lazy image is listed by its real data-src, not the placeholder', () => {
  const media = readJson(join(cap, 'media.json'));
  const team = media.find((m) => m.path === `${UPLOADS}team-1024x683.jpg`);
  assert.ok(team.source.includes('html'));
  assert.ok(team.referencedBy.includes('/'), 'the home page references it only through data-src');
  assert.ok(!media.some((m) => m.url.startsWith('data:')));
});

test('--download saves every file byte-identical under its path', () => {
  const media = readJson(join(cap, 'media.json'));
  for (const m of media) {
    assert.deepEqual(readFileSync(join(dl, m.path)), readFileSync(join(SITE, m.path)), m.path);
    assert.equal(m.bytes, readFileSync(join(SITE, m.path)).length, m.path);
  }
});

// A capture folder for one page served by a hand-written server.
function tinyCapture(origin, html) {
  const dir = mkdtempSync(join(work, 'tiny-'));
  mkdirSync(join(dir, 'pages'));
  writeFileSync(join(dir, 'pages/home.html'), html);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ origin, canonicalOrigin: origin }));
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify([{ url: `${origin}/`, path: '/', status: 200, snapshot: 'pages/home.html' }]));
  return dir;
}

function serve(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
      }));
  });
}

test('a size only the REST media list knows is listed with no pages; off-site media is not', async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 4 });
    res.end(req.method === 'HEAD' ? undefined : 'jpeg');
  });
  try {
    const dir = tinyCapture(
      server.origin,
      '<html><head><meta property="og:image" content="https://cdn.example.com/x.jpg"></head><body style="background: url(/bg.jpg)"><img src="/a.jpg"></body></html>',
    );
    mkdirSync(join(dir, 'wp-rest'));
    const sizes = { medium: { source_url: `${server.origin}/a-300x200.jpg` } };
    writeFileSync(join(dir, 'wp-rest/media.json'), JSON.stringify([{ source_url: `${server.origin}/a.jpg`, media_details: { sizes } }]));
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const media = readJson(join(dir, 'media.json'));
    assert.deepEqual(media.map((m) => [m.path, m.source, m.referencedBy]), [
      ['/a-300x200.jpg', ['rest'], []],
      ['/a.jpg', ['html', 'rest'], ['/']],
      ['/bg.jpg', ['css'], ['/']],
    ]);
  } finally {
    await server.close();
  }
});

test('a server that refuses HEAD is asked with GET', async () => {
  const body = Buffer.from('%PDF-1.4 tiny');
  const server = await serve((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(405, { Allow: 'GET' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': body.length });
      res.end(body);
    }
  });
  try {
    const dir = tinyCapture(server.origin, '<html><body><a href="/files/a.pdf">a</a> <a href="/about/">x</a></body></html>');
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const [entry, ...rest] = readJson(join(dir, 'media.json'));
    assert.deepEqual(rest, [], 'a link to a page is not media');
    assert.deepEqual(entry, {
      url: `${server.origin}/files/a.pdf`, path: '/files/a.pdf', source: ['html'], referencedBy: ['/'],
      status: 200, contentType: 'application/pdf', bytes: body.length,
    });
    assert.deepEqual(server.requests, ['HEAD /files/a.pdf', 'GET /files/a.pdf']);
  } finally {
    await server.close();
  }
});

test('a file that keeps answering 429 stops with exit 3, and a re-run only asks for what is left', async () => {
  let slow = true;
  const server = await serve((req, res) => {
    if (req.url === '/b.png' && slow) {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 3 });
    res.end(req.method === 'HEAD' ? undefined : 'png');
  });
  try {
    const dir = tinyCapture(server.origin, '<html><body><img src="/a.png"><img src="/b.png"></body></html>');
    const stopped = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(stopped.code, 3, stopped.stderr);
    assert.match(stopped.stderr, /again/);
    const partial = readJson(join(dir, 'media.json'));
    assert.deepEqual(partial.map((m) => `${m.path}:${m.status}`), ['/a.png:200', '/b.png:null']);

    slow = false;
    server.requests.length = 0;
    const resumed = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(server.requests, ['HEAD /b.png']);
    assert.deepEqual(readJson(join(dir, 'media.json')).map((m) => `${m.path}:${m.status}`), ['/a.png:200', '/b.png:200']);
  } finally {
    await server.close();
  }
});

test('--concurrency checks files at once and keeps media.json in order; out-of-range values exit 2', async () => {
  const flight = { now: 0, max: 0 };
  const server = await serve((req, res) => {
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    setTimeout(() => {
      flight.now -= 1;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 3 });
      res.end(req.method === 'HEAD' ? undefined : 'png');
    }, 100);
  });
  try {
    const names = Array.from({ length: 8 }, (_, i) => `/i${i}.png`);
    const dir = tinyCapture(server.origin, `<html><body>${names.map((n) => `<img src="${n}">`).join('')}</body></html>`);
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0', '--concurrency', '4']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(flight.max, 4);
    assert.deepEqual(readJson(join(dir, 'media.json')).map((m) => `${m.path}:${m.status}`), names.map((n) => `${n}:200`));
    for (const bad of ['0', '33', '1.5']) {
      const refused = await run(MEDIA, ['--capture', dir, '--concurrency', bad]);
      assert.equal(refused.code, 2, `--concurrency ${bad}`);
      assert.match(refused.stderr, /--concurrency needs a whole number from 1 to 32/);
    }
    assert.match((await run(MEDIA, ['--help'])).stdout, /--concurrency <n>/);
  } finally {
    await server.close();
  }
});

test('progress is saved to media.json every 100 files, so a stopped run resumes from there', async () => {
  let dir;
  let savedWhenAsked = null;
  const server = await serve((req, res) => {
    // When the 101st file is asked for, the first 100 are already on disk.
    if (req.url === '/f100.png' && savedWhenAsked === null) {
      const file = join(dir, 'media.json');
      savedWhenAsked = existsSync(file) ? readJson(file).filter((m) => m.status === 200).length : 0;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 3 });
    res.end(req.method === 'HEAD' ? undefined : 'png');
  });
  try {
    const names = Array.from({ length: 101 }, (_, i) => `/f${String(i).padStart(3, '0')}.png`);
    dir = tinyCapture(server.origin, `<html><body>${names.map((n) => `<img src="${n}">`).join('')}</body></html>`);
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(savedWhenAsked, 100);
  } finally {
    await server.close();
  }
});

test('srcset is parsed per the HTML rules: a URL is a run of non-spaces', () => {
  assert.deepEqual(srcsetUrls('a.jpg 300w,b.jpg 1024w'), ['a.jpg', 'b.jpg']);
  assert.deepEqual(srcsetUrls(' a.jpg,  b.jpg 2x , c.jpg'), ['a.jpg', 'b.jpg', 'c.jpg']);
  const cloudinary = 'https://res.cloudinary.com/demo/image/upload/w_300,h_200,c_fill/a.jpg 300w, '
    + 'https://res.cloudinary.com/demo/image/upload/w_1024,h_683,c_fill/a.jpg 1024w';
  assert.deepEqual(srcsetUrls(cloudinary), [
    'https://res.cloudinary.com/demo/image/upload/w_300,h_200,c_fill/a.jpg',
    'https://res.cloudinary.com/demo/image/upload/w_1024,h_683,c_fill/a.jpg',
  ]);
  assert.deepEqual(srcsetUrls('x.jpg (min-width: 2, 3) 2x, y.jpg 3x'), ['x.jpg', 'y.jpg'], 'a comma inside parentheses');
  assert.deepEqual(srcsetUrls(''), []);
  assert.deepEqual(srcsetUrls(null), []);
});

// A server where the listed paths always reset the connection and the rest answer 200.
function resetting(paths) {
  return serve((req, res) => {
    if (paths.includes(req.url)) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 3 });
    res.end(req.method === 'HEAD' ? undefined : 'png');
  });
}

test('a file that always resets is recorded with status 0 and the run finishes', async () => {
  const server = await resetting(['/dead.png']);
  try {
    const dir = tinyCapture(server.origin, '<html><body><img src="/a.png"><img src="/dead.png"><img src="/z.png"></body></html>');
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 0, result.stderr);
    const media = readJson(join(dir, 'media.json'));
    assert.deepEqual(media.map((m) => `${m.path}:${m.status}`), ['/a.png:200', '/dead.png:0', '/z.png:200']);
    const dead = media.find((m) => m.path === '/dead.png');
    assert.ok(dead.error, 'the network error is kept');
    assert.equal(dead.bytes, null);
    assert.equal(server.requests.filter((r) => r.endsWith('/dead.png')).length, 3, 'tried three times');
  } finally {
    await server.close();
  }
});

test('three different files failing in a row stop the run with exit 3', async () => {
  const server = await resetting(['/b1.png', '/b2.png', '/b3.png']);
  try {
    const dir = tinyCapture(
      server.origin,
      '<html><body><img src="/a.png"><img src="/b1.png"><img src="/b2.png"><img src="/b3.png"><img src="/c.png"></body></html>',
    );
    const result = await run(MEDIA, ['--capture', dir, '--delay', '0']);
    assert.equal(result.code, 3, result.stderr);
    assert.deepEqual(readJson(join(dir, 'media.json')).map((m) => `${m.path}:${m.status}`), [
      '/a.png:200', '/b1.png:0', '/b2.png:0', '/b3.png:0', '/c.png:null',
    ]);
    assert.ok(!server.requests.some((r) => r.endsWith('/c.png')));
  } finally {
    await server.close();
  }
});

test('--max-file-bytes records a larger file "too-large" and saves the rest, streamed to disk', async () => {
  const server = await serve((req, res) => {
    const body = req.url === '/big.pdf' ? Buffer.alloc(5000, 1) : Buffer.from('png');
    res.writeHead(200, { 'Content-Type': req.url === '/big.pdf' ? 'application/pdf' : 'image/png', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  try {
    const dir = tinyCapture(server.origin, '<html><body><img src="/a.png"><a href="/big.pdf">big</a></body></html>');
    const saved = join(dir, 'saved');
    const result = await run(MEDIA, ['--capture', dir, '--download', saved, '--delay', '0', '--max-file-bytes', '1000']);
    assert.equal(result.code, 0, result.stderr);
    const media = readJson(join(dir, 'media.json'));
    assert.deepEqual(media.map((m) => `${m.path}:${m.status}:${m.bytes}`), ['/a.png:200:3', '/big.pdf:too-large:null']);
    assert.equal(readFileSync(join(saved, 'a.png'), 'utf8'), 'png');
    assert.deepEqual(readdirSync(saved).sort(), ['a.png'], 'nothing is left of the large file');

    const bad = await run(MEDIA, ['--capture', dir, '--max-file-bytes', 'lots']);
    assert.equal(bad.code, 2);
    assert.match((await run(MEDIA, ['--help'])).stdout, /--max-file-bytes/);
  } finally {
    await server.close();
  }
});

test('media.mjs usage errors exit 2 and --help prints usage', async () => {
  const help = await run(MEDIA, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node media\.mjs --capture <dir>/);
  assert.match(help.stdout, /keyed by path/);
  assert.match(help.stdout, /first URL/);
  assert.equal((await run(MEDIA, [])).code, 2);
  assert.equal((await run(MEDIA, ['--capture', join(work, 'missing')])).code, 2);
});

test('media.mjs refuses a capture with no page that answered 200 (exit 2)', async () => {
  const empty = join(work, 'empty-capture');
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, 'meta.json'), JSON.stringify({ origin: 'https://example.com' }));
  writeFileSync(join(empty, 'inventory.json'), JSON.stringify([{ url: 'https://example.com/', path: '/', status: 404, snapshot: 'pages/home.html' }]));
  const result = await run(MEDIA, ['--capture', empty, '--delay', '0']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no page .*answered 200/i);
  assert.ok(!existsSync(join(empty, 'media.json')));
});
