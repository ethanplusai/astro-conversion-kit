// The stylesheets of one captured page, in document order: what its <head> links and inlines
// (the order the cascade depends on), and every <link rel="stylesheet"> anywhere in the page
// with its media attribute. A block theme interleaves linked sheets and <style> blocks in a
// page-specific order, so the build reproduces each page's own list instead of one merged file.
import { parse } from 'parse5';

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value ?? null;
const isSheet = (node) => node.tagName === 'link'
  && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet');

function resolve(href, base) {
  try {
    const url = new URL(href.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// html: the captured page; base: its URL. Returns { head, links }: head is
// [{ kind: 'link', href, media } | { kind: 'inline', text }] for the <head> in order (href
// absolute, media null when the link has none), links every stylesheet link in the document.
export function pageStyles(html, base) {
  const head = [];
  const links = [];
  const walk = (node, inHead) => {
    if (isSheet(node)) {
      const href = attr(node, 'href') && resolve(attr(node, 'href'), base);
      if (href) {
        const link = { kind: 'link', href, media: attr(node, 'media')?.trim() || null };
        links.push(link);
        if (inHead) head.push(link);
      }
    } else if (node.tagName === 'style' && inHead) {
      head.push({ kind: 'inline', text: node.childNodes.map((c) => c.value ?? '').join('') });
    }
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child, inHead || node.tagName === 'head');
  };
  walk(parse(html), false);
  return { head, links };
}
