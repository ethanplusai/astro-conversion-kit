#!/usr/bin/env node
// Upload the media cache to an object store, verify every object by HEAD, and
// keep a resumable manifest of what is safely stored.
// Exit codes: 0 all uploaded and verified, 1 an upload or verification failed,
// 2 usage or environment error (including missing credentials).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { createBlobStore, BLOB_ENV, BLOB_ENDPOINT } from './lib/stores/blob.mjs';
import { createR2Store, R2_ENV } from './lib/stores/r2.mjs';

const HELP = `Usage: node media-upload.mjs --store blob|r2 --dir <cache> --manifest media-manifest.json
                            --prefix /wp-content/uploads/ [--media capture/media.json]
                            [--endpoint <url>] [--concurrency <n>]

Uploads every file under <cache><prefix> (the cache mirrors site paths, so
<cache>/wp-content/uploads/2026/01/a.jpg is the site path
/wp-content/uploads/2026/01/a.jpg and the object key wp-content/uploads/2026/01/a.jpg).
Each upload is checked with a HEAD whose content-length must match the file.
PUT and HEAD are retried twice (after 1 s, then 2 s) on 429 and 5xx.
The manifest ([{ path, bytes, url, etag }]) is saved every 50 uploads and at
the end; files already in it with the same size are skipped, so a rerun resumes.
url is the object's public address on blob, and on r2 the site path the R2 media
function serves (the bucket itself stays private).
With --media, each file's content type comes from the captured media list;
otherwise it is looked up from the file extension.
--concurrency uploads that many files at once (default 1, at most 32); the store's
429 answers are retried as above.

Credentials come from the environment:
  blob: BLOB_READ_WRITE_TOKEN
  r2:   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
--endpoint overrides the API base (default ${BLOB_ENDPOINT} for blob,
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com for r2).

Exit codes: 0 done, 1 an upload or verification failed, 2 usage or missing credentials.`;

const SAVE_EVERY = 50;

const STORES = {
  blob: { env: BLOB_ENV, create: createBlobStore },
  r2: { env: R2_ENV, create: createR2Store },
};

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function usage(message) {
  console.error(`media-upload: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else usage(`unexpected argument "${arg}"`);
  }
  return opts;
}

function readJsonArray(file, what) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('not a JSON array');
    return data;
  } catch (err) {
    return usage(`cannot read ${what} ${file}: ${err.message}`);
  }
}

// Temp file plus rename, so an interrupted run never leaves a half-written manifest.
function writeManifest(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmp, file);
}

async function main() {
  assertNodeVersion();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  for (const name of ['store', 'dir', 'manifest', 'prefix']) if (!opts[name]) usage(`--${name} is required (see --help)`);
  const concurrency = opts.concurrency === undefined ? 1 : Number(opts.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) usage('--concurrency needs a whole number from 1 to 32');
  const kind = STORES[opts.store];
  if (!kind) usage(`--store must be blob or r2, got "${opts.store}"`);

  const missing = kind.env.filter((name) => !process.env[name]);
  if (missing.length) {
    usage(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; export ${missing.length === 1 ? 'it' : 'them'} and run again.`);
  }

  const prefix = `/${opts.prefix.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const root = join(opts.dir, prefix);
  if (!existsSync(root) || !statSync(root).isDirectory()) usage(`no media folder at ${root}`);

  const capturedTypes = new Map(
    opts.media
      ? readJsonArray(opts.media, 'media list')
          .filter((e) => e.status === 200 && e.path && e.contentType)
          .map((e) => [e.path, e.contentType])
      : [],
  );
  const done = new Map(
    (existsSync(opts.manifest) ? readJsonArray(opts.manifest, 'manifest') : []).map((e) => [e.path, e]),
  );
  const save = () => writeManifest(opts.manifest, [...done.values()]);

  const store = kind.create({ env: process.env, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  // One file: skipped when the manifest already holds it at this size.
  const uploadOne = async (file) => {
    const sitePath = `/${relative(opts.dir, file).split(sep).join('/')}`;
    const size = statSync(file).size;
    if (done.get(sitePath)?.bytes === size) {
      skipped += 1;
      return;
    }
    try {
      const body = readFileSync(file);
      const put = await store.put(sitePath.slice(1), body, capturedTypes.get(sitePath) ?? contentTypeFor(file));
      const head = await store.head(put.url);
      if (head.bytes !== body.length) {
        throw new Error(`size mismatch for ${sitePath}: local ${body.length} bytes, store reports ${head.bytes}`);
      }
      done.set(sitePath, { path: sitePath, bytes: body.length, url: put.url, etag: head.etag ?? put.etag ?? null });
      uploaded += 1;
      if (uploaded % SAVE_EVERY === 0) save();
      console.log(`uploaded ${sitePath} (${body.length} bytes)`);
    } catch (err) {
      failed += 1;
      console.error(`failed ${sitePath}: ${err.message}`);
    }
  };

  const files = walk(root);
  let next = 0;
  const worker = async () => {
    while (next < files.length) await uploadOne(files[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  save();
  console.log(`media-upload (${opts.store}): uploaded ${uploaded}, skipped ${skipped}, failed ${failed}; manifest ${opts.manifest}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`media-upload: ${err.message}`);
    process.exit(1);
  });
}
