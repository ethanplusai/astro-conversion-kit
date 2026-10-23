#!/usr/bin/env node
// Scaffold a new Astro site repository from the kit's templates and copy in the kit's scripts.
// Exit 0 success, 2 usage or environment error (including a non-empty target directory).
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node init-site.mjs --dir <path> --origin <url> --name "<site name>"
                         --host vercel|cloudflare [options]

Creates <path> (or fills it when it holds nothing but .git, .gitignore, a README, capture/ and
.conversion/: the capture and the run state are kept and committed with the scaffold), copies the site
templates with placeholders filled in, copies the kit's gate, review and conversion scripts into
scripts/, writes package.json, makes the first commit on main and switches to astro-rebuild.

Options:
  --dir <path>              target directory (required)
  --origin <url>            live site origin, e.g. https://www.example.com (required)
  --name <name>             site name (required)
  --host vercel|cloudflare  hosting target (required)
  --trailing-slash <mode>   always (default) or never: the majority form of live URLs
  --repo <git url>          add as remote "origin" when none is set
  --kit <dir>               kit root to copy from (default: this script's kit)
  --astro-version <ver>     astro version to pin (default: latest 7.x from npm)
  --no-install              skip npm install
  --help                    show this help

Exit codes: 0 scaffolded, 2 usage or environment error (a non-empty directory is refused).`;

const HOSTS = {
  vercel: {
    redirectsOut: 'vercel.json',
    skip: ['public/_headers'],
    deployPreview: 'npx vercel deploy',
    deployProduction: 'npx vercel deploy --prod',
    envCommand: '`npx vercel env add PUBLIC_INDEXABLE production` (value `true`).',
    dnsNote: 'add the domain with `npx vercel domains add <domain>` and set the records it prints.',
  },
  cloudflare: {
    redirectsOut: 'public/_redirects',
    skip: ['vercel.json', '.vercelignore'],
    // wrangler uploads the local dist/, so the flag belongs on the local build, never in the dashboard.
    deployPreview: 'npm run build && npx wrangler pages deploy dist --branch astro-rebuild',
    deployProduction: 'PUBLIC_INDEXABLE=true npm run build && npx wrangler pages deploy dist --branch main',
    envCommand:
      'set it on the local build that is deployed (`PUBLIC_INDEXABLE=true npm run build`), not in the ' +
      'Pages dashboard; every preview deploy is rebuilt with a plain `npm run build` first.',
    dnsNote: 'add the custom domain in the Pages project and set the records it shows.',
  },
};

const TRAILING = { always: 'directory', never: 'file' };
// A run captures and plans before the scaffold exists, so its capture/ and .conversion/ may be here.
const ALLOWED_EXISTING = new Set(['.git', '.gitignore', 'README.md', 'README', '.DS_Store', 'capture', '.conversion']);
// Template files appended to an existing file of the same name instead of replacing it.
const APPEND_TO_EXISTING = new Set(['README.md', '.gitignore']);
const CONVERT_SCRIPTS = ['css-coverage', 'css-prune', 'media-plan', 'media-upload', 'review-serve', 'state'];
const PINNED_DEPS = ['parse5', 'playwright', 'pixelmatch', 'pngjs', 'css-tree'];
const COMMIT_SUBJECT = 'chore: scaffold from astro-conversion-kit';
// Vercel URL handling per trailing-slash mode; cleanUrls never goes with the directory format.
// No trailingSlash key: Vercel would apply it before the redirects and add a hop to every unslashed
// source, so build-redirects writes the same slash rules after the site's redirects instead.
const VERCEL_URLS = {
  always: {},
  never: { cleanUrls: true },
};

class UsageError extends Error {}

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        origin: { type: 'string' },
        name: { type: 'string' },
        host: { type: 'string' },
        'trailing-slash': { type: 'string', default: 'always' },
        repo: { type: 'string' },
        kit: { type: 'string' },
        'astro-version': { type: 'string' },
        'no-install': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (parsed.help) return parsed;
  for (const key of ['dir', 'origin', 'name', 'host']) {
    if (!parsed[key]) throw new UsageError(`--${key} is required`);
  }
  if (!HOSTS[parsed.host]) throw new UsageError(`--host must be vercel or cloudflare, not "${parsed.host}"`);
  if (!TRAILING[parsed['trailing-slash']]) {
    throw new UsageError(`--trailing-slash must be always or never, not "${parsed['trailing-slash']}"`);
  }
  let url;
  try {
    url = new URL(parsed.origin);
  } catch {
    throw new UsageError(`--origin is not a URL: ${parsed.origin}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new UsageError('--origin must be an http or https URL');
  return { ...parsed, url };
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function existingEntries(dir) {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) throw new UsageError(`--dir is not a directory: ${dir}`);
  return readdirSync(dir);
}

function latestAstro7() {
  try {
    const out = execFileSync('npm', ['view', 'astro@7', 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    const versions = [JSON.parse(out)].flat();
    const latest = versions[versions.length - 1];
    if (typeof latest === 'string' && latest.startsWith('7.')) return latest;
  } catch {
    // fall through to the error below
  }
  throw new UsageError('could not read the latest astro 7.x from npm; pass --astro-version <version>');
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function substitute(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in values ? values[key] : match));
}

function copyTemplates(templateDir, dir, values, skip) {
  for (const source of walk(templateDir)) {
    const rel = relative(templateDir, source);
    if (skip.includes(rel)) continue;
    const target = join(dir, rel);
    const text = substitute(readFileSync(source, 'utf8'), values);
    mkdirSync(dirname(target), { recursive: true });
    if (APPEND_TO_EXISTING.has(rel) && existsSync(target)) {
      const existing = readFileSync(target, 'utf8').replace(/\s*$/, '\n\n');
      writeFileSync(target, existing + text);
    } else {
      writeFileSync(target, text);
    }
  }
}

function writePackageJson(dir, kitPkg, astroVersion) {
  const path = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const kitDeps = { ...kitPkg.dependencies, ...kitPkg.devDependencies };
  pkg.devDependencies = { astro: astroVersion };
  for (const dep of PINNED_DEPS) {
    if (!kitDeps[dep]) throw new UsageError(`the kit's package.json does not pin ${dep}`);
    pkg.devDependencies[dep] = kitDeps[dep];
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeVercelJson(dir, trailing) {
  const path = join(dir, 'vercel.json');
  if (!existsSync(path)) return;
  const config = { ...VERCEL_URLS[trailing], ...JSON.parse(readFileSync(path, 'utf8')) };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function readKitPackage(kit) {
  const path = join(kit, 'package.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read the kit's package.json at ${path}: ${err.message}`);
  }
}

// The sitemap the runbook submits, from what the capture saved (the same names
// baseline/sitemaps.json freezes): the first one capture/robots.txt names, else the index, else
// its one sitemap, else the sitemap-index.xml the build ships when live had none.
export function sitemapUrl(dir, origin) {
  const saved = join(dir, 'capture', 'sitemaps');
  const names = existsSync(saved) ? readdirSync(saved).filter((f) => /\.xml$/i.test(f)).sort() : [];
  const robotsFile = join(dir, 'capture', 'robots.txt');
  const robots = existsSync(robotsFile) ? readFileSync(robotsFile, 'utf8') : '';
  const named = [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)]
    .map((m) => { try { return new URL(m[1]).pathname.split('/').pop(); } catch { return null; } })
    .find((n) => n && names.includes(n));
  const name = named ?? ['sitemap_index.xml', 'sitemap-index.xml', 'sitemap.xml'].find((n) => names.includes(n))
    ?? names.find((n) => /index/i.test(n)) ?? names[0] ?? 'sitemap-index.xml';
  return `${origin}/${name}`;
}

function copyIfPresent(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyScripts(kit, dir) {
  const scripts = join(dir, 'scripts');
  copyIfPresent(join(kit, 'skills', 'parity-gates', 'scripts'), scripts);
  copyIfPresent(join(kit, 'skills', 'visual-review', 'scripts'), join(scripts, 'review'));
  for (const name of CONVERT_SCRIPTS) {
    copyIfPresent(join(kit, 'skills', 'convert-site', 'scripts', `${name}.mjs`), join(scripts, `${name}.mjs`));
  }
  // The convert-site scripts import ./lib/ (node-version, media stores); merge it beside the gates' lib.
  copyIfPresent(join(kit, 'skills', 'convert-site', 'scripts', 'lib'), join(scripts, 'lib'));
}

function git(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new UsageError(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function hasCommits(dir) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function setUpGit(dir, repo) {
  if (!existsSync(join(dir, '.git'))) git(dir, ['init', '-q', '-b', 'main']);
  else if (!hasCommits(dir)) git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  if (repo && !git(dir, ['remote']).split('\n').includes('origin')) git(dir, ['remote', 'add', 'origin', repo]);
}

function commitAndBranch(dir) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', COMMIT_SUBJECT]);
  git(dir, ['switch', '-q', '-c', 'astro-rebuild']);
}

function npmInstall(dir) {
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  } catch {
    throw new UsageError(
      'npm install failed. The scaffold is written but not committed; do not run init-site again.\n' +
        `Fix the error above, then run in ${dir}:\n` +
        `  npm install && git add -A && git commit -m "${COMMIT_SUBJECT}" && git switch -c astro-rebuild`,
    );
  }
}

export function initSite(argv) {
  const opts = parseOptions(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const dir = resolve(opts.dir);
  const kit = resolve(opts.kit || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
  const templateDir = join(kit, 'skills', 'convert-site', 'templates', 'site');
  if (!existsSync(templateDir)) throw new UsageError(`no site templates found under ${kit}`);
  const kitPkg = readKitPackage(kit);

  const unexpected = existingEntries(dir).filter((name) => !ALLOWED_EXISTING.has(name));
  if (unexpected.length > 0) {
    throw new UsageError(
      `${dir} is not empty; init-site only fills a directory holding nothing but .git, .gitignore, a README, capture/ and .conversion/. Found:\n` +
        unexpected.sort().map((name) => `  ${name}`).join('\n'),
    );
  }

  const astroVersion = opts['astro-version'] || latestAstro7();
  const host = HOSTS[opts.host];
  const values = {
    ORIGIN: opts.url.origin,
    HOST: opts.url.hostname,
    SITE_NAME: opts.name,
    SITE_NAME_JS: JSON.stringify(opts.name),
    ORIGIN_JS: JSON.stringify(opts.url.origin),
    SLUG: slugify(opts.name),
    HOSTING: opts.host,
    DATE: new Date().toISOString().slice(0, 10),
    TRAILING: opts['trailing-slash'],
    FORMAT: TRAILING[opts['trailing-slash']],
    REDIRECTS_OUT: host.redirectsOut,
    DEPLOY_PREVIEW: host.deployPreview,
    DEPLOY_PRODUCTION: host.deployProduction,
    ENV_COMMAND: host.envCommand,
    DNS_NOTE: host.dnsNote,
    SITEMAP_URL: sitemapUrl(dir, opts.url.origin),
  };

  mkdirSync(dir, { recursive: true });
  setUpGit(dir, opts.repo);
  copyTemplates(templateDir, dir, values, host.skip);
  writePackageJson(dir, kitPkg, astroVersion);
  writeVercelJson(dir, opts['trailing-slash']);
  copyScripts(kit, dir);
  if (!opts['no-install']) npmInstall(dir);
  commitAndBranch(dir);
  console.log(`Scaffolded ${values.SITE_NAME} in ${dir} (host ${opts.host}); on branch astro-rebuild.`);
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  assertNodeVersion();
  try {
    initSite(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`init-site: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }
}
