#!/usr/bin/env node
// Prunes the captured CSS, dropping the rules no page used according to css-coverage.mjs and
// keeping the ones coverage cannot see: by default each linked stylesheet on its own at its live
// path and each page's <style> blocks in that page's order; --single-sheet merges all into one.
// Exit codes: 0 written, 1 a stylesheet file had no matching coverage (kept whole), 2 usage or input error.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';
import { assertNodeVersion } from './lib/node-version.mjs';
import { scopeInlineRules } from './lib/inline-scope.mjs';
import { pageStyles } from './lib/head-css.mjs';

const HELP = `Usage: node css-prune.mjs --css <capture/css dir> --coverage coverage.json
                         --report prune-report.json
                         [--public public] [--inline-out src/styles/inline]
                         [--capture <capture dir>]
                         [--widths 390,768,1440] [--origin https://www.example.com]
       node css-prune.mjs --single-sheet --css <capture/css dir> --coverage coverage.json
                         --out <site.css> --report prune-report.json [--pages-out <dir>]

Default (per sheet): live serves each page its own list of <link rel="stylesheet"> and
<style> blocks in a page-specific order, and equal-specificity rules resolve by that
order, so merging them changes the cascade (block themes above all). Each page's
<head> list is read from --capture (default: the folder holding --css):
inventory.json and the pages/ snapshots.
  - Every same-origin stylesheet a page links (anywhere in the page) is pruned on
    its own, with the coverage of its own href only (identical sheets under two
    paths, as a multisite has, never share coverage), and written to
    <--public>/<its live path>; the query string is dropped from the file name.
    One pathname under several queries with the same bytes is one file pruned
    with all their coverages; with other bytes the later one is written to the
    path with its query before the extension (style.css?ver=2 -> style.ver-2.css)
    and its pages link that. The site's host with or without www., on http or
    https, counts as the site. A captured sheet only an @import reaches, whose
    @import stays in the output (an unparsable parent, or an unparsable child
    kept as an @import), is written at its live path too.
  - Every distinct <style> block in a page's <head> is pruned against the
    inline:<n> coverage entries of the same text and written to
    <--inline-out>/inline-<page slug>-<n>.css, named after the first page that
    has it (n counts that page's head <style> blocks); every inline-*.css already
    there is removed first. A block no coverage saw is kept whole and listed in
    uncoveredInline.
  - report.heads maps each captured path to its head list in live order:
    { kind: "link", href, media? } (href root-relative with live's query for a
    same-origin sheet, absolute for another origin's, left as live links it) and
    { kind: "inline", file }. The build passes it to Base.astro per page.
  - No site.css is written: every rule stays in its live sheet or page
    (report.siteCss is null).
  - A sheet linked with a media attribute no tested width satisfies (print) is
    kept whole: coverage runs on screen only. Its link keeps the media attribute.
  - A same-origin link whose sheet was not captured is left out of heads and
    listed in notCaptured; another origin's sheets are listed in external.

--single-sheet: one stylesheet of every .css file in --css (in
capture/css/manifest.json order when present, [{ file, href|inline, pages[] }]),
for a simple classic theme: one theme sheet and no <style> blocks whose order
matters. Coverage URLs match a manifest href or finalUrl on path and query,
ignoring the origin (then on path alone); without a manifest they match a file of
the same basename. inline:<n> entries (one <style> block each) match every inline
file (inline-<slug>.css, a page's blocks) that contains their text, trimmed, and
serves one of their pages; an inline file's kept rules follow a comment naming its
pages and file. A sheet linked with a media attribute other than "all" on every
page (read from --capture when its inventory exists) is wrapped in that @media;
its @layer statements and kept @import rules stay at the top of the file, in order,
each @import with that media added (one with its own media list is kept as written,
with a line on stderr).

Per-page inline rules (--single-sheet): when two inline files have a rule with the
same selector (inside the same @media, @supports or @layer) and other declarations,
as block themes print with counter classes (.wp-elements-1 a { color: white }
on one page, { color: black } on another), that rule, and every inline rule
whose selector names one of its classes, is left out of --out and written to
<--pages-out>/<inline file name> (default: a pages/ folder beside --out), one
file per inline file, for the build to link only on that file's pages. Rules
the inline files agree on, and blocks pages share, stay in --out.

Kept:
  - every rule any page used (its range overlaps a used range)
  - every rule whose selector contains :hover :focus :active :visited :target
    :checked ::before ::after :nth or :not( and, beyond those, ::selection
    ::placeholder :disabled :invalid :focus-visible :focus-within
  - every rule in a coverage entry's stateRanges: an interaction state (.open,
    .is-open, .menu-open, .active, .expanded, .show, .visible,
    [aria-expanded="true"], [open] and the like) whose element was on a covered
    page, so the state a script turns on (an open mobile menu) survives
  - every @font-face, @keyframes, @namespace, @layer statement and
    @supports block, and everything inside @media (prefers-*)
  - every @media block that none of --widths satisfies (print, very wide or
    narrow queries, features this script cannot evaluate): no evidence, no removal
  - other @media blocks only when a rule inside them is kept
A stylesheet file that no coverage entry matches is kept whole and the exit
code is 1. An inline file or block no coverage saw is kept whole too, listed in
uncoveredInline, and does not change the exit code. A sheet or block css-tree
cannot parse is kept byte for byte, listed in unparsed ({ href, error }) with one
line on stderr, and does not change the exit code.

Kept rules are copied from the source as written (comments inside them too);
a pruned @media block is its original prelude around the kept rules.

An @import whose target is a captured file (its manifest href or finalUrl,
resolved against the importing sheet's finalUrl or href) is dropped, and the
target's pruned rules take its place, before the importer's own rules, inside
the import's conditions (layer(x) as @layer x { }, supports() as @supports,
a media list as @media). A sheet is emitted once per output file, at the first
place it is reached; a later import of it adds nothing there.
A sheet imported under a media list none of --widths satisfies is kept whole.
An @import whose target was not captured (blocked-address, too-deep, 404, or
not in the manifest) is kept and listed in unresolvedImports.

Kept @import and @namespace rules, and @layer statements that come before a
file's first style rule, are moved to the top of the output file (layer statements
first, in source order, then imports, then namespaces), because CSS only allows
them there. This can change cascade order for a kept @import that sat after
an inlined one or in a later file. @charset is dropped.

Relative url() and @import references are rewritten against the stylesheet's
manifest finalUrl or href (inline blocks: their page): same-origin targets
become root-relative paths, other origins stay absolute; data:, # and
root-relative references are left alone. --origin is the site's origin; it
defaults to the most common origin among the manifest's hrefs and pages
(the coverage URLs when there is no manifest).

The report is { mode: "per-sheet" | "single-sheet", before: bytes, after: bytes,
removedRules: n, keptBecause: { pseudo: n, atRule: n, untestedMedia: n, state: n },
unmatched: [file], uncoveredInline: [file], unresolvedImports: [{ file, href, reason }],
unparsed: [{ href, error }], pageSheets: [{ file, pages, rules }] } and, per sheet,
siteCss: null, sheets: [{ href, file, bytesBefore, bytesAfter, rulesRemoved }],
inline: [{ file, pages, bytesBefore, bytesAfter, rulesRemoved }], external: [href],
notCaptured: [{ href, status }], heads: { <path>: [entry] }; where keptBecause
counts rules and blocks no page used that were kept by the exceptions above
(untestedMedia also counts sheets imported or linked under an untested media
list; state the rules kept for stateRanges, printed as "kept for state: N
rules"). Coverage written before stateRanges existed has none: run
css-coverage.mjs again so interaction states are kept.

  --widths       the viewport widths the coverage run used (default 390,768,1440)
  --public       folder the sheets go to at their live paths (default public)
  --inline-out   folder for the head <style> block files (default src/styles/inline)
  --capture      the capture folder (default: the folder holding --css)
  --single-sheet one merged --out instead; --out and --pages-out only work with it
  --pages-out    folder for the per-page sheets (default: pages/ beside --out);
                 written only when some page has rules of its own; every
                 inline-*.css already in it is removed first (other files stay)

Exit codes: 0 written, 1 a stylesheet file had no matching coverage (written, kept whole),
2 usage or input error.`;

const PSEUDO = /:hover|:focus|:active|:visited|:target|:checked|::before|::after|:nth|:not\(|::selection|::placeholder|:disabled|:invalid|:focus-visible|:focus-within/;
const KEEP_WHOLE = new Set(['font-face', 'keyframes', 'supports']);
const HEADER = new Set(['import', 'namespace']);
const DEFAULT_WIDTHS = [390, 768, 1440];
const VIEWPORT_HEIGHT = 900;
const PLACEHOLDER = 'http://placeholder.invalid';

class UsageError extends Error {}

const overlaps = (used, start, end) => used.some(([a, b]) => a < end && b > start);
const sourceOf = (text, node) => (node?.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : '');
const unprefixed = (name) => (csstree.vendorPrefix(name) ? name.slice(csstree.vendorPrefix(name).length) : name);

// --- media queries -----------------------------------------------------------

function toPx(value) {
  const match = /^(-?[\d.]+)(px|em|rem)?$/i.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] && match[2].toLowerCase() !== 'px' ? n * 16 : n;
}

// true, false, or null when the feature cannot be judged offline.
function featureMatches(feature, width) {
  const inner = feature.trim().toLowerCase();
  const plain = /^([a-z-]+)\s*(?::\s*(.+))?$/.exec(inner);
  if (plain) {
    const [, name, value] = plain;
    const dims = { width, height: VIEWPORT_HEIGHT };
    const dim = /^(min-|max-)?(width|height)$/.exec(name);
    if (dim && value !== undefined) {
      const px = toPx(value);
      if (px === null) return null;
      const actual = dims[dim[2]];
      if (dim[1] === 'min-') return actual >= px;
      if (dim[1] === 'max-') return actual <= px;
      return actual === px;
    }
    if (name === 'orientation') return value === (width > VIEWPORT_HEIGHT ? 'landscape' : 'portrait');
    if (name === 'hover' || name === 'any-hover') return value === undefined || value === 'hover';
    if (name === 'pointer' || name === 'any-pointer') return value === undefined || value === 'fine';
    if (name === 'color' && value === undefined) return true;
    return null;
  }
  // Range syntax: (width >= 600px), (400px <= width < 800px)
  const parts = inner.split(/\s*(<=|>=|<|>|=)\s*/);
  if (parts.length !== 3 && parts.length !== 5) return null;
  const compare = (a, op, b) => ({ '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b, '=': a === b })[op];
  const resolveSide = (side) => (side === 'width' ? width : side === 'height' ? VIEWPORT_HEIGHT : toPx(side));
  for (let i = 0; i + 2 < parts.length; i += 2) {
    const a = resolveSide(parts[i]);
    const b = resolveSide(parts[i + 2]);
    if (a === null || b === null) return null;
    if (!compare(a, parts[i + 1], b)) return false;
  }
  return true;
}

function queryMatches(query, width) {
  let q = query.trim().toLowerCase();
  let negate = false;
  if (q.startsWith('not ')) {
    negate = true;
    q = q.slice(4);
  } else if (q.startsWith('only ')) q = q.slice(5);
  let result = true;
  for (const term of q.split(/\s+and\s+/)) {
    const t = term.trim();
    let r;
    if (t === 'all' || t === 'screen') r = true;
    else if (/^[a-z]+$/.test(t)) r = false; // print, speech, tv...
    else if (t.startsWith('(') && t.endsWith(')') && !/\b(or|not)\b|\(.*\(/.test(t.slice(1, -1))) r = featureMatches(t.slice(1, -1), width);
    else r = null;
    if (r === null) return null;
    if (!r) result = false;
  }
  return negate ? !result : result;
}

// Whether any tested width satisfies a media query list.
export function mediaTested(prelude, widths = DEFAULT_WIDTHS) {
  const queries = prelude.split(',');
  return widths.some((width) => queries.some((query) => queryMatches(query, width) === true));
}

// --- url rewriting -------------------------------------------------------------

// Rewrites one url() or @import reference; returns null to leave it as written.
export function rewriteRef(ref, base, siteOrigin) {
  const value = ref.trim();
  if (!value || value.startsWith('#') || /^data:/i.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
  if (absolute && !/^https?:/i.test(value)) return null;
  if (!base) return null;
  let resolved;
  try {
    resolved = new URL(value, new URL(base, PLACEHOLDER));
  } catch {
    return null;
  }
  if (resolved.origin === PLACEHOLDER || resolved.origin === siteOrigin) {
    return resolved.pathname + resolved.search + resolved.hash;
  }
  return absolute || value.startsWith('//') ? null : resolved.href;
}

const quoteLike = (original, value) => {
  const q = original.includes('"') ? '"' : original.includes("'") ? "'" : '';
  return `${q}${value}${q}`;
};

// Every url() and @import string in the sheet that needs rewriting, as
// { start, end, text } replacements over the source.
function urlReplacements(ast, text, base, siteOrigin) {
  const replacements = [];
  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Url') {
        if (this.atrule && this.atrule.name.toLowerCase() === 'namespace') return;
        const original = sourceOf(text, node);
        // A url( css-tree recovered from (no closing parenthesis) is left as written.
        if (!original.trimEnd().endsWith(')')) return;
        const next = rewriteRef(node.value, base, siteOrigin);
        if (next === null) return;
        replacements.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: `url(${quoteLike(original, next)})` });
      } else if (node.type === 'String' && this.atrule && this.atrule.name.toLowerCase() === 'import'
        && this.atrulePrelude && this.atrule.prelude.children?.first === node) {
        const next = rewriteRef(node.value, base, siteOrigin);
        if (next === null) return;
        replacements.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: quoteLike(sourceOf(text, node), next) });
      }
    },
  });
  return replacements.sort((a, b) => a.start - b.start);
}

function sliceWith(text, start, end, replacements) {
  let out = '';
  let at = start;
  for (const r of replacements) {
    if (r.start < start || r.end > end) continue;
    out += text.slice(at, r.start) + r.text;
    at = r.end;
  }
  return out + text.slice(at, end);
}

// --- @import -------------------------------------------------------------------

// What an @import rule asks for: { href, layer, supports, media }. href is the target resolved
// against the sheet's base (null when it cannot be), layer is null, '' (anonymous) or a name,
// supports and media are the condition texts or null.
function importParts(node, { text, base, siteOrigin }) {
  const children = node.prelude?.children?.toArray() ?? [];
  const at = children.findIndex((child) => child.type === 'Url' || child.type === 'String');
  const parts = { href: null, layer: null, supports: null, media: null };
  if (at === -1) return parts;
  try {
    const url = new URL(String(children[at].value).trim(), new URL(base ?? '/', siteOrigin ?? PLACEHOLDER));
    if (/^https?:$/.test(url.protocol)) {
      url.hash = '';
      parts.href = url.href;
    }
  } catch {
    // left unresolved
  }
  for (const child of children.slice(at + 1)) {
    if (child.type === 'WhiteSpace') continue;
    const fn = child.type === 'Function' ? child.name.toLowerCase() : null;
    const inner = () => sourceOf(text, child).slice(child.name.length + 1, -1).trim();
    if (parts.layer === null && child.type === 'Identifier' && child.name.toLowerCase() === 'layer') parts.layer = '';
    else if (parts.layer === null && fn === 'layer') parts.layer = inner();
    else if (parts.supports === null && fn === 'supports') parts.supports = inner();
    else {
      parts.media = text.slice(child.loc.start.offset, node.prelude.loc.end.offset).trim() || null;
      break;
    }
  }
  return parts;
}

// An imported sheet's kept text inside the conditions its @import put on it.
function wrapImport(css, { layer, supports, media }) {
  let out = css;
  if (media) out = `@media ${media} {\n${out}\n}`;
  if (supports) out = `@supports ${/^(\(|not\b|selector\()/i.test(supports) ? supports : `(${supports})`} {\n${out}\n}`;
  if (layer !== null) out = `@layer${layer ? ` ${layer}` : ''} {\n${out}\n}`;
  return out;
}

// --- pruning -------------------------------------------------------------------

// Walks a list of rules and at-rules; returns the kept source text of each kept node.
function pruneList(list, ctx, header) {
  const { text, used, counts, widths } = ctx;
  const emit = (node) => sliceWith(text, node.loc.start.offset, node.loc.end.offset, ctx.replacements);
  const kept = [];
  let preamble = Boolean(header);
  list.forEach((node) => {
    if (!node.loc) return;
    const covered = overlaps(used, node.loc.start.offset, node.loc.end.offset);
    if (node.type === 'Rule') {
      preamble = false;
      if (covered) kept.push(emit(node));
      else if (PSEUDO.test(sourceOf(text, node.prelude))) {
        counts.pseudo += 1;
        kept.push(emit(node));
      } else if (overlaps(ctx.state, node.loc.start.offset, node.loc.end.offset)) {
        counts.state += 1;
        kept.push(emit(node));
      } else counts.removedRules += 1;
      return;
    }
    if (node.type === 'Comment') {
      if (node.value.startsWith('!')) kept.push(emit(node));
      return;
    }
    if (node.type !== 'Atrule') {
      kept.push(emit(node));
      return;
    }
    const name = unprefixed(node.name.toLowerCase());
    if (name === 'charset') return;
    if (header && (HEADER.has(name) || (name === 'layer' && !node.block && preamble))) {
      if (!covered) counts.atRule += 1;
      header[name === 'layer' ? 'layers' : `${name}s`].push(emit(node));
      if (name === 'import') ctx.importRefs.push(importParts(node, ctx));
      return;
    }
    preamble = false;
    const prelude = sourceOf(text, node.prelude);
    if (name === 'media' && /prefers-/i.test(prelude)) {
      if (!covered) counts.atRule += 1;
      kept.push(emit(node));
      return;
    }
    if (name === 'media' && !mediaTested(prelude, widths)) {
      if (!covered) counts.untestedMedia += 1;
      kept.push(emit(node));
      return;
    }
    const nested = node.block && !KEEP_WHOLE.has(name)
      && !node.block.children.some((child) => child.type === 'Declaration');
    if (nested) {
      const inner = pruneList(node.block.children, ctx, null);
      if (inner.length) {
        const opening = text.slice(node.loc.start.offset, node.block.loc.start.offset);
        kept.push(`${opening}{\n${inner.map((part) => `  ${part}`).join('\n')}\n}`);
      }
      return;
    }
    if (!covered) counts.atRule += 1;
    kept.push(emit(node));
  });
  return kept;
}

// Prunes one stylesheet's text against used [start, end] ranges into that text.
// options: { base, siteOrigin, widths, stateRanges }. Returns { css, header, imports,
// removedRules, keptBecause }; css holds the kept body, header the @layer statements, @import
// and @namespace rules that a combined file must put first, and imports what each
// of header.imports asks for ({ href, layer, supports, media }, same order).
// stateRanges are the unused interaction-state rules css-coverage saw the element of: kept.
export function pruneCss(text, usedRanges, { base, siteOrigin, widths = DEFAULT_WIDTHS, stateRanges = [] } = {}) {
  const ast = csstree.parse(text, { positions: true });
  const counts = { pseudo: 0, atRule: 0, untestedMedia: 0, state: 0, removedRules: 0 };
  const header = { layers: [], imports: [], namespaces: [] };
  const ctx = {
    text, used: usedRanges, state: stateRanges, counts, widths, base, siteOrigin, importRefs: [], replacements: urlReplacements(ast, text, base, siteOrigin),
  };
  const body = pruneList(ast.children, ctx, header);
  return {
    css: body.join('\n'),
    header,
    imports: ctx.importRefs,
    removedRules: counts.removedRules,
    keptBecause: { pseudo: counts.pseudo, atRule: counts.atRule, untestedMedia: counts.untestedMedia, state: counts.state },
  };
}

// Maps ranges taken in coverage text onto a file's text: unchanged when the texts
// match, shifted when the coverage text sits inside the file, and otherwise
// located rule by rule.
export function mapRanges(fileText, coverageText, usedRanges) {
  if (fileText === coverageText) return usedRanges;
  const at = fileText.indexOf(coverageText);
  if (at !== -1) return usedRanges.map(([start, end]) => [start + at, end + at]);
  const mapped = [];
  let from = 0;
  for (const [start, end] of usedRanges) {
    const segment = coverageText.slice(start, end);
    if (!segment) continue;
    let found = fileText.indexOf(segment, from);
    if (found === -1) found = fileText.indexOf(segment);
    if (found === -1) continue;
    mapped.push([found, found + segment.length]);
    from = found + segment.length;
  }
  return mapped;
}

// --- files and coverage ----------------------------------------------------------

// Path (and query) of a URL, ignoring its origin.
function pathKey(href, withSearch) {
  try {
    const url = new URL(href, PLACEHOLDER);
    return url.pathname + (withSearch ? url.search : '');
  } catch {
    return null;
  }
}

function urlBasename(href) {
  const path = pathKey(href, false);
  return path ? basename(path) : basename(href.split(/[?#]/)[0]);
}

function originOf(href) {
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${what} ${file}: ${error.message}`);
  }
}

// The .css files in source order: manifest order first, then the rest by name.
function listFiles(dir) {
  if (!existsSync(dir)) throw new UsageError(`--css ${dir} does not exist`);
  const names = readdirSync(dir).filter((name) => name.endsWith('.css'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const manifestFile = join(dir, 'manifest.json');
  const hasManifest = existsSync(manifestFile);
  const manifest = hasManifest ? readJson(manifestFile, 'manifest') : [];
  if (!Array.isArray(manifest)) throw new UsageError(`${manifestFile} is not a JSON array`);
  const byFile = new Map(manifest.filter((entry) => entry && names.includes(entry.file)).map((entry) => [entry.file, entry]));
  const ordered = [...byFile.keys(), ...names.filter((name) => !byFile.has(name))];
  const files = ordered.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8'), entry: byFile.get(name) }));
  return { files, hasManifest, manifest };
}

// The most common http(s) origin among the manifest's hrefs and pages, or
// among the coverage URLs when there is no manifest.
function guessOrigin(files, coverage) {
  const tally = new Map();
  const hrefs = files.flatMap(({ entry }) => [entry?.href, ...(entry?.pages ?? [])]);
  for (const href of hrefs.some(Boolean) ? hrefs : Object.keys(coverage)) {
    const origin = href && originOf(href);
    if (origin) tally.set(origin, (tally.get(origin) ?? 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// A sheet is known by its href and, when it redirected, by where it ended up.
const hrefsOf = (file) => [file.entry?.href, file.entry?.finalUrl].filter(Boolean);

function findFileForUrl(files, key) {
  const withHref = files.filter((f) => f.entry?.href);
  const exact = withHref.filter((f) => hrefsOf(f).some((href) => pathKey(href, true) === pathKey(key, true)));
  if (exact.length) return exact[0];
  const byPath = withHref.filter((f) => hrefsOf(f).some((href) => pathKey(href, false) === pathKey(key, false)));
  if (byPath.length === 1) return byPath[0];
  const byName = files.filter((f) => !f.entry?.href && f.name === urlBasename(key));
  return byName.length === 1 ? byName[0] : null;
}

// A capture's file of a page's <style> blocks (inline-<slug>.css), not a stylesheet file.
const isInline = (file) => (file.entry ? Boolean(file.entry.inline) : file.name.startsWith('inline-'));

// The files an inline:<n> coverage entry describes. The capture trims each block and joins a
// page's blocks into one file, so a block shared by pages with different block sets sits in
// several files: every inline file holding the block on one of the entry's pages gets it.
function inlineTargets(files, trimmed, pages = []) {
  const holders = files.filter((f) => isInline(f) && f.text.includes(trimmed));
  const onPage = holders.filter((f) => (f.entry?.pages ?? []).some((page) => pages.includes(page)));
  if (onPage.length) return onPage;
  if (holders.length) return holders;
  const any = files.find((f) => f.text.includes(trimmed));
  return any ? [any] : [];
}

// Gives each coverage entry to the file(s) it describes; returns Map<file name,
// { ranges, stateRanges, matched, url }>, url being the first coverage URL matched to the file.
function assignCoverage(files, coverage) {
  const assigned = new Map(files.map((file) => [file.name, { ranges: [], stateRanges: [], matched: false, url: null }]));
  for (const [key, { text = '', usedRanges = [], stateRanges = [], pages }] of Object.entries(coverage)) {
    if (key.startsWith('inline:')) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      const lead = text.length - text.trimStart().length;
      const shift = (ranges) => ranges.map(([start, end]) => [Math.max(0, start - lead), Math.min(trimmed.length, end - lead)])
        .filter(([start, end]) => end > start);
      for (const file of inlineTargets(files, trimmed, pages)) {
        const slot = assigned.get(file.name);
        slot.matched = true;
        slot.ranges.push(...mapRanges(file.text, trimmed, shift(usedRanges)));
        slot.stateRanges.push(...mapRanges(file.text, trimmed, shift(stateRanges)));
      }
      continue;
    }
    const file = findFileForUrl(files, key);
    if (!file) continue;
    const slot = assigned.get(file.name);
    slot.matched = true;
    slot.url ??= key;
    slot.ranges.push(...mapRanges(file.text, text, usedRanges));
    slot.stateRanges.push(...mapRanges(file.text, text, stateRanges));
  }
  return assigned;
}

// The comment that heads an inline file's kept rules in the combined stylesheet.
function inlineComment(file) {
  const pages = file.entry?.pages ?? [];
  const shown = pages.slice(0, 3).join(', ') + (pages.length > 3 ? ` and ${pages.length - 3} more` : '');
  const inner = `inline <style> blocks${shown ? ` of ${shown}` : ''} (${file.name})`;
  return `/* ${inner.replaceAll('*/', '* /')} */`;
}

// The comment that heads a per-page sheet.
function pageComment(file) {
  const inner = `rules of the inline <style> blocks of ${(file.entry?.pages ?? []).join(', ') || file.name} (${file.name}) `
    + 'that another page defines differently: link this file only on these pages';
  return `/* ${inner.replaceAll('*/', '* /')} */`;
}

const emptyReport = (mode) => ({
  mode,
  before: 0,
  after: 0,
  removedRules: 0,
  keptBecause: { pseudo: 0, atRule: 0, untestedMedia: 0, state: 0 },
  unmatched: [],
  uncoveredInline: [],
  unresolvedImports: [],
  unparsed: [],
  pageSheets: [],
});

// The capture's files and coverage, read and matched once for either mode.
function load({ css, coverage, origin }) {
  const { files, hasManifest, manifest } = listFiles(css);
  if (!files.length) throw new UsageError(`--css ${css} holds no .css files`);
  if (!hasManifest) console.error(`warning: no manifest.json in ${css}; relative url() references are resolved against the matched coverage URLs`);
  const siteOrigin = origin ?? guessOrigin(files, coverage);
  return { files, manifest, siteOrigin, assigned: assignCoverage(files, coverage) };
}

// Prunes text, or, when css-tree cannot parse it, keeps it byte for byte (listed under unparsed).
// Returns pruneCss's result, with unparsed: true and css the original text in the second case.
function pruneOrKeep(text, used, options, { report, name, href }) {
  try {
    return pruneCss(text, used, options);
  } catch (error) {
    report.unparsed.push({ href: href ?? name, error: error.message });
    console.error(`css-prune: could not parse ${name}${href ? ` (${href})` : ''}: ${error.message}; kept it byte for byte`);
    return {
      css: text, header: { layers: [], imports: [], namespaces: [] }, imports: [], removedRules: 0,
      keptBecause: { pseudo: 0, atRule: 0, untestedMedia: 0, state: 0 }, unparsed: true,
    };
  }
}

// render(file, { whole, emitted, header, inlineKept }) returns one file's kept text: the sheets it
// imports (each in place, inside the import's conditions, pruned in turn) and then its own rules.
// Each file is emitted once per emitted set; header collects the @layer statements, @import and
// @namespace rules that must come first; an inline file's own rules go to inlineKept when given.
// keepImport(target), when given (per-sheet mode), is called for an imported sheet css-tree cannot
// parse: its @import stays in the output and the caller serves it at its live path, byte for
// byte. Without it, such a sheet is inlined byte for byte with its url()s made root-relative.
function renderer({ files, manifest, siteOrigin, assigned, widths, report, keepImport = null }) {
  const parses = new Map();
  const parsable = (file) => {
    if (!parses.has(file.name)) {
      try {
        pruneCss(file.text, [], { widths });
        parses.set(file.name, true);
      } catch {
        parses.set(file.name, false);
      }
    }
    return parses.get(file.name);
  };
  // Why an @import target is not among the captured files.
  const unresolvedReason = (href) => {
    const entry = href && manifest.find((e) => e?.href === href || e?.finalUrl === href);
    if (!entry) return 'not captured';
    return entry.file ? 'file missing' : String(entry.status ?? 'not saved');
  };
  const render = (file, { whole = false, emitted, header, inlineKept }) => {
    emitted.add(file.name);
    const slot = assigned.get(file.name);
    const inline = isInline(file);
    let used = slot.ranges;
    if (!slot.matched) {
      if (inline) {
        report.uncoveredInline.push(file.name);
        console.error(`no coverage saw the <style> blocks in ${file.name}${file.entry?.pages?.length ? ` (${file.entry.pages.join(', ')})` : ''}; kept them whole`);
      } else {
        report.unmatched.push(file.name);
        console.error(`no coverage matched ${file.name}${file.entry?.href ? ` (${file.entry.href})` : ''}; kept it whole`);
      }
    }
    if (!slot.matched || whole) used = [[0, file.text.length]];
    const base = file.entry?.finalUrl ?? file.entry?.href ?? file.entry?.pages?.[0] ?? slot.url;
    const result = pruneOrKeep(file.text, used, { base, siteOrigin, widths, stateRanges: slot.stateRanges }, { report, name: file.name, href: file.entry?.href });
    report.before += Buffer.byteLength(file.text);
    report.removedRules += result.removedRules;
    for (const reason of Object.keys(report.keptBecause)) report.keptBecause[reason] += result.keptBecause[reason];
    header.layers.push(...result.header.layers);
    header.namespaces.push(...result.header.namespaces);
    const parts = [];
    result.imports.forEach((ref, i) => {
      const target = ref.href && files.find((f) => !isInline(f) && hrefsOf(f).includes(ref.href));
      if (!target) {
        const reason = unresolvedReason(ref.href);
        const href = ref.href ?? result.header.imports[i];
        header.imports.push(result.header.imports[i]);
        report.unresolvedImports.push({ file: file.name, href, reason });
        console.error(`css-prune: unresolved import in ${file.name}: ${href} (${reason}); kept as an @import`);
        return;
      }
      if (emitted.has(target.name)) return;
      if (keepImport && !parsable(target)) {
        header.imports.push(result.header.imports[i]);
        keepImport(target);
        return;
      }
      // A sheet imported under a media query no tested width satisfies has no evidence against any rule.
      const untested = ref.media !== null && !mediaTested(ref.media, widths);
      if (untested) report.keptBecause.untestedMedia += 1;
      const inner = render(target, { whole: whole || untested, emitted, header, inlineKept });
      if (inner) parts.push(wrapImport(inner, ref));
    });
    const own = result.unparsed && !keepImport ? rewriteRawRefs(file.text, base, siteOrigin) : result.css;
    if (own && inline && inlineKept) inlineKept.set(file.name, own);
    else if (own) parts.push(own);
    return parts.join('\n');
  };
  return render;
}

const newHeader = () => ({ layers: [], imports: [], namespaces: [] });
const withHeader = (header, body) => [...header.layers, ...header.imports, ...header.namespaces, ...body].join('\n');

// The stylesheet a link names: its manifest href or finalUrl, then the same path and query on
// any origin (one file only). Keyed by href, so identical sheets under two paths stay apart.
function fileForHref(files, href) {
  const sheets = files.filter((f) => !isInline(f) && f.entry?.href);
  const exact = sheets.find((f) => hrefsOf(f).includes(href));
  if (exact) return exact;
  const byPath = sheets.filter((f) => hrefsOf(f).some((h) => pathKey(h, true) === pathKey(href, true)));
  return byPath.length === 1 ? byPath[0] : null;
}

// Where a sheet captured under a query is served when another sheet with other bytes already
// has its pathname: the query, made file-name safe, before the extension
// (/t/style.css?ver=2 -> /t/style.ver-2.css). The routes gate names it the same way.
export function variantPath(pathname, search) {
  const tag = search.replace(/^\?/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'variant';
  const dot = pathname.lastIndexOf('.');
  return dot > pathname.lastIndexOf('/') ? `${pathname.slice(0, dot)}.${tag}${pathname.slice(dot)}` : `${pathname}.${tag}`;
}

// The site's own host, with or without www., on either scheme.
const bareHost = (href) => {
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) ? url.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

// The url() and @import references of a sheet css-tree cannot parse, rewritten by text as
// rewriteRef does (same-origin root-relative), for a sheet inlined away from its own path.
function rewriteRawRefs(text, base, siteOrigin) {
  const swap = (whole, quote, ref, wrap) => {
    const next = rewriteRef(ref, base, siteOrigin);
    return next === null ? whole : wrap(`${quote}${next}${quote}`);
  };
  return text
    .replace(/url\(\s*(['"]?)([^'"()\s]+)\1\s*\)/gi, (whole, quote, ref) => swap(whole, quote, ref, (v) => `url(${v})`))
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (whole, quote, ref) => swap(whole, quote, ref, (v) => `@import ${v}`));
}

// Every captured page's stylesheets ({ record, head, links } in inventory order), read from
// <capture>/inventory.json and the snapshots; null when the inventory is absent.
function capturedPages(capture) {
  const file = join(capture, 'inventory.json');
  if (!existsSync(file)) return null;
  const inventory = readJson(file, 'inventory');
  if (!Array.isArray(inventory)) throw new UsageError(`${file} is not a JSON array`);
  return inventory
    .filter((record) => record?.snapshot && existsSync(join(capture, record.snapshot)))
    .map((record) => ({ record, ...pageStyles(readFileSync(join(capture, record.snapshot), 'utf8'), record.finalUrl ?? record.url) }));
}

// The media a sheet is linked with, per file name: null when some page links it with no media
// attribute or "all" (no condition), otherwise the media lists joined.
function linkMedia(files, pages) {
  const seen = new Map();
  for (const { links } of pages ?? []) {
    for (const link of links) {
      const file = fileForHref(files, link.href);
      if (!file) continue;
      const list = seen.get(file.name) ?? new Set();
      list.add(link.media && link.media.toLowerCase() !== 'all' ? link.media : null);
      seen.set(file.name, list);
    }
  }
  return new Map([...seen].map(([name, list]) => [name, list.has(null) ? null : [...list].join(', ')]));
}

// A hoisted @import rule of a sheet linked under media: the media list added when the rule has
// none; one with its own media list is kept as written (two lists cannot be joined in general).
function importUnder(rule, media, name) {
  const node = csstree.parse(rule, { positions: true }).children.first;
  const parts = node?.type === 'Atrule' ? importParts(node, { text: rule, base: null, siteOrigin: null }) : null;
  if (!parts || parts.media) {
    console.error(`css-prune: ${rule.trim()} in ${name} has its own media list; kept as written, not under the link's media (${media})`);
    return rule;
  }
  return rule.replace(/\s*;?\s*$/, ` ${media};`);
}

// --single-sheet: one stylesheet of every captured file in source order, colliding per-page
// inline rules split into page sheets. A sheet every page links with a media attribute is
// wrapped in that @media (kept whole when no tested width satisfies it).
export function prune({ css, coverage, widths = DEFAULT_WIDTHS, origin, capture = dirname(css) }) {
  const loaded = load({ css, coverage, origin });
  const { files } = loaded;
  const report = emptyReport('single-sheet');
  const render = renderer({ ...loaded, widths, report });
  const media = linkMedia(files, capturedPages(capture));
  const header = newHeader();
  const emitted = new Set();
  const inlineKept = new Map(); // inline file name -> its kept rules, split by scopeInlineRules
  const bodies = [];
  for (const file of files) {
    if (emitted.has(file.name)) continue;
    const condition = media.get(file.name) ?? null;
    const untested = condition !== null && !mediaTested(condition, widths);
    if (untested) report.keptBecause.untestedMedia += 1;
    const own = newHeader();
    const text = render(file, { whole: untested, emitted, header: own, inlineKept });
    // CSS allows @import and @layer statements only at the top, so a wrapped sheet's stay there,
    // in order; its @import takes the link's media.
    header.layers.push(...own.layers);
    header.namespaces.push(...own.namespaces);
    header.imports.push(...(condition ? own.imports.map((rule) => importUnder(rule, condition, file.name)) : own.imports));
    if (isInline(file)) bodies.push({ file, before: text });
    else if (text) bodies.push(condition ? wrapImport(text, { layer: null, supports: null, media: condition }) : text);
  }
  // Inline files are never import targets, so their kept rules are split once all are known.
  const scoped = scopeInlineRules([...inlineKept].map(([name, kept]) => ({ name, css: kept })));
  const pageSheets = [];
  const body = bodies.map((part) => {
    if (typeof part === 'string') return part;
    const { file, before } = part;
    const split = scoped.get(file.name);
    if (split?.rules) {
      const pages = file.entry?.pages ?? [];
      pageSheets.push({ file: file.name, pages, rules: split.rules, css: `${pageComment(file)}\n${split.own}\n` });
    }
    return [before, split?.shared ? `${inlineComment(file)}\n${split.shared}` : ''].filter(Boolean).join('\n');
  }).filter(Boolean);
  report.pageSheets = pageSheets.map(({ file, pages, rules }) => ({ file, pages, rules }));
  const output = `${withHeader(header, body)}\n`;
  report.after = Buffer.byteLength(output);
  return { output, report, pageSheets };
}

// The used and state ranges coverage saw for each distinct inline block, by its trimmed text.
function inlineCoverage(coverage) {
  const byText = new Map();
  for (const [key, { text = '', usedRanges = [], stateRanges = [] }] of Object.entries(coverage)) {
    if (!key.startsWith('inline:')) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    const lead = text.length - text.trimStart().length;
    const shift = (ranges) => ranges.map(([start, end]) => [Math.max(0, start - lead), Math.min(trimmed.length, end - lead)])
      .filter(([start, end]) => end > start);
    const slot = byText.get(trimmed) ?? { ranges: [], stateRanges: [] };
    slot.ranges.push(...shift(usedRanges));
    slot.stateRanges.push(...shift(stateRanges));
    byText.set(trimmed, slot);
  }
  return byText;
}

// The default: each linked stylesheet pruned on its own and written at its live path under
// publicDir, each page's head <style> blocks pruned into one file per distinct block, and every
// page's head stylesheet order in report.heads ({ kind: 'link', href, media? } and
// { kind: 'inline', file }). Returns { report, sheets: [{ path, css }], inline: [{ name, css }] }.
export function prunePerSheet({ css, coverage, widths = DEFAULT_WIDTHS, origin, capture = dirname(css), publicDir }) {
  const pages = capturedPages(capture);
  if (!pages) {
    throw new UsageError(`per-sheet mode reads each page's head from ${join(capture, 'inventory.json')} and its snapshots, `
      + 'which do not exist: pass --capture <capture dir>, or --single-sheet for one merged file');
  }
  const loaded = load({ css, coverage, origin });
  const { files, siteOrigin } = loaded;
  const report = { ...emptyReport('per-sheet'), siteCss: null, sheets: [], inline: [], external: [], notCaptured: [], heads: {} };
  const toWrite = [];
  const queued = new Set();
  const media = linkMedia(files, pages);
  const site = bareHost(siteOrigin);
  // The site's own host, www or not, on either scheme: served from public/, never from live.
  const sameSite = (href) => Boolean(site) && bareHost(href) === site;

  // Sheets by pathname: the same bytes under several queries are one file pruned with all their
  // coverages; other bytes under the same pathname go to variantPath, which their pages link.
  const own = files.filter((f) => !isInline(f) && f.entry?.href && sameSite(f.entry.href));
  const served = new Map(); // file name -> { primary, url } (url: the served path, root-relative)
  for (const file of own) {
    const { pathname, search } = new URL(file.entry.href);
    const twin = own.find((f) => served.has(f.name) && new URL(f.entry.href).pathname === pathname && f.text === file.text);
    if (twin) {
      const { primary, url } = served.get(twin.name);
      const [into, from] = [loaded.assigned.get(primary.name), loaded.assigned.get(file.name)];
      into.ranges.push(...from.ranges);
      into.stateRanges.push(...from.stateRanges);
      into.matched ||= from.matched;
      served.set(file.name, { primary, url });
      continue;
    }
    const taken = [...served.values()].some((s) => s.url === pathname);
    served.set(file.name, { primary: file, url: taken ? variantPath(pathname, search) : pathname });
  }
  const enqueue = (file) => {
    const primary = file && served.get(file.name)?.primary;
    if (!primary || queued.has(primary.name)) return;
    queued.add(primary.name);
    toWrite.push(primary);
  };
  const render = renderer({ ...loaded, widths, report, keepImport: enqueue });
  // A link's href: same-site sheets at the path they are served at, with live's query.
  const linkHref = (href) => {
    const file = fileForHref(files, href);
    const url = new URL(href);
    return (file && served.get(file.name)?.url) ?? url.pathname;
  };

  // Linked sheets in source order, then the sheets only an @import left in the output reaches,
  // each pruned with its own coverage only.
  const linked = new Set(pages.flatMap(({ links }) => links.map((link) => fileForHref(files, link.href)?.name).filter(Boolean)));
  for (const file of files) if (linked.has(file.name)) enqueue(file);
  const sheets = [];
  for (let i = 0; i < toWrite.length; i += 1) {
    const file = toWrite[i];
    const condition = media.get(file.name) ?? null;
    const untested = condition !== null && !mediaTested(condition, widths);
    if (untested) report.keptBecause.untestedMedia += 1;
    const before = { bytes: report.before, rules: report.removedRules, unparsed: report.unparsed.length };
    const header = newHeader();
    const body = render(file, { whole: untested, emitted: new Set(), header });
    const keptAsIs = report.unparsed.slice(before.unparsed).some((u) => u.href === file.entry.href);
    // An unparsable sheet keeps its @imports: the captured sheets they name are served too.
    if (keptAsIs) {
      const hrefs = hrefsOf(file);
      for (const child of files) if (child.entry?.importedBy?.some((h) => hrefs.includes(h))) enqueue(child);
    }
    const text = keptAsIs ? file.text : `${withHeader(header, [body].filter(Boolean))}\n`;
    const path = join(publicDir, decodeURIComponent(served.get(file.name).url));
    sheets.push({ path, css: text });
    report.after += Buffer.byteLength(text);
    const row = { file: path, bytesBefore: report.before - before.bytes, bytesAfter: Buffer.byteLength(text), rulesRemoved: report.removedRules - before.rules };
    for (const twin of own.filter((f) => served.get(f.name).primary === file)) report.sheets.push({ href: twin.entry.href, ...row });
  }

  // Head <style> blocks: one file per distinct block, named after the first page that has it.
  const covered = inlineCoverage(coverage);
  const blocks = new Map(); // trimmed text -> report.inline row
  const inline = [];
  for (const { record, head } of pages) {
    const slug = basename(record.snapshot).replace(/\.html?$/i, '');
    const list = [];
    let n = 0;
    for (const item of head) {
      if (item.kind === 'link') {
        const file = fileForHref(files, item.href);
        const entry = { kind: 'link', href: sameSite(item.href) ? linkHref(item.href) + new URL(item.href).search : item.href, ...(item.media ? { media: item.media } : {}) };
        if (!sameSite(item.href)) {
          if (!report.external.includes(item.href)) report.external.push(item.href);
        } else if (!file) {
          if (!report.notCaptured.some((row) => row.href === item.href)) {
            const status = loaded.manifest.find((e) => e?.href === item.href)?.status ?? 'not captured';
            report.notCaptured.push({ href: item.href, status });
            console.error(`css-prune: ${item.href} (linked by ${record.path}) was not captured (${status}); its link is left out`);
          }
          continue;
        }
        list.push(entry);
        continue;
      }
      n += 1;
      const trimmed = item.text.trim();
      if (!trimmed) continue;
      let row = blocks.get(trimmed);
      if (!row) {
        const name = `inline-${slug}-${n}.css`;
        const slot = covered.get(trimmed);
        if (!slot) {
          report.uncoveredInline.push(name);
          console.error(`no coverage saw the <style> block ${name} (${record.path}); kept it whole`);
        }
        const used = slot ? slot.ranges : [[0, trimmed.length]];
        const result = pruneOrKeep(trimmed, used, { base: record.finalUrl ?? record.url, siteOrigin, widths, stateRanges: slot?.stateRanges ?? [] }, { report, name: `${name} (${record.path})` });
        const text = result.unparsed ? item.text : `${withHeader(result.header, [result.css].filter(Boolean))}\n`;
        report.before += Buffer.byteLength(trimmed);
        report.after += Buffer.byteLength(text);
        report.removedRules += result.removedRules;
        for (const reason of Object.keys(report.keptBecause)) report.keptBecause[reason] += result.keptBecause[reason];
        row = { file: name, pages: [], bytesBefore: Buffer.byteLength(trimmed), bytesAfter: Buffer.byteLength(text), rulesRemoved: result.removedRules };
        blocks.set(trimmed, row);
        report.inline.push(row);
        inline.push({ name, css: text });
      }
      if (!row.pages.includes(record.path)) row.pages.push(record.path);
      list.push({ kind: 'inline', file: row.file });
    }
    report.heads[record.path] = list;
  }
  return { report, sheets, inline };
}

function parseWidths(value) {
  return value.split(',').map((w) => {
    const width = Number(w.trim());
    if (!Number.isInteger(width) || width < 100 || width > 4000) throw new UsageError(`--widths has a bad width: ${w}`);
    return width;
  });
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        css: { type: 'string' },
        coverage: { type: 'string' },
        out: { type: 'string' },
        report: { type: 'string' },
        widths: { type: 'string', default: DEFAULT_WIDTHS.join(',') },
        origin: { type: 'string' },
        capture: { type: 'string' },
        public: { type: 'string', default: 'public' },
        'inline-out': { type: 'string', default: join('src', 'styles', 'inline') },
        'single-sheet': { type: 'boolean', default: false },
        'pages-out': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  for (const name of ['css', 'coverage', 'report']) if (!values[name]) throw new UsageError(`--${name} is required`);
  values.singleSheet = values['single-sheet'];
  if (values.singleSheet && !values.out) throw new UsageError('--out is required with --single-sheet');
  if (!values.singleSheet && (values.out || values['pages-out'])) {
    throw new UsageError(`${values.out ? '--out' : '--pages-out'} is for --single-sheet; the default writes each sheet under --public and the inline blocks to --inline-out`);
  }
  if (values.singleSheet) values.pagesOut = values['pages-out'] ?? join(dirname(values.out), 'pages');
  values.inlineOut = values['inline-out'];
  values.capture ??= dirname(values.css);
  let origin;
  if (values.origin) {
    origin = originOf(values.origin);
    if (!origin) throw new UsageError(`--origin is not an http(s) URL: ${values.origin}`);
  }
  return { ...values, widths: parseWidths(values.widths), origin };
}

// Removes a previous run's inline-*.css from dir, so none is left for a block or page set that no
// longer has one; other files stay.
function clearInline(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (/^inline-.*\.css$/.test(name)) rmSync(join(dir, name), { force: true });
  }
}

const summaryLine = ({ before, after, removedRules, keptBecause }) => `css: ${before} -> ${after} bytes, ${removedRules} rules removed `
  + `(kept unused: ${keptBecause.pseudo} pseudo, ${keptBecause.atRule} at-rule, ${keptBecause.untestedMedia} untested media; `
  + `kept for state: ${keptBecause.state} rules)`;

function writeSingle(options, result) {
  for (const file of [options.out, options.report]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(options.out, result.output);
  writeFileSync(options.report, `${JSON.stringify(result.report, null, 2)}\n`);
  clearInline(options.pagesOut);
  if (result.pageSheets.length) {
    mkdirSync(options.pagesOut, { recursive: true });
    for (const sheet of result.pageSheets) writeFileSync(join(options.pagesOut, sheet.file), sheet.css);
    console.log(`wrote ${result.pageSheets.length} per-page sheet(s) to ${options.pagesOut}: link each only on the pages pageSheets lists in ${options.report}`);
  }
  console.log(`${summaryLine(result.report)}; wrote ${options.out}`);
}

function writePerSheet(options, result) {
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(result.report, null, 2)}\n`);
  for (const sheet of result.sheets) {
    mkdirSync(dirname(sheet.path), { recursive: true });
    writeFileSync(sheet.path, sheet.css);
  }
  clearInline(options.inlineOut);
  mkdirSync(options.inlineOut, { recursive: true });
  for (const block of result.inline) writeFileSync(join(options.inlineOut, block.name), block.css);
  console.log(`${summaryLine(result.report)}; wrote ${result.sheets.length} sheet(s) at their live paths under ${options.public} `
    + `and ${result.inline.length} inline block file(s) to ${options.inlineOut}; no site.css: give each page its head list from heads in ${options.report}`);
}

function main() {
  assertNodeVersion();
  let options;
  let result;
  try {
    options = parse(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const coverage = readJson(options.coverage, 'coverage');
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
      throw new UsageError(`${options.coverage} is not a coverage object`);
    }
    const input = { css: options.css, coverage, widths: options.widths, origin: options.origin, capture: options.capture };
    result = options.singleSheet ? prune(input) : prunePerSheet({ ...input, publicDir: options.public });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`css-prune: ${error.message}\nRun with --help for usage.`);
    process.exit(2);
  }
  if (options.singleSheet) writeSingle(options, result);
  else writePerSheet(options, result);
  const { unmatched } = result.report;
  if (unmatched.length) {
    console.error(`css-prune: ${unmatched.length} file(s) had no matching coverage and were kept whole: ${unmatched.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
