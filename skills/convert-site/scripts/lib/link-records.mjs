// The hrefs of one captured page that the links gate will find broken in a build that keeps them as
// captured: WordPress API head links (nothing answers them on a static host) and links to pages
// live itself answered 404 or 410. Each is { href, kind: "api" | "broken" }, href exactly as the
// gate reads the attribute (trimmed), each once per page.
import { parse } from 'parse5';

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;
const relTokens = (node) => (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);

// The elements and attributes the links gate reads (parity-gates verify/links.mjs URL_ATTRS).
const URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  img: ['src', 'data-src', 'data-lazy-src'],
  source: ['src', 'data-src'],
  script: ['src'],
  iframe: ['src', 'data-src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
};

const API_RELS = new Set(['https://api.w.org/', 'edituri']);
const API_PATH = /^\/(?:wp-json(?:\/|$)|xmlrpc\.php$)/;

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function elements(node, out = []) {
  if (node.tagName in URL_ATTRS) out.push(node);
  for (const child of node.childNodes ?? []) elements(child, out);
  if (node.content) elements(node.content, out);
  return out;
}

// html: the captured page; pageUrl: its live URL; internal(url): whether the gate checks it;
// brokenPaths: paths live answered 404 or 410; resolves(path): whether a redirect now covers it.
export function linkRecords(html, { pageUrl, internal, brokenPaths, resolves = () => false }) {
  const found = new Map();
  for (const node of elements(parse(html))) {
    const rels = node.tagName === 'link' ? relTokens(node) : [];
    if (rels.includes('canonical')) continue;
    for (const name of URL_ATTRS[node.tagName]) {
      const href = attr(node, name)?.trim();
      if (!href || href.startsWith('#') || found.has(href)) continue;
      let url;
      try {
        url = new URL(href, pageUrl);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || !internal(url)) continue;
      const path = decode(url.pathname);
      if (node.tagName === 'link' && (rels.some((r) => API_RELS.has(r)) || API_PATH.test(path))) found.set(href, 'api');
      else if ((brokenPaths.has(path) || brokenPaths.has(`${path}${url.search}`)) && !resolves(path)) found.set(href, 'broken');
    }
  }
  return [...found].map(([href, kind]) => ({ href, kind }));
}
