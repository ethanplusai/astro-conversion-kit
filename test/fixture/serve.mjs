// Fixture server: a static imitation of a WordPress site for tests.
// startFixture({ port, blockAfter, delayMs, pathDelays, root, alwaysStatus, challenge })
//   -> { origin, requests, stats, close() }
// pathDelays maps a path to the delay in ms its answers take (instead of delayMs);
// stats.maxInFlight is the most requests the server held open at once (stats.reset() starts over);
// challenge: 'siteground' | 'cloudflare' answers every request with that host's bot challenge
// (SiteGround: a 202 page refreshing to /.well-known/sgcaptcha/; Cloudflare: a 403 "Just a
// moment..." page with cf-mitigated: challenge);
// alwaysStatus maps a path to the status it answers on every request, e.g. { '/flaky/': 503 };
// root serves pages and assets from another copy of site/ (wp-json and redirects stay the fixture's);
// `requests` lists every request URL in order.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, 'site');
const REDIRECTS = JSON.parse(readFileSync(join(HERE, 'redirects.json'), 'utf8'));
const WP_JSON_TYPES = ['pages', 'posts', 'media', 'categories', 'tags'];
const ORIGIN_PLACEHOLDER = /\{\{ORIGIN\}\}/g;
const SITE_NAME = 'Fixture Roofing & Siding';
const SITE_DESCRIPTION = 'Roofing and siding contractors';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8',
  '.txt': 'text/plain; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg']);

function readWpJson(type) {
  return JSON.parse(readFileSync(join(SITE, 'wp-json', 'wp', 'v2', `${type}.json`), 'utf8'));
}

// Every page and post id, for ?p=<id> shortlinks.
const SHORTLINKS = new Map(
  ['pages', 'posts'].flatMap((type) => readWpJson(type).map((item) => [String(item.id), item.link])),
);

function resolveFile(pathname, site) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(site, `.${decoded}`);
  if (target !== site && !target.startsWith(site + sep)) return null;
  const candidates = decoded.endsWith('/')
    ? [join(target, 'index.html'), join(target, 'index.xml')]
    : [target];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function contentTypeFor(file) {
  if (file.endsWith(`${sep}feed${sep}index.xml`)) return 'application/rss+xml; charset=UTF-8';
  return CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
}

function body(file, origin) {
  const buffer = readFileSync(file);
  if (!TEXT_EXTENSIONS.has(extname(file))) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(ORIGIN_PLACEHOLDER, origin));
}

function wpJson(type, searchParams, origin) {
  const items = JSON.parse(JSON.stringify(readWpJson(type)).replace(ORIGIN_PLACEHOLDER, origin));
  const perPage = Number(searchParams.get('per_page') ?? 10);
  const page = Number(searchParams.get('page') ?? 1);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    return { status: 400, headers: {}, json: { code: 'rest_invalid_param', message: 'Invalid parameter(s): per_page', data: { status: 400 } } };
  }
  const totalPages = Math.ceil(items.length / perPage);
  if (!Number.isInteger(page) || page < 1 || (page > totalPages && items.length > 0)) {
    return { status: 400, headers: {}, json: { code: 'rest_post_invalid_page_number', message: 'The page number requested is larger than the number of pages available.', data: { status: 400 } } };
  }
  return {
    status: 200,
    headers: { 'X-WP-Total': String(items.length), 'X-WP-TotalPages': String(totalPages) },
    json: items.slice((page - 1) * perPage, page * perPage),
  };
}

function route(req, origin, site) {
  const url = new URL(req.url, origin);
  const { pathname, searchParams } = url;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, body: 'Method Not Allowed' };
  }

  const redirect = REDIRECTS.find((rule) => rule.from === pathname);
  if (redirect) {
    const location = new URL(redirect.to, origin);
    location.search = url.search;
    return { status: redirect.status, headers: { Location: location.href }, body: '' };
  }

  if (pathname === '/' && searchParams.has('p')) {
    const link = SHORTLINKS.get(searchParams.get('p'));
    if (!link) return notFound(origin, site);
    return { status: 301, headers: { Location: link.replace(ORIGIN_PLACEHOLDER, origin) }, body: '' };
  }

  if (pathname === '/wp-json/' || pathname === '/wp-json') {
    const index = { name: SITE_NAME, description: SITE_DESCRIPTION, url: origin, home: origin, namespaces: ['wp/v2'] };
    return { status: 200, headers: { 'Content-Type': CONTENT_TYPES['.json'] }, body: JSON.stringify(index) };
  }

  const wpMatch = pathname.match(/^\/wp-json\/wp\/v2\/([a-z]+)\/?$/);
  if (wpMatch && WP_JSON_TYPES.includes(wpMatch[1])) {
    const result = wpJson(wpMatch[1], searchParams, origin);
    return {
      status: result.status,
      headers: { ...result.headers, 'Content-Type': CONTENT_TYPES['.json'] },
      body: JSON.stringify(result.json),
    };
  }

  const file = resolveFile(pathname, site);
  if (file && !file.startsWith(join(site, 'wp-json') + sep)) {
    return { status: 200, headers: { 'Content-Type': contentTypeFor(file) }, body: body(file, origin) };
  }

  return notFound(origin, site);
}

function notFound(origin, site) {
  const file = join(site, '404.html');
  return { status: 404, headers: { 'Content-Type': contentTypeFor(file) }, body: body(file, origin) };
}

// What each host answers a client it wants to check, on every request.
const CHALLENGES = {
  siteground: (req) => ({
    status: 202,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    body: `<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=${encodeURIComponent(req.url)}"></meta></head></html>`,
  }),
  cloudflare: () => ({
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
    body: '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><noscript>Enable JavaScript and cookies to continue</noscript>'
      + '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=fixture"></script></body></html>',
  }),
};

function respond(req, origin, site) {
  try {
    return route(req, origin, site);
  } catch (err) {
    return { status: 500, headers: { 'Content-Type': 'text/plain' }, body: `Internal Server Error: ${err.message}` };
  }
}

export function startFixture({ port = 0, blockAfter = Infinity, delayMs = 0, pathDelays = {}, root = SITE, alwaysStatus = {}, challenge = null } = {}) {
  if (challenge && !CHALLENGES[challenge]) throw new Error(`unknown challenge ${challenge}`);
  const site = resolve(root);
  let requests = 0;
  const log = [];
  let inFlight = 0;
  const stats = {
    maxInFlight: 0,
    reset() {
      stats.maxInFlight = inFlight;
    },
  };
  const server = createServer((req, res) => {
    requests += 1;
    log.push(req.url);
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    res.once('close', () => {
      inFlight -= 1;
    });
    const blocked = requests > blockAfter;
    const wait = pathDelays[req.url.split('?')[0]] ?? delayMs;
    setTimeout(() => {
      const origin = `http://${req.headers.host ?? `127.0.0.1:${server.address().port}`}`;
      const fixed = alwaysStatus[new URL(req.url, origin).pathname];
      const response = blocked
        ? { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'text/plain' }, body: 'Too Many Requests' }
        : challenge
          ? CHALLENGES[challenge](req)
          : fixed
            ? { status: fixed, headers: { 'Content-Type': 'text/plain' }, body: `Status ${fixed}` }
            : respond(req, origin, site);
      const payload = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
      res.writeHead(response.status, { ...response.headers, 'Content-Length': payload.length });
      res.end(req.method === 'HEAD' ? undefined : payload);
    }, wait);
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolveStart({
        origin,
        requests: log,
        stats,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
