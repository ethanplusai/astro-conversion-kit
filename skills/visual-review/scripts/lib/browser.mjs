// Chromium helpers for stable full-page screenshots: frozen motion, lazy content
// loaded, fonts ready, cookie banner out of the way.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { blockAnalytics } from './blocked-hosts.mjs';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const FREEZE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'freeze.css');
const VIEWPORT_HEIGHT = 900;
const IMAGE_TIMEOUT_MS = 10000;
const EVALUATE_TIMEOUT_MS = 15000;
export const LAZY_SCROLL_LIMITS = { maxViewports: 60, maxMs: 30000 };

// Navigation and network failures, which count as blocks; anything else is a page fault.
export class NavigationError extends Error {}

export const launchBrowser = () => chromium.launch();

// One context per width: device scale, reduced motion and the shared user agent, with
// analytics, tag and chat hosts blocked unless allowAnalytics, and the blockHosts always.
export async function newShotContext(browser, { width, scale = 1, allowAnalytics = false, blockHosts = [] }) {
  const context = await browser.newContext({
    viewport: { width, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    userAgent: USER_AGENT,
  });
  await blockAnalytics(context, { extra: blockHosts, analytics: !allowAnalytics });
  return context;
}

// page.evaluate has no timeout of its own; a page stuck in a loop must not hang the run.
async function evaluate(page, fn, arg, { timeoutMs = EVALUATE_TIMEOUT_MS, label = 'page script' } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([page.evaluate(fn, arg), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let cachedFreezeCss;
const freezeCss = () => (cachedFreezeCss ??= readFileSync(FREEZE_CSS, 'utf8'));

// Stops animations and transitions and forces scroll-reveal content visible.
// Injected with evaluate rather than addStyleTag, which never settles on a page
// whose own scripts are disabled.
export async function freezePage(page) {
  await evaluate(page, (css) => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  }, freezeCss(), { label: 'freeze.css injection' });
}

// Scrolls to the bottom one viewport at a time so lazy loaders fire, returns to
// the top, then waits for every image to finish (or fail). Pages that keep
// growing (infinite scroll) stop at limits.maxViewports or limits.maxMs.
// Returns { capped }; log receives a message when a limit was hit.
export async function loadLazyContent(page, { limits = LAZY_SCROLL_LIMITS, log = console.error } = {}) {
  const { capped } = await evaluate(page, async ({ maxViewports, maxMs, imageTimeoutMs }) => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const started = Date.now();
    // sizes="auto" only applies to lazy images: made eager, they fall back to 100vw and pick another
    // srcset file depending on timing, so those stay lazy and the scroll below loads them.
    for (const img of document.querySelectorAll('img[loading="lazy"]')) {
      if (!/^\s*auto\b/i.test(img.getAttribute('sizes') ?? '')) img.loading = 'eager';
    }
    const step = Math.max(200, window.innerHeight);
    let steps = 0;
    let hitCap = false;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      if (steps >= maxViewports || Date.now() - started >= maxMs) {
        hitCap = true;
        break;
      }
      window.scrollTo(0, y);
      steps += 1;
      await pause(100);
    }
    if (!hitCap) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await pause(250);
    }
    window.scrollTo(0, 0);
    // Only images the page asked for: a lazy image it never requested (a hidden slide) would
    // hold every shot to the timeout.
    const requested = [...document.images].filter((img) => img.currentSrc);
    const pending = requested.filter((img) => !img.complete);
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }))),
      pause(imageTimeoutMs),
    ]);
    // A loaded image can still be undecoded, and a full-page screenshot then paints it blank
    // (a fast local server hits this; a slow live one rarely does).
    await Promise.race([
      Promise.all(requested.map((img) => img.decode().catch(() => undefined))),
      pause(imageTimeoutMs),
    ]);
    return { capped: hitCap };
  }, { ...limits, imageTimeoutMs: IMAGE_TIMEOUT_MS }, {
    timeoutMs: limits.maxMs + IMAGE_TIMEOUT_MS + EVALUATE_TIMEOUT_MS,
    label: 'lazy-content scroll',
  });
  if (capped) {
    log(`lazy-content scroll stopped at ${limits.maxViewports} viewports or ${limits.maxMs} ms on ${page.url()}; the page may keep growing`);
  }
  return { capped };
}

// Clicks a consent button (accept / agree / got it / ok) inside a fixed or sticky
// layer or a cookie / consent container. Returns true when one was clicked.
export async function closeCookieBanner(page) {
  const clicked = await evaluate(page, () => {
    const LABEL = /\b(accept|agree|got it|ok)\b/i;
    const CONTAINER = /cookie|consent|gdpr|privacy/i;
    const inBanner = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const { position } = getComputedStyle(node);
        if (position === 'fixed' || position === 'sticky') return true;
        if (CONTAINER.test(`${node.id} ${node.className} ${node.getAttribute('aria-label') ?? ''}`)) return true;
      }
      return false;
    };
    const safeLink = (el) => el.tagName !== 'A' || !el.getAttribute('href') || /^(#|javascript:)/i.test(el.getAttribute('href'));
    const candidates = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a');
    for (const el of candidates) {
      const text = (el.value || el.textContent || '').trim();
      if (text.length > 40 || !LABEL.test(text) || !safeLink(el)) continue;
      if (!el.getClientRects().length || !inBanner(el)) continue;
      el.click();
      return true;
    }
    return false;
  }, undefined, { label: 'cookie banner check' });
  if (clicked) await page.waitForTimeout(300);
  return clicked;
}

// Loads url and returns a full-page PNG plus what was done to get it.
// Throws NavigationError when the page cannot be reached at all.
export async function capture(page, url, { wait = 1500, log = console.error } = {}) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (error) {
    throw new NavigationError(error.message.split('\n')[0]);
  }
  const status = response ? response.status() : 0;
  if (status >= 400) return { status };
  await freezePage(page);
  let bannerClosed = await closeCookieBanner(page);
  await loadLazyContent(page, { log });
  await evaluate(page, () => document.fonts.ready.then(() => undefined), undefined, { label: 'document.fonts.ready' });
  if (wait > 0) await page.waitForTimeout(wait);
  // Banners that appear late, after a scroll or a timer, are closed too.
  if (await closeCookieBanner(page)) bannerClosed = true;
  // Endless GSAP loops (a floating character, a drifting background) are JavaScript motion the
  // freeze CSS cannot stop; each is put back to its start so the frame does not depend on how
  // long the page took to load.
  await evaluate(page, () => {
    const timeline = window.gsap?.globalTimeline;
    if (!timeline?.getChildren) return;
    for (const tween of timeline.getChildren(true, true, true)) {
      const repeat = tween.repeat?.();
      if (repeat === -1 || repeat === Infinity) tween.progress(0).pause();
    }
  }, undefined, { label: 'GSAP loop reset' });
  const scrollHeight = await evaluate(page, () => Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  ), undefined, { label: 'page height' });
  const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
  return { status, buffer, bannerClosed, scrollHeight };
}

// PNG height from the IHDR chunk, without decoding the image.
export const pngHeight = (buffer) => buffer.readUInt32BE(20);
