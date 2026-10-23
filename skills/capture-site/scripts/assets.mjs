#!/usr/bin/env node
// Brand assets: the logo, the favicon, the apple-touch-icon and every web font, saved byte for
// byte into <capture>/assets/ so the build can use the originals.
// Sources: <link rel=icon|apple-touch-icon> and the logo (findLogo: in <header> first, then in
// other logo elements, an image or inline <svg> named logo, the home link's image, else the
// first <img>) on the home page snapshot, and every @font-face src in the stylesheets under <capture>/css/.
// Requests are paced like the crawl; fonts already saved are kept, so a stopped run resumes.
// assets/index.json lists every asset looked for, saved or missing.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';
import { assertNodeVersion } from './lib/node-version.mjs';
import { serializeOuter } from 'parse5';
import { attr, children, findAll, isElement, parseHtml } from '../../parity-gates/scripts/lib/html.mjs';
import { BLOCK_LIMIT, DEFAULT_CONCURRENCY, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, http, MAX_FILE_BYTES, pacing, POLITE_DELAY_MS } from './lib/http.mjs';

const USAGE = `Usage: node assets.mjs --capture <dir> [--delay <ms>] [--concurrency <n>] [--polite] [--ua "<string>"] [--max-file-bytes <n>]

Save the site's logo, favicon, apple-touch-icon and web fonts into <dir>/assets/
(logo.*, favicon.*, apple-touch-icon.*, fonts/*). The logo is found on the home page inside
<header> first, then inside other elements whose class or id names a logo: an <img> whose src,
alt, class or id says "logo", else an inline <svg> that does (saved as logo.svg), else the
<img> in the link to the home page, else the first <img>; the icons come from its <link rel=icon> and
<link rel=apple-touch-icon>, the web manifest from its <link rel=manifest>; the fonts are every @font-face src in <dir>/css/ (written by
capture.mjs; without it, fonts are reported as not captured).

  --capture <dir>   the capture folder written by capture.mjs
  --delay <ms>      time between request starts on a host (default ${DEFAULT_DELAY_MS})
  --concurrency <n> requests in flight on a host at once (default ${DEFAULT_CONCURRENCY})
  --polite          one request at a time, ${POLITE_DELAY_MS} ms apart; --delay and
                    --concurrency override it
  --ua "<string>"   user agent (default: a desktop Chrome)
  --max-file-bytes <n>  largest file to save (default ${MAX_FILE_BYTES}, 2 GB); a larger one is
                    listed with status "too-large"
  --help            show this help

Writes <dir>/assets/index.json listing each asset looked for. An asset that does not answer
200 is a warning on stderr and is listed there as missing. Files stream to disk; a host that
resolves to a loopback, private or link-local address (other than the site's own) is not
requested and is listed with status "blocked-address".

Exit codes: 0 done (missing assets included), 2 usage error or no inventory.json,
3 stopped because the site is blocking requests (wait, then run the same command again).`;

const TYPE_EXTENSIONS = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/avif': '.avif',
};
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];

class Blocked extends Error {}

const relTokens = (node) => (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
const classTokens = (node) => (attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);

function resolveUrl(href, base) {
  if (!href || /^data:/i.test(href.trim())) return null;
  try {
    const url = new URL(href.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function imageSrc(img) {
  const src = attr(img, 'src');
  if (src && !/^data:/i.test(src.trim())) return src;
  return LAZY_SRC.map((name) => attr(img, name)).find(Boolean) ?? null;
}

// "logo" or "logos" as a word of a name: site-logo.svg, custom-logo, "Brand logo", headerLogo
// (a camelCase word start counts), not "logout" or "catalogue".
const LOGO = /(^|[^A-Za-z]|[a-z](?=L))[Ll][Oo][Gg][Oo][Ss]?([^A-Za-z]|$)/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const mentionsLogo = (node, names) => names.some((name) => LOGO.test(attr(node, name) ?? ''));
const textContent = (node) => (node.nodeName === '#text' ? node.value : children(node).map(textContent).join(''));
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'image']);

// The site's logo on the home page. Looked for first inside <header>, then inside any other
// element whose class or id names a logo (.logo, .site-logo, #logo-wrap; a footer's sponsor
// logos only count when the header has no image at all). In each, in this order of preference:
// an <img> whose src, alt, class or id names a logo; an inline <svg> with a logo in its class,
// id, aria-label or <title>; the first <img> inside a link to the home page; the first <img>.
// Returns { img }, { svg } or null.
function findLogo(document, homeUrl) {
  const home = new URL(homeUrl);
  const isHome = (href) => {
    const url = resolveUrl(href, homeUrl);
    if (!url) return false;
    const target = new URL(url);
    return target.host.replace(/^www\./i, '') === home.host.replace(/^www\./i, '') && target.pathname === '/';
  };
  const groups = { header: { images: [], svgs: [] }, other: { images: [], svgs: [] } };
  const visit = (node, scope, inHome) => {
    let here = scope;
    if (node.tagName === 'header') here = 'header';
    else if (!here && isElement(node) && mentionsLogo(node, ['class', 'id'])) here = 'other';
    const linked = inHome || (node.tagName === 'a' && isHome(attr(node, 'href')));
    if (here && node.tagName === 'img' && imageSrc(node)) groups[here].images.push({ node, linked });
    if (node.tagName === 'svg') {
      if (here) groups[here].svgs.push(node);
      return;
    }
    for (const child of children(node)) visit(child, here, linked);
  };
  visit(document, null, false);
  for (const { images, svgs } of [groups.header, groups.other]) {
    const named = images.find(({ node }) => LOGO.test(imageSrc(node)) || mentionsLogo(node, ['alt', 'class', 'id']));
    if (named) return { img: named.node };
    const svg = svgs.find((node) => mentionsLogo(node, ['class', 'id', 'aria-label'])
      || findAll(node, (n) => n.tagName === 'title').some((t) => LOGO.test(textContent(t))));
    if (svg) return { svg };
    const linked = images.find((i) => i.linked);
    if (linked) return { img: linked.node };
    if (images.length) return { img: images[0].node };
  }
  return null;
}

// An inline <svg> that draws nothing itself: only <use> references to a symbol elsewhere on the page.
const onlyUses = (node) => findAll(node, (n) => n.tagName === 'use').length > 0 && findAll(node, (n) => SHAPES.has(n.tagName)).length === 0;

// An inline <svg> as a file of its own: the namespaces a standalone file needs are added.
function svgFile(node) {
  const has = (name) => node.attrs.some((a) => a.name === name);
  node.attrs = [...node.attrs];
  if (!has('xmlns')) node.attrs.push({ name: 'xmlns', value: SVG_NS });
  let markup = serializeOuter(node);
  if (/\sxlink:/.test(markup) && !has('xmlns:xlink')) {
    node.attrs.push({ name: 'xmlns:xlink', value: XLINK_NS });
    markup = serializeOuter(node);
  }
  return `${markup.replace(/&nbsp;/g, '&#160;')}\n`;
}

function iconHref(document, rels) {
  const link = findAll(document, (n) => n.tagName === 'link' && relTokens(n).some((r) => rels.includes(r)))[0];
  return link ? attr(link, 'href') : null;
}

function homeRecord(dir, inventory) {
  const pages = inventory.filter((r) => r.status === 200 && r.snapshot && existsSync(join(dir, r.snapshot)));
  return pages.find((r) => r.path === '/') ?? pages[0] ?? null;
}

// Every @font-face src url in the captured stylesheets, resolved against where each came from.
function fontUrls(dir, origin) {
  const cssDir = join(dir, 'css');
  const manifestFile = join(cssDir, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  const urls = [];
  for (const entry of JSON.parse(readFileSync(manifestFile, 'utf8'))) {
    if (!entry?.file) continue; // not saved: an HTTP status, too-deep or a refused address
    const file = [join(cssDir, entry.file), join(dir, entry.file)].find((f) => existsSync(f));
    if (!file) continue;
    const base = entry.finalUrl ?? entry.href ?? new URL(entry.pages?.[0] ?? '/', origin).href;
    const ast = csstree.parse(readFileSync(file, 'utf8'), { parseValue: true, onParseError: () => {} });
    csstree.walk(ast, {
      visit: 'Atrule',
      enter(rule) {
        if (rule.name.toLowerCase() !== 'font-face' || !rule.block) return;
        csstree.walk(rule.block, {
          visit: 'Declaration',
          enter(decl) {
            if (decl.property.toLowerCase() !== 'src') return;
            csstree.walk(decl.value, {
              visit: 'Url',
              enter(node) {
                const url = resolveUrl(node.value, base);
                if (url && !urls.includes(url)) urls.push(url);
              },
            });
          },
        });
      },
    });
  }
  return urls;
}

function extensionFor(url, contentType) {
  const fromPath = extname(new URL(url).pathname).toLowerCase();
  if (fromPath) return fromPath;
  return TYPE_EXTENSIONS[(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? '';
}

function parseArgs(argv) {
  const args = { capture: null, delayMs: null, concurrency: null, polite: false, ua: DEFAULT_UA, maxFileBytes: MAX_FILE_BYTES, help: false };
  const value = (i) => (i < argv.length && !argv[i].startsWith('--') ? argv[i] : null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--capture' && value(i + 1)) args.capture = argv[(i += 1)];
    else if (arg === '--ua' && value(i + 1)) args.ua = argv[(i += 1)];
    else if (arg === '--delay' && value(i + 1)) {
      args.delayMs = Number(argv[(i += 1)]);
      if (!Number.isInteger(args.delayMs) || args.delayMs < 0) return { error: '--delay needs a whole number' };
    } else if (arg === '--concurrency' && value(i + 1)) {
      args.concurrency = Number(argv[(i += 1)]);
      if (!Number.isInteger(args.concurrency) || args.concurrency < 1) return { error: '--concurrency needs a whole number of at least 1' };
    } else if (arg === '--polite') args.polite = true; else if (arg === '--max-file-bytes' && value(i + 1)) {
      args.maxFileBytes = Number(argv[(i += 1)]);
      if (!Number.isInteger(args.maxFileBytes) || args.maxFileBytes < 1) return { error: '--max-file-bytes needs a whole number of bytes' };
    } else return { error: `unknown or incomplete option ${arg}` };
  }
  if (!args.help && !args.capture) return { error: '--capture <dir> is required' };
  return { ...args, ...pacing(args) };
}

async function main() {
  assertNodeVersion();
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dir = resolve(args.capture);
  const inventoryFile = join(dir, 'inventory.json');
  if (!existsSync(inventoryFile)) {
    console.error(`No inventory.json in ${dir}. Run capture.mjs first.`);
    process.exit(2);
  }
  const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  const metaFile = join(dir, 'meta.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const home = homeRecord(dir, inventory);
  const origin = meta.canonicalOrigin ?? meta.origin ?? (home ? new URL(home.url).origin : null);
  const out = join(dir, 'assets');
  // One entry per asset looked for: { kind, url, file, status, note }. Written to
  // assets/index.json so readme.mjs can list what was saved and what is missing.
  const entries = [];
  const warnings = [];
  http.resetBlocked();

  const fontNames = new Map(); // file name -> url, so two fonts with one name do not overwrite
  // Saves url as <out>/<stem><ext>, or fonts/<name> (kept when already saved).
  const save = async (kind, url, stem, { keepName = false } = {}) => {
    let name = null;
    if (keepName) {
      const original = basename(new URL(url).pathname) || 'font';
      name = original;
      for (let n = 2; fontNames.has(name) && fontNames.get(name) !== url; n += 1) {
        name = original.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
      }
      fontNames.set(name, url);
    }
    const known = keepName ? join(out, stem, name) : null;
    if (known && existsSync(known)) {
      entries.push({ kind, url, file: `assets/${stem}/${name}`, status: 200, note: null });
      return;
    }
    // Streamed to the known name, or to a temporary one until the type gives the extension.
    const download = known ?? join(out, `.${stem}.download`);
    const res = await fetchPaced(url, {
      delayMs: args.delayMs, concurrency: args.concurrency, ua: args.ua, redirect: 'follow', trusted: [origin], maxBytes: args.maxFileBytes, toFile: download,
    });
    if (http.blocked >= BLOCK_LIMIT) throw new Blocked();
    if (res.status !== 200) {
      const note = `missing: ${url} returned ${res.status || res.error}`;
      entries.push({ kind, url, file: null, status: res.status, note });
      warnings.push(`${kind} ${note}`);
      return;
    }
    const file = known ?? join(out, `${stem}${extensionFor(url, res.headers['content-type'])}`);
    if (file !== download) renameSync(download, file);
    entries.push({ kind, url, file: `assets/${file.slice(out.length + 1)}`, status: 200, note: null });
  };
  const absent = (kind, note) => entries.push({ kind, url: null, file: null, status: null, note });

  const finish = () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
    console.log(entries.map((e) => `${e.kind}: ${e.file ?? e.note}`).join('\n'));
    for (const w of warnings) console.error(`Warning: ${w}`);
  };

  try {
    if (!home) {
      for (const kind of ['logo', 'favicon', 'apple-touch-icon', 'manifest']) absent(kind, 'not captured (no page snapshot answered 200)');
    } else {
      const document = parseHtml(readFileSync(join(dir, home.snapshot), 'utf8'));
      const logo = findLogo(document, home.url);
      if (logo?.svg) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'logo.svg'), svgFile(logo.svg));
        const note = onlyUses(logo.svg) ? 'inline <svg> in the home page; uses a symbol defined elsewhere on the page' : 'inline <svg> in the home page';
        entries.push({ kind: 'logo', url: null, file: 'assets/logo.svg', status: 200, note });
      }
      const targets = [
        ...(logo?.svg ? [] : [['logo', logo?.img ? resolveUrl(imageSrc(logo.img), home.url) : null, 'none (no <img> or logo <svg> inside <header> or a logo element)']]),
        ['favicon', resolveUrl(iconHref(document, ['icon']), home.url), 'none on the site'],
        ['apple-touch-icon', resolveUrl(iconHref(document, ['apple-touch-icon', 'apple-touch-icon-precomposed']), home.url), 'none on the site'],
        ['manifest', resolveUrl(iconHref(document, ['manifest']), home.url), 'none on the site'],
      ];
      for (const [kind, url, missing] of targets) {
        if (url) await save(kind, url, kind);
        else absent(kind, missing);
      }
      // The root icons browsers and launch checks ask for whatever the head links; saved when the
      // capture's probe (meta.json icons) saw live answer 200.
      for (const [path, stem] of [['/favicon.ico', 'root-favicon'], ['/apple-touch-icon.png', 'root-apple-touch-icon']]) {
        if (origin && meta.icons?.[path] === 200) await save(stem, new URL(path, origin).href, stem);
      }
    }

    const fonts = origin ? fontUrls(dir, origin) : null;
    if (fonts === null) absent('fonts', 'not captured (no css/manifest.json in the capture; run capture.mjs first)');
    else if (fonts.length === 0) absent('fonts', 'none (no @font-face src in the captured CSS)');
    else for (const url of fonts) await save('font', url, 'fonts', { keepName: true });
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    finish();
    console.error('Stopped: the site is blocking requests. Wait a while, then run the same command again.');
    process.exit(3);
  }
  finish();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
