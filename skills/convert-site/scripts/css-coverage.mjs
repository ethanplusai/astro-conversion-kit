#!/usr/bin/env node
// Records which parts of each stylesheet the site's pages actually use, with
// Chromium CSS coverage over every route at every width.
// Exit codes: 0 written, 1 a route failed to load, 2 usage or environment error,
// 3 stopped after 3 consecutive blocked responses.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertNodeVersion } from './lib/node-version.mjs';
import { blockAnalytics } from './lib/blocked-hosts.mjs';
import { stateRules } from './lib/state-selectors.mjs';

const MAX_TOGGLES = 20;
const HELP = `Usage: node css-coverage.mjs --base <origin> --routes <list|inventory.json> --out coverage.json
                           [--widths 390,768,1440] [--delay 500]

Loads every route at every width in Chromium with CSS coverage on, waits for the
load event and a short settle, hovers and focuses the first a, button and input
larger than 1x1 pixel (a clipped skip link is passed over), clicks once each menu
or accordion toggle a person could reach (button[aria-controls], [aria-expanded],
.menu-toggle, .hamburger, [data-toggle], [data-bs-toggle], summary; up to
${MAX_TOGGLES} a page; a toggle that is a link or submits a form goes nowhere), so an
open menu's rules count as used, then stops coverage. Results are merged per
stylesheet and written as
  { "<stylesheet url>": { text, usedRanges: [[start, end], ...], stateRanges },
    "inline:<n>": { text, usedRanges, stateRanges, pages: [path, ...] } }
usedRanges are character offsets into text, sorted with overlaps merged.
stateRanges are the unused rules that style an interaction state (a class such as
.open, .is-open, .menu-open, .active, .expanded, .show, .visible, or
[aria-expanded="true"], [aria-hidden="false"], [open]) whose element (the selector
with its state and pseudo parts taken out) is on a covered page: a state no click
reached. css-prune.mjs keeps them. Inline
<style> blocks with the same text share one inline:<n> key and list the pages
they appear on. A block is known by its text (trimmed), so one that ends in a
/*# sourceURL=<file> */ comment, which Chromium files under that file's URL,
is still an inline block. Analytics, tag, pixel and chat hosts are blocked, so their
injected styles are not recorded and the loads do not count as visits.

  --base     origin to load, e.g. https://www.example.com
  --routes   a comma list of paths, or capture/inventory.json ([{ path, ... }];
             records with a status other than 200 are skipped)
  --widths   comma list of viewport widths (default 390,768,1440)
  --out      coverage file to write
  --delay    milliseconds between page loads (default 500); doubled on 429/503

Exit codes: 0 written, 1 a route failed to load (the rest are still written),
2 usage or environment error, 3 stopped after 3 consecutive blocked responses
(403/429/503/network; what was collected so far is written).`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const VIEWPORT_HEIGHT = 900;
const SETTLE_MS = 300;
const BLOCKED = new Set([403, 429, 503]);
const BACKOFF = new Set([429, 503]);
const MAX_CONSECUTIVE_BLOCKS = 3;
const INTERACTIVE = ['a', 'button', 'input'];
const TOGGLES = 'button[aria-controls], [aria-expanded], .menu-toggle, .hamburger, [data-toggle], [data-bs-toggle], summary';

class UsageError extends Error {}

// Sorts [start, end] ranges and merges the ones that overlap or touch.
export function mergeRanges(ranges) {
  const sorted = ranges.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function readRoutes(value) {
  if (!value.endsWith('.json')) return value.split(',').map((path) => path.trim()).filter(Boolean);
  let records;
  try {
    records = JSON.parse(readFileSync(value, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${value}: ${error.message}`);
  }
  if (!Array.isArray(records)) throw new UsageError(`${value} is not a JSON array`);
  return records
    .filter((record) => record && typeof record.path === 'string' && (record.status === undefined || record.status === 200))
    .map((record) => record.path);
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
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  for (const name of ['base', 'routes', 'out']) if (!values[name]) throw new UsageError(`--${name} is required`);
  let base;
  try {
    base = new URL(values.base).origin;
  } catch {
    throw new UsageError(`--base is not a URL: ${values.base}`);
  }
  const widths = values.widths.split(',').map((w) => {
    const width = Number(w.trim());
    if (!Number.isInteger(width) || width < 100 || width > 4000) throw new UsageError(`--widths has a bad width: ${w}`);
    return width;
  });
  const delay = Number(values.delay);
  if (!Number.isFinite(delay) || delay < 0) throw new UsageError(`--delay must be a number of milliseconds: ${values.delay}`);
  const routes = readRoutes(values.routes);
  if (!routes.length) throw new UsageError('--routes names no paths');
  return { base, routes, widths, out: resolve(values.out), delay };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The first element matching selector that a pointer can reach: larger than 1x1 and not
// visibility:hidden, so a clipped skip link is passed over instead of timing out the hover.
function firstReachable(selector) {
  return [...document.querySelectorAll(selector)].find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  }) ?? null;
}

// Hover and focus the first reachable element of each interactive kind so their state rules count.
async function interact(page) {
  for (const selector of INTERACTIVE) {
    const handle = await page.evaluateHandle(firstReachable, selector).catch(() => null);
    const element = handle?.asElement();
    if (!element) continue;
    await element.hover({ timeout: 1000 }).catch(() => {});
    await element.focus().catch(() => {});
    await handle.dispose().catch(() => {});
  }
}

// Clicks each reachable toggle once, in document order, with the DOM's own click (no pointer
// hit test, so an open overlay cannot stall the run). A link's navigation and a form's submit
// are cancelled first, so the page stays the one being covered. Each click forces a style
// recalculation, so the state it turns on counts as used.
function clickToggles({ selector, max }) {
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    const href = link?.getAttribute('href') ?? '';
    if (link && !href.startsWith('#') && !/^javascript:/i.test(href)) event.preventDefault();
  }, true);
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  let clicked = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (clicked >= max) break;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1 || getComputedStyle(el).visibility === 'hidden') continue;
    el.click();
    void document.body.offsetHeight;
    clicked += 1;
  }
  return clicked;
}

// The base selectors (lib/state-selectors.mjs) that match an element on the page.
function matching(selectors) {
  return selectors.filter((selector) => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  });
}

// Gives each entry stateRanges: its unused state rules whose element is on the page.
async function addStateRanges(page, entries) {
  const candidates = entries.map(({ text, ranges }) => stateRules(text)
    .filter(({ start, end }) => !ranges.some((r) => r.start < end && r.end > start)));
  const bases = [...new Set(candidates.flat().flatMap((rule) => rule.bases))];
  const found = new Set(bases.length ? await page.evaluate(matching, bases).catch(() => []) : []);
  entries.forEach((entry, i) => {
    entry.stateRanges = candidates[i].filter((rule) => rule.bases.some((b) => found.has(b))).map(({ start, end }) => [start, end]);
  });
}

// The text of every <style> element on the page, in document order.
function styleBlockTexts() {
  return [...document.querySelectorAll('style')].map((style) => style.textContent);
}

// Whether a coverage entry is one of the page's <style> blocks. Chromium reports an inline block
// under the URL its /*# sourceURL=<file> */ comment names (WordPress 6.9+ ends every block with
// one), so a block is known by its text, trimmed as the capture stores it, whatever its url.
export function isInlineEntry({ url, text }, pageUrl, styleTexts = []) {
  if (!url || url === pageUrl) return true;
  const trimmed = text.trim();
  return Boolean(trimmed) && styleTexts.some((block) => block.trim() === trimmed);
}

// One route at one width: returns { status, entries } or { status: 0, error }.
async function coverRoute(page, url) {
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  } catch (error) {
    await page.coverage.stopCSSCoverage().catch(() => {});
    return { status: 0, error };
  }
  await sleep(SETTLE_MS);
  await interact(page);
  const clicked = await page.evaluate(clickToggles, { selector: TOGGLES, max: MAX_TOGGLES }).catch(() => 0);
  if (clicked) await sleep(SETTLE_MS);
  const entries = await page.coverage.stopCSSCoverage();
  await addStateRanges(page, entries);
  const styleTexts = await page.evaluate(styleBlockTexts).catch(() => []);
  return { status: response ? response.status() : 0, entries, pageUrl: page.url(), styleTexts };
}

// Folds one page's coverage entries into the merged result.
function addEntries(result, inlineKeys, entries, pageUrl, path, styleTexts) {
  for (const { url, text, ranges, stateRanges = [] } of entries) {
    const used = ranges.map(({ start, end }) => [start, end]);
    const inline = isInlineEntry({ url, text }, pageUrl, styleTexts);
    let key = url;
    if (inline) {
      if (!inlineKeys.has(text)) inlineKeys.set(text, `inline:${inlineKeys.size + 1}`);
      key = inlineKeys.get(text);
    }
    const entry = (result[key] ??= inline ? { text, usedRanges: [], stateRanges: [], pages: [] } : { text, usedRanges: [], stateRanges: [] });
    entry.usedRanges = mergeRanges([...entry.usedRanges, ...used]);
    entry.stateRanges = mergeRanges([...entry.stateRanges, ...stateRanges]);
    if (inline && !entry.pages.includes(path)) entry.pages.push(path);
  }
}

async function cover({ base, routes, widths, out, delay }) {
  const result = {};
  const inlineKeys = new Map();
  let failed = 0;
  let stopped = false;
  let blocks = 0;
  let pace = delay;
  let first = true;
  const browser = await chromium.launch();
  try {
    widths: for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, userAgent: USER_AGENT });
      await blockAnalytics(context);
      for (const path of routes) {
        const url = new URL(path, base).href;
        for (;;) {
          if (!first) await sleep(pace);
          first = false;
          const page = await context.newPage();
          const outcome = await coverRoute(page, url);
          await page.close().catch(() => {});
          if (outcome.status === 0 || BLOCKED.has(outcome.status)) {
            blocks += 1;
            console.error(`blocked: ${url} at ${width} (${outcome.error ? outcome.error.message.split('\n')[0] : outcome.status})`);
            if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
              stopped = true;
              break widths;
            }
            if (outcome.status === 0 || BACKOFF.has(outcome.status)) pace = Math.max(pace, 1000) * 2;
            continue;
          }
          blocks = 0;
          pace = delay;
          if (outcome.status >= 400) {
            failed += 1;
            console.error(`failed: ${url} at ${width}: HTTP ${outcome.status}`);
          } else {
            addEntries(result, inlineKeys, outcome.entries, outcome.pageUrl, path, outcome.styleTexts);
            console.log(`covered ${path} at ${width}`);
          }
          break;
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`wrote ${out}: ${Object.keys(result).length} stylesheets`);
  if (stopped) {
    console.error(`stopped after ${MAX_CONSECUTIVE_BLOCKS} consecutive blocked responses; partial coverage saved in ${out}`);
    return 3;
  }
  return failed ? 1 : 0;
}

async function main() {
  assertNodeVersion();
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`css-coverage: ${error.message}\nRun with --help for usage.`);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    process.exit(await cover(options));
  } catch (error) {
    console.error(`css-coverage: environment error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
