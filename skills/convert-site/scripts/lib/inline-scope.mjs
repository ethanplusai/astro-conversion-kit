// Splits the kept rules of a capture's inline files (one file per set of pages' <style> blocks)
// into the ones every page can share and the ones that must stay on their own pages.
// Block themes print per-page CSS with counter classes (.wp-elements-1 a { color: white } on one
// page, { color: black } on another): merged into one sheet, the last page wins everywhere.
import * as csstree from 'css-tree';

// At-rules whose children are rules about the same elements, so a rule inside one is still a rule.
const CONTAINERS = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document']);
const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;

const squash = (value) => value.replace(/\s+/g, ' ').trim();
const sourceOf = (text, node) => text.slice(node.loc.start.offset, node.loc.end.offset);
const unprefixed = (name) => (csstree.vendorPrefix(name) ? name.slice(csstree.vendorPrefix(name).length) : name);
const isContainer = (node) => node.type === 'Atrule' && node.block && CONTAINERS.has(unprefixed(node.name.toLowerCase()));
const opening = (text, node) => text.slice(node.loc.start.offset, node.block.loc.start.offset);

// Calls visit(rule, context) for each style rule, context being the preludes of its containers.
function eachRule(list, text, context, visit) {
  list.forEach((node) => {
    if (!node.loc) return;
    if (node.type === 'Rule') visit(node, context);
    else if (isContainer(node)) eachRule(node.block.children, text, [...context, squash(opening(text, node))], visit);
  });
}

const ruleKey = (text, node, context) => `${context.join(' ')}|${squash(sourceOf(text, node.prelude))}`;
const ruleBody = (text, node) => squash(sourceOf(text, node.block));
const classesOf = (selector) => [...selector.matchAll(CLASS)].map((match) => match[1]);

// The selector without what its functional pseudo-classes hold (:not(), :where(), :is(), :has(),
// :nth-child(... of ...)): the classes left are the ones it styles, not the ones it filters on.
function outsideParens(selector) {
  let out = '';
  let depth = 0;
  for (const char of selector) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

// The kept source of the nodes in list that belong to the side asked for (own: true for the
// page's own rules); a container is kept with only its children of that side.
function emit(list, text, context, ownRule, own) {
  const parts = [];
  list.forEach((node) => {
    if (!node.loc) return;
    if (node.type === 'Rule') {
      if (ownRule(node, context) === own) parts.push(sourceOf(text, node));
      return;
    }
    if (isContainer(node)) {
      const inner = emit(node.block.children, text, [...context, squash(opening(text, node))], ownRule, own);
      if (inner.length) parts.push(`${opening(text, node)}{\n${inner.map((part) => `  ${part}`).join('\n')}\n}`);
      return;
    }
    if (!own) parts.push(sourceOf(text, node));
  });
  return parts;
}

// sheets: [{ name, css }], each the kept rules of one inline file. A rule is the page's own when
// another file has a rule with the same selector (inside the same containers) and other
// declarations (a file repeating one rule is no difference), or when its selector names a class
// a colliding selector names outside its :not(), :where(), :is() and :has() (the counter class a
// page reuses for its own elements, not the .wp-element-button it filters on). Everything else, identical blocks shared by pages among
// it, stays shared. Returns Map<name, { shared, own, rules }>: shared is css unchanged when the
// file has no own rules, own the page's own rules ('' when none), rules how many there are.
export function scopeInlineRules(sheets) {
  const parsed = sheets.map(({ name, css }) => ({ name, css, ast: csstree.parse(css, { positions: true }) }));
  const bodies = new Map();
  for (const { name, css, ast } of parsed) {
    eachRule(ast.children, css, [], (node, context) => {
      const key = ruleKey(css, node, context);
      const seen = bodies.get(key) ?? { selector: squash(sourceOf(css, node.prelude)), byFile: new Map() };
      // The distinct declaration blocks a file gives the selector: a repeat is no difference.
      const own = seen.byFile.get(name) ?? [];
      const body = ruleBody(css, node);
      seen.byFile.set(name, own.includes(body) ? own : [...own, body]);
      bodies.set(key, seen);
    });
  }
  const collisions = [...bodies].filter(([, { byFile }]) => new Set([...byFile.values()].map((list) => list.join('\n'))).size > 1);
  const colliding = new Set(collisions.map(([key]) => key));
  const classes = new Set(collisions.flatMap(([, { selector }]) => classesOf(outsideParens(selector))));
  const result = new Map();
  for (const { name, css, ast } of parsed) {
    let rules = 0;
    const ownRule = (node, context) => {
      if (colliding.has(ruleKey(css, node, context))) return true;
      return classesOf(sourceOf(css, node.prelude)).some((c) => classes.has(c));
    };
    eachRule(ast.children, css, [], (node, context) => {
      if (ownRule(node, context)) rules += 1;
    });
    result.set(name, rules
      ? { shared: emit(ast.children, css, [], ownRule, false).join('\n'), own: emit(ast.children, css, [], ownRule, true).join('\n'), rules }
      : { shared: css, own: '', rules: 0 });
  }
  return result;
}
