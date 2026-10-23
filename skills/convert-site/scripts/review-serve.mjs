#!/usr/bin/env node
// Serve a built site's dist/ for the local visual review, applying vercel.json the way the staging
// host does: redirects, then the files, then rewrites, a rewrite to another origin proxied.
// Exit codes: 0 served and stopped (or --stop done), 2 usage or environment error (port in use).
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { cloudflareRoutes, routes } from './lib/review-routes.mjs';
import { contentTypeFor } from './media-upload.mjs';

const HELP = `Usage: node review-serve.mjs [--dir <site>] [--port 4321] [--background | --stop]

Serves <site>/dist/ at http://localhost:<port> for the review:* steps and applies <site>/vercel.json
the way the staging host does: redirects first (with their status codes), then the files in dist/
(/path/ serves path/index.html; a miss serves dist/404.html with status 404), then rewrites in
order. A rewrite to another origin (media left on the live site in live-temporary mode, an
importmap target) is proxied: GET and HEAD only, same path and query, the response streamed with
its cache-control, no cookies either way. A rewrite to a local path serves that file from dist/.
With no vercel.json, dist/_redirects (Cloudflare Pages) applies instead, first matching line
wins: "source destination [status]" with * and :name, 301/302/303/307/308 redirect (302 when no
status), 200 rewrites or proxies; any other line is skipped with a warning on stderr. Either
file is re-read when it changes, so a rebuild or a new rewrite needs no restart.

Use it instead of astro preview whenever media or scripts are not in dist/: astro preview ignores
vercel.json, so every rewritten image would 404 and every pixel diff would fail.

Options:
  --dir <site>     the site repository (default: the current directory)
  --port <n>       port to listen on (default 4321); a port another process holds exits 2
  --background     start detached, write .conversion/review-serve.pid, wait until it answers
  --stop           stop the background server named in .conversion/review-serve.pid
  --help           show this help

Exit codes: 0 served (or stopped), 2 usage or environment error.`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.xsl': 'application/xml; charset=utf-8',
  '.rss': 'application/rss+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
};
// Response headers a proxied answer keeps. Set-Cookie is never among them.
const PASS_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'expires', 'content-range', 'accept-ranges'];
// Request headers a proxied request carries. Cookie is never among them.
const FORWARD_HEADERS = ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'user-agent'];
const PID_FILE = join('.conversion', 'review-serve.pid');
const LOG_FILE = join('.conversion', 'review-serve.log');

class UsageError extends Error {}

const typeOf = (file) => TYPES[extname(file).toLowerCase()] ?? contentTypeFor(file);

function options(argv) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string', default: '.' },
        port: { type: 'string', default: '4321' },
        background: { type: 'boolean', default: false },
        stop: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return values;
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new UsageError(`--port must be a port number, got "${values.port}"`);
  }
  if (values.background && values.stop) throw new UsageError('--background and --stop do not go together');
  return { ...values, dir: resolve(values.dir), port: Number(values.port) };
}

function readConfig(dir) {
  const file = join(dir, 'vercel.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.message}`);
  }
}

// The file in dist/ that answers a path, or null. Never a file outside dist/.
export function distFile(dist, path, { cleanUrls = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const bare = rel.replace(/\/+$/, '');
  const candidates = rel === '' ? ['index.html']
    : rel.endsWith('/') ? [`${bare}/index.html`]
      : [bare, ...(cleanUrls ? [`${bare}.html`] : []), `${bare}/index.html`];
  for (const candidate of candidates) {
    const full = resolve(dist, candidate);
    if (full !== dist && !full.startsWith(dist + sep)) return null;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

function sendFile(req, res, file, status = 200) {
  const size = statSync(file).size;
  res.writeHead(status, { 'Content-Type': typeOf(file), 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function notFound(req, res, dist) {
  const page = join(dist, '404.html');
  if (existsSync(page)) return sendFile(req, res, page, 404);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : 'Not found\n');
}

async function proxy(req, res, destination) {
  const headers = { 'accept-encoding': 'identity' };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  let upstream;
  try {
    upstream = await fetch(destination, { method: req.method, headers, redirect: 'follow' });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`review-serve: could not reach ${destination}: ${err.cause?.message ?? err.message}\n`);
    return;
  }
  const out = {};
  // fetch has decoded a compressed body, so the upstream length no longer matches it.
  const decoded = upstream.headers.has('content-encoding');
  for (const name of PASS_HEADERS) {
    if (decoded && name === 'content-length') continue;
    const value = upstream.headers.get(name);
    if (value !== null) out[name] = value;
  }
  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

// A file's change stamp, or null when it is absent.
function stamp(file) {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

// The routing table: vercel.json when the site has one, else dist/_redirects (Cloudflare Pages),
// else none. Re-read whenever either file changes, so redirects:build, a new media rewrite or a
// rebuild takes effect without a restart.
function routeTable(dir, dist) {
  const vercelFile = join(dir, 'vercel.json');
  const redirectsFile = join(dist, '_redirects');
  let key;
  let current;
  return () => {
    const next = `${stamp(vercelFile)}|${stamp(redirectsFile)}`;
    if (next === key) return current;
    if (existsSync(vercelFile)) {
      const config = readConfig(dir);
      current = { table: routes(config), cleanUrls: config.cleanUrls === true };
    } else if (existsSync(redirectsFile)) {
      const warn = (n, line) => console.error(`review-serve: dist/_redirects line ${n} not understood, skipped: ${line}`);
      current = { table: cloudflareRoutes(readFileSync(redirectsFile, 'utf8'), warn), cleanUrls: false };
    } else current = { table: routes({}), cleanUrls: false };
    key = next;
    return current;
  };
}

export function handler({ dir }) {
  const dist = join(dir, 'dist');
  const currentRoutes = routeTable(dir, dist);
  currentRoutes();
  return async (req, res) => {
    let table;
    let cleanUrls;
    try {
      ({ table, cleanUrls } = currentRoutes());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`review-serve: ${err.message}\n`);
    }
    const url = new URL(req.url, 'http://localhost');
    const { pathname: path, search } = url;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('review-serve answers GET and HEAD only\n');
    }
    const redirect = table.redirect(path, search);
    if (redirect) {
      res.writeHead(redirect.status, { Location: redirect.location });
      return res.end();
    }
    const file = distFile(dist, path, { cleanUrls });
    if (file) return sendFile(req, res, file);
    const rewrite = table.rewrite(path, search);
    if (rewrite?.external) return proxy(req, res, rewrite.destination);
    if (rewrite) {
      const target = distFile(dist, rewrite.destination.split('?')[0], { cleanUrls });
      if (target) return sendFile(req, res, target);
    }
    return notFound(req, res, dist);
  };
}

// Who listens on the port, best effort: { pid, command } or null when nothing does.
function lsofListener(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const pid = /^p(\d+)$/m.exec(out)?.[1];
    const command = /^c(.+)$/m.exec(out)?.[1];
    return pid ? { pid: Number(pid), command: command ?? 'unknown command' } : null;
  } catch {
    return null;
  }
}

function answers(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (yes) => {
      socket.destroy();
      done(yes);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Something already accepting on IPv4 or IPv6 localhost, or listed by lsof on any interface.
async function portHolder(port) {
  const listener = lsofListener(port);
  if (listener) return listener;
  if ((await answers('127.0.0.1', port)) || (await answers('::1', port))) return { pid: 'unknown', command: 'unknown command' };
  return null;
}

const inUse = (port, holder) =>
  new UsageError(`port ${port} is in use by another process (pid ${holder.pid}, ${holder.command}); pass --port`);

async function serveForeground({ dir, port }) {
  const dist = join(dir, 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new UsageError(`no dist/ in ${dir}: run npm run build first`);
  const holder = await portHolder(port);
  if (holder) throw inUse(port, holder);
  const server = createServer(handler({ dir }));
  await new Promise((done, fail) => {
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') fail(inUse(port, lsofListener(port) ?? { pid: 'unknown', command: 'unknown command' }));
      else fail(new UsageError(`cannot listen on port ${port}: ${err.message}`));
    });
    server.listen(port, done);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(`review-serve: serving ${dist} at http://localhost:${port}`);
}

async function startBackground({ dir, port }) {
  mkdirSync(join(dir, '.conversion'), { recursive: true });
  const logPath = join(dir, LOG_FILE);
  const log = openSync(logPath, 'w');
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--dir', dir, '--port', String(port)], {
    detached: true, stdio: ['ignore', log, log],
  });
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 1; });
  for (let i = 0; i < 150; i += 1) {
    if (exited !== null) {
      process.stderr.write(readFileSync(logPath, 'utf8'));
      process.exit(exited === 0 ? 2 : exited);
    }
    if (/ at http:\/\/localhost:\d+/.test(readFileSync(logPath, 'utf8'))) {
      writeFileSync(join(dir, PID_FILE), `${child.pid}\n`);
      child.unref();
      console.log(`review-serve: running in the background (pid ${child.pid}) at http://localhost:${port}; stop it with --stop`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  throw new UsageError(`the server did not start in 30 s; see ${logPath}`);
}

// The command line of a running pid, or null when no such process runs.
function commandOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

async function stopBackground({ dir }) {
  const pidFile = join(dir, PID_FILE);
  if (!existsSync(pidFile)) {
    console.log('review-serve: not running (no .conversion/review-serve.pid)');
    return;
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  rmSync(pidFile, { force: true });
  const command = commandOf(pid);
  if (command === null) {
    console.log(`review-serve: not running (pid ${pid} had already exited)`);
    return;
  }
  if (!command.includes('review-serve.mjs')) {
    console.log(`review-serve: pid file is stale (pid ${pid} is not review-serve: ${command}); removed it`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.log(`review-serve: not running (pid ${pid} had already exited)`);
    return;
  }
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      console.log(`review-serve: stopped (pid ${pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UsageError(`pid ${pid} did not exit after SIGTERM`);
}

async function main() {
  assertNodeVersion();
  try {
    const opts = options(process.argv.slice(2));
    if (opts.help) return console.log(HELP);
    if (opts.stop) await stopBackground(opts);
    else if (opts.background) await startBackground(opts);
    else await serveForeground(opts);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`review-serve: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
