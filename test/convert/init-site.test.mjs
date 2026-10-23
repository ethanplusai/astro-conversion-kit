import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INIT = join(ROOT, 'skills', 'convert-site', 'scripts', 'init-site.mjs');
const TEMPLATES = join(ROOT, 'skills', 'convert-site', 'templates');
const KIT_PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const EXPECTED_FILES = [
  'package.json', 'astro.config.mjs', '.nvmrc', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md',
  'exceptions.json', 'proposals.json', 'src/layouts/Base.astro', 'src/lib/exceptions.mjs',
  'src/lib/site.mjs', 'src/pages/404.astro', 'src/pages/robots.txt.js', 'docs/LAUNCH.md',
  'docs/plan.md', 'docs/third-party.md', 'src/styles/site.css',
];

// Copied scripts are copied verbatim: placeholders inside them are not substituted.
const RUN_ALL = "// dummy gate runner for {{ORIGIN}}\n";

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plant(file, content = '// dummy\n') {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function bareKit(t) {
  const kit = tempDir(t, 'kit-');
  cpSync(join(ROOT, 'package.json'), join(kit, 'package.json'));
  cpSync(TEMPLATES, join(kit, 'skills', 'convert-site', 'templates'), { recursive: true });
  return kit;
}

// A copy of the kit with one dummy file planted in each script tree init-site copies from.
function fakeKit(t) {
  const kit = bareKit(t);
  cpSync(join(ROOT, 'skills', 'convert-site', 'scripts', 'lib'), join(kit, 'skills', 'convert-site', 'scripts', 'lib'),
    { recursive: true });
  plant(join(kit, 'skills', 'parity-gates', 'scripts', 'verify', 'run-all.mjs'), RUN_ALL);
  plant(join(kit, 'skills', 'parity-gates', 'scripts', 'build-baseline.mjs'));
  plant(join(kit, 'skills', 'parity-gates', 'scripts', 'lib', 'html.mjs'));
  plant(join(kit, 'skills', 'visual-review', 'scripts', 'shoot.mjs'));
  plant(join(kit, 'skills', 'convert-site', 'scripts', 'state.mjs'));
  plant(join(kit, 'skills', 'convert-site', 'scripts', 'media-plan.mjs'));
  plant(join(kit, 'skills', 'convert-site', 'scripts', 'unrelated.mjs'));
  return kit;
}

// A copy of the kit with the real script trees and no kit-root scripts/: what a site gets must stand alone.
function realKit(t) {
  const kit = bareKit(t);
  for (const skill of ['parity-gates', 'visual-review', 'convert-site']) {
    cpSync(join(ROOT, 'skills', skill, 'scripts'), join(kit, 'skills', skill, 'scripts'), { recursive: true });
  }
  return kit;
}

function run(args) {
  return spawnSync(process.execPath, [INIT, ...args], { encoding: 'utf8', env: GIT_ENV });
}

function baseArgs(dir, kit, { host = 'vercel', name = 'Fixture Roofing Co', extra = [] } = {}) {
  return [
    '--dir', dir, '--origin', 'https://www.fixture-roofing.test/', '--name', name,
    '--host', host, '--no-install', '--astro-version', '7.4.2', ...(kit ? ['--kit', kit] : []), ...extra,
  ];
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === '.git') return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

test('--help prints usage and exits 0', () => {
  const result = spawnSync(process.execPath, [INIT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--dir/);
});

test('init scaffolds templates, copies scripts, commits on main and switches to astro-rebuild', (t) => {
  const kit = fakeKit(t);
  const dir = join(tempDir(t, 'site-'), 'site');
  const result = run(baseArgs(dir, kit));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const files = walk(dir);
  for (const file of EXPECTED_FILES) assert.ok(files.includes(file), `missing ${file}`);
  assert.ok(files.includes('vercel.json'));
  // The CLI does not read .gitignore, so the upload leaves out the local build, run state, review
  // output and the ignored screenshots here; capture/ itself is uploaded because the build reads it.
  assert.deepEqual(readFileSync(join(dir, '.vercelignore'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')),
    ['/dist/', '/.conversion/', '/review/', '/capture/screens/', '/capture/lighthouse-live/']);
  assert.notEqual(git(dir, 'ls-files', '.vercelignore'), '', '.vercelignore committed');
  assert.ok(!files.includes('public/_headers'), 'vercel sites get vercel.json, not _headers');

  for (const file of files.filter((f) => !f.startsWith('scripts/'))) {
    assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /\{\{/, `unsubstituted placeholder in ${file}`);
  }

  // Copied script trees, committed (not swallowed by .gitignore) and copied verbatim.
  for (const path of ['verify/run-all.mjs', 'build-baseline.mjs', 'lib/html.mjs', 'lib/node-version.mjs',
    'lib/stores/r2.mjs', 'review/shoot.mjs', 'state.mjs', 'media-plan.mjs']) {
    assert.ok(existsSync(join(dir, 'scripts', path)), `scripts/${path} copied`);
    assert.notEqual(git(dir, 'ls-files', `scripts/${path}`), '', `scripts/${path} committed`);
  }
  assert.equal(readFileSync(join(dir, 'scripts', 'verify', 'run-all.mjs'), 'utf8'), RUN_ALL);
  assert.ok(!existsSync(join(dir, 'scripts', 'unrelated.mjs')), 'only the named convert-site scripts are copied');

  // Vercel URL handling for trailing slashes always: no trailingSlash key (build-redirects writes the
  // slash rules after the site's redirects), never cleanUrls.
  const vercel = JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'));
  assert.ok(!('trailingSlash' in vercel));
  assert.ok(!('cleanUrls' in vercel));
  assert.ok(Array.isArray(vercel.headers));

  // Substitutions.
  const config = readFileSync(join(dir, 'astro.config.mjs'), 'utf8');
  assert.match(config, /site: 'https:\/\/www\.fixture-roofing\.test'/);
  assert.match(config, /trailingSlash: 'always'/);
  assert.match(config, /format: 'directory'/);
  assert.match(config, /output: 'static'/);
  assert.doesNotMatch(config, /adapter\s*:/);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(agents, readFileSync(join(dir, 'CLAUDE.md'), 'utf8'));
  assert.ok(agents.split('\n').length < 80);
  assert.match(agents, /astro-rebuild/);
  assert.match(agents, /PUBLIC_INDEXABLE/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'exceptions.json'), 'utf8')), []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'proposals.json'), 'utf8')), []);
  assert.match(readFileSync(join(dir, 'docs', 'plan.md'), 'utf8'), /Fixture Roofing Co/);
  assert.match(readFileSync(join(dir, 'docs', 'LAUNCH.md'), 'utf8'), /www\.fixture-roofing\.test/);
  assert.match(readFileSync(join(dir, 'src', 'lib', 'site.mjs'), 'utf8'),
    /export const INDEXABLE = process\.env\.PUBLIC_INDEXABLE === 'true'/);
  const base = readFileSync(join(dir, 'src', 'layouts', 'Base.astro'), 'utf8');
  assert.match(base, /noindex, nofollow/);
  // site.css by URL and linked by hand before the head slot (an imported stylesheet would land at
  // the end of <head>); a page sheet from src/styles/pages/ after it, on the pages that name one.
  assert.match(base, /^import siteCss from '\.\.\/styles\/site\.css\?url';$/m);
  assert.match(base, /import\.meta\.glob\('\.\.\/styles\/pages\/\*\.css', \{ query: '\?url', import: 'default', eager: true \}\)/);
  assert.doesNotMatch(base, /^import '\.\.\/styles\/site\.css';$/m);
  const order = ['<link rel="stylesheet" href={siteCss} />', '{pageCss && <link rel="stylesheet" href={pageCss} />}', '<slot name="head" />'].map((s) => base.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `site.css, the page sheet, then the head slot: ${order}`);
  assert.match(readFileSync(join(dir, 'src', 'styles', 'site.css'), 'utf8'), /css-prune\.mjs/);
  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
  for (const entry of ['/capture/screens/', '/capture/lighthouse-live/', '/review/', 'node_modules', 'dist',
    '.astro', '.env*', '!.env.example', '.conversion/*.tmp', '/media-cache/', '.vercel']) {
    assert.ok(ignore.includes(entry), `.gitignore lacks ${entry}`);
  }

  // package.json.
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'fixture-roofing-co');
  assert.equal(pkg.scripts.verify, 'node scripts/verify/run-all.mjs');
  assert.equal(pkg.scripts['verify:proposals'], 'PROPOSALS=on node scripts/verify/run-all.mjs');
  assert.equal(pkg.scripts['verify:release'], 'PUBLIC_INDEXABLE=true node scripts/verify/run-all.mjs');
  assert.equal(pkg.scripts.baseline, 'node scripts/build-baseline.mjs --capture capture --out baseline');
  assert.equal(pkg.scripts['redirects:build'],
    'node scripts/build-redirects.mjs --csv redirects.csv --host vercel --out vercel.json --trailing-slash always --routes baseline/routes.json');
  assert.equal(pkg.scripts['verify:live'], 'node scripts/verify-live.mjs');
  for (const name of ['shoot', 'diff', 'styles', 'sheet']) {
    assert.equal(pkg.scripts[`review:${name}`], `node scripts/review/${name}.mjs`);
  }
  assert.equal(pkg.scripts['review:check'], 'node scripts/review/check.mjs --review review');
  assert.equal(pkg.scripts['review:serve'], 'node scripts/review-serve.mjs');
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^\| `npm run review:serve` \| Serve `dist\/` with vercel\.json applied, for the visual review \|$/m);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^\| `npm run review:check` \| Re-reads every diff and style result; exits 1 if any row fails \|$/m);
  assert.match(agents, /review:shoot`, `review:diff`, `review:styles`, `review:sheet` and `review:check`/);
  assert.equal(pkg.scripts.dev, 'astro dev');
  assert.equal(pkg.scripts.build, 'astro build');
  assert.equal(pkg.scripts.preview, 'astro preview');
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.mjs"');
  assert.equal(pkg.devDependencies.astro, '7.4.2');
  for (const dep of ['parse5', 'playwright', 'pixelmatch', 'pngjs', 'css-tree']) {
    assert.equal(pkg.devDependencies[dep], KIT_PKG.dependencies[dep], dep);
  }

  // Git state.
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%s', 'main'), 'chore: scaffold from astro-conversion-kit');
  assert.equal(git(dir, 'branch', '--show-current'), 'astro-rebuild');
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // A second init into the same directory is refused.
  const again = run(baseArgs(dir, kit));
  assert.equal(again.status, 2);
  assert.match(again.stderr, /not empty/);
  assert.match(again.stderr, /astro\.config\.mjs/);
});

test('the real copied scripts answer --help from inside the scaffolded site', (t) => {
  const dir = join(tempDir(t, 'site-'), 'site');
  const result = run(baseArgs(dir, realKit(t)));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Stands in for npm install: the site resolves the pinned packages from its own node_modules.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const scripts = ['scripts/review/shoot.mjs', 'scripts/state.mjs', 'scripts/media-upload.mjs', 'scripts/review-serve.mjs', 'scripts/verify-live.mjs']
    .filter((script) => script !== 'scripts/verify-live.mjs' || existsSync(join(dir, script)));
  for (const script of scripts) {
    const help = spawnSync(process.execPath, [script, '--help'], { cwd: dir, encoding: 'utf8' });
    assert.equal(help.status, 0, `${script} --help: ${help.stderr}`);
    assert.match(help.stdout, /Usage/, script);
  }
});

test('cloudflare host and --trailing-slash never shape the scaffold', (t) => {
  const dir = tempDir(t, 'site-');
  const result = run(baseArgs(dir, fakeKit(t), { host: 'cloudflare', extra: ['--trailing-slash', 'never'] }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(dir, 'public', '_headers')), 'Astro copies public/_headers into dist/');
  assert.ok(!existsSync(join(dir, 'vercel.json')));
  assert.ok(!existsSync(join(dir, '.vercelignore')));
  const config = readFileSync(join(dir, 'astro.config.mjs'), 'utf8');
  assert.match(config, /trailingSlash: 'never'/);
  assert.match(config, /format: 'file'/);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['redirects:build'], /--host cloudflare --out public\/_redirects --trailing-slash never --routes baseline\/routes\.json$/);
  const launch = readFileSync(join(dir, 'docs', 'LAUNCH.md'), 'utf8');
  assert.ok(launch.includes('`npm run build && npx wrangler pages deploy dist --branch astro-rebuild`'));
  assert.ok(launch.includes('`PUBLIC_INDEXABLE=true npm run build && npx wrangler pages deploy dist --branch main`'));
  assert.match(launch, /not in the Pages dashboard/);
});

test('vercel with --trailing-slash never uses cleanUrls; quotes in the name stay valid JS', async (t) => {
  const dir = tempDir(t, 'site-');
  const name = "O'Neil & Sons $1";
  const result = run(baseArgs(dir, fakeKit(t), { name, extra: ['--trailing-slash', 'never'] }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const vercel = JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'));
  assert.equal(vercel.cleanUrls, true);
  assert.ok(!('trailingSlash' in vercel));
  assert.match(readFileSync(join(dir, 'astro.config.mjs'), 'utf8'), /format: 'file'/);
  const site = await import(pathToFileURL(join(dir, 'src', 'lib', 'site.mjs')).href);
  assert.equal(site.SITE_NAME, name);
  assert.equal(site.ORIGIN, 'https://www.fixture-roofing.test');
  const lists = await import(pathToFileURL(join(dir, 'src', 'lib', 'exceptions.mjs')).href);
  assert.deepEqual(lists.exceptions, []);
  assert.deepEqual(lists.proposals, []);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, 'o-neil-sons-1');
});

test('a kit without a readable package.json is a usage error', (t) => {
  const kit = bareKit(t);
  writeFileSync(join(kit, 'package.json'), '{ not json');
  const dir = tempDir(t, 'site-');
  const invalid = run(baseArgs(dir, kit));
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /package\.json/);
  rmSync(join(kit, 'package.json'));
  assert.equal(run(baseArgs(dir, kit)).status, 2);
  assert.deepEqual(readdirSync(dir), []);
});

test('a README-only directory is accepted and missing kit script trees are skipped', (t) => {
  const dir = tempDir(t, 'site-');
  writeFileSync(join(dir, 'README.md'), '# Existing repo\n');
  const result = run(baseArgs(dir, bareKit(t)));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /^# Existing repo/);
  assert.match(readme, /astro-conversion-kit/);
  assert.ok(!existsSync(join(dir, 'scripts')));
});

test('a folder holding only a capture, run state and .gitignore is scaffolded around them', (t) => {
  const dir = tempDir(t, 'site-');
  plant(join(dir, 'capture', 'inventory.json'), '[]\n');
  plant(join(dir, 'capture', 'screens', 'live', 'home', '390.png'), 'not really a png');
  plant(join(dir, '.conversion', 'state.json'), '{"version":1,"phase":"plan"}\n');
  plant(join(dir, '.conversion', 'media-cache', 'wp-content', 'uploads', 'a.jpg'), 'not really a jpg');
  writeFileSync(join(dir, '.gitignore'), '/scratch/\n');
  const result = run(baseArgs(dir, bareKit(t)));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // The capture and the state are kept as they were and land in the scaffold commit.
  assert.equal(readFileSync(join(dir, '.conversion', 'state.json'), 'utf8'), '{"version":1,"phase":"plan"}\n');
  assert.notEqual(git(dir, 'ls-files', 'capture/inventory.json'), '');
  assert.notEqual(git(dir, 'ls-files', '.conversion/state.json'), '');
  assert.equal(git(dir, 'ls-files', 'capture/screens'), '', 'screenshots stay out of git');
  assert.equal(git(dir, 'ls-files', '.conversion/media-cache'), '', 'the downloaded media stays out of git');
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '1');

  // The existing .gitignore keeps its lines and gains the template's.
  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/scratch\/$/m);
  assert.match(ignore, /^\/capture\/screens\/$/m);
});

test('anything else beside the capture is still refused', (t) => {
  const dir = tempDir(t, 'site-');
  plant(join(dir, 'capture', 'inventory.json'), '[]\n');
  plant(join(dir, 'notes.txt'), 'stray\n');
  const result = run(baseArgs(dir, bareKit(t)));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not empty/);
  assert.match(result.stderr, /Found:\n {2}notes\.txt\n/, 'only the stray file is listed');
});

test('usage errors exit 2 and write nothing', (t) => {
  const dir = tempDir(t, 'site-');
  const badHost = run(baseArgs(dir, null, { host: 'netlify' }));
  assert.equal(badHost.status, 2);
  assert.match(badHost.stderr, /--host/);
  assert.equal(run(['--dir', dir, '--name', 'X', '--host', 'vercel']).status, 2);
  assert.equal(run(baseArgs(dir, null, { extra: ['--trailing-slash', 'sometimes'] })).status, 2);
  assert.deepEqual(readdirSync(dir), []);
});

// The script each npm script in docs/LAUNCH.md runs, so its flags can be checked against --help.
const LAUNCH_SCRIPTS = {
  'review:shoot': ['visual-review', 'shoot.mjs'],
  'review:diff': ['visual-review', 'diff.mjs'],
  'review:sheet': ['visual-review', 'sheet.mjs'],
  'review:styles': ['visual-review', 'styles.mjs'],
  'review:serve': ['convert-site', 'review-serve.mjs'],
  'verify:live': ['parity-gates', 'verify-live.mjs'],
  verify: ['parity-gates', 'verify/forms.mjs', 'verify/routes.mjs'],
  'verify:release': ['parity-gates', 'verify/forms.mjs', 'verify/routes.mjs'],
};

const helpOf = (skill, script) => spawnSync(process.execPath, [join(ROOT, 'skills', skill, 'scripts', script), '--help'], { encoding: 'utf8' }).stdout;

test('docs/LAUNCH.md: every command complete, its flags in the script --help, the sitemap from the capture, the visual rule', (t) => {
  const dir = tempDir(t, 'site-');
  for (const name of ['page-sitemap.xml', 'post-sitemap.xml', 'sitemap_index.xml']) plant(join(dir, 'capture', 'sitemaps', name), '<x/>\n');
  const result = run(baseArgs(dir, bareKit(t)));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const launch = readFileSync(join(dir, 'docs', 'LAUNCH.md'), 'utf8');

  const commands = [...launch.matchAll(/`(npm run [^`]+)`/g)].map((m) => m[1]);
  const flagged = (name) => commands.filter((c) => c.startsWith(`npm run ${name} -- `));
  for (const name of ['review:shoot', 'review:diff', 'review:sheet', 'verify', 'verify:release']) assert.ok(flagged(name).length, `${name} with its arguments`);
  assert.ok(commands.filter((c) => c.startsWith('npm run verify:live')).every((c) => /-- --base \S+/.test(c)), 'verify:live always with --base');
  assert.match(launch, /npm run review:shoot -- --base http:\/\/localhost:4321 --routes capture\/templates\.json --widths 390,768,1440 --out review\/new/);
  assert.match(launch, /npm run review:diff -- --a capture\/screens\/live --b review\/new --out review\/diff/);
  for (const name of ['verify', 'verify:release']) {
    for (const c of flagged(name)) assert.match(c, /--endpoint "\$FORM_ENDPOINT" --honeypot _gotcha --thank-you \/thank-you\//);
  }
  for (const [name, [skill, ...scripts]] of Object.entries(LAUNCH_SCRIPTS)) {
    const help = scripts.map((s) => helpOf(skill, s)).join('\n');
    for (const c of commands.filter((x) => x === `npm run ${name}` || x.startsWith(`npm run ${name} `))) {
      for (const flag of c.match(/--[a-z-]+/g) ?? []) assert.ok(help.includes(flag), `${c}: ${flag} is not in ${scripts.join(', ')} --help`);
    }
  }
  assert.match(launch, /^ {4}export FORM_ENDPOINT="https:\/\/formspree\.io\/f\/REPLACE"$/m);
  assert.ok(launch.includes('`https://www.fixture-roofing.test/sitemap_index.xml`'), 'the sitemap index the capture saved');
  assert.doesNotMatch(launch, /forms@example\.com style|each miss is an exception/);
  assert.match(launch, /0\.5 % or fewer differing pixels/);
  assert.match(launch, /needs a decision row/);
  assert.ok(commands.includes('npm run review:check'), 'review:check closes the visual review');
  assert.match(launch, /`docs\/visual-overrides\.json`/);
  assert.doesNotMatch(launch, /--per-route/);
  // review:check reads review/styles.json, so B writes it; and says where the step can run.
  assert.match(launch, /npm run review:styles -- --live https:\/\/www\.fixture-roofing\.test --new http:\/\/localhost:4321 --routes capture\/templates\.json --widths 390,768,1440 --out review\/styles\.json/);
  assert.match(launch.replace(/\s+/g, ' '), /on the machine that ran the conversion/);
  assert.match(launch.replace(/\s+/g, ' '), /With `npm run review:serve` running in a second terminal/);
  assert.doesNotMatch(launch, /npm run preview/);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /forms@example\.com/);
  assert.match(agents.replace(/\s+/g, ' '), /goes only to the address given at intake/);
});

test('docs/LAUNCH.md submits the sitemap robots.txt names when the capture saved several', (t) => {
  const dir = tempDir(t, 'site-');
  for (const name of ['wp-sitemap.xml', 'wp-sitemap-posts-post-1.xml', 'sitemap_index.xml']) plant(join(dir, 'capture', 'sitemaps', name), '<x/>\n');
  plant(join(dir, 'capture', 'robots.txt'), 'User-agent: *\nDisallow: /wp-admin/\n\nSitemap: https://www.fixture-roofing.test/wp-sitemap.xml\n');
  assert.equal(run(baseArgs(dir, bareKit(t))).status, 0);
  assert.ok(readFileSync(join(dir, 'docs', 'LAUNCH.md'), 'utf8').includes('`https://www.fixture-roofing.test/wp-sitemap.xml`'));
});

test('docs/LAUNCH.md names the sitemap-index.xml the build ships when the capture saved no sitemap', (t) => {
  const dir = tempDir(t, 'site-');
  assert.equal(run(baseArgs(dir, bareKit(t))).status, 0);
  assert.ok(readFileSync(join(dir, 'docs', 'LAUNCH.md'), 'utf8').includes('`https://www.fixture-roofing.test/sitemap-index.xml`'));
});
