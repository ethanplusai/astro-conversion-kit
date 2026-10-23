// Route folders shared by shoot.mjs and styles.mjs: both key their rows by the
// same name, so the contact sheet can pair style rows with screenshots.
import { existsSync, readFileSync, statSync } from 'node:fs';

// A --routes value the scripts cannot use; each script reports it as a usage error.
export class RoutesError extends Error {}

export function slugFor(path) {
  const trimmed = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'home';
  // %e2 and %E2 are one URL (RFC 3986): upper-case escapes, so both spellings share a folder
  // on a case-insensitive disk instead of overwriting each other.
  return trimmed.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase()).split('/').map((part) => part.replace(/[^A-Za-z0-9_.-]/g, '-')).join('__');
}

function templateFolder(name) {
  const folder = typeof name === 'string' ? name : '';
  if (!folder || /[/\\]/.test(folder) || folder.includes('..') || folder.startsWith('.')) {
    throw new RoutesError(`template name ${JSON.stringify(name)} cannot be a folder name (no /, \\, .. or leading .)`);
  }
  return folder;
}

// [{ route, path }] from a templates.json (route is the template name, or with
// full the slug of every path) or a comma list of paths (route is the path slug).
export function readRoutes(value, { full = false } = {}) {
  let routes;
  if (value.endsWith('.json') || (existsSync(value) && statSync(value).isFile())) {
    let templates;
    try {
      templates = JSON.parse(readFileSync(value, 'utf8'));
    } catch (error) {
      throw new RoutesError(`cannot read --routes ${value}: ${error.message}`);
    }
    if (!Array.isArray(templates)) throw new RoutesError('--routes JSON must be an array of { name, representative, paths }');
    routes = full
      ? templates.flatMap((t) => (t.paths ?? [t.representative]).map((path) => ({ route: slugFor(path), path })))
      : templates.map((t) => {
          if (!t.representative) throw new RoutesError(`template ${JSON.stringify(t.name)} has no representative`);
          return { route: templateFolder(t.name), path: t.representative };
        });
  } else {
    routes = value.split(',').map((p) => p.trim()).filter(Boolean).map((path) => ({ route: slugFor(path), path }));
  }
  const seen = new Map();
  for (const { route, path } of routes) {
    if (seen.has(route)) throw new RoutesError(`${seen.get(route)} and ${path} would both be saved in folder ${route}`);
    seen.set(route, path);
  }
  return routes;
}
