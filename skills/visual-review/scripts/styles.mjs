#!/usr/bin/env node
// Computed-style parity: samples the first match of each selector on the live
// and new site, per route and width, and compares typography, colour and spacing.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { blockAnalytics, parseBlockHosts } from './lib/blocked-hosts.mjs';
import { readRoutes, RoutesError } from './lib/routes.mjs';
import { LENGTH_TOLERANCE_PX, PROPERTIES, SELECTORS } from './lib/selectors.mjs';

const HELP = `Usage: node styles.mjs --live <origin> --new <origin> --routes <templates.json|list>
                        [--widths 390,1440] [--out styles.json] [--delay 500]
                        [--allow-analytics] [--block-hosts <host,...>]

Opens every route at every width on both origins and compares, on the first
match of each sampled selector, font-family (first family), font-size,
font-weight, line-height, letter-spacing, color, background-color,
text-transform, margin-top/bottom and the four paddings. A route that is not
2xx on either side gives one failing status row instead.
Lengths pass within ${LENGTH_TOLERANCE_PX} px; colours and families must match exactly.

  --routes   a templates.json path ([{ name, representative }]: the route is the
             template name and the representative path is sampled) or a comma
             list of paths (route is the path slug: / -> home, /a/b/ -> a__b),
             the same route names shoot.mjs gives its folders
  --widths   viewport widths, comma separated (default 390,1440)
  --out      where to write [{ route, path, width, selector, property, live, new, pass }]
  --delay    milliseconds between page loads (default 500)
  --allow-analytics  let analytics, tag, pixel and chat hosts load on both
             origins (blocked by default)
  --block-hosts <host,...>  also block these hosts (and their subdomains) on both
             origins for this run, with or without --allow-analytics: a consent
             manager such as cmp.osano.com that turns the theme's scripts off when
             the page is not on the live host

Exit codes: 0 every row passes, 1 a row fails, 2 usage or environment error.`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const VIEWPORT_HEIGHT = 900;
const NAV_TIMEOUT_MS = 30000;

class UsageError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// [{ route, path }] keyed exactly as shoot.mjs names its folders.
export function parseRoutes(value) {
  try {
    return readRoutes(value);
  } catch (err) {
    if (err instanceof RoutesError) throw new UsageError(err.message);
    throw err;
  }
}

export function firstFamily(value) {
  const first = String(value).split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '');
}

function px(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

export function compareValue(kind, live, next) {
  if (kind === 'family') return firstFamily(live).toLowerCase() === firstFamily(next).toLowerCase();
  if (kind === 'length') {
    const a = px(live);
    const b = px(next);
    if (a !== null && b !== null) return Math.abs(a - b) <= LENGTH_TOLERANCE_PX;
  }
  return live === next;
}

// Runs in the page: computed values for the first match of each selector, null when absent.
function sampleInPage({ selectors, properties }) {
  const result = {};
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) {
      result[selector] = null;
      continue;
    }
    const style = getComputedStyle(el);
    result[selector] = Object.fromEntries(properties.map((p) => [p, style.getPropertyValue(p)]));
  }
  return result;
}

// Opens a page and returns it with the final document status (after redirects).
async function openPage(context, url) {
  const page = await context.newPage();
  let status = null;
  page.on('response', (res) => {
    if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) status = res.status();
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    // A slow third-party script can hold the load event; the DOM and CSS are what we need.
    if (!/Timeout/i.test(err.message)) {
      await page.close();
      throw err;
    }
  }
  await page.evaluate(() => document.fonts?.ready);
  return { page, status };
}

async function sample(context, origin, path) {
  const { page, status } = await openPage(context, new URL(path, origin).href);
  try {
    const styles = await page.evaluate(sampleInPage, {
      selectors: SELECTORS,
      properties: PROPERTIES.map((p) => p.name),
    });
    return { status, styles };
  } finally {
    await page.close();
  }
}

const isOk = (status) => status !== null && status >= 200 && status < 300;

// Computed values that mean the same length.
function normalise(name, value) {
  if (name === 'letter-spacing' && value === 'normal') return '0px';
  return value;
}

// live and next are { status, styles }. A non-2xx side yields one failing status row.
export function compareSamples({ route, path }, width, liveSample, nextSample) {
  if (!isOk(liveSample.status) || !isOk(nextSample.status)) {
    return [{ route, path, width, selector: 'document', property: 'status', live: liveSample.status, new: nextSample.status, pass: false }];
  }
  const live = liveSample.styles;
  const next = nextSample.styles;
  const rows = [];
  for (const selector of SELECTORS) {
    const a = live[selector];
    const b = next[selector];
    if (!a && !b) continue;
    if (!a || !b) {
      rows.push({ route, path, width, selector, property: 'present', live: Boolean(a), new: Boolean(b), pass: false });
      continue;
    }
    for (const { name, kind } of PROPERTIES) {
      const liveValue = kind === 'family' ? firstFamily(a[name]) : normalise(name, a[name]);
      const newValue = kind === 'family' ? firstFamily(b[name]) : normalise(name, b[name]);
      rows.push({ route, path, width, selector, property: name, live: liveValue, new: newValue, pass: compareValue(kind, liveValue, newValue) });
    }
  }
  return rows;
}

function blockHostsFrom(value) {
  if (value === undefined) return [];
  try {
    return parseBlockHosts(value);
  } catch (error) {
    throw new UsageError(error.message);
  }
}

function options(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        live: { type: 'string' },
        new: { type: 'string' },
        routes: { type: 'string' },
        widths: { type: 'string', default: '390,1440' },
        out: { type: 'string', default: 'styles.json' },
        delay: { type: 'string', default: '500' },
        'allow-analytics': { type: 'boolean', default: false },
        'block-hosts': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  for (const name of ['live', 'new', 'routes']) {
    if (!values[name]) throw new UsageError(`--${name} is required`);
  }
  for (const name of ['live', 'new']) {
    try {
      new URL(values[name]);
    } catch {
      throw new UsageError(`--${name} must be an origin such as https://example.com`);
    }
  }
  const widths = values.widths.split(',').map((w) => Number(w.trim()));
  if (widths.some((w) => !Number.isInteger(w) || w < 1)) throw new UsageError('--widths must be positive integers');
  const delay = Number(values.delay);
  if (!Number.isFinite(delay) || delay < 0) throw new UsageError('--delay must be a number of milliseconds');
  const routes = parseRoutes(values.routes);
  if (routes.length === 0) throw new UsageError('--routes names no routes');
  return {
    live: values.live, next: values.new, routes, widths, out: values.out, delay,
    allowAnalytics: values['allow-analytics'], blockHosts: blockHostsFrom(values['block-hosts']),
  };
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = options(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  let chromium;
  let browser;
  try {
    ({ chromium } = await import('playwright'));
    browser = await chromium.launch();
  } catch (err) {
    console.error(`Cannot start chromium (try: npx playwright install chromium): ${err.message}`);
    return 2;
  }

  const rows = [];
  try {
    let loads = 0;
    for (const target of opts.routes) {
      for (const width of opts.widths) {
        const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, userAgent: USER_AGENT });
        await blockAnalytics(context, { extra: opts.blockHosts, analytics: !opts.allowAnalytics });
        try {
          const samples = [];
          for (const origin of [opts.live, opts.next]) {
            if (loads > 0 && opts.delay > 0) await sleep(opts.delay);
            loads += 1;
            samples.push(await sample(context, origin, target.path));
          }
          rows.push(...compareSamples(target, width, samples[0], samples[1]));
        } finally {
          await context.close();
        }
      }
    }
  } catch (err) {
    console.error(`Style sampling failed: ${err.message}`);
    return 2;
  } finally {
    await browser.close();
  }

  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);

  const failing = rows.filter((r) => !r.pass);
  for (const r of failing) {
    console.log(`FAIL ${r.route} (${r.path}) @${r.width} ${r.selector} ${r.property}: live ${r.live} | new ${r.new}`);
  }
  console.log(`${rows.length - failing.length}/${rows.length} style rows match; wrote ${out}`);
  return failing.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion();
  process.exitCode = await main();
}
