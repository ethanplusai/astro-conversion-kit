import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', 'convert-site', 'scripts', 'state.mjs',
);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function site(t) {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function state(dir, ...args) {
  return spawnSync(process.execPath, [STATE, '--dir', dir, ...args], { encoding: 'utf8' });
}

function ok(dir, ...args) {
  const result = state(dir, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function file(dir) {
  return JSON.parse(readFileSync(join(dir, '.conversion', 'state.json'), 'utf8'));
}

test('state --help exits 0', () => {
  const result = spawnSync(process.execPath, [STATE, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node state\.mjs/);
  assert.match(result.stdout, /never in parallel/);
});

test('usage errors exit 2', (t) => {
  const dir = site(t);
  assert.equal(spawnSync(process.execPath, [STATE, 'get'], { encoding: 'utf8' }).status, 2);
  assert.equal(state(dir).status, 2);
  assert.equal(state(dir, 'frobnicate').status, 2);
  assert.equal(state(dir, 'set', 'hosting', 'not json').status, 2);
  assert.equal(state(dir, 'set', '__proto__.x', '1').status, 2);
  assert.equal(state(dir, 'phase').status, 2);
  assert.equal(state(dir, 'decision', '{"topic":"x"}').status, 2);
});

test('set then get round-trips JSON values', (t) => {
  const dir = site(t);
  ok(dir, 'set', 'hosting', '"vercel"');
  assert.equal(ok(dir, 'get', 'hosting'), '"vercel"');
  ok(dir, 'set', 'counts.pages', '13');
  assert.equal(ok(dir, 'get', 'counts.pages'), '13');
  assert.equal(ok(dir, 'get', 'repo'), 'null');
  const saved = file(dir);
  assert.equal(saved.version, 1);
  assert.match(saved.startedAt, ISO);
  for (const key of ['site', 'repo', 'phase']) assert.equal(saved[key], null);
  assert.deepEqual(saved.phases, {});
  assert.deepEqual(saved.decisions, []);
  assert.deepEqual(saved.needsYou, []);
  assert.deepEqual(JSON.parse(ok(dir, 'get')).counts, { pages: 13 });
});

test('phase stamps startedAt, the next phase stamps finishedAt on the previous one', (t) => {
  const dir = site(t);
  ok(dir, 'phase', 'capture');
  let saved = file(dir);
  assert.equal(saved.phase, 'capture');
  assert.match(saved.phases.capture.startedAt, ISO);
  assert.equal(saved.phases.capture.finishedAt, null);
  assert.equal(saved.phases.capture.result, null);

  ok(dir, 'phase', 'build');
  saved = file(dir);
  assert.equal(saved.phase, 'build');
  assert.match(saved.phases.capture.finishedAt, ISO);
  assert.ok(saved.phases.capture.finishedAt >= saved.phases.capture.startedAt);
  assert.match(saved.phases.build.startedAt, ISO);
  assert.equal(saved.phases.build.finishedAt, null);
});

test('re-entering the current phase keeps its startedAt', (t) => {
  const dir = site(t);
  ok(dir, 'phase', 'capture');
  const first = file(dir).phases.capture.startedAt;
  ok(dir, 'phase', 'capture');
  assert.equal(file(dir).phases.capture.startedAt, first);
  assert.equal(file(dir).phases.capture.finishedAt, null);
});

test('decision appends with id and date filled in', (t) => {
  const dir = site(t);
  const full = '{"topic":"hosting","choice":"vercel","default":"vercel","reason":"r","costIfWrong":"c"}';
  assert.equal(ok(dir, 'decision', full), 'd1');
  assert.equal(ok(dir, 'decision', '{"topic":"forms","choice":"formspree"}'), 'd2');
  const [one, two] = file(dir).decisions;
  assert.deepEqual(Object.keys(one), ['id', 'topic', 'choice', 'default', 'reason', 'costIfWrong', 'date']);
  assert.equal(one.id, 'd1');
  assert.match(one.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(two.id, 'd2');
  assert.equal(two.default, null);
});

test('writes are atomic: no temp files left behind', (t) => {
  const dir = site(t);
  ok(dir, 'set', 'site', '"https://example.com"');
  ok(dir, 'phase', 'capture');
  assert.deepEqual(readdirSync(join(dir, '.conversion')), ['state.json']);
});

test('a corrupt state file is an environment error and is not overwritten', (t) => {
  const dir = site(t);
  mkdirSync(join(dir, '.conversion'));
  writeFileSync(join(dir, '.conversion', 'state.json'), '{oops');
  assert.equal(state(dir, 'set', 'hosting', '"vercel"').status, 2);
  assert.equal(readFileSync(join(dir, '.conversion', 'state.json'), 'utf8'), '{oops');
});

test('a state file holding null or an array exits 2 without a crash', (t) => {
  for (const content of ['null', '[]', '"text"']) {
    const dir = site(t);
    mkdirSync(join(dir, '.conversion'));
    writeFileSync(join(dir, '.conversion', 'state.json'), content);
    for (const args of [['set', 'hosting', '"vercel"'], ['phase', 'capture'], ['get']]) {
      const result = state(dir, ...args);
      assert.equal(result.status, 2, `${content} ${args.join(' ')}`);
      assert.match(result.stderr, /does not hold a JSON object/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    }
    assert.equal(readFileSync(join(dir, '.conversion', 'state.json'), 'utf8'), content);
  }
});

test('an unwritable state directory exits 2 with a message, not a stack trace', (t) => {
  const dir = site(t);
  mkdirSync(join(dir, '.conversion'));
  const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const permissions = (args) => {
    const result = spawnSync('icacls', [join(dir, '.conversion'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  if (process.platform === 'win32') permissions(['/deny', `${account}:(W)`]);
  else chmodSync(join(dir, '.conversion'), 0o500);
  let result;
  try {
    result = state(dir, 'set', 'hosting', '"vercel"');
  } finally {
    if (process.platform === 'win32') permissions(['/remove:d', account]);
    else chmodSync(join(dir, '.conversion'), 0o700);
  }
  assert.equal(result.status, 2);
  assert.match(result.stderr, process.platform === 'win32' ? /^state: .*EPERM/ : /^state: .*EACCES/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
