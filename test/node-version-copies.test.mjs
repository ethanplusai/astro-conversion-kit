import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_COPY = join(ROOT, 'scripts', 'lib', 'node-version.mjs');
// The kit's own skills; the vendored launch skills keep their upstream layout.
const SKILLS = ['capture-site', 'parity-gates', 'visual-review', 'convert-site', 'suggest-improvements'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function scriptFiles(skill) {
  const dir = join(ROOT, 'skills', skill, 'scripts');
  return existsSync(dir) ? walk(dir).filter((file) => file.endsWith('.mjs')) : [];
}

test('every skill carries a byte-identical copy of scripts/lib/node-version.mjs', () => {
  const expected = readFileSync(ROOT_COPY);
  for (const skill of SKILLS) {
    const copy = join(ROOT, 'skills', skill, 'scripts', 'lib', 'node-version.mjs');
    assert.ok(existsSync(copy), `${skill} has no scripts/lib/node-version.mjs`);
    assert.ok(readFileSync(copy).equals(expected), `${skill}'s node-version.mjs differs from the root copy`);
  }
});

test('no skill script imports node-version.mjs from outside its own skill', () => {
  const importRe = /from\s+['"]([^'"]*node-version\.mjs)['"]/g;
  for (const skill of SKILLS) {
    const skillDir = join(ROOT, 'skills', skill);
    for (const file of scriptFiles(skill)) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(importRe)) {
        const target = resolve(dirname(file), spec);
        const rel = relative(skillDir, target);
        assert.ok(!rel.startsWith('..'), `${relative(ROOT, file)} imports ${spec}, outside ${skill}`);
      }
    }
  }
});

test('every top-level skill script answers --help from a copy of the skills placed elsewhere', (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'skills-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  // Only the skills and the packages: no kit-root scripts/ next to them.
  for (const skill of SKILLS) {
    cpSync(join(ROOT, 'skills', skill), join(elsewhere, 'skills', skill), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(elsewhere, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const skill of SKILLS) {
    const dir = join(elsewhere, 'skills', skill, 'scripts');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
      const result = spawnSync(process.execPath, [join(dir, name), '--help'], { encoding: 'utf8', cwd: elsewhere });
      assert.equal(result.status, 0, `${skill}/scripts/${name} --help: ${result.stderr}`);
    }
  }
});
