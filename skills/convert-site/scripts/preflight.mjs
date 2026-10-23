#!/usr/bin/env node
// Preflight: what this machine has (Node, git, gh, vercel, wrangler, Playwright chromium)
// and a rough read of how experienced the person running the conversion is.
// Login probes report a boolean only: their output is inspected, never printed or stored.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isSupportedNodeVersion } from './lib/node-version.mjs';

const HELP = `Usage: node preflight.mjs [--json] [--home <dir>] [--path-env <PATH>]

Reports the tools a conversion needs and whether each CLI is logged in:
  node      version and whether it is supported
  git, gh, vercel, wrangler
            present, version, loggedIn (gh auth status, vercel whoami,
            wrangler whoami; git has no login and reports null)
            vercel and wrangler run through npx, as the skill runs them: each is
            probed as \`npx --no-install <cli> --version\` and \`... whoami\` (never
            installing anything), then as a binary on PATH; via says which
            answered ("npx", "path", or null when neither did)
            vercel also reports scope: the default team's slug, the value every
            \`--scope\` takes (a personal account's is its own team slug, never the
            username), or null when it cannot be read. It is the team \`vercel
            teams ls --json\` marks current, else the one whose id is the user's
            defaultTeamId (\`vercel api /v2/user --scope <any listed team>\`;
            without a scope the CLI refuses to pick one). Read-only calls.
  playwright chromium installed or not
  experience new | some | experienced, from two signals: at least 10 git
            repositories directly under the parent of the current directory,
            and gh being logged in (both: experienced, either: some)

Options:
  --json             print the report as JSON
  --home <dir>       scan <dir> for repositories and dotfiles instead of the
                     parent of the current directory and the home directory
  --path-env <PATH>  look up and run the CLIs with this PATH instead of $PATH

Each probe times out after 30 s (a cold \`npx vercel\` can take that long). A login probe
with no answer is reported as timedOut: true (loggedIn false), printed as "login unknown"
with the command to run yourself, never as logged out. Tokens and login output are never printed.
Test hook: PREFLIGHT_PROBE_TIMEOUT_MS=<ms> overrides the 30 s probe timeout.
Exit codes: 0 report printed, 2 usage error.`;

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const timeoutOverride = Number.parseInt(process.env.PREFLIGHT_PROBE_TIMEOUT_MS ?? '', 10);
const PROBE_TIMEOUT_MS = timeoutOverride > 0 ? timeoutOverride : DEFAULT_PROBE_TIMEOUT_MS;
const MAX_OUTPUT = 64 * 1024;
const REPOS_FOR_EXPERIENCED = 10;
const TOOLS = {
  git: null,
  gh: ['auth', 'status'],
  vercel: ['whoami'],
  wrangler: ['whoami'],
};
// "Logged out." is what `vercel whoami` prints (exit 1, no prompt) when no one is logged in.
const NOT_LOGGED_IN_RE = /not (?:logged in|authenticated)|unauthenticated|logged out|please (?:run )?(?:\S+ )?login/i;
const DOTFILES = ['.gitconfig', '.ssh', '.npmrc', '.nvm', join('.config', 'gh')];

function parseArgs(argv) {
  const opts = { json: false, home: null, pathEnv: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--home' || arg === '--path-env') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--home') opts.home = value;
      else opts.pathEnv = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function findBinary(name, pathEnv) {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// Runs a command with a hard timeout. The child gets its own process group so a
// hung CLI and anything it started are killed together. Output stays in memory.
function probe(file, args, pathEnv) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    };
    let child;
    try {
      child = spawn(file, args, {
        env: { ...process.env, PATH: pathEnv, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch {
      resolve({ code: null, output: '' });
      return;
    }
    const collect = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(null, true);
    }, PROBE_TIMEOUT_MS);
  });
}

async function checkTool(name, loginArgs, pathEnv) {
  const file = findBinary(name, pathEnv);
  if (!file) return { present: false, version: null, loggedIn: loginArgs ? false : null };
  const versionRun = await probe(file, ['--version'], pathEnv);
  const version = versionRun.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (!loginArgs) return { present: true, version, loggedIn: null };
  return { present: true, version, ...loginOf(await probe(file, loginArgs, pathEnv)) };
}

// A login probe's answer; one that timed out is not "logged out", so it says so.
function loginOf(login) {
  const loggedIn = login.code === 0 && !NOT_LOGGED_IN_RE.test(login.output);
  return login.timedOut ? { loggedIn, timedOut: true } : { loggedIn };
}

// The CLIs the skill runs through npx: what `npx --no-install <cli>` answers is what the agent
// will get, whether the package sits in a project, the npx cache or a global install.
const VIA_NPX = new Set(['vercel', 'wrangler']);

async function checkNpxTool(name, loginArgs, pathEnv) {
  const npx = findBinary('npx', pathEnv);
  let npxTimedOut = false;
  if (npx) {
    const versionRun = await probe(npx, ['--no-install', name, '--version'], pathEnv);
    npxTimedOut = versionRun.timedOut;
    if (versionRun.code === 0) {
      const version = versionRun.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      const login = loginOf(await probe(npx, ['--no-install', name, ...loginArgs], pathEnv));
      return { present: true, version, ...login, via: 'npx', run: (args) => probe(npx, ['--no-install', name, ...args], pathEnv) };
    }
  }
  const onPath = await checkTool(name, loginArgs, pathEnv);
  const file = onPath.present ? findBinary(name, pathEnv) : null;
  // A cold npx that did not answer in time is not proof the CLI is missing.
  const unknown = !onPath.present && npxTimedOut ? { timedOut: true } : {};
  return { ...onPath, ...unknown, via: onPath.present ? 'path' : null, run: (args) => probe(file, args, pathEnv) };
}

// The JSON object in a CLI's output (stderr progress lines around it are ignored), or null.
function jsonIn(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The default Vercel team's slug: the current one in `teams ls --json`, else the team whose id is
// the user's defaultTeamId. /v2/user needs some --scope in a non-interactive run; any listed team
// answers it. Only the slug leaves this function.
async function vercelScope(run) {
  const listed = await run(['teams', 'ls', '--json']);
  const teams = listed.code === 0 ? jsonIn(listed.output)?.teams : null;
  if (!Array.isArray(teams) || teams.length === 0) return null;
  const current = teams.find((team) => team?.current === true);
  if (typeof current?.slug === 'string') return current.slug;
  const asked = await run(['api', '/v2/user', '--scope', teams[0].slug]);
  const id = asked.code === 0 ? jsonIn(asked.output)?.user?.defaultTeamId : null;
  const slug = teams.find((team) => id && team?.id === id)?.slug;
  return typeof slug === 'string' ? slug : null;
}

async function checkVercel(name, loginArgs, pathEnv) {
  const { run, ...tool } = await checkNpxTool(name, loginArgs, pathEnv);
  return { ...tool, scope: tool.loggedIn ? await vercelScope(run) : null };
}

async function checkNpx(name, loginArgs, pathEnv) {
  const tool = await checkNpxTool(name, loginArgs, pathEnv);
  delete tool.run;
  return tool;
}

const CHECKS = { vercel: checkVercel, wrangler: checkNpx };

async function hasChromium() {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

// Directories directly under root that contain .git (a directory, or a file for worktrees).
function countRepos(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, '.git'))).length;
}

function countDotfiles(home) {
  return DOTFILES.filter((name) => existsSync(join(home, name))).length;
}

export async function preflight({ home = null, pathEnv = process.env.PATH ?? '' } = {}) {
  const names = Object.keys(TOOLS);
  const [results, chromium] = await Promise.all([
    Promise.all(names.map((name) => (CHECKS[name] ?? checkTool)(name, TOOLS[name], pathEnv))),
    hasChromium(),
  ]);
  const tools = Object.fromEntries(names.map((name, i) => [name, results[i]]));
  const signals = {
    repos: countRepos(home ?? dirname(process.cwd())),
    ghAuth: tools.gh.loggedIn === true,
    dotfiles: countDotfiles(home ?? homedir()),
  };
  const manyRepos = signals.repos >= REPOS_FOR_EXPERIENCED;
  let experience = 'new';
  if (manyRepos && signals.ghAuth) experience = 'experienced';
  else if (manyRepos || signals.ghAuth) experience = 'some';
  return {
    node: { version: process.versions.node, ok: isSupportedNodeVersion(process.versions.node) },
    tools,
    playwright: { chromium },
    experience,
    signals,
  };
}

function formatReport(report) {
  const lines = [`Node      ${report.node.version}  ${report.node.ok ? 'ok' : 'unsupported'}`];
  const noAnswer = [];
  for (const [name, tool] of Object.entries(report.tools)) {
    let login = '';
    if (tool.timedOut) login = 'login unknown';
    else if (tool.loggedIn === true) login = 'logged in';
    else if (tool.loggedIn === false) login = 'not logged in';
    const scope = tool.scope ? `  scope ${tool.scope}` : '';
    const detail = tool.present ? `${tool.version ?? 'unknown'}  ${login}${scope}`.trim() : tool.timedOut ? 'unknown' : 'missing';
    lines.push(`${name.padEnd(10)}${detail}`);
    if (tool.timedOut) {
      const command = [tool.via === 'npx' || !tool.present ? `npx ${name}` : name, ...(TOOLS[name] ?? ['--version'])].join(' ');
      noAnswer.push(`${name}: no answer in ${PROBE_TIMEOUT_MS / 1000} s; run \`${command}\` yourself`);
    }
  }
  lines.push(...noAnswer);
  lines.push(`Playwright chromium: ${report.playwright.chromium ? 'installed' : 'missing'}`);
  const { repos, ghAuth, dotfiles } = report.signals;
  lines.push(
    `Experience: ${report.experience} (git repos nearby: ${repos}, gh logged in: ${ghAuth ? 'yes' : 'no'}, dotfiles: ${dotfiles})`,
  );
  return lines.join('\n');
}

async function main(argv) {
  assertNodeVersion();
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`preflight: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const report = await preflight({ home: opts.home, pathEnv: opts.pathEnv ?? process.env.PATH ?? '' });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
