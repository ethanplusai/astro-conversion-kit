#!/usr/bin/env node
// Platform fingerprint: what a site is built on, and where its sitemaps are.
// fingerprint(origin, { fetch }) uses at most 4 requests: `/`, `/robots.txt`, then the
// robots-declared sitemap or `/sitemap_index.xml` (Drupal: `/sitemap.xml`), then `/sitemap.xml`
// as a fallback when that found nothing. Every sitemap robots.txt names is in `robotsSitemaps`,
// and each one is either fetched here or listed in `sitemapUrls`, so the capture reads them all.
// A Sitemap: line on another host (a sister site's, www and apex count as one host) is listed in
// `otherHostSitemaps` instead, and never fetched or expanded. A home page that is a bot challenge (lib/challenge.mjs)
// stops it there: `challenge` is { provider, cause } and nothing else is requested.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { fetchPaced, DEFAULT_DELAY_MS } from './lib/http.mjs';
import { parseSitemap } from './lib/sitemaps.mjs';
import { detectChallenge } from './lib/challenge.mjs';

const MAX_SITEMAP_REQUESTS = 2;
const BLOCK_STATUSES = new Set([403, 429, 503]);

// Each rule: generator text that names the platform, and page markers that give it away.
const PLATFORM_RULES = [
  { platform: 'wordpress', generator: /wordpress/i, markers: /\/wp-content\/|\/wp-json\b/ },
  { platform: 'drupal', generator: /drupal/i, markers: /\/sites\/default\/files\/|drupal-settings-json/ },
  { platform: 'webflow', generator: /webflow/i, markers: /\bdata-wf-page=/ },
  { platform: 'squarespace', generator: /squarespace/i, markers: /squarespace/i },
  { platform: 'wix', generator: /\bwix\b/i, markers: /wix\.com/i },
  { platform: 'shopify', generator: /shopify/i, markers: /cdn\.shopify\.com/i },
  { platform: 'joomla', generator: /joomla/i, markers: null },
];

const USAGE = `Usage: node fingerprint.mjs <origin> [--json] [--delay <ms>]

Identify the platform a live site runs on (WordPress, Drupal, Webflow, Squarespace,
Wix, Shopify, Joomla, static) and find its sitemaps, in at most 4 paced requests.

  <origin>      the site, e.g. https://www.example.com
  --json        print the result as JSON
  --delay <ms>  wait between requests (default ${DEFAULT_DELAY_MS})
  --help        show this help

A home page that is an anti-bot challenge (SiteGround's /.well-known/sgcaptcha/, Cloudflare's
challenge page, or a tiny page with no title) prints "blocked: <host> anti-bot challenge
(<cause>)" and exits 3.

Exit codes: 0 done, 2 usage or unreachable site, 3 the site is blocking requests or answers
with a bot challenge.`;

function attr(tagText, name) {
  const match = tagText.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function generators(html, headers) {
  const found = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => (attr(t, 'name') ?? '').toLowerCase() === 'generator')
    .map((t) => attr(t, 'content'))
    .filter(Boolean);
  if (headers['x-generator']) found.push(headers['x-generator']);
  return found;
}

function detectPlatform(html, gens) {
  for (const rule of PLATFORM_RULES) {
    const generator = gens.find((g) => rule.generator.test(g));
    if (generator) return { platform: rule.platform, generator };
  }
  for (const rule of PLATFORM_RULES) {
    if (rule.markers?.test(html)) return { platform: rule.platform, generator: null };
  }
  return { platform: 'static', generator: null };
}

function versionFrom(generator) {
  return generator?.match(/\b(\d+(?:\.\d+)*)\b/)?.[1] ?? null;
}

const unique = (values) => [...new Set(values)];
const bareHost = (host) => host.toLowerCase().replace(/^www\./, '');
const all = (html, pattern) => unique([...html.matchAll(pattern)].map((m) => m[1]));

function themeAndPlugins(platform, html) {
  if (platform === 'wordpress') {
    return {
      theme: html.match(/\/wp-content\/themes\/([^/"'?\s]+)\//)?.[1] ?? null,
      plugins: all(html, /\/wp-content\/plugins\/([^/"'?\s]+)\//g),
    };
  }
  if (platform === 'drupal') {
    const themes = [...html.matchAll(/(\/core)?\/(?:sites\/[^/"']+\/)?themes\/(?:custom\/|contrib\/)?([^/"'?\s]+)\//g)];
    const theme = (themes.find((m) => !m[1]) ?? themes[0])?.[2] ?? null;
    return {
      theme,
      plugins: all(html, /\/(?:sites\/[^/"']+\/)?modules\/(?:contrib\/|custom\/)?([^/"'?\s]+)\//g),
    };
  }
  return { theme: null, plugins: [] };
}

function detectRest(platform, html, headers) {
  if (platform === 'wordpress') return /api\.w\.org|\/wp-json\b/.test(html) || /api\.w\.org/.test(headers.link ?? '');
  if (platform === 'drupal') return /\/jsonapi\b/.test(html);
  return false;
}

function declaredSitemaps(robots, origin) {
  return unique(
    [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)]
      .map((m) => {
        try {
          return new URL(m[1], origin).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
}

async function findSitemaps(origin, platform, declared, fetch) {
  const fallback = new URL('/sitemap.xml', origin).href;
  const first = declared[0] ?? new URL(platform === 'drupal' ? '/sitemap.xml' : '/sitemap_index.xml', origin).href;
  const candidates = unique([first, fallback]).slice(0, MAX_SITEMAP_REQUESTS);
  const others = declared.slice(1);

  for (const url of candidates) {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.status !== 200) continue;
    const sitemap = parseSitemap(res.body, res.finalUrl || url);
    if (sitemap.index && sitemap.children.length > 0) return unique([...sitemap.children, ...others]);
    // Too large to read here: kept, so the capture's sitemap step reports it.
    if (sitemap.tooLarge || (!sitemap.index && sitemap.entries.length > 0)) return unique([url, ...others]);
  }
  return others;
}

// detect: false leaves challenge detection to the caller's fetch (capture.mjs judges every answer).
export async function fingerprint(origin, { fetch = fetchPaced, detect = true } = {}) {
  const base = new URL(origin).origin;
  const home = await fetch(new URL('/', base).href, { redirect: 'follow' });
  const html = home.status === 200 ? String(home.body) : '';
  const headers = home.headers ?? {};
  const challenge = detect ? detectChallenge(home) : null;

  // Unreachable, blocking or challenging: do not keep knocking.
  if (home.status === 0 || BLOCK_STATUSES.has(home.status) || challenge) {
    return {
      platform: 'unknown',
      platformVersion: null,
      generator: null,
      theme: null,
      plugins: [],
      hasRest: false,
      hasSitemap: false,
      sitemapUrls: [],
      robotsSitemaps: [],
      otherHostSitemaps: [],
      robots: '',
      server: headers.server ?? null,
      poweredBy: headers['x-powered-by'] ?? null,
      homeStatus: home.status,
      challenge,
    };
  }

  const gens = generators(html, headers);
  const detected = home.status === 200 ? detectPlatform(html, gens) : { platform: 'unknown', generator: null };
  const { platform } = detected;
  const generator = detected.generator ?? gens[0] ?? null;

  const robotsRes = await fetch(new URL('/robots.txt', base).href, { redirect: 'follow' });
  const robots = robotsRes.status === 200 ? String(robotsRes.body) : '';
  const declared = declaredSitemaps(robots, base);
  const onSite = (url) => bareHost(new URL(url).host) === bareHost(new URL(base).host);
  const robotsSitemaps = declared.filter(onSite);
  const otherHostSitemaps = declared.filter((url) => !onSite(url));
  const sitemapUrls = await findSitemaps(base, platform, robotsSitemaps, fetch);

  return {
    platform,
    platformVersion: versionFrom(detected.generator),
    generator,
    ...themeAndPlugins(platform, html),
    hasRest: detectRest(platform, html, headers),
    hasSitemap: sitemapUrls.length > 0,
    sitemapUrls,
    robotsSitemaps,
    otherHostSitemaps,
    robots,
    server: headers.server ?? null,
    poweredBy: headers['x-powered-by'] ?? null,
    homeStatus: home.status,
    challenge: null,
  };
}

function parseArgs(argv) {
  const args = { origin: null, json: false, delayMs: DEFAULT_DELAY_MS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--delay') {
      args.delayMs = Number(argv[(i += 1)]);
      if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay needs a number of milliseconds');
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (args.origin) throw new Error('only one origin is allowed');
    else args.origin = arg;
  }
  return args;
}

function printHuman(result) {
  const lines = [
    ['platform', result.platformVersion ? `${result.platform} ${result.platformVersion}` : result.platform],
    ['generator', result.generator],
    ['theme', result.theme],
    ['plugins', result.plugins.join(', ') || null],
    ['REST API', result.hasRest ? 'yes' : 'no'],
    ['sitemaps', result.sitemapUrls.join('\n            ') || 'none found'],
    ['robots', [
      ...result.robotsSitemaps.map((u) => `Sitemap: ${u}`),
      ...result.otherHostSitemaps.map((u) => `Sitemap: ${u} (other host, skipped)`),
    ].join('\n            ') || 'no Sitemap: lines'],
    ['server', result.server],
    ['powered by', result.poweredBy],
  ];
  for (const [label, value] of lines) console.log(`${`${label}:`.padEnd(12)}${value ?? '-'}`);
}

async function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let origin;
  try {
    origin = new URL(args.origin ?? '');
    if (!/^https?:$/.test(origin.protocol)) throw new Error();
  } catch {
    console.error(`An http(s) origin is required.\n\n${USAGE}`);
    process.exit(2);
  }

  const fetch = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, trusted: [origin.href] });
  const result = await fingerprint(origin.href, { fetch });
  if (result.homeStatus === 0) {
    console.error(`Could not reach ${origin.origin}.`);
    process.exit(2);
  }
  if (result.challenge) {
    console.error(`blocked: ${result.challenge.provider ?? origin.hostname} anti-bot challenge (${result.challenge.cause})`);
    process.exit(3);
  }
  if (BLOCK_STATUSES.has(result.homeStatus)) {
    console.error(`${origin.origin} answered ${result.homeStatus}: it is blocking requests. Wait and run again.`);
    process.exit(3);
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
