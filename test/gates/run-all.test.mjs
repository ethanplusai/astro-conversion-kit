import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { DIST_ORIGIN, makeDist } from './fixtures/make-dist.mjs';
import { gateScript, runGate } from './fixtures/run-gate.mjs';
import { gateFiles, optionsFromHelp } from '../../skills/parity-gates/scripts/verify/run-all.mjs';

const GATES = readdirSync(dirname(gateScript('run-all')))
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .sort();

let root;
let baseline;
let good;
// The fixture build is a Cloudflare Pages one (dist/_headers), so each dist also gets the
// public/_redirects compiled from the redirects.csv beside the baseline, as the build copies it.
// Every page carries the staging noindex meta, as Base.astro writes it without PUBLIC_INDEXABLE.
const build = (name, options) => {
  const dist = makeDist(join(root, name), { staging: true, ...options });
  copyFileSync(join(root, 'public', '_redirects'), join(dist, '_redirects'));
  return dist;
};
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'run-all-'));
  baseline = await buildFixtureBaseline(root);
  const compiler = fileURLToPath(new URL('../../skills/parity-gates/scripts/build-redirects.mjs', import.meta.url));
  execFileSync(process.execPath, [compiler, '--host', 'cloudflare'], { cwd: root, stdio: 'ignore' });
  good = build('dist-good');
});
after(() => rmSync(root, { recursive: true, force: true }));

// The fixture build keeps the live form action, and its _headers say noindex (a staging build).
const runAll = (dist, args = []) =>
  runGate('run-all', ['--dist', dist, '--baseline', baseline, '--endpoint', '/contact/', ...args], { cwd: root, env: { PUBLIC_INDEXABLE: '' } });

test('runs every gate in order and prints All N gates passed', async () => {
  // Each gate gets only the options it accepts: --origin is seo's, links' and sitemaps',
  // --allow-extra is routes', --endpoint is forms'.
  const result = await runAll(good, ['--origin', DIST_ORIGIN, '--allow-extra', '/nothing/']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const order = [...result.stdout.matchAll(/^([\w-]+): \d+ checked/gm)].map((m) => `${m[1]}.mjs`);
  assert.deepEqual(order, GATES);
  assert.match(result.stdout, new RegExp(`^All ${GATES.length} gates passed$`, 'm'));
});

// A release build compares URLs exactly, so these runs name the build's origin.
test('--release enables release checks, alone or with --with-proposals', async () => {
  const staging = await runAll(good, ['--origin', DIST_ORIGIN]);
  assert.equal(staging.code, 0, staging.stdout + staging.stderr);
  for (const args of [['--release'], ['--release', '--with-proposals']]) {
    const release = await runAll(good, [...args, '--origin', DIST_ORIGIN]);
    assert.equal(release.code, 1, release.stdout + release.stderr);
    assert.match(release.stdout + release.stderr, /PUBLIC_INDEXABLE=true/);
  }
});

test('stops at the first failing gate with its exit code', async () => {
  const bad = build('dist-bad', { bad: ['changed-title'] });
  const result = await runAll(bad, ['--origin', DIST_ORIGIN]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^routes: \d+ checked, 0 failed$/m);
  assert.match(result.stdout, /^seo: \d+ checked, 1 failed$/m);
  assert.doesNotMatch(result.stdout, /^text:/m);
  assert.doesNotMatch(result.stdout, /gates passed/);
});

test('verify:proposals passes with a markup proposal, which no gate compares; an unknown field still exits 2', async (t) => {
  const proposals = join(root, 'proposals.json');
  t.after(() => rmSync(proposals, { force: true }));
  const markup = {
    id: 'relative-links', path: '/about/', field: 'markup', from: '<a href="https://www.example.com/contact/">',
    to: '<a href="/contact/">', reason: 'links stay on the preview host', approvedBy: 'proposed', date: '2026-10-23',
  };
  writeFileSync(proposals, JSON.stringify([markup]));
  const on = await runGate('run-all', ['--dist', good, '--baseline', baseline, '--endpoint', '/contact/', '--origin', DIST_ORIGIN], {
    cwd: root, env: { PUBLIC_INDEXABLE: '', PROPOSALS: 'on' },
  });
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.match(on.stdout, new RegExp(`^All ${GATES.length} gates passed$`, 'm'));
  assert.doesNotMatch(on.stdout, /exception/);

  writeFileSync(proposals, JSON.stringify([{ ...markup, field: 'html' }]));
  const unknown = await runGate('run-all', ['--dist', good, '--baseline', baseline, '--endpoint', '/contact/', '--origin', DIST_ORIGIN], {
    cwd: root, env: { PUBLIC_INDEXABLE: '', PROPOSALS: 'on' },
  });
  assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /field "html" is not one of .*\|markup/);
});

test('--with-proposals loads markup proposals and rejects unknown fields only when enabled', async (t) => {
  const proposals = join(root, 'proposals.json');
  t.after(() => rmSync(proposals, { force: true }));
  const markup = {
    id: 'relative-links', path: '/about/', field: 'markup', from: '<a href="https://www.example.com/contact/">',
    to: '<a href="/contact/">', reason: 'links stay on the preview host', approvedBy: 'proposed', date: '2026-10-23',
  };
  writeFileSync(proposals, JSON.stringify([markup]));
  const on = await runAll(good, ['--with-proposals', '--origin', DIST_ORIGIN]);
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.match(on.stdout, new RegExp(`^All ${GATES.length} gates passed$`, 'm'));
  assert.doesNotMatch(on.stdout, /exception/);

  writeFileSync(proposals, JSON.stringify([{ ...markup, field: 'html' }]));
  const unknown = await runAll(good, ['--with-proposals', '--origin', DIST_ORIGIN]);
  assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /field "html" is not one of .*\|markup/);

  const off = await runAll(good, ['--origin', DIST_ORIGIN]);
  assert.equal(off.code, 0, off.stdout + off.stderr);
});

test('no gate lists a reserved run-all option', async () => {
  for (const file of gateFiles()) {
    const help = await runGate(file.slice(0, -4), ['--help']);
    assert.equal(help.code, 0, file + ': ' + help.stderr);
    const options = optionsFromHelp(help.stdout);
    for (const flag of ['release', 'with-proposals']) {
      assert.equal(options.has(flag), false, `${file} lists --${flag}`);
    }
  }
});

test('an option no gate accepts exits 2; --help exits 0', async () => {
  assert.equal((await runAll(good, ['--bogus'])).code, 2);
  const help = await runGate('run-all', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: run-all/);
  assert.match(help.stdout, /^  --release\s+run gates with PUBLIC_INDEXABLE=true$/m);
  assert.match(help.stdout, /^  --with-proposals\s+run gates with PROPOSALS=on$/m);
});
