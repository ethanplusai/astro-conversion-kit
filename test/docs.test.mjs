import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const DOCS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  ...(existsSync(join(ROOT, 'docs')) ? readdirSync(join(ROOT, 'docs')) : [])
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

// Kit scripts the README names that later tasks have not written yet.
// Remove each entry when its script lands; remove the set when it is empty.
const SHIPS_IN_A_LATER_TASK = new Set([
  'skills/capture-site/scripts/capture.mjs',
]);

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

// Fenced blocks plus inline code spans: where docs name commands and paths.
function codeTexts(markdown) {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  return [...fencedBlocks(markdown), ...[...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])];
}

// scripts/ paths that belong to a converted site repository, not to the kit: the ones the site
// template's package.json runs, and anything in their folders below scripts/.
const SITE_SCRIPTS = Object.values(
  JSON.parse(read('skills/convert-site/templates/site/package.json')).scripts,
).flatMap((command) => [...command.matchAll(/scripts\/[\w./-]+\.m?js/g)].map((match) => match[0]));
const SITE_SCRIPT_DIRS = [...new Set(SITE_SCRIPTS.map((path) => dirname(path)).filter((dir) => dir !== 'scripts'))];

function isSiteRepoScript(path) {
  return SITE_SCRIPTS.includes(path) || SITE_SCRIPT_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

// Inline links and images, outside fenced blocks, that point inside the repository.
function relativeLinks(markdown) {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'));
}

test('the required documents exist', () => {
  for (const path of [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/process.md',
    'docs/hosting.md',
    'docs/platforms.md',
    'docs/dependencies.md',
    'docs/faq.md',
    'docs/security.md',
  ]) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  }
});

test('CLAUDE.md is byte-equal to AGENTS.md', () => {
  assert.ok(readFileSync(join(ROOT, 'CLAUDE.md')).equals(readFileSync(join(ROOT, 'AGENTS.md'))));
});

test('README carries the paste line, both install paths and the examples heading', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes('Convert https://example.com to Astro with https://github.com/ethanplusai/astro-conversion-kit'),
    'paste line',
  );
  const blocks = fencedBlocks(readme).join('\n');
  assert.match(blocks, /^npx skills add ethanplusai\/astro-conversion-kit$/m, 'npx skills add block');
  assert.match(blocks, /^\/plugin marketplace add ethanplusai\/astro-conversion-kit$/m, 'plugin marketplace line');
  assert.match(blocks, /^\/plugin install astro-conversion/m, 'plugin install line');
  assert.match(readme, /^## Results$/m, 'results heading');
  assert.match(readme, /\]\(docs\/examples\/results\.png\)/, 'results image');
});

test('README stays under 200 lines', () => {
  assert.ok(read('README.md').split('\n').length < 200);
});

test('every relative link in the docs resolves', () => {
  const broken = [];
  for (const doc of DOCS) {
    for (const target of relativeLinks(read(doc))) {
      const path = decodeURIComponent(target.split('#')[0]);
      if (!path) continue;
      if (!existsSync(resolve(ROOT, dirname(doc), path))) broken.push(`${doc}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every kit script a doc names in code exists or ships in a later task', () => {
  const missing = [];
  for (const doc of DOCS) {
    for (const code of codeTexts(read(doc))) {
      for (const [, path] of code.matchAll(/(?<![\w./-])((?:skills|scripts)\/[\w./-]+\.m?js)/g)) {
        if (isSiteRepoScript(path)) continue;
        if (!existsSync(join(ROOT, path)) && !SHIPS_IN_A_LATER_TASK.has(path)) missing.push(`${doc}: ${path}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('AGENTS.md names every script that reads the live site, as convert-site/SKILL.md rule 2 does', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const rule = flat(/^- \*\*The live site is read-only\.\*\*[\s\S]*?(?=\n- \*\*)/m.exec(read('AGENTS.md'))?.[0] ?? '');
  const skill = flat(/^2\. \*\*The live site is read-only\.\*\*[\s\S]*?(?=\n\d\. )/m.exec(read('skills/convert-site/SKILL.md'))?.[0] ?? '');
  const readers = /Only these read it, paced: .+?\. Analytics are blocked on their live page loads, so no visit is counted\./;
  assert.match(skill, readers);
  assert.ok(rule.includes(readers.exec(skill)[0]), rule);
});

test('docs/dependencies.md justifies exactly the dependencies in package.json', () => {
  const deps = Object.keys(JSON.parse(read('package.json')).dependencies).sort();
  const headings = [...read('docs/dependencies.md').matchAll(/^## `?([\w@/.-]+)`?$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(headings, deps);
});
