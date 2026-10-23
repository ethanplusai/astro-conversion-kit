#!/usr/bin/env node
// Media gate: every file in baseline/media.json is served by the build with the same byte size.
// Where it lives follows docs/media-plan.json: "repo" (or no plan) -> dist/ (public/ before a build);
// under the plan's prefix, "store" -> media-manifest.json and "live-temporary" -> still on the live
// site, not checked (and a failure on a release build). Files outside the prefix are always in dist/.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, gateExceptions, report } from '../lib/gate-cli.mjs';
import { applyExceptions, exceptionFailure } from '../lib/exceptions.mjs';
import { readJson } from '../lib/dist.mjs';

const NAME = 'media';
const DEFAULT_PLAN = 'docs/media-plan.json';
const DEFAULT_MANIFEST = 'media-manifest.json';
const MODES = new Set(['repo', 'store', 'live-temporary']);
const OPTIONS = {
  'media-plan': { type: 'string', default: DEFAULT_PLAN, description: 'the media plan (media-plan.mjs); without one, media is in the repo' },
  'media-manifest': { type: 'string', default: DEFAULT_MANIFEST, description: 'the store manifest (media-upload.mjs), read when the plan mode is store' },
  public: { type: 'string', default: 'public', description: 'the site\'s public folder, read only when there is no dist' },
};
const NOTES = `
Plan modes: repo (or no plan file): each file is in dist with the same bytes; public is read
only when there is no dist yet, since once built dist is what deploys. store: each file under
the plan's prefix is in the manifest with the same bytes. live-temporary: files under the prefix
are not checked and the summary counts them as skipped (served from live); a skip is not a pass.
With PUBLIC_INDEXABLE=true, live-temporary fails every file: a release build may not serve media
from the live site. In every mode a file outside the prefix (theme fonts, a plan without a
prefix covers everything) is checked in dist like repo mode. A media exception names the media
path in path, the baseline byte count in from and the built one in to (to "" for a file the
build drops).
--paths selects a media file when its own path matches or a page that references it does
(baseline media.json referencedBy), so --paths "/,/about/" checks the media of those pages.
An entry with downloaded: false (a size only the REST media list names, which media.mjs lists
but does not download by default) is not checked and the summary counts it as skipped
("unreferenced size"); it is never a failure.
`;

// Whether --paths selects a media file: by its own path, or by a page that references it.
const selected = (m, paths) => paths(m.path) || (m.referencedBy ?? []).some((page) => paths(page));
const FROM_LIVE = 'release build may not serve media from the live site';
const UNREFERENCED = 'unreferenced size';

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const isDir = (dir) => existsSync(dir) && statSync(dir).isDirectory();
const rel = (path) => decode(path).replace(/^\/+/, '');

function fail(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
}

// A JSON file that may be missing only when it is the default; anything unreadable exits 2.
function optionalJson(file, defaultName, what) {
  if (!existsSync(file)) {
    if (file === defaultName) return null;
    return fail(`${file}: ${what} not found`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`${file}: not valid JSON (${error.message})`);
  }
}

// path -> bytes in the build, or null when the build does not have it.
export function repoSizes(dirs) {
  return (path) => {
    for (const dir of dirs) {
      const full = join(dir, rel(path));
      if (existsSync(full) && statSync(full).isFile()) return statSync(full).size;
    }
    return null;
  };
}

export function manifestSizes(manifest) {
  const sizes = new Map(manifest.map((entry) => [decode(entry.path), entry.bytes]));
  return (path) => sizes.get(decode(path)) ?? null;
}

// Whether a media path is under the plan's prefix; a plan without one covers every path.
export function underPrefix(prefix) {
  return (path) => !prefix || decode(path).startsWith(prefix);
}

export function checkMedia({ media, sizeOf, exceptions, paths = () => true }) {
  const relevant = exceptions.filter((e) => e.field === 'media');
  const items = media.filter((m) => selected(m, paths));
  const known = new Set(media.map((m) => m.path));
  const failures = relevant.filter((e) => paths(e.path) && !known.has(e.path)).map((e) => exceptionFailure(e, 'path not checked'));
  for (const item of items) {
    const { expected, staleExceptions } = applyExceptions({ media: item.bytes }, item.path, relevant);
    failures.push(...staleExceptions.map((e) => exceptionFailure(e, 'no longer matches the baseline')));
    const actual = sizeOf(item.path);
    const want = expected.media === '' ? null : expected.media;
    if (actual !== want) failures.push({ path: item.path, field: 'media', expected: want, actual });
  }
  return { checked: items.length, failures };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  const plan = optionalJson(args.mediaPlan, DEFAULT_PLAN, 'media plan');
  const mode = plan?.mode ?? 'repo';
  if (!MODES.has(mode)) fail(`${args.mediaPlan}: mode "${mode}" is not one of ${[...MODES].join('|')}`);
  if (!existsSync(join(args.baseline, 'media.json'))) fail(`not found: ${join(args.baseline, 'media.json')}`);
  const listed = readJson(join(args.baseline, 'media.json'));
  // A size the capture listed but never downloaded (media.mjs --sizes referenced) has nothing to
  // compare: it is skipped and counted, never a failure.
  const unreferenced = listed.filter((m) => m.downloaded === false && selected(m, args.paths)).length;
  const media = listed.filter((m) => m.downloaded !== false);
  const items = media.filter((m) => selected(m, args.paths));
  const withUnreferenced = (results) => {
    if (!unreferenced) return results;
    const skipped = (results.skipped ?? 0) + unreferenced;
    const skipReason = [results.skipReason, UNREFERENCED].filter(Boolean).join('; ');
    const note = `skipped: ${unreferenced} unreferenced ${unreferenced === 1 ? 'size' : 'sizes'} (listed in media.json, not downloaded)`;
    return { ...results, skipped, skipReason, notes: [...(results.notes ?? []), note] };
  };
  if (mode === 'live-temporary' && process.env.PUBLIC_INDEXABLE === 'true') {
    const failures = items.map((m) => ({ path: m.path, field: 'media', expected: 'served by the build', actual: FROM_LIVE }));
    return report(NAME, withUnreferenced({ checked: items.length, failures }), { json: args.json });
  }
  // repo mode serves everything from dist; the other modes only what lies outside the prefix.
  const inside = mode === 'repo' ? () => false : underPrefix(plan?.prefix);
  const fromDist = media.filter((m) => !inside(m.path));
  let distSize = () => null;
  if (fromDist.some((m) => selected(m, args.paths))) {
    // dist is what is deployed; public is read only when there is no build yet.
    const dir = [args.dist, args.public].find(isDir);
    if (!dir) fail(`not found: ${args.dist} (the built site) or ${args.public}`);
    distSize = repoSizes([dir]);
  }
  let storeSize = () => null;
  if (mode === 'store') {
    if (!existsSync(args.mediaManifest)) fail(`${args.mediaManifest}: media manifest not found (the plan mode is store)`);
    const manifest = optionalJson(args.mediaManifest, null, 'media manifest');
    if (!Array.isArray(manifest)) fail(`${args.mediaManifest}: expected an array of { path, bytes }`);
    storeSize = manifestSizes(manifest);
  }
  const sizeOf = (path) => (inside(path) ? storeSize(path) : distSize(path));
  const checked = mode === 'live-temporary' ? fromDist : media;
  const results = checkMedia({ media: checked, sizeOf, exceptions: gateExceptions(NAME, args), paths: args.paths });
  if (mode === 'live-temporary') Object.assign(results, { skipped: items.length - results.checked, skipReason: 'served from live' });
  return report(NAME, withUnreferenced(results), { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
