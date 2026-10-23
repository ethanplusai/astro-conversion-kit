import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { startFixture } from '../fixture/serve.mjs';
import { VENDORS } from '../../skills/parity-gates/scripts/lib/vendors.mjs';
import { BLOCKED_HOSTS, isBlockedUrl, parseBlockHosts } from '../../skills/visual-review/scripts/lib/blocked-hosts.mjs';
import { startStub } from '../capture/helpers.mjs';
import { capture, newShotContext } from '../../skills/visual-review/scripts/lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COPIES = [
  join(ROOT, 'skills', 'visual-review', 'scripts', 'lib', 'blocked-hosts.mjs'),
  join(ROOT, 'skills', 'convert-site', 'scripts', 'lib', 'blocked-hosts.mjs'),
];
// The parity-gates vendors that only track or chat; recaptcha, video players and maps render content.
const TRACKING_VENDORS = ['gtm', 'ga4', 'meta-pixel', 'hotjar', 'clarity', 'hubspot', 'intercom', 'crisp', 'tawk'];
// HubSpot's form embed draws a form on the page, so it is left to load.
const RENDERS_CONTENT = new Set(['js.hsforms.net']);

// Host names named in a vendor's src pattern, e.g. /js\.hs-scripts\.com|js\.hsforms\.net/.
function hostsOf(pattern) {
  return pattern.source.split('|')
    .map((alternative) => alternative.replace(/\\\//g, '/').replace(/\\\./g, '.').match(/^[a-z0-9.-]+/i)?.[0])
    .filter((host) => host && host.includes('.'));
}

let fixture;
let browser;
before(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await fixture.close();
});

test('the blocked hosts cover every tracking host the parity-gates vendor list names', () => {
  const source = readFileSync(join(ROOT, 'skills', 'parity-gates', 'scripts', 'lib', 'vendors.mjs'), 'utf8');
  const hosts = VENDORS.filter((rule) => TRACKING_VENDORS.includes(rule.vendor)).flatMap((rule) => hostsOf(rule.src));
  assert.ok(hosts.length >= 10, `found ${hosts.join(', ')}`);
  for (const host of hosts) {
    assert.ok(source.includes(host.replace(/\./g, '\\.')), `${host} is read from vendors.mjs`);
    if (RENDERS_CONTENT.has(host)) assert.equal(isBlockedUrl(new URL(`https://${host}/x.js`)), false, host);
    else assert.ok(isBlockedUrl(new URL(`https://${host}/x.js`)), `${host} is not blocked`);
  }
});

test('the list names the tag, pixel and chat hosts of the brief', () => {
  for (const url of [
    'https://www.google-analytics.com/g/collect', 'https://www.googletagmanager.com/gtm.js?id=GTM-X',
    'https://connect.facebook.net/en_US/fbevents.js', 'https://static.hotjar.com/c/hotjar-1.js',
    'https://www.clarity.ms/tag/abc', 'https://js.hs-scripts.com/1.js', 'https://widget.intercom.io/widget/x',
    'https://js.driftt.com/include/1/x.js', 'https://snap.licdn.com/li.lms-analytics/insight.min.js',
    'https://analytics.tiktok.com/i18n/pixel/events.js', 'https://ct.pinterest.com/v3/', 'https://cdn.segment.com/analytics.js',
    'https://cdn.mxpnl.com/libs/mixpanel.js', 'https://plausible.io/js/script.js', 'https://cdn.usefathom.com/script.js',
    'https://example.matomo.cloud/matomo.js', 'https://client.crisp.chat/l.js', 'https://embed.tawk.to/x/default',
    'https://static.zdassets.com/ekr/snippet.js',
  ]) assert.ok(isBlockedUrl(new URL(url)), url);
  for (const url of [
    `${fixture.origin}/`, 'https://fonts.googleapis.com/css2', 'https://www.google.com/recaptcha/api.js',
    'https://www.youtube.com/iframe_api', 'https://maps.googleapis.com/maps/api/js', 'https://notgoogletagmanager.com/x',
  ]) assert.equal(isBlockedUrl(new URL(url)), false, url);
  assert.ok(BLOCKED_HOSTS.every((host) => host === host.toLowerCase()));
});

test('convert-site carries a byte-identical copy of the blocked-hosts list', () => {
  assert.ok(readFileSync(COPIES[1]).equals(readFileSync(COPIES[0])));
});

test('shoot, styles and css-coverage block analytics on every context unless --allow-analytics', () => {
  for (const script of ['visual-review/scripts/styles.mjs', 'convert-site/scripts/css-coverage.mjs']) {
    const source = readFileSync(join(ROOT, 'skills', script), 'utf8');
    assert.match(source, /import \{ blockAnalytics, parseBlockHosts \} from '\.\/lib\/blocked-hosts\.mjs'/, script);
    assert.match(source, /blockAnalytics\(context[,)]/, script);
  }
  for (const script of ['shoot.mjs', 'styles.mjs']) {
    const source = readFileSync(join(ROOT, 'skills', 'visual-review', 'scripts', script), 'utf8');
    assert.match(source, /--allow-analytics/, script);
  }
});

test('--block-hosts adds hosts to the block list for the run, even with --allow-analytics', async () => {
  // A consent manager on another host (cmp.osano.com on a real site): here localhost, while the
  // page is served from 127.0.0.1.
  const stub = await startStub({
    '/': (origin) => ({ body: `<!doctype html><title>x</title><h1>Hi</h1><script src="${origin.replace('127.0.0.1', 'localhost')}/cmp.js"></script>` }),
    '/cmp.js': { headers: { 'Content-Type': 'text/javascript' }, body: '' },
  });
  try {
    const shoot = (extra) => new Promise((done) => {
      execFile(process.execPath, [join(ROOT, 'skills', 'visual-review', 'scripts', 'shoot.mjs'), '--base', stub.origin, '--routes', '/',
        '--widths', '390', '--wait', '0', '--delay', '0', '--out', mkdtempSync(join(tmpdir(), 'block-hosts-')), ...extra], (err, stdout, stderr) => done({ code: err ? err.code : 0, stderr }));
    });
    const blocked = await shoot(['--block-hosts', 'LOCALHOST, cmp.example.com']);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.ok(!stub.requests.includes('/cmp.js'), 'the extra host was never asked');
    const allowed = await shoot(['--block-hosts', 'localhost', '--allow-analytics']);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok(!stub.requests.includes('/cmp.js'), '--allow-analytics does not lift --block-hosts');
    const loaded = await shoot([]);
    assert.equal(loaded.code, 0, loaded.stderr);
    assert.ok(stub.requests.includes('/cmp.js'), 'without the option the host loads');
    const bad = await shoot(['--block-hosts', 'https://cmp.example.com/x']);
    assert.equal(bad.code, 2, 'a URL is not a host name');
  } finally {
    await stub.close();
  }
  assert.deepEqual(parseBlockHosts('cmp.osano.com, Example.COM'), ['cmp.osano.com', 'example.com']);
  assert.ok(isBlockedUrl(new URL('https://cmp.osano.com/x.js'), ['osano.com']));
  assert.ok(!isBlockedUrl(new URL('https://cmp.osano.com/x.js')));
  for (const script of ['visual-review/scripts/shoot.mjs', 'visual-review/scripts/styles.mjs', 'convert-site/scripts/css-coverage.mjs']) {
    const help = spawnSync(process.execPath, [join(ROOT, 'skills', script), '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /--block-hosts <host,\.\.\.>/, script);
  }
});

// The page drawn with the tags blocked, and with them answered by an empty script as if they had loaded.
async function shot({ allowAnalytics }) {
  const context = await newShotContext(browser, { width: 390, allowAnalytics });
  const seen = { finished: [], failed: [] };
  if (allowAnalytics) {
    await context.route((url) => isBlockedUrl(url), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  }
  const page = await context.newPage();
  page.on('requestfinished', (request) => seen.finished.push(request.url()));
  page.on('requestfailed', (request) => seen.failed.push(request.url()));
  const { buffer } = await capture(page, `${fixture.origin}/`, { wait: 0, log: () => {} });
  await context.close();
  return { png: PNG.sync.read(buffer), seen };
}

test('blocking the fixture GA4 and GTM tags leaves the screenshot pixel for pixel the same', async () => {
  const blocked = await shot({ allowAnalytics: false });
  const loaded = await shot({ allowAnalytics: true });
  const external = (urls) => urls.filter((url) => !url.startsWith(fixture.origin));
  assert.deepEqual(external(blocked.seen.finished), [], 'no third-party request completed');
  assert.ok(blocked.seen.failed.some((url) => url.includes('googletagmanager.com/gtag/js')), 'the gtag request was stopped');
  assert.ok(loaded.seen.finished.some((url) => url.includes('googletagmanager.com')), 'allowAnalytics lets the tags through');
  assert.equal(blocked.png.height, loaded.png.height);
  const { width, height } = blocked.png;
  assert.equal(pixelmatch(blocked.png.data, loaded.png.data, null, width, height, { threshold: 0.1, includeAA: false }), 0);
});
