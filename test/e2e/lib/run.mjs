// The convert-site run on the fixture, phase by phase, as skills/convert-site/SKILL.md and
// references/phases.md write it: one exported function per phase, each running that phase's
// commands from SITE and returning what its proof needs. The test plays the agent; where a phase
// needs an account (a GitHub repo, a Vercel deploy) the stand-ins are named at the function.
// Scripts run as child processes so the in-process fixture keeps answering.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { chromium } from 'playwright';
import { vercelResolver } from '../../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';

export const KIT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const TMP = join(KIT, 'test', 'tmp');
export const NAME = 'Fixture Roofing';
// The form id the person sent at the forms step (forms.md); ids are not secret.
export const ENDPOINT = 'https://formspree.io/f/test';
export const ASTRO_VERSION = '7.4.2';
export const WIDTHS = [390, 768, 1440];
export const PHASES = ['intake', 'capture', 'plan', 'scaffold', 'baseline', 'build', 'gates', 'visual', 'components', 'prelaunch', 'suggestions', 'pr'];
const OLD_URLS = ['/old-services', '/about'];
const SKILLS = join(KIT, 'skills');
const NODE_BIN = dirname(process.execPath);
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

// ---------------------------------------------------------------------------------------------
// Running commands.

// This Node first on PATH (npm, npx and astro with it), no indexable flag and no proposals
// unless a step sets them.
function baseEnv() {
  const env = { ...process.env, ...GIT_ENV, PATH: `${NODE_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  delete env.PUBLIC_INDEXABLE;
  delete env.PROPOSALS;
  return env;
}

// Resolves { code, stdout, stderr, command } whatever the exit code.
export function sh(command, args, { cwd, env = {}, timeout = 300_000 } = {}) {
  return new Promise((done) => {
    execFile(command, args, { cwd, env: { ...baseEnv(), ...env }, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, command: [command, ...args].join(' ') });
    });
  });
}

// Throws with the output when a command did not exit as expected.
export function expectCode(result, code = 0) {
  if (result.code !== code) {
    throw new Error(`${result.command} exited ${result.code}, expected ${code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  }
  return result;
}

const kit = (skill, script) => join(SKILLS, skill, 'scripts', script);
const node = (site, script, args, options = {}) => sh(process.execPath, [script, ...args], { cwd: site, ...options });
const npm = (site, args, options = {}) => sh('npm', args, { cwd: site, ...options });
const git = (site, args) => sh('git', args, { cwd: site });
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// S below: node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE
export async function S(site, ...args) {
  return expectCode(await node(site, kit('convert-site', 'state.mjs'), ['--dir', site, ...args]));
}
const setState = (site, key, value) => S(site, 'set', key, JSON.stringify(value));
export const state = (site) => readJson(join(site, '.conversion', 'state.json'));

// The form flags the gates get on every run (forms.md), plus the new thank-you page (routes).
const FORM_FLAGS = ['--endpoint', ENDPOINT, '--honeypot', '_gotcha', '--thank-you', '/thank-you/'];
const VERIFY_FLAGS = [...FORM_FLAGS, '--allow-extra', '/thank-you/'];

// ---------------------------------------------------------------------------------------------
// 1. intake

// Every folder a run writes beside SITE (removed with it by cleanUp).
const besides = (site) => [`${site}-empty`, `${site}-remote.git`];

export function cleanUp(site) {
  for (const dir of [site, ...besides(site)]) rmSync(dir, { recursive: true, force: true });
}

// No CLI on PATH and an empty home for the preflight, so the run takes the "not logged in" paths
// whatever this machine has: nothing is ever deployed or pushed to a real account.
export async function intake({ site, live }) {
  cleanUp(site);
  mkdirSync(site, { recursive: true });
  await S(site, 'phase', 'intake');
  const empty = `${site}-empty`;
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  const preflight = JSON.parse(expectCode(await node(site, kit('convert-site', 'preflight.mjs'), ['--json', '--path-env', empty, '--home', empty])).stdout);
  const fingerprint = expectCode(await node(site, kit('capture-site', 'fingerprint.mjs'), [live]));
  // The defaults stand (nobody answers the message), plus the two old URLs the person listed.
  await setState(site, 'intake', {
    siteName: NAME, hosting: 'vercel', components: false, oldUrls: OLD_URLS, testAddress: null,
    platform: /platform:\s+(\S+)/.exec(fingerprint.stdout)?.[1] ?? null, experience: preflight.experience,
  });
  await setState(site, 'needsYou', [
    'gh is not logged in: create the repo, push main and astro-rebuild, open the PR from .conversion/pr-body.md',
    'vercel is not logged in: log in, then `npx vercel link --yes --project fixture-roofing` and `npx vercel deploy`',
    'no test address: no test submission; the forms launch check waits on you',
  ]);
  return { preflight, fingerprint };
}

// ---------------------------------------------------------------------------------------------
// 2. capture

export async function capture({ site, live }) {
  await S(site, 'phase', 'capture');
  const seeds = OLD_URLS.flatMap((path) => ['--seed', path]);
  const steps = [
    [kit('capture-site', 'capture.mjs'), [live, '--out', 'capture', '--delay', '0', '--no-wayback', ...seeds]],
    [kit('capture-site', 'media.mjs'), ['--capture', 'capture', '--download', '.conversion/media-cache', '--delay', '0']],
    [kit('capture-site', 'templates.mjs'), ['--capture', 'capture']],
    [kit('capture-site', 'assets.mjs'), ['--capture', 'capture', '--delay', '0']],
  ];
  for (const [script, args] of steps) expectCode(await node(site, script, args));
  // The coverage pages, as phases.md lists them: up to 10 per template, the representative first.
  const coverageRoutes = readJson(join(site, 'capture', 'templates.json'))
    .flatMap((t) => [t.representative, ...t.paths.filter((p) => p !== t.representative)].slice(0, 10)).join(',');
  // The live screenshots and the coverage run read the same capture and write apart: run together.
  await Promise.all([
    node(site, kit('visual-review', 'shoot.mjs'), ['--base', live, '--routes', 'capture/templates.json', '--widths', WIDTHS.join(','), '--out', 'capture/screens/live', '--delay', '0', '--wait', '200']),
    node(site, kit('convert-site', 'css-coverage.mjs'), ['--base', live, '--routes', coverageRoutes, '--out', 'capture/css-coverage.json', '--delay', '0']),
  ]).then((results) => results.forEach((r) => expectCode(r)));
  const lighthouse = await sh('npx', ['--no-install', 'lighthouse', '--version'], { cwd: site, timeout: 60_000 });
  expectCode(await node(site, kit('capture-site', 'readme.mjs'), ['--capture', 'capture']));
  const notes = [
    `- Lighthouse: ${lighthouse.code === 0 ? 'run per template representative' : 'not installed here; capture/lighthouse-live was not written and its checks are Not covered'}.`,
    '- Wayback: skipped (--no-wayback; the fixture has no archive).',
    `- Seeds: ${OLD_URLS.join(', ')} (old URLs from the intake).`,
    '- Shortlinks: recorded unverified (no --verify-shortlinks).',
    '- No file over 25 MB.',
  ];
  appendFileSync(join(site, 'capture', 'README.md'), `${notes.join('\n')}\n`);
  return { lighthouse };
}

// ---------------------------------------------------------------------------------------------
// 3. plan

// The oddities and defaults this capture shows, each "reproduce live" unless the gates or
// pre-launch force otherwise (and then the reason says which).
const DECISIONS = [
  { topic: 'CSS per live sheet', choice: 'each sheet pruned at its live path, each page its own head order', default: 'per sheet', reason: 'build-rules.md default; one merged file changes the cascade', costIfWrong: 'none' },
  { topic: 'shortcode printed as text on /choosing-siding-colors/', choice: 'reproduce live', default: 'reproduce live', reason: 'parity; the fix is a suggestion', costIfWrong: 'none for launch' },
  { topic: 'missing alt on a home carousel image', choice: 'reproduce live', default: 'reproduce live', reason: 'parity; the fix is a suggestion', costIfWrong: 'none for launch' },
  { topic: 'redirect chain /old-services -> /old-services/ -> /services/', choice: 'one hop to /services/', default: 'one hop', reason: 'the redirects gate requires one hop', costIfWrong: 'none' },
  { topic: 'post-sitemap.xml lists /deleted-post/ (404)', choice: 'sitemaps list the indexable 200 pages only', default: 'gate rule', reason: 'the sitemaps gate decides what they list', costIfWrong: 'none' },
  { topic: 'theme script reveal.js (lazy image, scroll reveal)', choice: 'copy to its live path', default: 'copy', reason: 'build-rules.md: scripts that drive visible behaviour are copied', costIfWrong: 'none' },
  { topic: 'WordPress REST and shortlink head links', choice: 'dropped', default: 'dropped', reason: 'they point at WordPress endpoints the static site does not have', costIfWrong: 'none' },
  { topic: 'no thank-you page on live', choice: 'build /thank-you/ from the page template, noindex, with its canonical', default: 'build it', reason: 'forms.md', costIfWrong: 'one extra page' },
  { topic: '/deleted-post/ (404 on live, listed in post-sitemap.xml)', choice: 'redirect to /blog/ (301), the posts archive', default: 'redirect to the nearest live parent, or the posts archive for a post', reason: 'build-rules.md: pre-launch requires every predecessor URL to resolve', costIfWrong: 'one old URL lands on the blog instead of a 404' },
  { topic: 'favicon.ico, apple-touch-icon.png and a web manifest', choice: 'generated from the captured favicon.svg', default: 'generate', reason: 'pre-launch blocks without them; live had only an SVG icon', costIfWrong: 'icons look different from live in a bookmark' },
];

export async function plan({ site }) {
  await S(site, 'phase', 'plan');
  await setState(site, 'hosting', 'vercel');
  const inventory = readJson(join(site, 'capture', 'inventory.json')).filter((r) => r.status === 200 && r.path !== '/');
  const slashed = inventory.filter((r) => r.path.endsWith('/')).length;
  const trailingSlash = slashed >= inventory.length - slashed ? 'always' : 'never';
  await setState(site, 'trailingSlash', trailingSlash);
  const mediaPlan = expectCode(await node(site, kit('convert-site', 'media-plan.mjs'), ['--media', 'capture/media.json', '--host', 'vercel', '--out', '.conversion/media-plan.json']));
  const decisions = [];
  for (const decision of DECISIONS) decisions.push((await S(site, 'decision', JSON.stringify(decision))).stdout.trim());
  write(join(site, '.conversion', 'plan.md'), planDraft(site, trailingSlash));
  return { trailingSlash, mediaPlan: readJson(join(site, '.conversion', 'media-plan.json')), decisions, mediaRun: mediaPlan };
}

function planDraft(site, trailingSlash) {
  const read = (file) => readJson(join(site, 'capture', file));
  const templates = read('templates.json');
  const inventory = read('inventory.json');
  const media = read('media.json');
  const media200 = media.filter((m) => m.status === 200);
  const scripts = read('scripts.json');
  const forms = inventory.filter((r) => r.forms?.some((f) => f.method === 'post'));
  return [
    `# Conversion plan: ${NAME}`,
    '',
    '## Templates found',
    '',
    '| Template | Example URL | Pages |',
    '| --- | --- | --- |',
    ...templates.map((t) => `| ${t.name} | ${t.representative} | ${t.count} |`),
    '',
    '## Counts',
    '',
    `| URLs in the inventory | ${inventory.length} |`,
    `| Pages answering 200 | ${inventory.filter((r) => r.status === 200).length} |`,
    `| Noindex pages | ${inventory.filter((r) => /noindex/i.test(r.robots ?? '')).length} |`,
    `| Media files | ${media200.length} (${media200.reduce((n, m) => n + m.bytes, 0)} bytes) |`,
    `| Redirects | ${read('redirects.json').length} |`,
    `| URL form | trailing slash ${trailingSlash} |`,
    '',
    '## Media decision',
    '',
    `${readJson(join(site, '.conversion', 'media-plan.json')).mode}: from media-plan.mjs (well under the repo thresholds).`,
    '',
    '## Redirects source',
    '',
    'The capture (seeds from the intake and shortlinks), via `npm run baseline` into redirects.csv.',
    '',
    '## Forms plan',
    '',
    '| Page | Fields | New endpoint |',
    '| --- | --- | --- |',
    ...forms.map((r) => `| ${r.path} | ${r.forms.find((f) => f.method === 'post').fields.map((f) => f.name).join(', ')} | ${ENDPOINT} |`),
    '',
    '## Analytics carry-over',
    '',
    ...Object.entries(scripts).map(([vendor, v]) => `- ${vendor} ${v.id} on ${v.pages.length} pages, kept as is.`),
    '',
    '## Out of scope',
    '',
    'None found (no search, comments, store or logins).',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// 4. scaffold

function cacheDir() {
  const kitDeps = readJson(join(KIT, 'package.json')).dependencies;
  const template = readFileSync(join(SKILLS, 'convert-site', 'templates', 'site', 'package.json'), 'utf8');
  const key = createHash('sha256')
    .update(JSON.stringify([process.versions.node.split('.')[0], process.platform, ASTRO_VERSION, kitDeps, template]))
    .digest('hex')
    .slice(0, 16);
  return join(TMP, 'e2e-cache', key, 'node_modules');
}

// gh is not logged in, so the "repo" is a bare repository beside the site: the stand-in for the
// GitHub remote that lets main and astro-rebuild be pushed. init-site runs npm install on the
// first run; its node_modules is then kept in test/tmp/e2e-cache and linked into later scaffolds
// (--no-install), the same packages the key pins.
export async function scaffold({ site, live, trailingSlash }) {
  await S(site, 'phase', 'scaffold');
  const remote = `${site}-remote.git`;
  rmSync(remote, { recursive: true, force: true });
  expectCode(await sh('git', ['init', '-q', '--bare', remote]));
  const cache = cacheDir();
  const installed = !existsSync(cache);
  const args = ['--dir', site, '--origin', live, '--name', NAME, '--host', 'vercel', '--trailing-slash', trailingSlash, '--repo', remote, '--astro-version', ASTRO_VERSION];
  const init = expectCode(await node(dirname(site), kit('convert-site', 'init-site.mjs'), installed ? args : [...args, '--no-install']));
  if (installed) {
    mkdirSync(dirname(cache), { recursive: true });
    try {
      renameSync(join(site, 'node_modules'), cache);
    } catch (error) {
      // Another run filled the cache first: use that one.
      if (!existsSync(cache)) throw error;
      rmSync(join(site, 'node_modules'), { recursive: true, force: true });
    }
  }
  symlinkSync(cache, join(site, 'node_modules'), 'dir');

  const decisions = state(site).decisions;
  const table = ['| Id | Date | Topic | Choice | Default | Reason | Cost if wrong |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...decisions.map((d) => `| ${d.id} | ${d.date} | ${d.topic} | ${d.choice} | ${d.default} | ${d.reason} | ${d.costIfWrong} |`)];
  write(join(site, 'docs', 'plan.md'), `${readFileSync(join(site, '.conversion', 'plan.md'), 'utf8')}## Decisions\n\n${table.join('\n')}\n`);
  renameSync(join(site, '.conversion', 'media-plan.json'), join(site, 'docs', 'media-plan.json'));
  await commit(site, 'docs: conversion plan');
  expectCode(await git(site, ['push', '-q', '-u', 'origin', 'main']));
  const build = expectCode(await npm(site, ['run', 'build']));
  const mainLog = expectCode(await git(site, ['log', 'main', '--oneline'])).stdout.trim().split('\n');
  const branch = expectCode(await git(site, ['branch', '--show-current'])).stdout.trim();
  return { init, installed, build, mainLog, branch };
}

export async function commit(site, message) {
  expectCode(await git(site, ['add', '-A']));
  return expectCode(await git(site, ['commit', '-q', '--allow-empty', '-m', message]));
}

// ---------------------------------------------------------------------------------------------
// 5. baseline

export async function baseline({ site }) {
  await S(site, 'phase', 'baseline');
  const built = expectCode(await npm(site, ['run', 'baseline']));
  const check = await node(site, kit('parity-gates', 'build-baseline.mjs'), ['--out', 'baseline', '--check']);
  await commit(site, 'chore: baseline from capture');
  return { built, check };
}

// ---------------------------------------------------------------------------------------------
// 6. build

const slugOf = (path) => (path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/\//g, '__'));
const pascal = (name) => name.split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const attrsOf = (node) => Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));

// A captured page cut into source slices: the head nodes, the chrome before and after <main>,
// the nav inside the header, <main>'s attributes and inner HTML, and the body class.
export function cutPage(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlNode = document.childNodes.find((n) => n.tagName === 'html');
  const head = htmlNode.childNodes.find((n) => n.tagName === 'head');
  const body = htmlNode.childNodes.find((n) => n.tagName === 'body');
  const slice = (n) => html.slice(n.sourceCodeLocation.startOffset, n.sourceCodeLocation.endOffset);
  const find = (n, tag) => (n.tagName === tag ? n : (n.childNodes ?? []).map((c) => find(c, tag)).find(Boolean));
  const main = find(body, 'main');
  const nav = find(body, 'nav');
  const bodyStart = body.sourceCodeLocation.startTag.endOffset;
  const bodyEnd = body.sourceCodeLocation.endTag?.startOffset ?? html.length;
  const loc = main.sourceCodeLocation;
  return {
    head: head.childNodes.map((n) => ({ node: n, source: slice(n) })),
    before: html.slice(bodyStart, loc.startOffset).replace(/^\n/, ''),
    nav: nav ? slice(nav) : '',
    after: html.slice(loc.endOffset, bodyEnd),
    mainAttrs: attrsOf(main),
    content: html.slice(loc.startTag.endOffset, loc.endTag.startOffset),
    bodyClass: attrsOf(body).class ?? '',
  };
}

// Head nodes Base.astro writes from baseline/seo.json, or the build replaces or drops.
function perPageHead({ node }) {
  if (node.nodeName === '#text') return true;
  const a = attrsOf(node);
  const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
  const name = (a.name ?? '').toLowerCase();
  if (['title', 'style'].includes(node.tagName)) return true;
  if (node.tagName === 'meta' && (a.charset || ['viewport', 'description', 'robots'].includes(name) || name.startsWith('twitter:') || (a.property ?? '').startsWith('og:'))) return true;
  if (node.tagName === 'link' && ['canonical', 'stylesheet', 'shortlink', 'https://api.w.org/'].some((r) => rel.includes(r))) return true;
  if (node.tagName === 'script' && a.type === 'application/ld+json') return true;
  return false;
}

// Lazy images: the real source goes into src and srcset; the data-* attributes stay as captured.
export function unlazy(markup) {
  return markup.replace(/<img\b[^>]*\bdata-src="[^"]*"[^>]*>/g, (tag) => {
    const src = /\bdata-src="([^"]*)"/.exec(tag)[1];
    const srcset = /\bdata-srcset="([^"]*)"/.exec(tag)?.[1];
    let out = tag.replace(/\ssrc="[^"]*"/, ` src="${src}"`);
    if (srcset && !/\ssrcset="/.test(out)) out = out.replace(/\sdata-srcset="/, ` srcset="${srcset}" data-srcset="`);
    return out;
  });
}

// Forms per forms.md: the action is the endpoint, method POST, the live fields kept, Formspree's
// honeypot and the thank-you field added. A GET form (a search box) is kept as live has it.
export function rewireForms(markup, live) {
  return markup.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/g, (m, attrs, inner) => {
    if (!/\smethod="post"/i.test(attrs)) return m;
    const opened = attrs.replace(/\saction="[^"]*"/, '').replace(/\smethod="[^"]*"/, '');
    const added = '<input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="display:none" aria-hidden="true">'
      + `<input type="hidden" name="_next" value="${live}/thank-you/">`;
    return `<form${opened} action="${ENDPOINT}" method="POST">${inner}${added}</form>`;
  });
}

const js = (value) => JSON.stringify(value);

function componentFile(markup, children = '') {
  return `---\n// Captured markup of the representative page, copied, not retyped.\n${children}const markup = ${js(markup)};\n---\n`;
}

function layoutFile({ headExtras, mainAttrs }) {
  return `---
// One template's layout: Base.astro, the shared head tags of the template, the header and footer
// components, and the page's head values from baseline/seo.json.
import Base from './Base.astro';
import Header from '../components/Header.astro';
import Footer from '../components/Footer.astro';
const { seo = {}, bodyClass, head = {}, css } = Astro.props;
const headExtras = ${js(headExtras)};
const og = Object.entries(seo.og ?? {});
const twitter = Object.entries(seo.twitter ?? {});
const jsonLd = seo.jsonLd ?? [];
const mainAttrs = ${js(mainAttrs)};
---
<Base title={head.title ?? seo.title} description={head.description ?? (seo.description || undefined)} canonical={head.canonical ?? (seo.canonical || undefined)} robots={head.robots ?? (seo.robots || undefined)} lang={seo.lang || 'en'} bodyClass={bodyClass} css={css}>
  <Fragment slot="head">
    {og.map(([key, value]) => <meta property={\`og:\${key}\`} content={value} />)}
    {twitter.map(([key, value]) => <meta name={\`twitter:\${key}\`} content={value} />)}
    {jsonLd.map((block) => <script type="application/ld+json" set:html={JSON.stringify(block)} />)}
    <Fragment set:html={headExtras} />
  </Fragment>
  <Header />
  <main {...mainAttrs}><slot /></main>
  <Footer />
</Base>
`;
}

const ROUTE = `---
// Every captured page through its template's layout; content moved from capture/ by the build
// step into src/content/pages/<slug>.html.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import seo from '../../baseline/seo.json';
import pages from '../content/pages.json';
import { LAYOUTS } from '../layouts/index.mjs';

export function getStaticPaths() {
  return pages.map((page) => ({ params: { path: page.path === '/' ? undefined : page.path.replace(/^\\/|\\/$/g, '') }, props: { page } }));
}
const { page } = Astro.props;
const Layout = LAYOUTS[page.template];
const html = readFileSync(join(process.cwd(), 'src', 'content', 'pages', \`\${page.slug}.html\`), 'utf8');
---
<Layout seo={seo[page.path]} bodyClass={page.bodyClass} css={page.css}><Fragment set:html={html} /></Layout>
`;

// Steps 1 and 2: media at its original paths, the theme scripts at theirs, the pruned CSS.
export async function mediaAndCss({ site }) {
  cpSync(join(site, '.conversion', 'media-cache'), join(site, 'public'), { recursive: true });
  for (const entry of readJson(join(site, 'capture', 'js', 'manifest.json')).filter((e) => e.file)) {
    cpSync(join(site, 'capture', 'js', entry.file), join(site, 'public', decodeURIComponent(new URL(entry.src).pathname).replace(/^\//, '')));
  }
  // Each linked sheet pruned into public/ at its live path, each head <style> block into
  // src/styles/inline/; the report's heads give every page its head CSS list for Base.astro.
  const prune = await node(site, kit('convert-site', 'css-prune.mjs'), ['--css', 'capture/css', '--coverage', 'capture/css-coverage.json', '--report', '.conversion/css-prune-report.json']);
  return { prune };
}

// Each page's head CSS list in live order (css-prune's heads), for Base.astro's css prop.
function headCss(site, path) {
  const { heads } = readJson(join(site, '.conversion', 'css-prune-report.json'));
  if (!heads[path]) throw new Error(`${path}: css-prune's report has no head CSS list`);
  return heads[path];
}

// Steps 3 to 5: the shared parts as components, one layout per template, the content of the
// given paths moved into src/content/pages/, forms rewired. Throws when a page's chrome differs
// from its template's representative: the template split would be wrong.
export function templates({ site, live, paths }) {
  const capture = join(site, 'capture');
  const routes = readJson(join(site, 'baseline', 'routes.json'));
  const templateList = readJson(join(capture, 'templates.json'));
  const page = (path) => cutPage(readFileSync(join(capture, routes.find((r) => r.path === path).snapshot), 'utf8'));
  const first = page(templateList[0].representative);
  const [beforeNav, afterNav] = first.before.split(first.nav);
  write(join(site, 'src', 'components', 'Nav.astro'), `${componentFile(first.nav)}<Fragment set:html={markup} />\n`);
  write(join(site, 'src', 'components', 'Header.astro'), `---\nimport Nav from './Nav.astro';\nconst before = ${js(beforeNav)};\nconst after = ${js(afterNav)};\n---\n<Fragment set:html={before} /><Nav /><Fragment set:html={after} />\n`);
  write(join(site, 'src', 'components', 'Footer.astro'), `${componentFile(first.after)}<Fragment set:html={markup} />\n`);

  const layouts = {};
  for (const template of [...templateList, { name: 'other', representative: templateList[0].representative, paths: [] }]) {
    const rep = page(template.representative);
    const headExtras = rep.head.filter((h) => !perPageHead(h)).map((h) => h.source).join('\n');
    layouts[template.name] = pascal(template.name);
    write(join(site, 'src', 'layouts', `${layouts[template.name]}.astro`), layoutFile({ headExtras: rewireForms(headExtras, live), mainAttrs: rep.mainAttrs }));
  }
  write(join(site, 'src', 'layouts', 'index.mjs'), `${Object.values(layouts).map((l) => `import ${l} from './${l}.astro';`).join('\n')}\n\nexport const LAYOUTS = { ${Object.entries(layouts).map(([k, v]) => `${js(k)}: ${v}`).join(', ')} };\n`);
  write(join(site, 'src', 'pages', '[...path].astro'), ROUTE);

  const pages = [];
  for (const path of paths) {
    const route = routes.find((r) => r.path === path);
    const cut = page(path);
    if (cut.before !== first.before || cut.after !== first.after) throw new Error(`${path}: header or footer differs from the representative`);
    write(join(site, 'src', 'content', 'pages', `${slugOf(path)}.html`), rewireForms(unlazy(cut.content), live));
    pages.push({ path, slug: slugOf(path), template: route.template, bodyClass: cut.bodyClass, css: headCss(site, path) });
  }
  write(join(site, 'src', 'content', 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`);
  return { layouts, pages: pages.map((p) => p.path) };
}

// The thank-you page (forms.md): the plain page template, one line.
export function thankYouPage(site, live) {
  write(join(site, 'src', 'pages', 'thank-you.astro'), `---
import Page from '../layouts/Page.astro';
---
<Page head={{ title: ${js(`Thank you | ${NAME}`)}, description: 'Your message was sent.', canonical: ${js(`${live}/thank-you/`)}, robots: 'noindex' }} bodyClass="page-template-default page" css={${js(headCss(site, '/about/'))}}>
  <article class="page type-page"><h1 class="entry-title">Thank you</h1><p>Your message was sent. We will get back to you within one business day.</p></article>
</Page>
`);
}

// The rollout's extras: sitemaps at the live URLs, the feed, the captured 404, robots, the icons.
export async function rollout({ site, live }) {
  const capture = join(site, 'capture');
  const routes = readJson(join(site, 'baseline', 'routes.json'));
  // Sitemaps: the live files' names; each lists its live entries that are indexable 200 pages,
  // and any indexable page no live sitemap listed joins the first child.
  write(join(site, 'src', 'lib', 'sitemaps.mjs'), `// Sitemaps at the live URLs, generated from baseline/routes.json and capture/sitemaps/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import routes from '../../baseline/routes.json';
import { ORIGIN } from './site.mjs';

const KINDS = new Set(['page', 'post', 'archive']);
const read = (name) => readFileSync(join(process.cwd(), 'capture', 'sitemaps', name), 'utf8');
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\\/loc>/g)].map((m) => m[1]);
const indexable = routes.filter((r) => r.status === 200 && KINDS.has(r.kind) && !r.noindex).map((r) => r.path);
const children = locs(read('sitemap_index.xml')).map((loc) => new URL(loc).pathname.slice(1));
const listed = new Map(children.map((name) => [name, locs(read(name)).map((loc) => new URL(loc).pathname).filter((p) => indexable.includes(p))]));
const unlisted = indexable.filter((p) => ![...listed.values()].some((list) => list.includes(p)));
listed.get(children[0]).push(...unlisted);

const xml = (body) => new Response(\`<?xml version="1.0" encoding="UTF-8"?>\\n\${body}\\n\`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
export const sitemapIndex = () => xml(\`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\${children.map((c) => \`<sitemap><loc>\${ORIGIN}/\${c}</loc></sitemap>\`).join('')}</sitemapindex>\`);
export const sitemap = (name) => xml(\`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\${listed.get(name).map((p) => \`<url><loc>\${ORIGIN}\${p}</loc></url>\`).join('')}</urlset>\`);
export const childNames = children;
`);
  write(join(site, 'src', 'pages', 'sitemap_index.xml.js'), "import { sitemapIndex } from '../lib/sitemaps.mjs';\n\nexport const GET = () => sitemapIndex();\n");
  const children = readFileSync(join(capture, 'sitemaps', 'sitemap_index.xml'), 'utf8').match(/<loc>[^<]+<\/loc>/g).map((l) => basename(l.slice(5, -6)));
  for (const name of children) {
    write(join(site, 'src', 'pages', `${name}.js`), `import { sitemap } from '../lib/sitemaps.mjs';\n\nexport const GET = () => sitemap(${js(name)});\n`);
  }
  // Feeds: the captured feed served at its path through feed/index.xml (and the rewrite
  // redirects:build writes for it).
  const feeds = readJson(join(capture, 'feeds', 'index.json'));
  for (const route of routes.filter((r) => r.kind === 'feed' && r.status === 200)) {
    const entry = feeds.find((f) => f.path === route.path);
    write(join(site, 'src', 'pages', route.path.replace(/^\/|\/$/g, ''), 'index.xml.js'), `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GET = () => new Response(readFileSync(join(process.cwd(), 'capture', ${js(entry.file)}), 'utf8'), { headers: { 'Content-Type': ${js(entry.contentType)} } });
`);
  }
  // The captured 404 page's markup in its layout.
  const missing = routes.find((r) => r.status === 404 && r.snapshot);
  const record = readJson(join(capture, 'inventory.json')).find((r) => r.path === missing.path);
  const cut = cutPage(readFileSync(join(capture, missing.snapshot), 'utf8'));
  write(join(site, 'src', 'pages', '404.astro'), `---
import Other from '../layouts/Other.astro';
const html = ${js(cut.content)};
---
<Other head={{ title: ${js(record.title)}, description: ${js(record.description ?? undefined)}, robots: 'noindex' }} bodyClass=${js(cut.bodyClass)} css={${js(headCss(site, missing.path))}}><Fragment set:html={html} /></Other>
`);
  // robots.txt: the captured file is the indexable body, its sister-site Sitemap: line included.
  const robots = join(site, 'src', 'pages', 'robots.txt.js');
  writeFileSync(robots, readFileSync(robots, 'utf8')
    .replace("import { INDEXABLE, ORIGIN } from '../lib/site.mjs';", "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { INDEXABLE } from '../lib/site.mjs';")
    .replace('? `User-agent: *\\nAllow: /\\n\\nSitemap: ${ORIGIN}/sitemap.xml\\n`', "? readFileSync(join(process.cwd(), 'capture', 'robots.txt'), 'utf8')"));
  await writeIcons(site);
}

// An .ico holding one PNG image.
function icoFromPng(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

// The icon set pre-launch requires, drawn from the captured favicon (a decision row): favicon.svg,
// favicon.ico, a 180x180 apple-touch-icon.png and a manifest Base.astro links on every page.
async function writeIcons(site) {
  const svg = readFileSync(join(site, 'capture', 'assets', 'favicon.svg'));
  write(join(site, 'public', 'favicon.svg'), svg);
  const browser = await chromium.launch();
  const shots = {};
  try {
    const page = await browser.newPage();
    for (const size of [32, 180]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<body style="margin:0;background:#fff"><img style="display:block;width:${size}px;height:${size}px;object-fit:contain" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body>`);
      shots[size] = await page.screenshot({ type: 'png' });
    }
  } finally {
    await browser.close();
  }
  write(join(site, 'public', 'apple-touch-icon.png'), shots[180]);
  write(join(site, 'public', 'favicon.ico'), icoFromPng(shots[32], 32));
  write(join(site, 'public', 'site.webmanifest'), `${JSON.stringify({ name: NAME, short_name: NAME, start_url: '/', display: 'browser', icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] }, null, 2)}\n`);
  const layout = join(site, 'src', 'layouts', 'Base.astro');
  const links = '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n    <link rel="manifest" href="/site.webmanifest" />\n    <slot name="head" />';
  writeFileSync(layout, readFileSync(layout, 'utf8').replace('<slot name="head" />', links));
}

const SCOPED_GATES = ['forms', 'headers', 'media', 'routes', 'scripts', 'seo', 'text'];

// The seven path-scoped gates of phase 6, each run alone; P empty means every path.
export async function scopedGates(site, P) {
  const results = {};
  for (const gate of SCOPED_GATES) {
    const args = [...(P ? ['--paths', P] : []), ...(gate === 'forms' ? FORM_FLAGS : []), ...(gate === 'routes' ? ['--allow-extra', '/thank-you/'] : [])];
    results[gate] = await node(site, join(site, 'scripts', 'verify', `${gate}.mjs`), args);
  }
  return results;
}

// The design lock on the template set: shoot new against the local preview, diff, styles, sheet.
export async function templateReview(site, live, preview) {
  const run = (script, args) => npm(site, ['run', `review:${script}`, '--', ...args]);
  const shoot = expectCode(await run('shoot', ['--base', preview, '--routes', 'capture/templates.json', '--widths', WIDTHS.join(','), '--out', 'review/new', '--delay', '0', '--wait', '200']));
  const diff = await run('diff', ['--a', 'capture/screens/live', '--b', 'review/new', '--out', 'review/diff']);
  const styles = await run('styles', ['--live', live, '--new', preview, '--routes', 'capture/templates.json', '--out', 'review/styles.json', '--delay', '0']);
  const sheet = expectCode(await run('sheet', ['--live', 'capture/screens/live', '--new', 'review/new', '--diff', 'review/diff/diff.json', '--styles', 'review/styles.json', '--out', 'review/index.html']));
  return { shoot, diff, styles, sheet };
}

export async function build({ site, live }) {
  await S(site, 'phase', 'build');
  const media = await mediaAndCss({ site });
  const templateList = readJson(join(site, 'capture', 'templates.json'));
  const P = templateList.map((t) => t.representative).join(',');
  const made = templates({ site, live, paths: templateList.map((t) => t.representative) });
  thankYouPage(site, live);
  // The decision row's redirect (redirects.csv, source "decision", the decision id in note).
  const deleted = state(site).decisions.find((d) => d.topic.startsWith('/deleted-post/'));
  appendFileSync(join(site, 'redirects.csv'), `/deleted-post/,/blog/,301,decision,${deleted.id}\n`);
  const redirects = expectCode(await npm(site, ['run', 'redirects:build']));
  expectCode(await npm(site, ['run', 'build']));
  const templateGates = await scopedGates(site, P);
  const preview = await reviewServe(site);
  let lock;
  try {
    lock = await templateReview(site, live, preview.origin);
  } finally {
    await preview.close();
  }
  await commit(site, 'feat: templates');

  const all = readJson(join(site, 'baseline', 'routes.json')).filter((r) => r.status === 200 && ['page', 'post', 'archive'].includes(r.kind)).map((r) => r.path);
  templates({ site, live, paths: all });
  await rollout({ site, live });
  const finalBuild = expectCode(await npm(site, ['run', 'build']));
  const allGates = await scopedGates(site, '');
  await commit(site, 'feat: every page, sitemaps, feed, 404, robots and icons');
  return { media, made, redirects, templateGates, lock, finalBuild, allGates };
}

// ---------------------------------------------------------------------------------------------
// 7. gates

export async function gates({ site }) {
  await S(site, 'phase', 'gates');
  expectCode(await npm(site, ['run', 'build']));
  const staging = await npm(site, ['run', 'verify', '--', ...VERIFY_FLAGS]);
  const stagingAbout = readFileSync(join(site, 'dist', 'about', 'index.html'), 'utf8');
  expectCode(await npm(site, ['run', 'build'], { env: { PUBLIC_INDEXABLE: 'true' } }));
  const release = await npm(site, ['run', 'verify:release', '--', ...VERIFY_FLAGS]);
  expectCode(await npm(site, ['run', 'build']));
  await setState(site, 'phases.gates.result', { verify: staging.code, release: release.code });
  return { staging, release, stagingAbout };
}

// ---------------------------------------------------------------------------------------------
// 8. visual

export async function visual({ site, live }) {
  await S(site, 'phase', 'visual');
  const preview = await reviewServe(site);
  try {
    const run = (script, args) => npm(site, ['run', `review:${script}`, '--', ...args]);
    // The template-set rerun and the two full shoots write apart: run together.
    const [templateSet, liveAll, newAll] = await Promise.all([
      templateReview(site, live, preview.origin),
      node(site, kit('visual-review', 'shoot.mjs'), ['--base', live, '--routes', 'capture/templates.json', '--full', '--widths', '390,1440', '--out', 'capture/screens/live-all', '--delay', '0', '--wait', '200']),
      run('shoot', ['--base', preview.origin, '--routes', 'capture/templates.json', '--full', '--widths', '390,1440', '--out', 'review/new-all', '--delay', '0', '--wait', '200']),
    ]);
    expectCode(liveAll);
    expectCode(newAll);
    const diffAll = await run('diff', ['--a', 'capture/screens/live-all', '--b', 'review/new-all', '--out', 'review/diff-all']);
    const sheetAll = expectCode(await run('sheet', ['--live', 'capture/screens/live-all', '--new', 'review/new-all', '--diff', 'review/diff-all/diff.json', '--out', 'review/all.html']));
    // The phase's proof: npm run review:check re-reads every diff and style row.
    const check = await npm(site, ['run', 'review:check']);
    return { templateSet, liveAll, newAll, diffAll, sheetAll, check };
  } finally {
    await preview.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 9. components

export async function components({ site }) {
  await S(site, 'phase', 'components');
  await setState(site, 'phases.components.result', 'skipped: off by default');
}

// ---------------------------------------------------------------------------------------------
// 10. prelaunch

// pre-launch runs the production build itself (PUBLIC_INDEXABLE=true) from a committed, pushed
// tree. vercel is not logged in, so the staging deploy is serveLikeVercel on the staging build
// (a preview: Vercel adds X-Robots-Tag: noindex); the release check serves the
// PUBLIC_INDEXABLE=true build the same way without it, which is what production serves.
export async function prelaunch({ site, live }) {
  await S(site, 'phase', 'prelaunch');
  await commit(site, 'chore: state before pre-launch');
  expectCode(await git(site, ['push', '-q', '-u', 'origin', 'astro-rebuild']));
  const preLaunch = await node(site, kit('pre-launch', 'pre-launch.mjs'), [
    '--dir', site, '--production-url', live, '--predecessor-url', live, '--ignore-dir', 'capture', '--out', join(site, 'review', 'pre-launch'),
  ], { env: { PUBLIC_INDEXABLE: 'true' } });
  const gate = readJson(join(site, 'review', 'pre-launch', 'gate.json'));
  const reconcile = await node(site, kit('convert-site', 'prelaunch-reconcile.mjs'), [
    '--findings', join('review', 'pre-launch', 'gate.json'), '--baseline', 'baseline', '--plan', join('docs', 'plan.md'), '--json',
  ]);

  expectCode(await npm(site, ['run', 'build']));
  const staging = await serveLikeVercel(site, { preview: true });
  let stagingLive;
  let audit;
  try {
    await setState(site, 'staging', staging.origin);
    stagingLive = await npm(site, ['run', 'verify:live', '--', '--base', staging.origin, '--baseline', 'baseline', '--expect-noindex', '--delay', '0']);
    audit = await node(site, kit('launch-audit', 'launch-audit.mjs'), ['--url', staging.origin, '--staging', '--ignore-robots', '--old-url', live, '--out', join(site, 'review', 'launch-audit')], { timeout: 600_000 });
  } finally {
    await staging.close();
  }
  for (const [from, to] of [['baseline.json', 'audit-baseline.json'], ['redirects.csv', 'audit-redirects.csv']]) {
    const file = join(site, 'review', 'launch-audit', from);
    if (existsSync(file)) cpSync(file, join(site, 'docs', 'launch', to));
  }

  expectCode(await npm(site, ['run', 'build'], { env: { PUBLIC_INDEXABLE: 'true' } }));
  const production = await serveLikeVercel(site);
  let releaseLive;
  try {
    releaseLive = await npm(site, ['run', 'verify:live', '--', '--base', production.origin, '--baseline', 'baseline', '--delay', '0']);
  } finally {
    await production.close();
  }
  return { preLaunch, gate, reconcile, stagingLive, audit, releaseLive };
}

// ---------------------------------------------------------------------------------------------
// 11. suggestions

// gates.json collected exactly as phases.md §11 does.
const COLLECT = "const fs=require('fs');const t=fs.readFileSync('.conversion/gates.out','utf8');const d=t.split(/^(?=\\{$)/m).map(s=>s.replace(/^All \\d+ gates passed\\s*$/m,'').trim()).filter(Boolean).map(JSON.parse);fs.writeFileSync('.conversion/gates.json',JSON.stringify(d,null,2)+'\\n')";

export async function suggestions({ site }) {
  await S(site, 'phase', 'suggestions');
  expectCode(await npm(site, ['run', 'build']));
  const out = await npm(site, ['run', '--silent', 'verify', '--', '--json', ...VERIFY_FLAGS]);
  writeFileSync(join(site, '.conversion', 'gates.out'), out.stdout);
  expectCode(await sh(process.execPath, ['-e', COLLECT], { cwd: site }));
  const suggest = expectCode(await node(site, kit('suggest-improvements', 'suggest.mjs'), [
    '--capture', 'capture', '--baseline', 'baseline', '--review', 'review', '--gates', '.conversion/gates.json', '--out', 'docs/suggestions.md', '--json', 'suggestions.json',
  ]));
  appendFileSync(join(site, 'docs', 'suggestions.md'), '\n## From the review\n\n- No difference at 0.5 % or more on any template or page; nothing to add from the visual review.\n');
  return { suggest, gatesOut: out, gatesJson: readJson(join(site, '.conversion', 'gates.json')) };
}

// ---------------------------------------------------------------------------------------------
// 12. pr

export async function pr({ site, results }) {
  await S(site, 'phase', 'pr');
  const needsYou = state(site).needsYou;
  appendFileSync(join(site, 'docs', 'LAUNCH.md'), `\n## Run-specific needs\n\n${needsYou.map((n) => `- [ ] ${n}`).join('\n')}\n`);
  const body = [
    '## What changed', '', `WordPress site at its live origin converted to static Astro on Vercel; media in the repository.`, '',
    '## Gate output', '', '```', results.gates.staging.stdout.trim(), '```', '',
    '## Not covered', '', '### pre-launch', '', ...results.prelaunch.gate.checks.filter((c) => c.status === 'skip').map((c) => `- ${c.id}: ${c.detail}`), '',
    '## Waiting on you', '', ...needsYou.map((n) => `- ${n}`), '',
  ].join('\n');
  write(join(site, '.conversion', 'pr-body.md'), body);
  await commit(site, 'docs: launch runbook');
  expectCode(await npm(site, ['run', 'build']));
  const verify = await npm(site, ['run', 'verify', '--', ...VERIFY_FLAGS]);
  const check = await npm(site, ['run', 'review:check']);
  expectCode(await git(site, ['push', '-q', 'origin', 'astro-rebuild']));
  await setState(site, 'needsYou', [...needsYou, 'open the PR: gh pr create --base main --head astro-rebuild --body-file .conversion/pr-body.md']);
  await setState(site, 'phases.pr.result', { pr: null, draft: false, body: '.conversion/pr-body.md' });
  // The last phase has no next one to stamp it.
  await setState(site, 'phases.pr.finishedAt', new Date().toISOString());
  return { verify, check };
}

// ---------------------------------------------------------------------------------------------
// Serving the build.

// A port nothing listens on right now (the OS picks it).
function freePort() {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

// npm run review:serve on a free port in the background, as phases.md's "Serve, then wait" does:
// it returns once the server answers this site's dist/, and exits 2 when another process holds the
// port, so another run's server or a leftover one is never shot. close() runs review:serve --stop.
export async function reviewServe(site) {
  const port = await freePort();
  expectCode(await npm(site, ['run', 'review:serve', '--', '--background', '--port', String(port)]));
  return { origin: `http://localhost:${port}`, close: () => npm(site, ['run', 'review:serve', '--', '--stop']) };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.xml': 'application/xml', '.css': 'text/css', '.js': 'text/javascript',
  '.txt': 'text/plain', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// A local stand-in for a Vercel deployment of dist/: vercel.json's redirects (one hop per
// request) and exact rewrites through the parity gates' Vercel resolver, its catch-all headers,
// then the files (a directory path serves only its index.html). `preview` adds the
// X-Robots-Tag: noindex Vercel sends on preview deployments.
function fileFor(dist, urlPath) {
  const path = urlPath.replace(/^\/+/, '');
  const candidates = !path ? ['index.html'] : path.endsWith('/') ? [`${path}index.html`] : [path, `${path}/index.html`];
  return candidates.map((c) => join(dist, c)).find((f) => f.startsWith(dist + sep) && existsSync(f) && statSync(f).isFile()) ?? null;
}

export function serveLikeVercel(site, { preview = false } = {}) {
  const dist = join(site, 'dist');
  const config = readJson(join(site, 'vercel.json'));
  const resolveUrl = vercelResolver({ config, dist });
  const headers = Object.fromEntries((config.headers ?? []).filter((r) => r.source === '/(.*)').flatMap((r) => r.headers).map(({ key, value }) => [key, value]));
  if (preview) headers['X-Robots-Tag'] = 'noindex';
  const server = createServer((req, res) => {
    const { hops } = resolveUrl(req.url);
    if (hops.length) {
      res.writeHead(hops[0].status, { ...headers, Location: hops[0].to });
      return res.end();
    }
    const requested = decodeURIComponent(req.url.split('?')[0]);
    const rewrite = (config.rewrites ?? []).find((r) => r.source === requested);
    const file = fileFor(dist, requested) ?? (rewrite ? fileFor(dist, rewrite.destination) : null);
    if (!file) {
      const notFound = join(dist, '404.html');
      res.writeHead(404, { ...headers, 'Content-Type': TYPES['.html'] });
      return res.end(existsSync(notFound) ? readFileSync(notFound) : 'Not found');
    }
    const body = readFileSync(file);
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()); }) });
    });
  });
}

