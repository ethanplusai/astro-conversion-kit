#!/usr/bin/env node
// Vendors the launch skills (pre-launch, launch-audit, post-launch) from website-launch-skills
// at the commit pinned in launch-skills.lock.json. The three are copied as a set because
// pre-launch and post-launch import launch-audit/scripts/lib/ by relative path.
// Exit 0 synced, 2 usage or environment error (including local edits to the vendored copies).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node scripts/sync-launch-skills.mjs [--commit <sha>]

Copies skills/pre-launch, skills/launch-audit and skills/post-launch from the
repository named in launch-skills.lock.json, at the commit it pins, into this
kit's skills/ folder (node_modules excluded), then records the commit and the
time in the lock file.

  --commit <sha>  sync this full 40-character commit instead, and pin it

Refuses to run if the vendored copies have local modifications: change the
skills upstream, then sync.

Exit codes: 0 synced, 2 usage or environment error.`;

const SKILLS = ['pre-launch', 'launch-audit', 'post-launch'];
const SHA_RE = /^[0-9a-f]{40}$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'launch-skills.lock.json');

class UsageError extends Error {}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new UsageError(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function parseArgs(argv) {
  const args = { commit: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--commit') args.commit = argv[++i] ?? '';
    else if (arg.startsWith('--commit=')) args.commit = arg.slice('--commit='.length);
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (args.commit !== null && !SHA_RE.test(args.commit)) {
    throw new UsageError(`--commit needs a full 40-character sha, got "${args.commit}"`);
  }
  return args;
}

function readLock() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read ${basename(LOCK)}: ${err.message}`);
  }
  if (typeof lock.repo !== 'string' || !lock.repo) throw new UsageError(`${basename(LOCK)} has no "repo"`);
  if (!SHA_RE.test(String(lock.commit))) throw new UsageError(`${basename(LOCK)} has no full "commit" sha`);
  return lock;
}

function assertClean() {
  const paths = SKILLS.map((skill) => `skills/${skill}`);
  const status = git(ROOT, ['status', '--porcelain', '--', ...paths]);
  if (status) {
    throw new UsageError(
      `The vendored launch skills have local modifications; change them upstream instead:\n${status}`,
    );
  }
}

// GitHub serves any reachable commit by sha, so a shallow fetch of exactly that commit is enough.
function checkout(repo, commit, dir) {
  git(dir, ['init', '-q']);
  git(dir, ['fetch', '-q', '--depth', '1', repo, commit]);
  // core.autocrlf=false keeps the line endings upstream committed (Git for Windows turns it on).
  git(dir, ['-c', 'advice.detachedHead=false', '-c', 'core.autocrlf=false', 'checkout', '-q', 'FETCH_HEAD']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head !== commit) throw new UsageError(`Fetched ${head}, expected ${commit}`);
}

function copySkills(source) {
  for (const skill of SKILLS) {
    const from = join(source, 'skills', skill);
    if (!existsSync(join(from, 'SKILL.md'))) throw new UsageError(`Upstream has no skills/${skill}/SKILL.md`);
  }
  for (const skill of SKILLS) {
    const to = join(ROOT, 'skills', skill);
    rmSync(to, { recursive: true, force: true });
    cpSync(join(source, 'skills', skill), to, {
      recursive: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
  }
}

function sync(args) {
  const lock = readLock();
  const commit = args.commit ?? lock.commit;
  assertClean();
  const work = mkdtempSync(join(tmpdir(), 'launch-skills-'));
  try {
    checkout(lock.repo, commit, work);
    copySkills(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const next = { repo: lock.repo, commit, syncedAt: new Date().toISOString() };
  writeFileSync(LOCK, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main() {
  assertNodeVersion();
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      process.exit(0);
    }
    const { repo, commit } = sync(args);
    console.log(`Synced ${SKILLS.join(', ')} from ${repo} at ${commit}`);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
