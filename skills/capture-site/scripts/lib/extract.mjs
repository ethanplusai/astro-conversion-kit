// One page's inventory record from its HTML. Pure: HTML string and URL in, record out.
// extractPage(html, url, { status, finalUrl, snapshot }) -> one inventory.json record (the fields
// returned at the end of extractPage). Besides the inventory fields it carries
// `alternates[]` ({ href, type, hreflang } from <link rel=alternate>) and `shortlink` (from
// <link rel=shortlink>: a site-relative path such as `/?p=7` when on the same site) so the
// crawler can use them without parsing the page twice.
import { attr, byTag, find, findAll, parseHtml, walk } from '../../../parity-gates/scripts/lib/html.mjs';
import { visibleText } from '../../../parity-gates/scripts/lib/visible-text.mjs';
import { jsonLdBlocks, jsonLdNodes, jsonLdTypes, metaMaps, relTokens, textOf } from '../../../parity-gates/scripts/lib/head.mjs';
import { detectVendor } from '../../../parity-gates/scripts/lib/vendors.mjs';
import { formFields } from '../../../parity-gates/scripts/lib/forms.mjs';

const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

const bareHost = (host) => host.toLowerCase().replace(/^www\./, '');
const unique = (values) => [...new Set(values)];

function resolver(base) {
  return (href) => {
    if (href === null || href === undefined) return null;
    const trimmed = String(href).trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed, base).href;
    } catch {
      return null;
    }
  };
}

function absoluteSrcset(srcset, resolve) {
  if (!srcset) return null;
  return srcset
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return [resolve(url) ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}

// A <script type> that loads code other than a classic script.
const SCRIPT_KINDS = { module: 'module', importmap: 'importmap' };

// The file URLs an import map names: its `imports` values and every `scopes` entry's values.
// A value ending in "/" maps a path prefix, not a file, and is skipped; broken JSON names none.
function importMapUrls(code) {
  let map;
  try {
    map = JSON.parse(code);
  } catch {
    return [];
  }
  const tables = [map?.imports, ...Object.values(map?.scopes ?? {})];
  return tables
    .flatMap((table) => (table && typeof table === 'object' ? Object.values(table) : []))
    .filter((value) => typeof value === 'string' && value.trim() && !value.trim().endsWith('/'));
}

function toInt(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

export function extractPage(html, url, { status = null, finalUrl = null, snapshot = null } = {}) {
  const page = new URL(url);
  const document = parseHtml(html);
  const baseHref = attr(find(document, byTag('base')) ?? {}, 'href');
  const resolve = resolver(resolver(page.href)(baseHref) ?? page.href);
  const { og, twitter, named } = metaMaps(document);

  const links = findAll(document, byTag('link'));
  const linkHref = (rel) => links.filter((n) => relTokens(n).includes(rel)).map((n) => resolve(attr(n, 'href'))).filter(Boolean);

  const headings = (tag) => findAll(document, byTag(tag)).map(textOf).filter(Boolean);
  const body = find(document, byTag('body'));
  const titleNode = find(document, byTag('title'));

  const images = [];
  for (const img of findAll(document, byTag('img'))) {
    const lazySrc = LAZY_SRC.map((name) => attr(img, name)).find(Boolean);
    const src = resolve(lazySrc ?? attr(img, 'src'));
    if (!src || src.startsWith('data:')) continue;
    const srcset = LAZY_SRCSET.map((name) => attr(img, name)).find(Boolean) ?? attr(img, 'srcset');
    images.push({
      src,
      srcset: absoluteSrcset(srcset, resolve),
      alt: attr(img, 'alt'),
      width: toInt(attr(img, 'width')),
      height: toInt(attr(img, 'height')),
      lazy: Boolean(lazySrc) || (attr(img, 'loading') ?? '').toLowerCase() === 'lazy',
    });
  }

  const iframes = unique(
    findAll(document, byTag('iframe'))
      .map((n) => resolve(attr(n, 'src') ?? attr(n, 'data-src')))
      .filter((src) => src && src !== 'about:blank'),
  );

  const forms = findAll(document, byTag('form')).map((form) => ({
    action: attr(form, 'action') || null,
    method: (attr(form, 'method') || 'get').toLowerCase(),
    fields: formFields(form),
  }));

  // One entry per <script> element (kind "script", "module" or "importmap"), each URL an import
  // map names right after its element (kind "importmap"), then each <link rel=modulepreload>
  // (kind "modulepreload"). A file URL listed by an earlier map or link is not listed again.
  const scripts = [];
  const listed = new Set();
  const addFile = (src, kind) => {
    if (!src || listed.has(src)) return;
    listed.add(src);
    scripts.push({ src, inline: false, kind, ...detectVendor(src, '') });
  };
  for (const n of findAll(document, byTag('script'))) {
    const type = (attr(n, 'type') ?? '').trim().toLowerCase();
    if (type === 'application/ld+json') continue;
    const kind = SCRIPT_KINDS[type] ?? 'script';
    const src = resolve(attr(n, 'src'));
    const code = src ? '' : n.childNodes.map((c) => c.value ?? '').join('');
    if (src) listed.add(src);
    scripts.push({ src, inline: !src, kind, ...detectVendor(src, code) });
    if (kind === 'importmap' && !src) for (const url of importMapUrls(code)) addFile(resolve(url), 'importmap');
  }
  for (const href of linkHref('modulepreload')) addFile(href, 'modulepreload');

  const styles = [];
  walk(document, (n) => {
    if (n.tagName === 'link' && relTokens(n).includes('stylesheet')) {
      const href = resolve(attr(n, 'href'));
      if (href) styles.push({ href, inline: false });
    } else if (n.tagName === 'style') styles.push({ href: null, inline: true });
    return undefined;
  });

  const internalLinks = [];
  const externalLinks = [];
  for (const a of findAll(document, (n) => n.tagName === 'a' || n.tagName === 'area')) {
    const href = resolve(attr(a, 'href'));
    if (!href) continue;
    const target = new URL(href);
    if (!/^https?:$/.test(target.protocol)) continue;
    target.hash = '';
    if (bareHost(target.hostname) === bareHost(page.hostname)) internalLinks.push(target.pathname + target.search);
    else externalLinks.push(target.href);
  }

  const blocks = jsonLdBlocks(document);
  const ldNodes = jsonLdNodes(blocks);
  const ldValue = (key) => ldNodes.map((n) => n[key]).find((v) => typeof v === 'string') ?? null;
  const text = visibleText(html);

  return {
    url: page.href,
    path: page.pathname + page.search,
    status,
    finalUrl: finalUrl ?? page.href,
    title: titleNode ? textOf(titleNode) : null,
    description: named.description ?? null,
    canonical: linkHref('canonical')[0] ?? null,
    robots: named.robots ?? null,
    lang: attr(find(document, byTag('html')) ?? {}, 'lang'),
    h1: headings('h1'),
    h2: headings('h2'),
    h3: headings('h3'),
    og,
    twitter,
    jsonLd: blocks,
    jsonLdTypes: jsonLdTypes(blocks),
    published: named['article:published_time'] ?? ldValue('datePublished'),
    modified: named['article:modified_time'] ?? og.updated_time ?? ldValue('dateModified'),
    wordCount: text ? text.split(/\s+/).length : 0,
    bodyClasses: (attr(body ?? {}, 'class') ?? '').split(/\s+/).filter(Boolean),
    images,
    iframes,
    forms,
    scripts,
    styles,
    internalLinks: unique(internalLinks),
    externalLinks: unique(externalLinks),
    snapshot,
    text,
    alternates: alternatesOf(links, resolve),
    shortlink: sitePath(linkHref('shortlink')[0] ?? null, page),
  };
}

function alternatesOf(links, resolve) {
  const seen = new Set();
  const found = [];
  for (const n of links.filter((l) => relTokens(l).includes('alternate'))) {
    const href = resolve(attr(n, 'href'));
    if (!href || seen.has(href)) continue;
    seen.add(href);
    found.push({ href, type: (attr(n, 'type') || '').toLowerCase() || null, hreflang: attr(n, 'hreflang') || null });
  }
  return found;
}

// Same-site URLs become a path with their query; other sites stay absolute.
function sitePath(href, page) {
  if (!href) return null;
  const url = new URL(href);
  return bareHost(url.hostname) === bareHost(page.hostname) ? url.pathname + url.search : url.href;
}
