import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseRedirectsFile, resolveCloudflare } from '../../skills/parity-gates/scripts/lib/cloudflare-resolver.mjs';
import { resolveVercel } from '../../skills/parity-gates/scripts/lib/vercel-resolver.mjs';
import { SLASH_RULES } from '../../skills/parity-gates/scripts/build-redirects.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../skills/parity-gates/scripts/build-redirects.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../skills/convert-site/templates/site/vercel.json', import.meta.url));

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'build-redirects-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

async function compile(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const HEADER = 'from,to,status,source,note';
function csv(name, rows) {
  const file = join(root, name);
  writeFileSync(file, `${[HEADER, ...rows].join('\n')}\n`);
  return file;
}

const ROWS = [
  '/old-services,/services/,301,seed,',
  '/?p=7,/services/,301,shortlink,unverified shortlink',
  '/About-Us,/about/,301,decision,kept case as live',
  '/blog/*,/news/:splat,301,decision,',
  '/spring-sale/,/contact/,302,capture,',
];

test('vercel: merges into vercel.json, keeps headers and cleanUrls, replaces redirects', async () => {
  const out = join(root, 'merge-vercel.json');
  const existing = { ...JSON.parse(readFileSync(TEMPLATE, 'utf8')), cleanUrls: true, trailingSlash: false };
  existing.redirects = [{ source: '/stale', destination: '/', permanent: true }];
  writeFileSync(out, JSON.stringify(existing));
  const result = await compile(['--csv', csv('merge.csv', ROWS), '--host', 'vercel', '--out', out, '--trailing-slash', 'never']);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(config.headers, existing.headers);
  assert.equal(config.cleanUrls, true);
  assert.ok(!config.redirects.some((r) => r.source === '/stale'), 'old redirects are replaced');
  for (const r of config.redirects) {
    assert.ok(!('permanent' in r), 'never permanent');
    assert.equal(typeof r.statusCode, 'number');
  }
});

test('vercel: one rule per row, statusCode from the csv, query rows use has, catch-alls in both forms', async () => {
  const out = join(root, 'rules.json');
  const result = await compile(['--csv', csv('rules.csv', ROWS), '--host', 'vercel', '--out', out, '--trailing-slash', 'always']);
  assert.equal(result.code, 0, result.stderr);
  const { redirects } = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(redirects.filter((r) => r.source === '/old-services'), [
    { source: '/old-services', destination: '/services/', statusCode: 301 },
  ]);
  assert.deepEqual(redirects.find((r) => r.has), {
    source: '/',
    has: [{ type: 'query', key: 'p', value: '7' }],
    destination: '/services/',
    statusCode: 301,
  });
  assert.ok(redirects.some((r) => r.source === '/About-Us'), 'sources keep their case');
  assert.deepEqual(
    redirects.filter((r) => r.source.startsWith('/blog/')).map((r) => r.source),
    ['/blog/:splat*', '/blog/:splat*/'],
  );
  assert.equal(redirects.find((r) => r.source === '/spring-sale/').statusCode, 302);
});

test('vercel: trailingSlash is replaced by ordered rules after the site redirects', async () => {
  const out = join(root, 'slash.json');
  writeFileSync(out, JSON.stringify({ trailingSlash: true, headers: [] }));
  const result = await compile(['--csv', csv('slash.csv', ROWS.slice(0, 1)), '--host', 'vercel', '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(!('trailingSlash' in config), 'trailingSlash would run before the redirects and add a hop');
  assert.equal(config.redirects[0].source, '/old-services');
  assert.ok(config.redirects.slice(1).every((r) => r.statusCode === 308), 'slash rules come last');
  assert.match(result.stderr, /trailingSlash/);
});

test('cloudflare: static rules first, splats kept, query rows listed for Single Redirects', async () => {
  const out = join(root, 'public', '_redirects');
  csv('cf.csv', [...ROWS, '/?p=2,/,301,shortlink,']);
  // The default --out is public/_redirects, which Astro copies into dist/.
  const result = await compile(['--csv', 'cf.csv', '--host', 'cloudflare']);
  assert.equal(result.code, 0, result.stderr);
  const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  // In "always" mode a catch-all lands on the slashed URL in one hop; its bare prefix gets a static rule.
  assert.deepEqual(lines, [
    '/old-services /services/ 301',
    '/About-Us /about/ 301',
    '/blog/ /news/ 301',
    '/spring-sale/ /contact/ 302',
    '/blog/* /news/:splat/ 301',
  ]);
  const rules = parseRedirectsFile(readFileSync(out, 'utf8'));
  assert.deepEqual(resolveCloudflare('/blog/a', { rules, dist: root }).hops, [{ from: '/blog/a', to: '/news/a/', status: 301 }]);
  assert.deepEqual(resolveCloudflare('/blog/', { rules, dist: root }).hops, [{ from: '/blog/', to: '/news/', status: 301 }]);
  assert.match(result.stderr, /cloudflare-query-redirects\.csv/);
  assert.match(result.stderr, /Single Redirect/);
  assert.match(result.stderr, /no-op row\(s\) left out .*\/\?p=2/);
  assert.equal(readFileSync(join(root, 'cloudflare-query-redirects.csv'), 'utf8'), 'from,to,status\n/?p=7,/services/,301\n');
  // Without query rows the list is removed rather than left stale.
  await compile(['--csv', csv('cf-none.csv', ROWS.slice(0, 1)), '--host', 'cloudflare', '--out', join(root, 'none_redirects')]);
  assert.ok(!existsSync(join(root, 'cloudflare-query-redirects.csv')));
});

test('vercel: the mode is read back from the slash rules a previous run wrote', async () => {
  const out = join(root, 'again.json');
  writeFileSync(out, '{}');
  await compile(['--csv', csv('again.csv', ROWS.slice(0, 1)), '--host', 'vercel', '--out', out, '--trailing-slash', 'never']);
  const again = await compile(['--csv', 'again.csv', '--host', 'vercel', '--out', out]);
  assert.match(again.stdout, /trailing slash never/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).redirects.at(-1), { source: '/:path(.+)/', destination: '/:path', statusCode: 308 });
});

test('vercel: warns on an unslashed target in always mode and near the 2,048-route limit', async () => {
  const out = join(root, 'warn.json');
  const unslashed = await compile(['--csv', csv('unslashed.csv', ['/x,/contact,301,decision,', '/y,/brochure.pdf,301,decision,']), '--host', 'vercel', '--out', out]);
  assert.match(unslashed.stderr, /1 target\(s\) without a trailing slash.*\/x -> \/contact/);
  const many = Array.from({ length: 1801 }, (_, i) => `/old-${i},/services/,301,decision,`);
  const big = await compile(['--csv', csv('big.csv', many), '--host', 'vercel', '--out', join(root, 'big.json')]);
  assert.equal(big.code, 0);
  assert.match(big.stderr, /1803 routes .*2,048/);
  const small = await compile(['--csv', csv('small.csv', ROWS.slice(0, 1)), '--host', 'vercel', '--out', join(root, 'small.json')]);
  assert.doesNotMatch(small.stderr, /warning/);
});

test('cloudflare: more than 2,000 static or 100 dynamic rules warns', async () => {
  const many = Array.from({ length: 2001 }, (_, i) => `/old-${i},/services/,301,decision,`);
  const result = await compile(['--csv', csv('many.csv', many), '--host', 'cloudflare', '--out', join(root, 'many_redirects')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /2001 static rules.*2,000/);
  const dynamic = Array.from({ length: 101 }, (_, i) => `/d${i}/*,/services/,301,decision,`);
  const r2 = await compile(['--csv', csv('dyn.csv', dynamic), '--host', 'cloudflare', '--out', join(root, 'dyn_redirects')]);
  assert.match(r2.stderr, /101 dynamic rules.*100/);
  const few = await compile(['--csv', csv('few.csv', ROWS), '--host', 'cloudflare', '--out', join(root, 'few_redirects')]);
  assert.doesNotMatch(few.stderr, /static rules|dynamic rules/);
});

const ROUTES = [
  { path: '/', status: 200, kind: 'page' },
  { path: '/feed/', status: 200, kind: 'feed' },
  { path: '/blog/feed/', status: 200, kind: 'feed' },
  { path: '/old-feed/', status: 404, kind: 'feed' },
];
function routesFile(name) {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(ROUTES));
  return file;
}

test('vercel: --routes adds a rewrite per feed route to its index.xml, merged by source', async () => {
  const out = join(root, 'feeds-vercel.json');
  writeFileSync(out, JSON.stringify({
    ...JSON.parse(readFileSync(TEMPLATE, 'utf8')),
    rewrites: [{ source: '/media/:path*', destination: 'https://store.example.com/:path*' }, { source: '/feed/', destination: '/stale.xml' }],
  }));
  const result = await compile(['--csv', csv('feeds.csv', ROWS.slice(0, 1)), '--host', 'vercel', '--out', out, '--routes', routesFile('routes.json')]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(config.rewrites, [
    { source: '/media/:path*', destination: 'https://store.example.com/:path*' },
    { source: '/feed/', destination: '/feed/index.xml' },
    { source: '/blog/feed/', destination: '/blog/feed/index.xml' },
  ]);
  assert.match(result.stdout, /2 feed rewrite\(s\)/);
  const csvAfter = readFileSync(join(root, 'feeds.csv'), 'utf8');
  assert.ok(!csvAfter.includes('feed'), 'redirects.csv stays redirect-only');
});

test('vercel: feed rewrites count toward the 2,048-route warning', async () => {
  const many = Array.from({ length: 1800 }, (_, i) => ({ path: `/f${i}/feed/`, status: 200, kind: 'feed' }));
  const file = join(root, 'many-routes.json');
  writeFileSync(file, JSON.stringify(many));
  const result = await compile(['--csv', csv('few.csv', ROWS.slice(0, 1)), '--host', 'vercel', '--out', join(root, 'many-vercel.json'), '--routes', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /warning: 18\d\d routes/);
});

test('cloudflare: --routes writes a 200 rewrite line per feed, which the resolver serves', async () => {
  const out = join(root, 'feeds', '_redirects');
  const result = await compile(['--csv', csv('cf-feeds.csv', ROWS.slice(0, 1)), '--host', 'cloudflare', '--out', out, '--routes', routesFile('cf-routes.json')]);
  assert.equal(result.code, 0, result.stderr);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^\/feed\/ \/feed\/index\.xml 200$/m);
  assert.match(text, /^\/blog\/feed\/ \/blog\/feed\/index\.xml 200$/m);
  assert.doesNotMatch(text, /old-feed/);
});

test('vercel: every file extension in dist/ (else public/) joins the slash rules, so the site\'s own files keep their URL', async () => {
  const site = join(root, 'scan');
  const put = (rel) => {
    mkdirSync(join(site, rel, '..'), { recursive: true });
    writeFileSync(join(site, rel), 'x');
  };
  put('public/files/data.Qxz');
  writeFileSync(join(site, 'redirects.csv'), `${HEADER}\n`);
  const run = async () => {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, '--host', 'vercel'], { cwd: site });
    return { stdout, stderr, config: JSON.parse(readFileSync(join(site, 'vercel.json'), 'utf8')) };
  };
  const fromPublic = await run();
  assert.match(fromPublic.stdout, /1 extension\(s\) found in public/);
  assert.deepEqual(resolveVercel('/files/data.Qxz', { config: fromPublic.config, dist: join(site, 'public') }).hops, []);
  put('dist/files/data.Qxz');
  put('dist/files/sheet.zzk');
  const fromDist = await run();
  assert.match(fromDist.stdout, /2 extension\(s\) found in dist/);
  assert.match(fromDist.stdout, /trailing slash always/, 'the mode is read back from rules that hold found extensions');
  assert.deepEqual(resolveVercel('/files/sheet.zzk', { config: fromDist.config, dist: join(site, 'dist') }).hops, []);
});

test('vercel: a .php path (admin-ajax.php) is a file, never given a trailing slash', () => {
  const config = { redirects: SLASH_RULES.always };
  const dist = mkdtempSync(join(root, 'php-'));
  assert.deepEqual(resolveVercel('/wp-admin/admin-ajax.php', { config, dist }).hops, []);
  assert.equal(resolveVercel('/wp-admin/admin-ajax.php/', { config, dist }).hops[0]?.to, '/wp-admin/admin-ajax.php');
});

test('usage errors exit 2; --help exits 0 and notes static-file precedence', async () => {
  assert.equal((await compile(['--host', 'netlify', '--csv', csv('u.csv', ROWS)])).code, 2);
  assert.equal((await compile(['--host', 'vercel', '--csv', join(root, 'nope.csv')])).code, 2);
  assert.equal((await compile(['--host', 'vercel', '--csv', csv('ok.csv', ROWS.slice(0, 1)), '--out', join(root, 'x.json'), '--routes', join(root, 'missing-routes.json')])).code, 2);
  const badStatus = csv('bad-status.csv', ['/a,/b/,200,decision,']);
  assert.equal((await compile(['--host', 'vercel', '--csv', badStatus, '--out', join(root, 'x.json')])).code, 2);
  assert.ok(!existsSync(join(root, 'x.json')));
  const help = await compile(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /dist\/ when it exists, else public\//);
  assert.match(help.stdout, /static file/i);
});
