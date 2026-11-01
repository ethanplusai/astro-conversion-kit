#!/usr/bin/env node
// Runs every gate in this folder in alphabetical order with the same arguments, and stops at the
// first gate that fails. Each gate receives only the options its --help lists, so a gate-specific
// option (routes --allow-extra, seo --origin) can be given once for the whole run.
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = 'run-all.mjs';

const USAGE = `Usage: run-all [options]

Runs every gate in ${HERE} in alphabetical order, passing each one the options it accepts, and
stops at the first gate that fails. Every option of every gate is accepted here; see each gate's
--help (node <gate>.mjs --help).

  --release               run gates with PUBLIC_INDEXABLE=true
  --with-proposals        run gates with PROPOSALS=on
  --help                  show this help

Exit codes: 0 every gate passed, otherwise the exit code of the first gate that did not pass
(1 failed gate, 2 usage or environment error).
`;

export function gateFiles(dir = HERE) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && f !== SELF)
    .sort();
}

// "--flag <value>" and "--flag" lines of a gate's --help -> Map(flag -> takes a value).
export function optionsFromHelp(help) {
  const options = new Map();
  for (const match of help.matchAll(/^\s+--([a-z0-9][\w-]*)(\s+<value>)?/gim)) {
    if (match[1] !== 'help') options.set(match[1], Boolean(match[2]));
  }
  return options;
}

// argv -> [{ flag, tokens }], each option with the tokens that carry it. Throws on a token that is
// not an option known to some gate.
export function splitArgs(argv, known) {
  const parsed = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const match = /^--([^=]+)(=.*)?$/.exec(token);
    if (!match || !known.has(match[1])) throw new Error(`unknown argument ${token}`);
    const tokens = [token];
    if (known.get(match[1]) && !match[2]) {
      if (i + 1 >= argv.length) throw new Error(`${token} needs a value`);
      tokens.push(argv[(i += 1)]);
    }
    parsed.push({ flag: match[1], tokens });
  }
  return parsed;
}

function main() {
  assertNodeVersion();
  const env = { ...process.env };
  const argv = process.argv.slice(2).filter((arg) => {
    if (arg === '--release') {
      env.PUBLIC_INDEXABLE = 'true';
      return false;
    }
    if (arg === '--with-proposals') {
      env.PROPOSALS = 'on';
      return false;
    }
    return true;
  });
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const gates = gateFiles().map((file) => {
    const help = spawnSync(process.execPath, [join(HERE, file), '--help'], { encoding: 'utf8' });
    if (help.status !== 0) {
      process.stderr.write(`run-all: ${file} --help exited ${help.status}\n${help.stderr ?? ''}`);
      process.exit(2);
    }
    const options = optionsFromHelp(help.stdout);
    for (const flag of ['release', 'with-proposals']) {
      if (options.has(flag)) {
        process.stderr.write(`run-all: ${file} lists reserved option --${flag}\n`);
        process.exit(2);
      }
    }
    return { file, options };
  });
  const known = new Map(gates.flatMap((g) => [...g.options]));
  let parsed;
  try {
    parsed = splitArgs(argv, known);
  } catch (error) {
    process.stderr.write(`run-all: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  for (const gate of gates) {
    const args = parsed.filter((p) => gate.options.has(p.flag)).flatMap((p) => p.tokens);
    const result = spawnSync(process.execPath, [join(HERE, gate.file), ...args], { stdio: 'inherit', env });
    if (result.status !== 0) process.exit(result.status ?? 2);
  }
  process.stdout.write(`All ${gates.length} gates passed\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
