// Path prefixes a capture left out (capture.mjs --exclude, baseline/meta.json excluded), matched
// in one canonical form on both sides: the URL parser's encoding of the path (non-ASCII as
// UTF-8 percent escapes), every escape of an unreserved character (A-Z a-z 0-9 - . _ ~) decoded
// and every other escape in upper case. So /présidence/, /pr%c3%a9sidence/ and /pr%C3%A9sidence/
// are one path, and /%70resident/ is /president/. Letters outside escapes stay case-sensitive.
// canonicalPath(path) -> that form. excludedBy(prefixes, pathname) -> the first prefix covering
// the path (a prefix ending in / also covers the same path without it), or null.
const UNRESERVED = /[A-Za-z0-9\-._~]/;

export function canonicalPath(path) {
  let pathname;
  try {
    pathname = new URL(path, 'http://x').pathname;
  } catch {
    pathname = String(path);
  }
  return pathname.replace(/%([0-9a-f]{2})/gi, (escape, hex) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

export function excludedBy(prefixes, pathname) {
  if (!prefixes?.length) return null;
  const path = canonicalPath(pathname);
  for (const prefix of prefixes) {
    const want = canonicalPath(prefix);
    if (path.startsWith(want) || (want.endsWith('/') && path === want.slice(0, -1))) return prefix;
  }
  return null;
}
