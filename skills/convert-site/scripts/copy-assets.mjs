#!/usr/bin/env node
// Copy the captured files the build serves from public/ at their live paths: the site's own
// scripts, the fonts, the root icons, the web manifest and the media outside the media prefix.
// Pure: reads the capture and the media download, writes under <site>/public/. Idempotent.
// Exit codes: 0 copied, 1 a listed file is missing, 2 usage or input error.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { excludedBy } from './lib/excluded.mjs';

const HELP = `Usage: node copy-assets.mjs --capture capture --site . [--media-cache <dir>] [--plan <file>]

Copies to <site>/public/, each at its live path:
  scripts     every file in <capture>/js/manifest.json that the capture saved (every kind:
              classic, module, import map, modulepreload). A query-concatenated URL
              (WordPress VIP's /_static/??a.js,b.js) is written to /_static/concat/<sha1>.js,
              the sha1 of its root-relative URL, and public/_static/concat/manifest.json maps
              each such URL to its file: point the markup at it (a decision row) and pass
              --allow-extra '/_static/concat/*' to the routes gate
  fonts       every "font" entry of <capture>/assets/index.json (files under assets/fonts/):
              a font on the site's host at its path, one from a font service under /fonts/
  root icons  every "root-icon" entry with a file, at its path (/favicon.ico, ...)
  manifest    the "manifest" entry (the web manifest), at its path
  media       every file in the media download that is outside the media plan's prefix
              (mode store or live-temporary: the store or the rewrite serves the prefix);
              in mode repo, every file
Prints a count per kind. Running it again rewrites the same files.

  --capture <dir>      the capture folder (default: capture)
  --site <dir>         the site repository (default: .)
  --media-cache <dir>  where media.mjs --download saved the media
                       (default: <site>/.conversion/media-cache)
  --plan <file>        the media plan with mode and prefix (default: <site>/docs/media-plan.json,
                       else <site>/.conversion/media-plan.json); needed when media was downloaded
  --help               show this help

Nothing under a prefix the capture excluded (meta.json excluded) is copied. A file the capture
names outside the capture folder (a manifest "file" such as ../../.env) is refused.

Exit codes: 0 copied, 1 a file the capture lists is missing or refused (the others are still
copied), 2 usage error or unreadable input.`;

class UsageError extends Error {}

const readJson = (file, fallback) => {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`${file}: not valid JSON (${err.message})`);
  }
};

const bareHost = (host) => host.toLowerCase().replace(/^www\./, '');

function decode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// The file under public/ for a live path, or null when the path would leave public/.
function publicTarget(pub, livePath) {
  const target = resolve(pub, `.${decode(livePath)}`);
  return target.startsWith(pub + sep) ? target : null;
}

// The root-relative URL a concatenation is known by: path and query as written.
export const concatKey = (url) => `${url.pathname}${url.search}`;
export const concatPath = (key) => `/_static/concat/${createHash('sha1').update(key).digest('hex')}.js`;
const isConcat = (url) => url.search.startsWith('??');

function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.endsWith('.part'))
    .map((d) => join(d.parentPath, d.name));
}

function mediaPlan(site, planFile) {
  const candidates = planFile ? [planFile] : [join(site, 'docs', 'media-plan.json'), join(site, '.conversion', 'media-plan.json')];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return null;
  const plan = readJson(file);
  if (!plan || typeof plan.mode !== 'string' || (plan.mode !== 'repo' && typeof plan.prefix !== 'string')) {
    throw new UsageError(`${file}: no mode and prefix (write it with media-plan.mjs)`);
  }
  return plan;
}

export function copyAssets({ capture, site, mediaCache, plan: planFile }) {
  const pub = resolve(site, 'public');
  const meta = readJson(join(capture, 'meta.json'), {});
  const siteOrigin = meta.canonicalOrigin ?? meta.origin ?? null;
  const siteHost = siteOrigin ? bareHost(new URL(siteOrigin).host) : null;
  const counts = { scripts: 0, concat: 0, fonts: 0, rootIcons: 0, manifest: 0, media: 0, excluded: 0 };
  const missing = [];
  const skipped = [];
  const refused = [];
  const excluded = meta.excluded ?? [];

  // Copies source (which must lie inside root) to public/ at livePath, unless livePath is under a
  // prefix the capture excluded (an old download may still hold such files).
  const put = (source, livePath, what, root = capture, sitePath = livePath) => {
    if (excludedBy(excluded, sitePath)) {
      counts.excluded += 1;
      return false;
    }
    const full = resolve(source);
    if (!full.startsWith(resolve(root) + sep)) {
      refused.push(`${what} ${source}: outside ${root}`);
      return false;
    }
    if (!existsSync(full)) {
      missing.push(`${what} ${relative(process.cwd(), source) || source}`);
      return false;
    }
    const target = publicTarget(pub, livePath);
    if (!target) {
      skipped.push(`${what} ${livePath}: the path leaves public/`);
      return false;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    return true;
  };

  const scripts = readJson(join(capture, 'js', 'manifest.json'), []);
  const concat = readJson(join(pub, '_static', 'concat', 'manifest.json'), {});
  for (const entry of scripts) {
    if (!entry?.file || !entry.src) continue;
    const url = new URL(entry.src);
    const source = join(capture, 'js', entry.file);
    if (isConcat(url)) {
      const key = concatKey(url);
      if (put(source, concatPath(key), `script ${entry.src}:`, capture, url.pathname)) {
        concat[key] = concatPath(key);
        counts.scripts += 1;
        counts.concat += 1;
      }
    } else if (put(source, url.pathname, `script ${entry.src}:`)) counts.scripts += 1;
  }
  if (counts.concat) {
    mkdirSync(join(pub, '_static', 'concat'), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(concat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(join(pub, '_static', 'concat', 'manifest.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  }

  for (const entry of readJson(join(capture, 'assets', 'index.json'), [])) {
    if (!entry?.file) continue;
    const source = join(capture, entry.file);
    if (entry.kind === 'font') {
      const url = new URL(entry.url);
      const live = siteHost && bareHost(url.host) === siteHost ? url.pathname : `/fonts/${basename(entry.file)}`;
      if (put(source, live, `font ${entry.url}:`)) counts.fonts += 1;
    } else if (entry.kind === 'root-icon' && entry.path) {
      if (put(source, entry.path, `root icon ${entry.path}:`)) counts.rootIcons += 1;
    } else if (entry.kind === 'manifest' && entry.url) {
      const url = new URL(entry.url);
      if (siteHost && bareHost(url.host) !== siteHost) skipped.push(`manifest ${entry.url}: on another host, left as linked`);
      else if (put(source, url.pathname, `manifest ${entry.url}:`)) counts.manifest += 1;
    }
  }

  const cache = resolve(mediaCache ?? join(site, '.conversion', 'media-cache'));
  let plan = null;
  if (existsSync(cache)) {
    plan = mediaPlan(site, planFile);
    if (!plan) throw new UsageError(`media was downloaded to ${cache} but no media plan was found (docs/media-plan.json or .conversion/media-plan.json; pass --plan)`);
    const prefix = plan.mode === 'repo' ? null : `/${decode(plan.prefix).replace(/^\/+|\/+$/g, '')}/`;
    for (const file of walk(cache)) {
      const livePath = `/${relative(cache, file).split(sep).join('/')}`;
      if (prefix && excludedBy([prefix], livePath)) continue;
      if (put(file, livePath, 'media', cache)) counts.media += 1;
    }
  }
  return { counts, missing, skipped, refused, plan, excluded };
}

function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        capture: { type: 'string', default: 'capture' },
        site: { type: 'string', default: '.' },
        'media-cache': { type: 'string' },
        plan: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  const capture = resolve(values.capture);
  if (!existsSync(capture)) throw new UsageError(`${capture}: capture folder not found`);
  if (values.plan && !existsSync(values.plan)) throw new UsageError(`${values.plan}: media plan not found`);
  return { capture, site: resolve(values.site), mediaCache: values['media-cache'], plan: values.plan ? resolve(values.plan) : undefined };
}

function main() {
  assertNodeVersion();
  let result;
  try {
    const opts = options(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    result = copyAssets(opts);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`copy-assets: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  const { counts, missing, skipped, refused, plan } = result;
  console.log(`scripts: ${counts.scripts} (${counts.concat} concatenated)`);
  console.log(`fonts: ${counts.fonts}`);
  console.log(`root icons: ${counts.rootIcons}`);
  console.log(`manifest: ${counts.manifest}`);
  if (!plan) console.log('media: 0 (no media download)');
  else if (plan.mode === 'repo') console.log(`media (repo mode, every file): ${counts.media}`);
  else console.log(`media outside ${plan.prefix}: ${counts.media}`);
  if (counts.excluded) console.log(`excluded: ${counts.excluded} (under a prefix the capture left out: ${(result.excluded ?? []).join(', ')})`);
  for (const line of skipped) console.log(`skipped ${line}`);
  for (const line of missing) console.error(`missing: ${line}`);
  for (const line of refused) console.error(`refused: ${line}`);
  process.exitCode = missing.length || refused.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
