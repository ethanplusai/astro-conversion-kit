#!/usr/bin/env node
// Forms gate: each page with a form on the live site has the same forms in the build, each with
// the same field names in the same order and the same method. A POST form (a contact form) has
// its action set to the endpoint the build submits to (--endpoint); --honeypot names a spam-trap
// field every POST form must carry; --thank-you names the page every POST form leads to. A GET
// form (a search box), and a POST form that already posts to another origin, keep their live
// action and need none of those.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/node-version.mjs';
import { gateArgs, report } from '../lib/gate-cli.mjs';
import { attr, byTag, findAll, parseHtml } from '../lib/html.mjs';
import { formFields } from '../lib/forms.mjs';
import { distFiles, firstExisting, originOf, pageFiles, pageFormat, readJson, requireInputs } from '../lib/dist.mjs';

const NAME = 'forms';
const OPTIONS = {
  endpoint: { type: 'string', default: '', description: 'the URL every POST form posts to; required when the baseline has a POST form' },
  honeypot: { type: 'string', default: '', description: 'a field name every POST form must have; allowed even where the live form had none' },
  'thank-you': { type: 'string', default: '', description: 'the page every POST form leads to: a hidden _next or redirect field set to it (the path, or an absolute URL on the canonical host), and a built page' },
};
const NOTES = `
A GET form (method get, or no method: a search box) is compared with live as it is: the same
action path (an action on the site's own origin compares by path and query, any other by its
full URL), method and fields, in order. It needs no --endpoint, honeypot or thank-you page; the
summary notes "N search/GET forms compared". Only a POST form is a submission form.
A POST form whose live action is on another site (a newsletter list host, a form service: a
registrable domain other than the site's, so www., http:, a subdomain and //host/ of the site
are the site, and a WordPress handler such as admin-ajax.php, wp-comments-post.php, ?wpcf7 or
wp-json/contact-form-7 is the site on any host) already works on a static host: it is kept as captured and compared like a GET form (the same
full action URL, method and fields), with no --endpoint, honeypot or thank-you; the summary
notes "N forms kept as is (posts to <host>)". Only a POST form posting to the site itself
(its own origin, a relative or empty action) is rewired and needs --endpoint.
Fields are named input, select and textarea elements, without submit, button, reset and image
inputs, read the way the capture reads them. A _next or redirect field the live form did not
have is the endpoint's thank-you setting and is not compared with the live fields.
--thank-you <path>: every form must carry a hidden _next or redirect field set to it, and the
path must be a page in dist. The field may hold the path itself, or an absolute URL (as some
endpoints require) whose host is the baseline's canonicalOrigin (origin when meta.json has none)
and whose path is --thank-you. Without it the thank-you page is not checked, and the summary
counts each form as skipped.
A form the static site keeps but switches off (a login or checkout it cannot serve) is listed
in inert-forms.json, when that file exists, as { path, form, reason }, form being its 0-based
index among the page's forms. The gate requires live's fields and method and an action that
sends nowhere (none, "#" or javascript:), and counts the form as skipped.
`;
const THANK_YOU_FIELDS = ['_next', 'redirect'];

// The forms of a built page, as the capture records them; fields are names, hidden values kept.
export function formsOf(html) {
  return findAll(parseHtml(html), byTag('form')).map((form) => ({
    action: attr(form, 'action') || null,
    method: (attr(form, 'method') || 'get').toLowerCase(),
    fields: formFields(form).map((f) => f.name),
    hidden: Object.fromEntries(
      findAll(form, (n) => n.tagName === 'input' && (attr(n, 'type') ?? '').toLowerCase() === 'hidden' && attr(n, 'name')).map((n) => [attr(n, 'name'), attr(n, 'value') ?? '']),
    ),
  }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The host of the site the baseline captured: canonicalOrigin, or origin when it has none.
export function siteHostOf(meta = {}) {
  for (const value of [meta.canonicalOrigin, meta.origin]) {
    try {
      return new URL(value).host;
    } catch {
      // not a URL; try the next one
    }
  }
  return null;
}

// A thank-you field value leads to thankYou: the path itself, or an absolute URL on siteHost.
export function leadsTo(value, thankYou, siteHost) {
  if (value === thankYou) return true;
  if (!siteHost || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.host === siteHost && url.pathname === thankYou;
  } catch {
    return false;
  }
}

const methodOf = (form) => (form.method || 'get').toLowerCase();
export const isPost = (form) => methodOf(form) === 'post';

// Where a form's action points, comparable between live and the build: the path and query for an
// action on the site (relative, or absolute on one of origins), the full URL for any other host.
// An empty action submits to the page itself.
export function actionTarget(action, page, origins = []) {
  const base = 'http://forms.invalid';
  let url;
  try {
    url = new URL(action ?? '', new URL(page, base));
  } catch {
    return action;
  }
  if (url.origin === base || origins.includes(url.origin)) return `${url.pathname}${url.search}`;
  return url.href;
}

// Public suffixes of two labels, under which a registrable domain has three (example.co.uk).
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'co.za', 'co.in', 'com.sg',
  'com.hk', 'co.kr', 'com.tr', 'com.cn', 'com.ar', 'co.il',
]);

// The registrable domain of a hostname: its last two labels, or three under a two-level public
// suffix; an IP address or a single label as it is.
export function registrableDomain(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1)) || hostname.includes(':')) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

// Managed-WordPress staging hosts: a form posting to one of these posts to the old site, not to a
// form service, even when its action is a page URL rather than a handler.
const MANAGED_WP_SUFFIXES = [
  'wpengine.com', 'wpenginepowered.com', 'kinsta.cloud', 'pantheonsite.io', 'flywheelsites.com',
  'wpcomstaging.com', 'cloudwaysapps.com', 'mystagingwebsite.com', 'dreamhosters.com', 'instawp.xyz',
];
const managedWordPress = (hostname) => MANAGED_WP_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`));

// WordPress's own form handlers: whatever host they are on, the form posts to the old site.
const OLD_SITE_PATH = /\/(?:wp-admin\/admin-ajax\.php|wp-comments-post\.php|wp-admin\/admin-post\.php)$/i;
const OLD_SITE_URL = /[?&]wpcf7|wp-json\/contact-form-7/i;

// The host a POST form already posts to when that is another site (a newsletter list host, a form
// service: a different registrable domain), else null: such a form works on a static host
// unchanged and is kept as captured. Null for a form posting to the old site: an empty or relative
// action, one on any host of the site's registrable domains (www, http, a subdomain, a
// protocol-relative //host), a WordPress form handler on any host, and any managed-WordPress
// staging host (wpengine.com, kinsta.cloud, pantheonsite.io, ...).
export function externalHost(form, page, origins = []) {
  if (!isPost(form)) return null;
  const action = (form.action ?? '').trim();
  if (!action) return null;
  const base = origins[0] ?? 'http://forms.invalid';
  let url;
  try {
    url = new URL(action, new URL(page, base));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.hostname === 'forms.invalid') return null;
  if (OLD_SITE_PATH.test(url.pathname) || OLD_SITE_URL.test(action)) return null;
  if (managedWordPress(url.hostname.toLowerCase().replace(/\.$/, ''))) return null;
  const siteDomains = new Set(origins.map((o) => registrableDomain(new URL(o).hostname)));
  if (siteDomains.has(registrableDomain(url.hostname))) return null;
  return url.host;
}

// A GET form against its live form: the same action target, method and fields.
export function compareGetForm(path, label, expected, actual, origins = []) {
  const failures = [];
  const field = (name) => (label ? `${label} ${name}` : name);
  const want = expected.fields.map((f) => (typeof f === 'string' ? f : f.name));
  if (!same(want, actual.fields)) failures.push({ path, field: field('fields'), expected: want, actual: actual.fields });
  if (methodOf(expected) !== actual.method) failures.push({ path, field: field('method'), expected: methodOf(expected), actual: actual.method });
  const wantAction = actionTarget(expected.action, path, origins);
  const gotAction = actionTarget(actual.action, path, origins);
  if (wantAction !== gotAction) failures.push({ path, field: field('action'), expected: wantAction, actual: gotAction });
  return failures;
}

export function compareForm(path, label, expected, actual, { endpoint, honeypot, thankYou, siteHost = null }) {
  const failures = [];
  const field = (name) => (label ? `${label} ${name}` : name);
  const want = expected.fields.map((f) => (typeof f === 'string' ? f : f.name));
  let got = actual.fields;
  if (honeypot) {
    if (!got.includes(honeypot)) failures.push({ path, field: field('honeypot'), expected: honeypot, actual: null });
    if (!want.includes(honeypot)) got = got.filter((name) => name !== honeypot);
  }
  got = got.filter((name) => !THANK_YOU_FIELDS.includes(name) || want.includes(name));
  if (thankYou) {
    const values = THANK_YOU_FIELDS.filter((name) => name in actual.hidden).map((name) => actual.hidden[name]);
    if (!values.some((value) => leadsTo(value, thankYou, siteHost))) failures.push({ path, field: field('thank-you'), expected: thankYou, actual: values[0] ?? null });
  }
  if (!same(want, got)) failures.push({ path, field: field('fields'), expected: want, actual: got });
  const method = (expected.method || 'get').toLowerCase();
  if (method !== actual.method) failures.push({ path, field: field('method'), expected: method, actual: actual.method });
  if (actual.action !== endpoint) failures.push({ path, field: field('action'), expected: endpoint, actual: actual.action });
  return failures;
}

// A form listed as inert: the same fields and method as live, and an action that sends nowhere.
const sendsNowhere = (action) => !action || action === '#' || /^javascript:/i.test(action);

export function compareInertForm(path, label, expected, actual) {
  const failures = [];
  const field = (name) => (label ? `${label} ${name}` : name);
  const want = expected.fields.map((f) => (typeof f === 'string' ? f : f.name));
  if (!same(want, actual.fields)) failures.push({ path, field: field('fields'), expected: want, actual: actual.fields });
  const method = (expected.method || 'get').toLowerCase();
  if (method !== actual.method) failures.push({ path, field: field('method'), expected: method, actual: actual.method });
  if (!sendsNowhere(actual.action)) failures.push({ path, field: field('inert action'), expected: 'none, # or javascript:', actual: actual.action });
  return failures;
}

export function checkForms({ dist, forms, endpoint, honeypot = '', thankYou = '', meta = {}, paths = () => true, inert = [] }) {
  const inertKeys = new Set(inert.map((entry) => `${entry.path}#${entry.form}`));
  let inertCount = 0;
  const siteHost = siteHostOf(meta);
  const origins = [meta.origin, meta.canonicalOrigin].map((o) => originOf(o ?? '')).filter(Boolean);
  let getCount = 0;
  const keptHosts = [];
  const files = distFiles(dist);
  const format = pageFormat(files);
  const failures = [];
  let checked = 0;
  let formCount = 0;
  for (const [path, expected] of Object.entries(forms)) {
    if (!paths(path) || expected.length === 0) continue;
    checked += 1;
    const candidates = pageFiles(path, format);
    const file = firstExisting(dist, candidates);
    if (!file) {
      failures.push({ path, field: 'page', expected: candidates[0], actual: null });
      continue;
    }
    const actual = formsOf(readFileSync(join(dist, file), 'utf8'));
    if (actual.length !== expected.length) {
      failures.push({ path, field: 'forms', expected: expected.length, actual: actual.length });
      continue;
    }
    expected.forEach((form, i) => {
      const label = expected.length > 1 ? `form ${i + 1}` : '';
      if (inertKeys.has(`${path}#${i}`)) {
        inertCount += 1;
        failures.push(...compareInertForm(path, label, form, actual[i]));
        return;
      }
      const host = externalHost(form, path, origins);
      if (host) {
        keptHosts.push(host);
        failures.push(...compareGetForm(path, label, form, actual[i], origins));
        return;
      }
      if (!isPost(form)) {
        getCount += 1;
        failures.push(...compareGetForm(path, label, form, actual[i], origins));
        return;
      }
      formCount += 1;
      failures.push(...compareForm(path, label, form, actual[i], { endpoint, honeypot, thankYou, siteHost }));
    });
  }
  const notes = getCount ? [`${getCount} search/GET forms compared`] : [];
  if (keptHosts.length) {
    const n = keptHosts.length;
    notes.push(`${n} ${n === 1 ? 'form' : 'forms'} kept as is (posts to ${[...new Set(keptHosts)].join(', ')})`);
  }
  if (thankYou && formCount > 0) {
    const candidates = pageFiles(thankYou, format);
    if (!candidates.some((c) => files.includes(c))) failures.push({ path: thankYou, field: 'thank-you', expected: candidates[0], actual: null });
  }
  const inertSkip = inertCount ? { skipped: inertCount, skipReason: 'inert forms' } : {};
  if (thankYou || formCount === 0) return { checked, failures, notes, ...inertSkip };
  return { checked, failures, skipped: formCount + inertCount, skipReason: `thank-you not checked${inertCount ? ', inert forms' : ''}`, notes: [...notes, 'thank-you: not checked (no --thank-you)'] };
}

function main() {
  assertNodeVersion();
  const args = gateArgs(process.argv.slice(2), NAME, { options: OPTIONS, notes: NOTES });
  requireInputs(NAME, args.dist, args.baseline, ['forms.json']);
  const forms = readJson(join(args.baseline, 'forms.json'));
  const metaFile = join(args.baseline, 'meta.json');
  const meta = existsSync(metaFile) ? readJson(metaFile) : {};
  const origins = [meta.origin, meta.canonicalOrigin].map((o) => originOf(o ?? '')).filter(Boolean);
  const inert = existsSync('inert-forms.json') ? readJson('inert-forms.json') : [];
  for (const entry of inert) {
    if (!entry.path || !Number.isInteger(entry.form) || !entry.reason) {
      process.stderr.write(`${NAME}: every inert-forms.json entry needs path, form and reason\n`);
      process.exit(2);
    }
  }
  const inertKeys = new Set(inert.map((entry) => `${entry.path}#${entry.form}`));
  const postsToSite = (form, path, i) => isPost(form) && !externalHost(form, path, origins) && !inertKeys.has(`${path}#${i}`);
  const withForms = Object.entries(forms).filter(([path, list]) => args.paths(path) && list.some((form, i) => postsToSite(form, path, i)));
  if (withForms.length > 0 && !args.endpoint) {
    process.stderr.write(`${NAME}: --endpoint <url> is required: the baseline has POST forms on ${withForms.map(([p]) => p).join(', ')}\n`);
    process.exit(2);
  }
  const results = checkForms({
    dist: args.dist,
    forms,
    endpoint: args.endpoint,
    honeypot: args.honeypot,
    thankYou: args.thankYou,
    meta,
    paths: args.paths,
    inert,
  });
  report(NAME, results, { json: args.json });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
