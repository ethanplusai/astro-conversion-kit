import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFLIGHT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', 'convert-site', 'scripts', 'preflight.mjs',
);
const SECRET = 'gho_FAKETOKEN0123456789';
const SLEEP_MARK = 7357;

// True while a process matching pattern is alive; retries briefly so a just-killed one can be reaped.
function strayProcess(pattern) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (spawnSync('pgrep', ['-f', pattern]).status !== 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return true;
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBin(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

// A fake gh that is logged in and leaks a token on stdout, as `gh auth status -t` would.
function fakeGh(dir) {
  fakeBin(dir, 'gh', [
    'if [ "$1" = "--version" ]; then echo "gh version 2.70.0 (2026-01-01)"; exit 0; fi',
    `if [ "$1" = "auth" ]; then echo "Logged in to github.com account test (${SECRET})"; exit 0; fi`,
    'exit 1',
  ].join('\n'));
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [PREFLIGHT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
}

function runJson(args, env) {
  const result = run(['--json', ...args], env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), 'token leaked');
  return JSON.parse(result.stdout);
}

test('preflight --help exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node preflight\.mjs/);
  assert.match(result.stdout, /PREFLIGHT_PROBE_TIMEOUT_MS/);
});

test('preflight rejects unknown or incomplete flags with exit 2', () => {
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--home']).status, 2);
});

test('fake gh is logged in, missing vercel is not present', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.node.version, process.versions.node);
  assert.equal(report.node.ok, true);
  assert.deepEqual(report.tools.gh, { present: true, version: '2.70.0', loggedIn: true });
  assert.deepEqual(report.tools.vercel, { present: false, version: null, loggedIn: false, via: null, scope: null });
  assert.equal(report.tools.wrangler.present, false);
  assert.equal(report.tools.git.present, false);
  assert.equal(typeof report.playwright.chromium, 'boolean');
  assert.equal(report.signals.ghAuth, true);
  assert.equal(report.signals.repos, 0);
  assert.equal(report.experience, 'some');
});

test('experience is new with an empty --home and no logged-in tools', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.experience, 'new');
  assert.deepEqual(report.signals, { repos: 0, ghAuth: false, dotfiles: 0 });
});

test('a CLI that says it is not authenticated is not logged in', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeBin(bin, 'wrangler', [
    'if [ "$1" = "--version" ]; then echo "4.20.1"; exit 0; fi',
    'echo "You are not authenticated. Please run wrangler login."; exit 0',
  ].join('\n'));
  fakeBin(bin, 'vercel', [
    'if [ "$1" = "--version" ]; then echo "Vercel CLI 44.2.0"; exit 0; fi',
    'echo "Error: not logged in" >&2; exit 1',
  ].join('\n'));
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.deepEqual(report.tools.wrangler, { present: true, version: '4.20.1', loggedIn: false, via: 'path' });
  assert.deepEqual(report.tools.vercel, { present: true, version: '44.2.0', loggedIn: false, via: 'path', scope: null });
});

// A fake npx that runs an installed vercel (not on PATH) and knows no wrangler, as
// `npx --no-install` does: it answers only for a package it can find without installing.
function fakeNpx(dir, log) {
  fakeBin(dir, 'npx', [
    `echo "$@" >> "${log}"`,
    'if [ "$1" != "--no-install" ]; then echo "would install" >&2; exit 9; fi',
    'if [ "$2" = "vercel" ] && [ "$3" = "--version" ]; then echo "Vercel CLI 50.1.0"; exit 0; fi',
    'if [ "$2" = "vercel" ] && [ "$3" = "whoami" ]; then echo "fixture-user"; exit 0; fi',
    'echo "npm error could not determine executable to run" >&2; exit 1',
  ].join('\n'));
}

test('vercel and wrangler are found through npx --no-install, then on PATH', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  const log = join(home, 'npx.log');
  fakeNpx(bin, log);
  fakeBin(bin, 'wrangler', [
    'if [ "$1" = "--version" ]; then echo "4.20.1"; exit 0; fi',
    'echo "you@example.com"; exit 0',
  ].join('\n'));
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.deepEqual(report.tools.vercel, { present: true, version: '50.1.0', loggedIn: true, via: 'npx', scope: null });
  assert.deepEqual(report.tools.wrangler, { present: true, version: '4.20.1', loggedIn: true, via: 'path' });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes('--no-install vercel whoami'), calls.join('\n'));
  assert.ok(calls.every((c) => c.startsWith('--no-install ')), 'never lets npx install');
});

// A logged-in Vercel CLI 65 on an account in several teams, as the jquery.com runs met it:
// `teams ls --json` marks none current, `api /v2/user` without --scope answers missing_scope, and
// with any team's scope it returns the user and its defaultTeamId (the personal team).
function fakeTeamsNpx(dir, log, { current = false, teams = 'ok' } = {}) {
  const list = JSON.stringify({ teams: [
    { id: 'team_other', slug: 'agency-team', name: 'Agency', current: false },
    { id: 'team_personal', slug: 'fixture-users-projects-1a2b', name: 'Fixture projects', current },
  ], pagination: { count: 2, next: null } });
  fakeBin(dir, 'npx', [
    `echo "$@" >> "${log}"`,
    'if [ "$2" = "vercel" ] && [ "$3" = "--version" ]; then echo "Vercel CLI 65.1.0"; exit 0; fi',
    'if [ "$2" = "vercel" ] && [ "$3" = "whoami" ]; then echo "fixture-user"; exit 0; fi',
    teams === 'ok'
      ? `if [ "$2" = "vercel" ] && [ "$3" = "teams" ] && [ "$4" = "ls" ] && [ "$5" = "--json" ]; then echo '${list}'; exit 0; fi`
      : 'if [ "$2" = "vercel" ] && [ "$3" = "teams" ]; then echo "Error: offline" >&2; exit 1; fi',
    'if [ "$2" = "vercel" ] && [ "$3" = "api" ] && [ "$4" = "/v2/user" ] && [ "$5" = "--scope" ]; then',
    `  echo '{"user":{"id":"u1","username":"fixture-user","email":"user@example.com","defaultTeamId":"team_personal"}}'; exit 0`,
    'fi',
    `if [ "$2" = "vercel" ] && [ "$3" = "api" ]; then echo '{"status":"action_required","reason":"missing_scope"}'; exit 1; fi`,
    'echo "npm error could not determine executable to run" >&2; exit 1',
  ].join('\n'));
}

test('vercel.scope is the default team slug: from teams ls when one is current, else the user\'s defaultTeamId', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  const log = join(home, 'npx.log');
  fakeTeamsNpx(bin, log);
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.deepEqual(report.tools.vercel, { present: true, version: '65.1.0', loggedIn: true, via: 'npx', scope: 'fixture-users-projects-1a2b' });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes('--no-install vercel teams ls --json'), calls.join('\n'));
  assert.ok(calls.includes('--no-install vercel api /v2/user --scope agency-team'), calls.join('\n'));
  assert.ok(!calls.some((c) => /--scope fixture-user\b/.test(c)), 'the username is never a scope');
  assert.ok(!readFileSync(log, 'utf8').includes('example.com'), 'nothing the API returns is logged');

  const current = tempDir(t, 'preflight-bin-');
  const currentLog = join(home, 'npx-current.log');
  fakeTeamsNpx(current, currentLog, { current: true });
  assert.equal(runJson(['--home', home, '--path-env', current]).tools.vercel.scope, 'fixture-users-projects-1a2b');
  assert.ok(!readFileSync(currentLog, 'utf8').includes('/v2/user'), 'a current team needs no second call');
});

test('vercel.scope is null when the team list cannot be read, and the human report names the scope', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeTeamsNpx(bin, join(home, 'npx.log'), { teams: 'offline' });
  assert.equal(runJson(['--home', home, '--path-env', bin]).tools.vercel.scope, null);
  const ok = tempDir(t, 'preflight-bin-');
  fakeTeamsNpx(ok, join(home, 'npx-ok.log'));
  const human = run(['--home', home, '--path-env', ok]);
  assert.match(human.stdout, /vercel\s+65\.1\.0\s+logged in\s+scope fixture-users-projects-1a2b/);
});

// Vercel CLI 65 logged out, as the live proof recorded it: `whoami` prints "> Logged out." and a
// hint, exits 1, and never prompts. `exitCode` lets a shim that exits 0 be tested too.
function fakeLoggedOutNpx(dir, log, exitCode) {
  fakeBin(dir, 'npx', [
    `echo "$@ HOME=$HOME" >> "${log}"`,
    'if [ "$2" = "vercel" ] && [ "$3" = "--version" ]; then echo "Vercel CLI 65.1.0"; exit 0; fi',
    'if [ "$2" = "vercel" ] && [ "$3" = "whoami" ]; then',
    '  read -r answer && echo "read stdin: $answer"',
    '  echo "> Logged out."',
    '  echo "> Run \`vercel deploy --temporary\` to create a temporary deployment you can claim later, or \`vercel login\` to log in."',
    `  exit ${exitCode}`,
    'fi',
    'echo "npm error could not determine executable to run" >&2; exit 1',
  ].join('\n'));
}

test('a logged-out vercel (exit 1, "> Logged out.") is present and not logged in, probed with the real HOME', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  const log = join(home, 'npx.log');
  fakeLoggedOutNpx(bin, log, 1);
  const report = runJson(['--home', home, '--path-env', bin], { HOME: '/home/fixture-real' });
  assert.deepEqual(report.tools.vercel, { present: true, version: '65.1.0', loggedIn: false, via: 'npx', scope: null });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  // The npx cache lives under HOME: the probe keeps the person's HOME, never --home or an empty one.
  assert.ok(calls.every((c) => c.endsWith(' HOME=/home/fixture-real')), calls.join('\n'));
});

test('"> Logged out." means not logged in even when the CLI exits 0', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeLoggedOutNpx(bin, join(home, 'npx.log'), 0);
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.tools.vercel.loggedIn, false);
});

test('a hanging login probe times out instead of blocking', { timeout: 30000 }, (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  // Not exec: the sleep is a grandchild holding the output pipe, so the whole group must die.
  // The odd duration lets pgrep find exactly this sleep afterwards.
  fakeBin(bin, 'vercel', `if [ "$1" = "--version" ]; then echo "44.2.0"; exit 0; fi\n/bin/sleep ${SLEEP_MARK}\nexit 0`);
  const started = Date.now();
  const report = runJson(['--home', home, '--path-env', bin], { PREFLIGHT_PROBE_TIMEOUT_MS: '1000' });
  const elapsed = Date.now() - started;
  assert.equal(report.tools.vercel.present, true);
  assert.equal(report.tools.vercel.loggedIn, false);
  assert.ok(elapsed >= 900, `probe returned before the 1 s timeout (${elapsed} ms)`);
  assert.ok(elapsed < 8000, `probe did not time out (${elapsed} ms)`);
  assert.equal(strayProcess(`sleep ${SLEEP_MARK}`), false, 'timed-out probe left its grandchild running');
});

test('a login probe with no answer is reported as timed out, not logged out, with the command to run', { timeout: 30000 }, (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeBin(bin, 'vercel', `if [ "$1" = "--version" ]; then echo "44.2.0"; exit 0; fi\n/bin/sleep ${SLEEP_MARK}\nexit 0`);
  const env = { PREFLIGHT_PROBE_TIMEOUT_MS: '1000' };
  const report = runJson(['--home', home, '--path-env', bin], env);
  assert.deepEqual(report.tools.vercel, { present: true, version: '44.2.0', loggedIn: false, timedOut: true, via: 'path', scope: null });
  const text = run(['--home', home, '--path-env', bin], env);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^vercel {4}44\.2\.0 {2}login unknown$/m);
  assert.match(text.stdout, /^vercel: no answer in 1 s; run `vercel whoami` yourself$/m);
  assert.doesNotMatch(text.stdout, /vercel.*not logged in/);
  assert.equal(strayProcess(`sleep ${SLEEP_MARK}`), false);
});

test('a cold npx that does not answer in time is "unknown", never "missing"', { timeout: 30000 }, (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeBin(bin, 'npx', `if [ "$2" = "vercel" ]; then /bin/sleep ${SLEEP_MARK}; fi\nexit 1`);
  const env = { PREFLIGHT_PROBE_TIMEOUT_MS: '1000' };
  assert.deepEqual(runJson(['--home', home, '--path-env', bin], env).tools.vercel, { present: false, version: null, loggedIn: false, timedOut: true, via: null, scope: null });
  const text = run(['--home', home, '--path-env', bin], env);
  assert.match(text.stdout, /^vercel {4}unknown$/m);
  assert.match(text.stdout, /^vercel: no answer in 1 s; run `npx vercel whoami` yourself$/m);
  assert.equal(strayProcess(`sleep ${SLEEP_MARK}`), false);
});

test('a CLI found on PATH (gh) is named without npx in the no-answer line', { timeout: 30000 }, (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeBin(bin, 'gh', `if [ "$1" = "--version" ]; then echo "gh version 2.70.0"; exit 0; fi\n/bin/sleep ${SLEEP_MARK}\nexit 0`);
  const text = run(['--home', home, '--path-env', bin], { PREFLIGHT_PROBE_TIMEOUT_MS: '1000' });
  assert.match(text.stdout, /^gh: no answer in 1 s; run `gh auth status` yourself$/m);
  assert.equal(strayProcess(`sleep ${SLEEP_MARK}`), false);
});

test('the probe timeout is 30 s by default', () => {
  assert.match(run(['--help']).stdout, /Each probe times out after 30 s/);
});

test('ten git repos under --home plus gh login is experienced; dotfiles counted', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  for (let i = 0; i < 10; i += 1) mkdirSync(join(home, `repo-${i}`, '.git'), { recursive: true });
  mkdirSync(join(home, 'not-a-repo', 'nested', '.git'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n');
  mkdirSync(join(home, '.ssh'));
  const report = runJson(['--home', home, '--path-env', bin]);
  assert.equal(report.signals.repos, 10);
  assert.equal(report.signals.dotfiles, 2);
  assert.equal(report.experience, 'experienced');
});

test('ten repos without gh login is some', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  for (let i = 0; i < 10; i += 1) mkdirSync(join(home, `repo-${i}`, '.git'), { recursive: true });
  assert.equal(runJson(['--home', home, '--path-env', bin]).experience, 'some');
});

test('human output summarises and never contains the token', (t) => {
  const bin = tempDir(t, 'preflight-bin-');
  const home = tempDir(t, 'preflight-home-');
  fakeGh(bin);
  const result = run(['--home', home, '--path-env', bin]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gh\s+2\.70\.0\s+logged in/);
  assert.match(result.stdout, /Experience: some/);
  assert.ok(!result.stdout.includes(SECRET));
});
