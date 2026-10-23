import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../skills/capture-site/scripts/lib/extract.mjs';
import { slugFor } from '../../skills/capture-site/scripts/lib/slug.mjs';

const ORIGIN = 'https://www.example.com';
const page = (rel) =>
  readFileSync(new URL(`../fixture/site/${rel}`, import.meta.url), 'utf8').replace(/\{\{ORIGIN\}\}/g, ORIGIN);

test('the home page record carries head, body classes and vendors', () => {
  const record = extractPage(page('index.html'), `${ORIGIN}/`);
  assert.equal(record.url, `${ORIGIN}/`);
  assert.equal(record.path, '/');
  assert.equal(record.title, 'Fixture Roofing & Siding | Roofing and siding contractors');
  assert.equal(record.description, 'Roof repair, replacement and siding installation from a local crew.');
  assert.equal(record.canonical, `${ORIGIN}/`);
  assert.equal(record.lang, 'en-US');
  assert.equal(record.robots, null);
  assert.deepEqual(record.h1, ['Roofs and siding built to last']);
  assert.ok(record.h2.includes('What we do'));
  assert.equal(record.og.title, 'Fixture Roofing & Siding | Roofing and siding contractors');
  assert.ok(record.bodyClasses.includes('home'));
  assert.ok(record.bodyClasses.includes('page'));

  const ga4 = record.scripts.filter((s) => s.vendor === 'ga4');
  assert.ok(ga4.length >= 1);
  assert.ok(ga4.every((s) => s.id === 'G-FIXTURE1'));
  assert.ok(ga4.some((s) => s.inline) && ga4.some((s) => !s.inline));
  const gtm = record.scripts.find((s) => s.vendor === 'gtm');
  assert.equal(gtm.id, 'GTM-FIXTURE');
  const theme = record.scripts.find((s) => s.src?.includes('reveal.js'));
  assert.equal(theme.vendor, 'other');
  assert.equal(theme.kind, 'script');

  assert.deepEqual(record.styles, [
    { href: `${ORIGIN}/wp-content/themes/fixture/style.css?ver=1.4.2`, inline: false },
    { href: null, inline: true },
    { href: null, inline: true },
    { href: null, inline: true },
  ], 'the theme stylesheet and three WordPress <style> blocks');
  assert.equal(record.shortlink, '/?p=2');
  assert.deepEqual(record.alternates, [{ href: `${ORIGIN}/feed/`, type: 'application/rss+xml', hreflang: null }]);
});

test('module scripts, modulepreload links and import map URLs are script entries with a kind', () => {
  const record = extractPage(page('index.html'), `${ORIGIN}/`);
  const files = record.scripts.filter((s) => s.src && s.kind !== 'script').map((s) => ({ src: s.src, kind: s.kind, inline: s.inline }));
  assert.deepEqual(files, [
    { src: `${ORIGIN}/wp-includes/js/script-modules/interactivity/index.min.js?ver=6.6.2`, kind: 'importmap', inline: false },
    { src: `${ORIGIN}/wp-content/themes/fixture/js/util.js`, kind: 'importmap', inline: false },
    { src: `${ORIGIN}/wp-content/themes/fixture/js/view.js?ver=1.4.2`, kind: 'module', inline: false },
    { src: `${ORIGIN}/wp-includes/js/script-modules/a11y/index.min.js?ver=6.6.2`, kind: 'modulepreload', inline: false },
  ]);
  const map = record.scripts.find((s) => s.inline && s.kind === 'importmap');
  assert.equal(map.src, null, 'the import map element itself is an inline entry');

  const odd = extractPage(`<html><head>
    <script type="importmap">{"imports":{"a":"/a.js","dir/":"/dir/","bad":42}}</script>
    <script type="importmap">not json</script>
    <link rel="modulepreload" href="/a.js">
  </head></html>`, 'https://example.com/x/');
  assert.deepEqual(odd.scripts.filter((s) => s.src).map((s) => `${s.kind} ${s.src}`), ['importmap https://example.com/a.js'],
    'a path prefix, a non-string and broken JSON are skipped; one URL is listed once');
});

test('the lazy image takes data-src and the noscript copy is not counted twice', () => {
  const record = extractPage(page('index.html'), `${ORIGIN}/`);
  // The 24px header avatar reuses team-300x200.jpg; the lazy team photo is the other one.
  const team = record.images.filter((img) => img.src.includes('/team-') && img.width !== 24);
  assert.equal(team.length, 1);
  assert.equal(team[0].lazy, true);
  assert.equal(team[0].src, `${ORIGIN}/wp-content/uploads/2026/01/team-1024x683.jpg`);
  assert.match(team[0].srcset, /team-300x200\.jpg 300w/);
  assert.equal(team[0].alt, 'Our crew');
  assert.equal(team[0].width, 1024);
  const hero = record.images.find((img) => img.alt === 'A finished roof at sunset');
  assert.equal(hero.lazy, false);
  assert.equal(hero.height, 683);
  assert.equal(record.images.filter((img) => img.src.startsWith('data:')).length, 0);
  assert.deepEqual(record.iframes, [], 'the GTM noscript iframe is not an iframe on the page');
});

test('links split into internal paths and external URLs, fragments stripped', () => {
  const record = extractPage(page('index.html'), `${ORIGIN}/`);
  assert.ok(record.internalLinks.includes('/hidden-page/'));
  assert.ok(record.internalLinks.includes('/services/siding/'));
  assert.ok(record.internalLinks.includes('/'));
  assert.ok(!record.internalLinks.some((l) => l.includes('#')));
  assert.equal(new Set(record.internalLinks).size, record.internalLinks.length);
  assert.ok(!record.internalLinks.some((l) => l.startsWith('mailto:')));
  assert.deepEqual(record.externalLinks, []);
});

test('visible text leaves out chrome and hidden blocks', () => {
  const record = extractPage(page('index.html'), `${ORIGIN}/`);
  assert.match(record.text, /Roofs and siding built to last/);
  assert.match(record.text, /Call us at 555-555-0100 today\./);
  assert.doesNotMatch(record.text, /Proudly powered by WordPress/, 'footer');
  assert.doesNotMatch(record.text, /Skip to content/);
  assert.doesNotMatch(record.text, /Winter special/, 'display:none block');
  assert.ok(record.wordCount > 0);
  assert.equal(record.wordCount, record.text.split(/\s+/).length);
});

test('the contact form lists its fields, and the honeypot label is not visible text', () => {
  const record = extractPage(page('contact/index.html'), `${ORIGIN}/contact/`);
  assert.equal(record.forms.length, 1);
  const [form] = record.forms;
  assert.equal(form.action, '/contact/');
  assert.equal(form.method, 'post');
  assert.deepEqual(form.fields.map((f) => f.name), ['name', 'email', 'message', 'website']);
  assert.deepEqual(form.fields.map((f) => f.type), ['text', 'email', 'textarea', 'text']);
  assert.deepEqual(form.fields.map((f) => f.required), [true, true, true, false]);
  assert.match(record.text, /Fill in the form/);
  assert.doesNotMatch(record.text, /Website/);
});

test('a post records its type and the noindex page its robots', () => {
  const post = extractPage(page('spring-roof-checklist/index.html'), `${ORIGIN}/spring-roof-checklist/`);
  assert.ok(post.bodyClasses.includes('single-post'));
  assert.equal(post.og.type, 'article');
  const hidden = extractPage(page('private-page/index.html'), `${ORIGIN}/private-page/`);
  assert.match(hidden.robots, /noindex/);
});

test('vendors are found in src and inline code with their ids', () => {
  const html = `<html><head>
    <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
    <script>fbq('init', '1234567890'); fbq('track', 'PageView');</script>
    <script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){};h._hjSettings={hjid:3456789,hjsv:6};})(window,document);</script>
    <script>(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "abcd1234ef");</script>
    <script src="//js.hs-scripts.com/998877.js"></script>
    <script src="https://www.google.com/recaptcha/api.js?render=6LcKEY"></script>
    <script src="https://embed.tawk.to/5f1/default"></script>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebPage","FAQPage"],"datePublished":"2026-01-01"}]}</script>
  </head><body><iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>`;
  const record = extractPage(html, 'https://example.com/x/');
  const v = (name) => record.scripts.find((s) => s.vendor === name);
  assert.equal(v('meta-pixel').id, null, 'the loader carries no id');
  assert.equal(record.scripts.filter((s) => s.vendor === 'meta-pixel')[1].id, '1234567890');
  assert.equal(v('hotjar').id, '3456789');
  assert.equal(v('clarity').id, 'abcd1234ef');
  assert.equal(v('hubspot').id, '998877');
  assert.equal(v('recaptcha').id, '6LcKEY');
  assert.equal(v('tawk').id, '5f1');
  assert.equal(record.scripts.length, 7, 'JSON-LD is not a script entry');
  assert.deepEqual(record.jsonLdTypes, ['Organization', 'WebPage', 'FAQPage']);
  assert.equal(record.published, '2026-01-01');
  assert.deepEqual(record.iframes, ['https://www.youtube.com/embed/abc']);
});

test('slugFor maps paths to safe file names', () => {
  assert.equal(slugFor('/'), 'home');
  assert.equal(slugFor('/a/b/'), 'a__b');
  assert.equal(slugFor('/?p=7'), '_q_p-7');
  assert.equal(slugFor('/About/Our Team/'), 'about__our-team');
  assert.equal(slugFor('/services/roofing/?x=1&y=2'), 'services__roofing_q_x-1-y-2');
  const long = slugFor(`/${'a'.repeat(300)}/`);
  assert.equal(long.length, 120);
  assert.notEqual(long, slugFor(`/${'a'.repeat(299)}b/`));
  assert.match(slugFor('/x.php?ü=1'), /^[a-z0-9_-]+$/);
});
