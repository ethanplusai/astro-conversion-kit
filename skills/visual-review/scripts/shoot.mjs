#!/usr/bin/env node
// Full-page Chromium screenshots of a set of routes at a set of widths.
// Exit 0 all shot, 1 a route failed, 2 usage or environment error,
// 3 stopped after repeated blocks (the manifest holds what was shot).
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { capture, launchBrowser, NavigationError, newShotContext, pngHeight } from './lib/browser.mjs';
import { readRoutes, RoutesError } from './lib/routes.mjs';

const HELP = `Usage: node shoot.mjs --base <origin> --routes <templates.json|/,/a/b/> --out <dir>
                      [--widths 390,768,1440] [--delay 500] [--wait 1500] [--full] [--scale 1]
                      [--allow-analytics]

Takes a full-page Chromium screenshot of every route at every width and writes
  <out>/<route>/<width>.png and <out>/manifest.json
  ([{ route, width, file, heightPx, bannerClosed, scrollHeight, heightMismatch }],
  plus error on a route that failed, whose file is null).

  --base     origin to shoot, e.g. https://www.example.com
  --routes   a templates.json ([{ name, representative, paths[] }]: the folder is
             the template name and the representative path is shot) or a comma
             list of paths (folder is the path slug: / -> home, /a/b/ -> a__b)
  --widths   comma list of viewport widths in whole CSS pixels (default 390,768,1440)
  --out      output directory
  --delay    milliseconds between page loads (default 500)
  --wait     milliseconds to settle before each capture (default 1500)
  --full     with a templates.json, shoot every path of every template
             (folders are path slugs) instead of only the representative
  --scale    device scale factor from 0.1 to 1 (default 1); 0.5 gives
             half-size images for previews
  --allow-analytics  let analytics, tag, pixel and chat hosts load (blocked
             by default: they do not draw the page, and a screenshot run
             must not count as visits in the site's reports)

Motion is frozen (prefers-reduced-motion plus injected CSS), scroll-reveal
content is forced visible, lazy images are loaded by scrolling to the bottom and
back (at most 60 viewports or 30 s), web fonts are awaited, and a cookie banner
whose button says accept, agree, got it or ok is closed (reported as
bannerClosed). A screenshot whose height is more than 2 pixels off the page's
scrollHeight is flagged with heightMismatch and a warning.

Exit codes: 0 all shot, 1 a route failed, 2 usage error,
3 stopped after 3 consecutive blocked responses (403/429/503/network).`;

const BLOCKED = new Set([403, 429, 503]);
const MAX_CONSECUTIVE_BLOCKS = 3;
const HEIGHT_TOLERANCE_PX = 2;

class UsageError extends Error {}

// True when the PNG height is more than 2 px off the page height at this scale.
export const heightMismatch = (heightPx, scrollHeight, scale) =>
  Math.abs(heightPx - Math.round(scrollHeight * scale)) > HEIGHT_TOLERANCE_PX;

function routesFrom(value, full) {
  try {
    return readRoutes(value, { full });
  } catch (error) {
    if (error instanceof RoutesError) throw new UsageError(error.message);
    throw error;
  }
}

function number(value, name, { min, max, integer = false }) {
  const n = Number(value);
  const ok = value !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
  if (!ok) throw new UsageError(`--${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return n;
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        routes: { type: 'string' },
        widths: { type: 'string', default: '390,768,1440' },
        out: { type: 'string' },
        delay: { type: 'string', default: '500' },
        wait: { type: 'string', default: '1500' },
        full: { type: 'boolean', default: false },
        scale: { type: 'string', default: '1' },
        'allow-analytics': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  if (!values.base || !values.routes || !values.out) throw new UsageError('--base, --routes and --out are required');
  let base;
  try {
    base = new URL(values.base).origin;
  } catch {
    throw new UsageError(`--base is not a URL: ${values.base}`);
  }
  const widths = values.widths.split(',').map((w) => number(w.trim(), 'widths', { min: 100, max: 4000, integer: true }));
  const routes = routesFrom(values.routes, values.full);
  if (!routes.length) throw new UsageError('--routes names no paths');
  return {
    base,
    routes,
    widths,
    out: resolve(values.out),
    delay: number(values.delay, 'delay', { min: 0, max: 600000 }),
    wait: number(values.wait, 'wait', { min: 0, max: 600000 }),
    scale: number(values.scale, 'scale', { min: 0.1, max: 1 }),
    allowAnalytics: values['allow-analytics'],
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const failedEntry = (route, width, error) => ({
  route, width, file: null, heightPx: null, bannerClosed: false, scrollHeight: null, heightMismatch: false, error,
});

async function shoot({ base, routes, widths, out, delay, wait, scale, allowAnalytics }) {
  const manifest = [];
  let stopped = false;
  let pace = delay;
  let blocks = 0;
  let first = true;
  const browser = await launchBrowser();
  try {
    widths: for (const width of widths) {
      const context = await newShotContext(browser, { width, scale, allowAnalytics });
      let page = await context.newPage();
      for (const { route, path } of routes) {
        const url = new URL(path, base).href;
        for (;;) {
          if (!first) await sleep(pace);
          first = false;
          let result;
          try {
            result = await capture(page, url, { wait });
          } catch (error) {
            if (error instanceof NavigationError) {
              result = { status: 0, error };
            } else {
              const entry = failedEntry(route, width, error.message.split('\n')[0]);
              manifest.push(entry);
              console.error(`failed: ${url} at ${width}: ${entry.error}`);
              await page.close().catch(() => {});
              page = await context.newPage();
              blocks = 0;
              break;
            }
          }
          if (result.status === 0 || BLOCKED.has(result.status)) {
            blocks += 1;
            console.error(`blocked: ${url} at ${width} (${result.error ? result.error.message : result.status})`);
            if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
              stopped = true;
              break widths;
            }
            pace = Math.max(pace, 1000) * 2;
            continue;
          }
          blocks = 0;
          pace = delay;
          if (result.status >= 400) {
            const entry = failedEntry(route, width, `HTTP ${result.status}`);
            manifest.push(entry);
            console.error(`failed: ${url} at ${width}: ${entry.error}`);
            break;
          }
          const file = `${route}/${width}.png`;
          mkdirSync(join(out, route), { recursive: true });
          writeFileSync(join(out, file), result.buffer);
          const heightPx = pngHeight(result.buffer);
          const entry = {
            route, width, file, heightPx, bannerClosed: result.bannerClosed,
            scrollHeight: result.scrollHeight, heightMismatch: heightMismatch(heightPx, result.scrollHeight, scale),
          };
          manifest.push(entry);
          if (entry.heightMismatch) {
            console.error(`warning: ${file} is ${heightPx}px tall but the page is ${result.scrollHeight}px at scale ${scale}; the capture may be cut short`);
          }
          console.log(`${file} ${heightPx}px${entry.bannerClosed ? ' (cookie banner closed)' : ''}`);
          break;
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (stopped) {
    console.error(`stopped after ${MAX_CONSECUTIVE_BLOCKS} consecutive blocked responses; ${manifest.length} entries saved in ${join(out, 'manifest.json')}`);
    return 3;
  }
  return manifest.some((entry) => entry.error) ? 1 : 0;
}

async function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    process.exit(await shoot(options));
  } catch (error) {
    console.error(`environment error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
