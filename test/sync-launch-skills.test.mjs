import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['pre-launch', 'launch-audit', 'post-launch'];
// Only these kit files are needed to run the sync, so the test works on a throwaway copy.
const KIT_FILES = ['scripts/sync-launch-skills.mjs', 'scripts/lib/node-version.mjs', 'launch-skills.lock.json'];

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function run(dir, script, ...args) {
  return spawnSync(process.execPath, [join(dir, script), ...args], { cwd: dir, encoding: 'utf8' });
}

// Every node_modules folder under dir, one per line ('' when there is none).
function findNodeModules(dir) {
  return readdirSync(dir, { recursive: true }).filter((path) => basename(path) === 'node_modules').join('\n');
}

test('sync-launch-skills vendors the three launch skills at the locked sha', async (t) => {
  if (process.env.OFFLINE) {
    t.skip('OFFLINE is set: the sync needs network access to GitHub');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sync-launch-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of KIT_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(KIT, file), join(dir, file));
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: kit');

  const lock = JSON.parse(readFileSync(join(dir, 'launch-skills.lock.json'), 'utf8'));
  // One real sync; every assertion below reads its result.
  const sync = run(dir, 'scripts/sync-launch-skills.mjs');

  await t.test('the lock names the upstream repo and a full sha', () => {
    assert.equal(lock.repo, 'https://github.com/ethanplusai/website-launch-skills');
    assert.match(lock.commit, /^[0-9a-f]{40}$/);
  });

  await t.test('the sync exits 0 and records the sha and time in the lock', () => {
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    const after = JSON.parse(readFileSync(join(dir, 'launch-skills.lock.json'), 'utf8'));
    assert.equal(after.repo, lock.repo);
    assert.equal(after.commit, lock.commit);
    assert.ok(!Number.isNaN(Date.parse(after.syncedAt)), `syncedAt ${after.syncedAt}`);
  });

  await t.test('each skill arrives with SKILL.md and scripts/, without node_modules', () => {
    for (const skill of SKILLS) {
      assert.ok(existsSync(join(dir, 'skills', skill, 'SKILL.md')), `${skill}/SKILL.md`);
      assert.ok(existsSync(join(dir, 'skills', skill, 'scripts')), `${skill}/scripts/`);
    }
    assert.ok(existsSync(join(dir, 'skills', 'launch-audit', 'scripts', 'lib')), 'launch-audit/scripts/lib/');
    assert.equal(findNodeModules(join(dir, 'skills')), '');
  });

  await t.test('pre-launch runs through the kit path', () => {
    const help = run(dir, 'skills/pre-launch/scripts/pre-launch.mjs', '--help');
    assert.equal(help.status, 0, help.stderr);
  });

  await t.test('a second sync refuses when a vendored copy has local modifications', () => {
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: vendor');
    appendFileSync(join(dir, 'skills', 'pre-launch', 'SKILL.md'), '\nlocal edit\n');
    const again = run(dir, 'scripts/sync-launch-skills.mjs');
    assert.equal(again.status, 2, again.stdout);
    assert.match(again.stderr, /local modifications/);
    assert.match(readFileSync(join(dir, 'skills', 'pre-launch', 'SKILL.md'), 'utf8'), /local edit/);
  });
});

test('sync-launch-skills prints help and rejects a malformed --commit', () => {
  const help = run(KIT, 'scripts/sync-launch-skills.mjs', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--commit <sha>/);
  const bad = run(KIT, 'scripts/sync-launch-skills.mjs', '--commit', 'main');
  assert.equal(bad.status, 2, bad.stdout);
});
