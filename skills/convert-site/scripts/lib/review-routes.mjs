// vercel.json redirects and rewrites for the local review server (review-serve.mjs), matched the way
// Vercel matches them. The source matcher is the same path-to-regexp subset as
// skills/parity-gates/scripts/lib/vercel-resolver.mjs (a test keeps the two compiling alike): kept as a
// copy because each skill's scripts stand alone. No side effects on import.

function groupEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  throw new Error(`unbalanced "(" in ${src}`);
}

function tokenize(src) {
  const tokens = [];
  let text = '';
  let unnamed = 0;
  const flush = () => {
    if (text) tokens.push({ type: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if ((ch === ':' && /\w/.test(src[i + 1] ?? '')) || ch === '(') {
      let j = i;
      let name;
      if (ch === ':') {
        j = i + 1;
        while (j < src.length && /\w/.test(src[j])) j += 1;
        name = src.slice(i + 1, j);
      } else name = String(unnamed++);
      let pattern = null;
      if (src[j] === '(') {
        const end = groupEnd(src, j);
        pattern = src.slice(j + 1, end);
        j = end + 1;
      }
      const mod = src[j] && '*+?'.includes(src[j]) ? src[j++] : '';
      flush();
      tokens.push({ type: 'param', name, pattern, mod });
      i = j;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return tokens;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// path-to-regexp (strict, case-sensitive, "/" as delimiter) -> { regex, names }
export function compileSource(source) {
  const tokens = tokenize(source);
  const names = [];
  let re = '';
  tokens.forEach((token, k) => {
    if (token.type === 'text') {
      const next = tokens[k + 1];
      re += escapeRe(next?.type === 'param' && token.value.endsWith('/') ? token.value.slice(0, -1) : token.value);
      return;
    }
    const prev = tokens[k - 1];
    const pre = prev?.type === 'text' && prev.value.endsWith('/') ? '\\/' : '';
    const p = token.pattern ?? '[^\\/#\\?]+?';
    names.push(token.name);
    if (token.mod === '') re += `${pre}(${p})`;
    else if (token.mod === '?') re += `(?:${pre}(${p}))?`;
    else re += `(?:${pre}((?:${p})(?:${pre}(?:${p}))*))${token.mod === '*' ? '?' : ''}`;
  });
  return { regex: new RegExp(`^${re}$`), names };
}

// Fill :name parameters (and $1-style groups) of a destination; an empty optional parameter drops
// its leading "/".
export function fillDestination(destination, params) {
  return destination
    .replace(/(\/?):(\w+)(?:\([^)]*\))?([*+?]?)/g, (match, slash, name, mod) => {
      if (!(name in params)) return match;
      const value = params[name];
      if (value === undefined || value === '') return mod ? '' : slash;
      return `${slash}${value}`;
    })
    .replace(/\$(\d+)/g, (match, n) => (String(n - 1) in params ? params[String(n - 1)] ?? '' : match));
}

function conditionHolds(condition, query) {
  if (condition.type !== 'query') return false;
  const values = query.getAll(condition.key);
  if (condition.value === undefined) return values.length > 0;
  const re = new RegExp(`^(?:${condition.value})$`);
  return values.some((v) => re.test(v));
}

export const isExternal = (url) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url);

// The query string a destination gets: its own, or the request's when it has none.
const withQuery = (destination, search) => (destination.includes('?') ? destination : `${destination}${search}`);

// routes(config) -> { redirect(path, search), rewrite(path, search) }, each returning null or the
// first matching rule's answer: a redirect { location, status }, a rewrite { destination, external }.
export function routes(config = {}) {
  const compile = (list) => (Array.isArray(list) ? list : []).map((rule) => ({ rule, ...compileSource(rule.source) }));
  const redirects = compile(config.redirects);
  const rewrites = compile(config.rewrites);

  function first(list, path, search) {
    const query = new URLSearchParams(search);
    for (const { rule, regex, names } of list) {
      const m = regex.exec(path);
      if (!m) continue;
      if (rule.has && !rule.has.every((c) => conditionHolds(c, query))) continue;
      if (rule.missing && rule.missing.some((c) => conditionHolds(c, query))) continue;
      const params = Object.fromEntries(names.map((name, i) => [name, m[i + 1]]));
      return { rule, to: withQuery(fillDestination(rule.destination, params), search) };
    }
    return null;
  }

  return {
    redirect(path, search = '') {
      const hit = first(redirects, path, search);
      if (!hit) return null;
      return { location: hit.to, status: hit.rule.statusCode ?? (hit.rule.permanent === false ? 307 : 308) };
    },
    rewrite(path, search = '') {
      const hit = first(rewrites, path, search);
      return hit ? { destination: hit.to, external: isExternal(hit.to) } : null;
    },
  };
}

// Cloudflare Pages _redirects: "source destination [status]" per line, "#" comments. A source
// matches the whole path; "*" (the splat, at most once) matches anything and ":name" one segment;
// the destination takes :splat and :name. Status 301, 302, 303, 307 or 308 redirects (302 when
// none is given); 200 rewrites (proxied when the destination is on another origin). The first
// matching line wins. A line in any other shape (conditions, other statuses) is skipped and
// passed to warn(lineNumber, line).
const CF_REDIRECT = new Set([301, 302, 303, 307, 308]);

function compileCloudflare(source) {
  const names = [];
  let re = '';
  for (const part of source.split(/(\*|:[A-Za-z_]\w*)/)) {
    if (part === '*') {
      names.push('splat');
      re += '(.*)';
    } else if (/^:[A-Za-z_]\w*$/.test(part)) {
      names.push(part.slice(1));
      re += '([^/]+)';
    } else re += escapeRe(part);
  }
  return { regex: new RegExp(`^${re}$`), names };
}

export function cloudflareRoutes(text, warn = () => {}) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fields = line.split(/\s+/);
    const status = fields.length === 3 && /^\d{3}$/.test(fields[2]) ? Number(fields[2]) : fields.length === 2 ? 302 : NaN;
    const ok = fields[0].startsWith('/') && (CF_REDIRECT.has(status) || status === 200)
      && (fields[0].match(/\*/g) ?? []).length <= 1;
    if (!ok) {
      warn(i + 1, line);
      return;
    }
    lines.push({ destination: fields[1], status, ...compileCloudflare(fields[0]) });
  });

  function first(path, search) {
    for (const rule of lines) {
      const m = rule.regex.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(rule.names.map((name, k) => [name, m[k + 1]]));
      const to = rule.destination.replace(/:([A-Za-z_]\w*)/g, (match, name) => (name in params ? params[name] : match));
      return { status: rule.status, to: withQuery(to, search) };
    }
    return null;
  }

  return {
    redirect(path, search = '') {
      const hit = first(path, search);
      return hit && hit.status !== 200 ? { location: hit.to, status: hit.status } : null;
    },
    rewrite(path, search = '') {
      const hit = first(path, search);
      return hit && hit.status === 200 ? { destination: hit.to, external: isExternal(hit.to) } : null;
    },
  };
}
