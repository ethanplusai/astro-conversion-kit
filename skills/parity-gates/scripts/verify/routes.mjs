#!/usr/bin/env node
// Routes gate: every page, post, archive and feed the baseline recorded at 200 is built, every
// noindex route still says noindex, the build has nothing the live site did not, and every route
// the capture could not read (a status other than 200, 3xx, 404 or 410) has an exception.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, pathMatcher, report } from '../lib/gate-cli.mjs';
import { exceptionFailure } from '../lib/exceptions.mjs';
import { attr, find, parseHtml } from '../lib/html.mjs';
import { distFiles, feedFiles, pageFiles, pageFormat, PAGE_KINDS, readJson, requireInputs, servedPath } from '../lib/dist.mjs';

const NAME = 'routes';
const OPTIONS = {
  'allow-extra': { type: 'string', default: '', description: 'comma-separated extra paths the build may have, * matches anything' },
};
// Files every Astro build may carry besides the baseline routes, media and redirect sources.
const ALWAYS_ALLOWED = [
  /^404\.html$/,
  /^_astro\//,
  /^robots\.txt$/,
  /^sitemap(?:-index|-\d+)?\.xml$/,
  /^_(?:redirects|headers|routes\.json)$/,
  // The icon set and web app manifest a launch needs (pre-launch checks for them at the root).
  /^favicon(?:-[\w.-]+)?\.(?:ico|svg|png)$/,
  /^icon-[\w.-]+\.png$/,
  /^apple-touch-icon(?:-[\w.-]+)?\.png$/,
  /^(?:site|manifest)\.webmanifest$/,
];
const NOTES = `
A page may be built as <path>/index.html or <path>.html; both are accepted for every route.
The .html form (build.format "file") is served at /about rather than /about/, so the live site's
slashed URLs change: the redirects gate checks that they still answer.
Redirect sources are allowed as pages (Astro writes a meta-refresh page for each redirect).
The site's own scripts the capture saved (baseline/js.json) and its own stylesheets
(baseline/css.json, which css-prune serves pruned at the same paths, or for a sheet captured
under a query whose pathname another sheet has, at that path with the query before the extension)
may be built at their live paths, and the live sitemap file names (baseline/sitemaps.json) at the root; built or not, they are
never extras.
A route captured at any status other than 200, 3xx, 404 or 410 (a 503, a 0 for a network error)
was never read, so it fails as "not captured: <status>" unless a routes exception covers it:
{ path, field: "routes", from: "<status>", to: "skip" } leaves it out (counted as skipped, not
passed), and to: "<path>" names the built page that replaces it, which must exist.
`;
// Statuses the capture read for what they are; anything else means the route was never captured.
const CAPTURED = (status) => status === 200 || status === 404 || status === 410 || (status >= 300 && status < 400);
const WANT = '200, 3xx, 404 or 410';

function robotsOf(html) {
  const meta = find(parseHtml(html), (n) => n.tagName === 'meta' && (attr(n, 'name') ?? '').toLowerCase() === 'robots');
  return meta ? attr(meta, 'content') : null;
}

// Where css-prune serves a sheet captured under a query when another sheet with other bytes has
// its pathname (convert-site css-prune.mjs variantPath: /t/style.css?ver=2 -> /t/style.ver-2.css).
function variantPath(pathname, search) {
  const tag = search.replace(/^\?/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'variant';
  const dot = pathname.lastIndexOf('.');
  return dot > pathname.lastIndexOf('/') ? `${pathname.slice(0, dot)}.${tag}${pathname.slice(dot)}` : `${pathname}.${tag}`;
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

export function checkRoutes({ dist, routes, media, redirects = [], scripts = [], stylesheets = [], sitemaps = [], exceptions = [], paths = () => true, allowExtra = () => false }) {
  const files = distFiles(dist);
  const present = new Set(files);
  const format = pageFormat(files);
  const expected = new Set();
  const failures = [];
  const skips = [];
  let checked = 0;

  // Routes the capture never read: each needs a routes exception.
  const relevant = exceptions.filter((e) => e.field === 'routes' && paths(e.path));
  const used = new Set();
  const uncaptured = { total: 0, failed: 0, skipped: 0, replaced: 0 };
  for (const route of routes) {
    if (CAPTURED(route.status) || !paths(route.path)) continue;
    checked += 1;
    uncaptured.total += 1;
    const actual = `not captured: ${route.status}`;
    const exception = relevant.find((e) => e.path === route.path && String(e.from) === String(route.status));
    if (!exception) {
      uncaptured.failed += 1;
      failures.push({ path: route.path, field: 'status', expected: WANT, actual });
      continue;
    }
    used.add(exception);
    if (exception.to === 'skip') {
      uncaptured.skipped += 1;
      skips.push({ from: route.path, reason: `${actual} (exception: skip)` });
      continue;
    }
    uncaptured.replaced += 1;
    const candidates = pageFiles(String(exception.to), format);
    candidates.forEach((c) => expected.add(c));
    if (!candidates.some((c) => present.has(c))) failures.push({ path: route.path, field: 'file', expected: candidates[0], actual: null });
  }
  failures.push(...relevant.filter((e) => !used.has(e)).map((e) => exceptionFailure(e, 'no longer matches the baseline')));

  for (const route of routes) {
    if (route.status !== 200) continue;
    const isFeed = route.kind === 'feed';
    if (!isFeed && !PAGE_KINDS.has(route.kind)) continue;
    const candidates = isFeed ? feedFiles(route.path) : pageFiles(route.path, format);
    candidates.forEach((c) => expected.add(c));
    if (!paths(route.path)) continue;
    checked += 1;
    const file = candidates.find((c) => present.has(c));
    if (!file) {
      failures.push({ path: route.path, field: 'file', expected: candidates[0], actual: null });
      continue;
    }
    if (route.noindex) {
      const robots = robotsOf(readFileSync(join(dist, file), 'utf8'));
      if (!/\bnoindex\b/i.test(robots ?? '')) failures.push({ path: route.path, field: 'robots', expected: 'noindex', actual: robots });
    }
  }

  for (const item of media) expected.add(decode(item.path).replace(/^\/+/, ''));
  for (const script of scripts) expected.add(decode(new URL(script.src).pathname).replace(/^\/+/, ''));
  for (const sheet of stylesheets) {
    const { pathname, search } = new URL(sheet.href);
    expected.add(decode(pathname).replace(/^\/+/, ''));
    if (search) expected.add(decode(variantPath(pathname, search)).replace(/^\/+/, ''));
  }
  for (const name of sitemaps) expected.add(name);
  for (const redirect of redirects) pageFiles(redirect.from, format).forEach((c) => expected.add(c));
  for (const file of files) {
    if (expected.has(file) || ALWAYS_ALLOWED.some((re) => re.test(file))) continue;
    const path = servedPath(file);
    if (!paths(path) || allowExtra(path) || allowExtra(`/${file}`)) continue;
    failures.push({ path, field: 'extra', expected: null, actual: file });
  }
  const results = { checked, failures };
  if (uncaptured.total) {
    const { total, failed, skipped, replaced } = uncaptured;
    results.notes = [`${total} routes not captured (status other than ${WANT}): ${failed} failed, ${skipped} skipped, ${replaced} replaced`];
  }
  if (skips.length) Object.assign(results, { skipped: skips.length, skipReason: 'not captured, exception skip', skips });
  return results;
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['routes.json', 'media.json', 'redirects.json']);
  const results = checkRoutes({
    dist: args.dist,
    routes: readJson(join(args.baseline, 'routes.json')),
    media: readJson(join(args.baseline, 'media.json')),
    redirects: readJson(join(args.baseline, 'redirects.json')),
    scripts: existsSync(join(args.baseline, 'js.json')) ? readJson(join(args.baseline, 'js.json')) : [],
    stylesheets: existsSync(join(args.baseline, 'css.json')) ? readJson(join(args.baseline, 'css.json')) : [],
    sitemaps: existsSync(join(args.baseline, 'sitemaps.json')) ? readJson(join(args.baseline, 'sitemaps.json')) : [],
    exceptions: gateExceptions(NAME, args),
    paths: args.paths,
    allowExtra: args.allowExtra ? pathMatcher(args.allowExtra) : () => false,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
