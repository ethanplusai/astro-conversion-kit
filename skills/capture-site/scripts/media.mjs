#!/usr/bin/env node
// Media enumeration for a finished capture: every media file the site's pages, stylesheets, REST
// media list and image sitemaps point at, checked with one paced HEAD each (GET when HEAD is
// refused, or to download). Only files on the captured site are listed.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse } from 'parse5';
import { assertNodeVersion } from './lib/node-version.mjs';
import { BLOCK_LIMIT, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, MAX_FILE_BYTES, MAX_TEXT_BYTES, pacing, POLITE_DELAY_MS, TOO_LARGE } from './lib/http.mjs';
import { cssUrls, FONT_EXTENSIONS, IMAGE_EXTENSIONS } from './lib/css-urls.mjs';
import { extensionOf } from './lib/page-rules.mjs';
import { mediaUrlsOf } from './lib/wp-rest.mjs';
import { excludedBy, parseExclude } from './lib/exclude.mjs';
import { srcsetUrls } from '../../parity-gates/scripts/lib/srcset.mjs';

export { srcsetUrls };

// Media files are many and small: more in flight than the crawl's default.
const MEDIA_CONCURRENCY = 6;

const USAGE = `Usage: node media.mjs --capture <dir> [--download <dir>] [--sizes referenced|all] [--exclude <prefix>[,...]] [--delay <ms>] [--concurrency <n>] [--polite] [--max-file-bytes <n>]

List every media file of a captured site in <capture>/media.json:
  [{ url, path, source[], referencedBy[], variants[]?, status, contentType, bytes, resized? }]
source is where it was found: html (src, data-src, icons, preloads, links to files), srcset,
css (stylesheets and style attributes), rest (the WordPress media list, every size), sitemap
(image sitemaps), og (og:image, twitter:image). referencedBy lists the pages that use it.
Entries are keyed by path: references to the same path (another query string, http or https,
www or not) are one entry, and the URL listed and requested is the bare path, with no query
string. Image hosts that resize by query (WordPress VIP, Jetpack Photon, ?w=1024, ?resize=300,200)
serve the original at the bare path, so that is what is downloaded; each query string seen is
listed under variants: [{ query, referencedBy }] and not requested (--sizes all checks and
downloads them too, with downloaded: true, saved as <path>%3F<query> under <download>-variants/,
outside the cache that is uploaded or copied into the repo). When the bare path answers an
error (4xx or 5xx; a redirect is recorded with its location and a too-large file is asked again
once the cap is raised, as for any file), a variant is downloaded in its place and the entry says downloadedFrom: <url>. A variant
with no size or transform parameter (w, h, width, height, resize, crop, fit, quality, format,
s) is a cache-buster, the same file: the first one is preferred and nothing more is marked.
Otherwise the largest (by its w, width, resize or fit width, else the first seen) is saved and
the entry also says resized: true, so the plan can say the original is unavailable.
Each file is checked with one paced HEAD request (GET when HEAD is refused), several at once.
By default (--sizes referenced) the files checked and downloaded are every original in the REST
media list and every file a page, stylesheet, srcset, og tag or sitemap references; a REST
size also counts as referenced when its file name appears anywhere in the captured pages/,
css/ or js/ files (data-thumb, data-bg, JSON settings, scripts). A size only the REST media
list names (WordPress registers several per upload) is listed with downloaded: false and
reason "unreferenced size", and never requested. When the run stops, no new attempt starts;
files in flight finish. A file that times
out, resets the connection or answers 403 after 3 tries is listed with that status (0 for a
network error, with \`error\`); three such files in a row stop the run. A file larger than
--max-file-bytes is listed with status "too-large" and not saved; a file on a host that resolves
to a loopback, private or link-local address (other than the captured site's own) is not
requested and is listed "blocked-address".

  --capture <dir>   the capture folder written by capture.mjs (reads inventory.json,
                    pages/, css/, wp-rest/media.json, sitemaps/)
  --download <dir>  also save every file that answers 200 under <dir>/<path>, byte for byte
                    (streamed to disk; a download with no data for 30 s is a network error)
  --sizes referenced|all  which REST-only image sizes and query-string variants to fetch
                    (default referenced: none; all: every registered size and every
                    variant, for when old emails or other sites may link to them)
  --exclude <prefix>[,<prefix>...]  also leave out files whose path starts with one of these
                    (repeatable); the capture's own --exclude prefixes (meta.json excluded)
                    always apply: a file under one is never listed or requested
  --max-file-bytes <n>  largest file to download or measure (default ${MAX_FILE_BYTES}, 2 GB)
  --delay <ms>      time between request starts on the site (default ${DEFAULT_DELAY_MS})
  --concurrency <n> requests in flight on the site at once (default ${MEDIA_CONCURRENCY})
  --polite          one request at a time, ${POLITE_DELAY_MS} ms apart (for shared hosts with
                    bot walls); --delay and --concurrency override it
  --ua "<string>"   user agent (default: a desktop Chrome)
  --help            show this help

Run it again after a stop: files already checked (and downloaded) are kept.
Exit codes: 0 done, 2 usage error, no capture or no page that answered 200, 3 stopped because the site is blocking
requests (wait, then run the same command again).`;

const SIZES = new Set(['referenced', 'all']);
const UNREFERENCED = 'unreferenced size';
const SOURCE_ORDER = ['html', 'srcset', 'css', 'rest', 'sitemap', 'og'];
const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS,
  'mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'zip',
]);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
const PRELOAD_AS = new Set(['image', 'font', 'video', 'audio']);
const OG_KEYS = new Set([
  'og:image', 'og:image:url', 'og:image:secure_url', 'og:video', 'og:video:url', 'og:video:secure_url',
  'og:audio', 'twitter:image', 'twitter:image:src',
]);
const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
const HEAD_REFUSED = new Set([400, 403, 405, 501]);
// After its retries, one file's network error or 403 is its answer; a 429 or 503 means the site
// wants us to stop.
const GIVE_UP = new Set([0, 403]);
const GET_TIMEOUT_MS = 120_000;
// A download is bounded by the idle timeout; this only stops one that trickles forever.
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_MIN_MS = 500;

class UsageError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');

function parseArgs(argv) {
  const args = { capture: null, download: null, sizes: 'referenced', exclude: [], delayMs: null, concurrency: null, polite: false, ua: DEFAULT_UA, maxFileBytes: MAX_FILE_BYTES, help: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--capture') args.capture = value((i += 1), arg);
    else if (arg === '--download') args.download = value((i += 1), arg);
    else if (arg === '--sizes') {
      args.sizes = value((i += 1), arg);
      if (!SIZES.has(args.sizes)) throw new UsageError(`--sizes is referenced or all, got "${args.sizes}"`);
    }
    else if (arg === '--ua') args.ua = value((i += 1), arg);
    else if (arg === '--exclude') {
      try {
        args.exclude = parseExclude([...args.exclude, value((i += 1), arg)]);
      } catch (err) {
        throw new UsageError(err.message);
      }
    } else if (arg === '--delay') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 0) throw new UsageError('--delay needs a whole number');
      args.delayMs = n;
    } else if (arg === '--concurrency') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--concurrency needs a whole number of at least 1');
      args.concurrency = n;
    } else if (arg === '--polite') args.polite = true;
    else if (arg === '--max-file-bytes') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--max-file-bytes needs a whole number of bytes');
      args.maxFileBytes = n;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!args.help && !args.capture) throw new UsageError('--capture <dir> is required');
  return { ...args, ...pacing(args, { delay: DEFAULT_DELAY_MS, inFlight: MEDIA_CONCURRENCY }) };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;

// Every media reference in one page's HTML: [{ href, source, needsExtension }]. A style
// attribute's url()s are resolved against the page.
function pageRefs(html, pageUrl) {
  const refs = [];
  const add = (href, source, needsExtension = false) => {
    if (href && !/^data:/i.test(href.trim())) refs.push({ href: href.trim(), source, needsExtension });
  };
  const walk = (node) => {
    const tag = node.tagName;
    if (tag === 'img' || tag === 'source') {
      const lazy = LAZY_SRC.map((n) => attr(node, n)).find(Boolean);
      add(lazy ?? attr(node, 'src'), 'html');
      for (const name of ['srcset', ...LAZY_SRCSET]) for (const url of srcsetUrls(attr(node, name))) add(url, 'srcset');
    } else if (tag === 'video' || tag === 'audio') {
      add(attr(node, 'src'), 'html');
      add(attr(node, 'poster'), 'html');
    } else if (tag === 'link') {
      const rels = (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rels.some((r) => ICON_RELS.has(r))) add(attr(node, 'href'), 'html');
      else if (rels.includes('preload') && PRELOAD_AS.has((attr(node, 'as') ?? '').toLowerCase())) add(attr(node, 'href'), 'html');
    } else if (tag === 'a' || tag === 'area') {
      add(attr(node, 'href'), 'html', true);
    } else if (tag === 'meta') {
      const key = (attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase();
      if (OG_KEYS.has(key)) add(attr(node, 'content'), 'og');
    }
    const style = attr(node, 'style');
    if (style) for (const url of cssUrls(`x{${style}}`, pageUrl)) add(url, 'css');
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return refs;
}

function sitemapImages(dir) {
  if (!existsSync(dir)) return [];
  const urls = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'index.json') continue; // the capture's list of sitemaps asked for, not a sitemap
    let buffer = readFileSync(join(dir, name));
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = gunzipSync(buffer, { maxOutputLength: MAX_TEXT_BYTES });
      } catch {
        continue;
      }
    }
    for (const m of buffer.toString('utf8').matchAll(/<image:loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/image:loc>/gi)) {
      urls.push(m[1].trim().replace(/&amp;/g, '&'));
    }
  }
  return urls;
}

// Every media file the capture points at, keyed by path; none under an excluded prefix (the
// capture's meta.json excluded, plus `exclude`).
export function collectMedia(captureDir, { exclude = [] } = {}) {
  const meta = existsSync(join(captureDir, 'meta.json')) ? readJson(join(captureDir, 'meta.json')) : {};
  const prefixes = [...(meta.excluded ?? []), ...exclude];
  const inventory = readJson(join(captureDir, 'inventory.json'));
  const origin = meta.canonicalOrigin ?? meta.origin ?? (inventory[0] ? new URL(inventory[0].url).origin : null);
  if (!origin) throw new UsageError(`${captureDir} has no origin in meta.json and no pages`);
  const site = new URL(origin);
  const found = new Map();

  const add = (href, base, source, page, needsExtension = false) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url) !== bareHost(site)) return;
    url.protocol = site.protocol;
    url.host = site.host;
    url.hash = '';
    if (url.pathname.endsWith('/') || excludedBy(prefixes, url.pathname)) return;
    const ext = extensionOf(url.pathname);
    if (needsExtension && !MEDIA_EXTENSIONS.has(ext)) return;
    const query = url.search.slice(1);
    url.search = '';
    const entry = found.get(url.pathname) ?? { url: url.href, path: url.pathname, source: new Set(), referencedBy: new Set(), variants: new Map() };
    found.set(url.pathname, entry);
    entry.source.add(source);
    if (page) entry.referencedBy.add(page);
    if (query) {
      const pages = entry.variants.get(query) ?? new Set();
      entry.variants.set(query, pages);
      if (page) pages.add(page);
    }
  };

  for (const record of inventory) {
    if (record.status !== 200 || !record.snapshot) continue;
    const file = join(captureDir, record.snapshot);
    if (!existsSync(file)) continue;
    const pageUrl = new URL(record.path, origin).href;
    for (const ref of pageRefs(readFileSync(file, 'utf8'), pageUrl)) {
      add(ref.href, pageUrl, ref.source, record.path, ref.needsExtension);
    }
  }

  const manifestFile = join(captureDir, 'css', 'manifest.json');
  for (const entry of existsSync(manifestFile) ? readJson(manifestFile) : []) {
    if (!entry?.file || !existsSync(join(captureDir, 'css', entry.file))) continue;
    const base = entry.finalUrl ?? entry.href ?? new URL(entry.pages?.[0] ?? '/', origin).href;
    for (const url of cssUrls(readFileSync(join(captureDir, 'css', entry.file), 'utf8'), base)) {
      for (const page of entry.pages?.length ? entry.pages : [null]) add(url, base, 'css', page);
    }
  }

  const restMedia = join(captureDir, 'wp-rest', 'media.json');
  if (existsSync(restMedia)) for (const url of mediaUrlsOf(readJson(restMedia))) add(url, origin, 'rest', null);
  for (const url of sitemapImages(join(captureDir, 'sitemaps'))) add(url, origin, 'sitemap', null);

  return [...found.values()]
    .map((e) => ({
      url: e.url,
      path: e.path,
      source: SOURCE_ORDER.filter((s) => e.source.has(s)),
      referencedBy: [...e.referencedBy].sort(),
      ...(e.variants.size ? { variants: [...e.variants].map(([query, pages]) => ({ query, referencedBy: [...pages].sort() })) } : {}),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The paths of the originals in the REST media list (each item's source_url, not its sizes).
function restOriginals(captureDir, origin) {
  const file = join(captureDir, 'wp-rest', 'media.json');
  const paths = new Set();
  if (!existsSync(file)) return paths;
  for (const item of readJson(file) ?? []) {
    try {
      paths.add(new URL(item?.source_url, origin).pathname);
    } catch {
      // no usable source_url
    }
  }
  return paths;
}

// Every file name with a media extension written anywhere in the captured pages, stylesheets and
// scripts, decoded too. Themes and plugins name sizes in places the media list does not parse
// (data-thumb, data-bg, data-lazyload, Elementor's data-settings JSON, slider scripts), so a REST
// size counts as referenced when its file name appears anywhere at all.
const NAME_IN_TEXT = new RegExp(`[^\\s"'()<>,;=\\\\/]+\\.(?:${[...MEDIA_EXTENSIONS].join('|')})(?![a-z0-9])`, 'gi');
function namesInCapture(captureDir) {
  const names = new Set();
  for (const folder of ['pages', 'css', 'js']) {
    const dir = join(captureDir, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === 'manifest.json') continue;
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      for (const [found] of readFileSync(file, 'utf8').matchAll(NAME_IN_TEXT)) {
        names.add(found.toLowerCase());
        try {
          names.add(decodeURIComponent(found).toLowerCase());
        } catch {
          // not percent-encoded
        }
      }
    }
  }
  return names;
}

const fileName = (path) => {
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
};

// A size only the REST media list names: not an original, and no page, stylesheet, script,
// srcset, og tag or sitemap mentions it (by any attribute or text, matched by file name).
const unreferencedSize = (entry, originals, names) =>
  entry.source.length === 1 && entry.source[0] === 'rest' && !originals.has(entry.path) && !names.has(fileName(entry.path));

function downloadTarget(dir, path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const root = resolve(dir);
  const target = resolve(root, `.${decoded}`);
  return target.startsWith(root + sep) ? target : null;
}

// Where --sizes all saves variants: a sibling of the download folder, so the cache that is
// uploaded or copied into the repo holds bare paths only.
const variantsDir = (dir) => `${resolve(dir)}-variants`;

// A query-string variant's cache file: <path>%3F<query>, the query kept readable but safe.
function variantTarget(dir, path, query) {
  const target = downloadTarget(variantsDir(dir), path);
  const safe = query.replace(/[^A-Za-z0-9._~=&,+-]/g, (c) => encodeURIComponent(c).replace(/[!'()*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`));
  return target ? `${target}%3F${safe}` : null;
}

// The width a resizing query asks for (w=1024, width=1024, resize=1024,683, fit=1024,683), or null.
function queryWidth(query) {
  const params = new URLSearchParams(query);
  for (const key of ['w', 'width', 'resize', 'fit']) {
    const n = Number.parseInt(params.get(key) ?? '', 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Query parameters that resize or transform an image (Photon, VIP, Cloudinary-style, Gravatar s=).
const RESIZE_KEYS = ['w', 'h', 'width', 'height', 'resize', 'crop', 'fit', 'quality', 'format', 's'];
const isResize = (query) => {
  const params = new URLSearchParams(query);
  return RESIZE_KEYS.some((key) => params.has(key));
};

// The variant to save when the original is unavailable, and whether it is a resized copy: the
// first cache-buster (the same file as the original) when there is one, else the widest
// resize, else the first seen.
export function standInVariant(variants) {
  const buster = variants.find((v) => !isResize(v.query));
  if (buster) return { variant: buster, resized: false };
  let best = null;
  for (const v of variants) {
    const width = queryWidth(v.query);
    if (width !== null && (best === null || width > best.width)) best = { variant: v, width };
  }
  return { variant: best?.variant ?? variants[0], resized: true };
}

// Only an error answer (4xx, 5xx) means the original is missing. A redirect is recorded with its
// location, and "too-large" is asked again once the cap is raised: neither gets a stand-in.
const missingOriginal = (status) => typeof status === 'number' && status >= 400 && status < 600;

const fileHolds = (file, bytes) => {
  try {
    return statSync(file).size === bytes;
  } catch {
    return false;
  }
};

async function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const captureDir = resolve(args.capture);
  if (!existsSync(join(captureDir, 'inventory.json'))) {
    console.error(`No capture in ${captureDir}: inventory.json is missing (run capture.mjs first).`);
    process.exit(2);
  }

  if (!readJson(join(captureDir, 'inventory.json')).some((r) => r.status === 200)) {
    console.error(`No page in ${join(captureDir, 'inventory.json')} answered 200: there is no media to list. Fix the capture first (capture.mjs).`);
    process.exit(2);
  }

  let media;
  try {
    media = collectMedia(captureDir, { exclude: args.exclude });
  } catch (err) {
    console.error(`Cannot read the capture in ${captureDir}: ${err.message}`);
    process.exit(2);
  }
  const outFile = join(captureDir, 'media.json');
  const earlier = new Map();
  try {
    for (const e of existsSync(outFile) ? readJson(outFile) : []) earlier.set(e.path, e);
  } catch {
    // an unreadable earlier list is simply redone
  }
  const write = () => writeFileSync(outFile, `${JSON.stringify(media, null, 2)}\n`);
  const meta = existsSync(join(captureDir, 'meta.json')) ? readJson(join(captureDir, 'meta.json')) : {};
  const trusted = [meta.origin, meta.canonicalOrigin, media[0]?.url];
  const request = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, concurrency: args.concurrency, ua: args.ua, trusted, maxBytes: args.maxFileBytes });
  const streak = new Set();
  const originals = restOriginals(captureDir, meta.canonicalOrigin ?? meta.origin ?? media[0]?.url);
  const names = args.sizes === 'referenced' ? namesInCapture(captureDir) : new Set();
  let stop = null; // the entry whose answer stops the run; files in flight are let finish

  // Checks (and downloads) one file; returns its last answer, or null when the run started
  // stopping before an attempt (the file is left for the next run).
  const check = async (url, target) => {
    let res;
    let viaGet = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (stop) return null;
      viaGet = Boolean(args.download);
      if (!viaGet) {
        res = await request(url, { method: 'HEAD' });
        const length = res.headers?.['content-length'];
        viaGet = HEAD_REFUSED.has(res.status) || (res.status === 200 && length === undefined);
      }
      if (viaGet) {
        res = await request(url, target
          ? { toFile: target, timeoutMs: DOWNLOAD_TIMEOUT_MS }
          : { discardBody: true, timeoutMs: args.download ? DOWNLOAD_TIMEOUT_MS : GET_TIMEOUT_MS });
      }
      if (!BLOCK_STATUSES.has(res.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(Math.max(RETRY_MIN_MS, args.delayMs) * 2 ** (attempt - 1));
    }
    return { res, viaGet };
  };

  // Every entry carries the fields from the start, so a stopped run lists what is left as null.
  for (const entry of media) Object.assign(entry, { status: null, contentType: null, bytes: null });
  const todo = [];
  for (const entry of media) {
    const before = earlier.get(entry.path);
    const target = args.download ? downloadTarget(args.download, entry.path) : null;
    // A file that was too large is asked again: the cap may have been raised.
    if (args.sizes === 'all') {
      for (const variant of entry.variants ?? []) {
        const vTarget = args.download ? variantTarget(args.download, entry.path, variant.query) : null;
        const was = before?.variants?.find((v) => v.query === variant.query);
        if (was?.status === 200 && (!args.download || (vTarget && fileHolds(vTarget, was.bytes)))) {
          Object.assign(variant, { status: was.status, contentType: was.contentType, bytes: was.bytes });
          if (args.download) variant.downloaded = true;
        } else todo.push({ entry, variant, target: vTarget });
      }
    }
    // An earlier answer is kept only for the same URL (an older run may have asked a variant).
    if (before && before.url === entry.url && before.status !== null && !BLOCK_STATUSES.has(before.status) && before.status !== TOO_LARGE) {
      const downloaded = !args.download || before.status !== 200 || !target || fileHolds(target, before.bytes);
      if (downloaded) {
        Object.assign(entry, { status: before.status, contentType: before.contentType, bytes: before.bytes });
        if (before.location) entry.location = before.location;
        if (before.resized) entry.resized = true;
        if (before.downloadedFrom) entry.downloadedFrom = before.downloadedFrom;
        continue;
      }
    }
    if (args.sizes === 'referenced' && unreferencedSize(entry, originals, names)) {
      Object.assign(entry, { downloaded: false, reason: UNREFERENCED });
      continue;
    }
    todo.push({ entry, target });
  }
  // Originals first, so a stop leaves variants (not originals) for the next run.
  todo.sort((a, b) => Boolean(a.variant) - Boolean(b.variant));

  // Up to --concurrency files at once (the limiter paces the host). "In a row" is the order the
  // answers come back in.
  let done = 0;
  const worker = async () => {
    while (!stop && todo.length > 0) {
      const { entry, variant, target } = todo.shift();
      const url = variant ? `${entry.url}?${variant.query}` : entry.url;
      let checked = await check(url, target);
      if (!checked) return;
      const stops = (res) => BLOCK_STATUSES.has(res.status) && !GIVE_UP.has(res.status);
      if (stops(checked.res)) {
        stop ??= entry;
        return;
      }
      // The original is not at the bare path: save a variant in its place, marked when resized.
      let fallback = null;
      if (!variant && missingOriginal(checked.res.status) && entry.variants?.length) {
        const { variant: chosen, resized } = standInVariant(entry.variants);
        const tried = await check(`${entry.url}?${chosen.query}`, target);
        if (!tried) return;
        if (stops(tried.res)) {
          stop ??= entry;
          return;
        }
        if (tried.res.status === 200) {
          const what = resized ? `the resized copy ?${chosen.query} instead (resized: true)` : `?${chosen.query} instead (a cache-busting query, not a resize)`;
          process.stderr.write(`${entry.path}: the original answered ${checked.res.status}; saved ${what}\n`);
          fallback = { downloadedFrom: `${entry.url}?${chosen.query}`, ...(resized ? { resized: true } : {}) };
          checked = tried;
        }
      }
      const { res, viaGet } = checked;
      if (BLOCK_STATUSES.has(res.status)) streak.add(url);
      else streak.clear();

      const into = variant ?? entry;
      into.status = res.status;
      into.contentType = res.headers?.['content-type'] ?? null;
      const length = Number(res.headers?.['content-length']);
      into.bytes = typeof res.status !== 'number' || res.status === 0 ? null : viaGet ? res.bytes : Number.isFinite(length) ? length : null;
      if (res.status === 0 || typeof res.status !== 'number') into.error = res.error ?? 'network error';
      if (res.status >= 300 && res.status < 400 && res.headers?.location) {
        into.location = new URL(res.headers.location, url).href;
      }
      if (fallback) Object.assign(entry, fallback);
      if (variant && args.download && res.status === 200) variant.downloaded = true;
      if (streak.size >= BLOCK_LIMIT) stop ??= entry;
      done += 1;
      // Save progress now and then, so a run that is killed resumes without asking again.
      if (done % 100 === 0) write();
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(1, todo.length)) }, worker));
  if (stop) {
    write();
    console.error(
      `Stopped: ${new URL(stop.url).origin} is blocking requests or cannot be reached. Wait a while, then run the same command again; files already checked are kept.`,
    );
    process.exit(3);
  }

  write();
  const ok = media.filter((m) => m.status === 200);
  const bytes = ok.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  const saved = args.download ? `, saved under ${resolve(args.download)}` : '';
  const listedOnly = media.filter((m) => m.downloaded === false).length;
  const checked = media.length - listedOnly;
  const count = (n) => n.toLocaleString('en-US');
  console.log(`${count(checked)} originals + referenced sizes (${args.download ? 'downloaded' : 'checked'}), ${count(listedOnly)} unreferenced ${listedOnly === 1 ? 'size' : 'sizes'} (listed only)`);
  const varied = media.filter((m) => m.variants?.length);
  if (varied.length) {
    const n = varied.reduce((sum, m) => sum + m.variants.length, 0);
    const how = args.sizes !== 'all' ? 'listed only' : args.download ? 'downloaded' : 'checked';
    console.log(`${count(n)} query-string ${n === 1 ? 'variant' : 'variants'} of ${count(varied.length)} ${varied.length === 1 ? 'file' : 'files'} (${how})`);
    if (how === 'downloaded') console.log(`Variants saved under ${variantsDir(args.download)} (not part of the media cache).`);
  }
  const resized = media.filter((m) => m.resized).length;
  if (resized) {
    console.log(`${count(resized)} ${resized === 1 ? 'original' : 'originals'} unavailable (resized: true): a resized copy was saved in ${resized === 1 ? 'its' : 'their'} place`);
  }
  console.log(`Listed ${media.length} media files (${checked - ok.length} not 200, ${bytes} bytes) in ${outFile}${saved}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
