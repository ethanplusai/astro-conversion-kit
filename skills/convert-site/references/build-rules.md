# Build rules

Binding for every page, layout and file in the site. The capture is the source; the default build
equals live, faults included. When a rule here and a gate disagree, the gate is right about
parity and this file is wrong: say so and fix this file.

## Structure

- **Layouts and shared parts are always components.** One layout per template in
  `src/layouts/<Template>.astro`, built on `Base.astro`. The header, navigation and footer are
  `src/components/Header.astro`, `Nav.astro`, `Footer.astro` (plus any other block every page of
  a template shares, such as a sidebar), each holding the captured markup of the representative
  page, copied, not retyped.
- **Content blocks are the captured markup.** A page's main content is moved from
  `capture/pages/<slug>.html` by a script, never by hand: a small Node script in the site (for
  example `tools/extract-content.mjs`, using `parse5`) cuts each page's content region and writes
  it to `src/content/pages/<slug>.html`; each template's route (for example
  `src/pages/[...path].astro` with `getStaticPaths` over `baseline/routes.json`) renders it with
  `<Fragment set:html={html} />` inside the template's layout. The content region is found by
  the same selector for every page of a template; a page that does not fit means the template
  split is wrong, not that the page needs special casing.
- **Head tags from the baseline.** Title, description, canonical, robots, `lang`, Open Graph,
  Twitter and JSON-LD come from `baseline/seo.json` per path (JSON-LD as captured, in
  `<script type="application/ld+json" set:html>`). The body class and `<html>` attributes are
  copied from the captured page.
- **No retyping, no tidying.** Text, headings, alt text, link text, whitespace inside `<pre>`,
  entities and odd markup stay as captured. A typo is reproduced and goes in the suggestions.
- **Components beyond the shared parts** are the optional pass (`components-optional.md`),
  after the visual review, never during the build.

## URLs in the captured markup

- **Forms that already post elsewhere stay as captured.** A POST form whose `action` is on
  another registrable domain (a newsletter list host, a form service) is kept exactly as captured and listed
  in the plan under "Forms kept as is" with its action host; only a POST form posting to the
  old site (an empty or relative action, the live origin, `/wp-admin/admin-ajax.php`,
  `/wp-comments-post.php`) is rewired to the form endpoint (`forms.md`).
- **Content links stay as captured.** Every `<a href>` (and `<area href>`, a form `action` other than the rewired ones above, and
  the head's canonical, alternate, REST and oEmbed links) keeps the URL the capture saved, a
  same-origin absolute one (`https://<live host>/team`) included: never rewrite one to
  root-relative or to another host. The links gate counts same-origin absolute links as internal.
  Dropping or changing one because it cannot work on a static site is a `links` exception
  (`exceptions.json`, SKILL.md "Decisions, exceptions, proposals"), never an edit.
- **So a preview's links lead to live.** WordPress writes every internal link absolute, so on a
  staging or preview host each click on a captured same-origin `<a href>` goes back to the live
  site, and `launch-audit` on that host crawls only the first page. The default build keeps it
  that way (it equals live); say so when you hand over the preview URL. To make a preview that
  can be clicked through, offer it as a proposal: one decision, and a `proposalOn(id)` switch in
  a small helper the page body passes through, that rewrites body `<a href>` on the live origin
  (`https://`, `http://` or `//`, with or without `www.`) to root-relative. It leaves head tags
  (canonical, alternate, og) alone and keeps any href that a `link` exception records exactly
  as recorded. Record it in `proposals.json` with `field: "markup"`, one record per page it
  changes (`from` the live href form, `to` the root-relative one); no gate compares it, since the
  links gate already counts both forms as internal. The helper is a dozen lines: match
  `href="https://www.example.com/..."` (and the `http://`, `//` and apex forms) in the body
  markup, replace the origin with nothing when `proposalOn(id)` is true, and return the markup
  unchanged otherwise.
- **WordPress API head links are kept as captured.** `wp-json/` (`rel="https://api.w.org/"`),
  `xmlrpc.php?rsd` (`EditURI`) and `wp-json/wp/v2/pages/N` (`alternate`) stay in the head
  although nothing answers them on a static host. `npm run links:exceptions`
  (`link-exceptions.mjs --baseline baseline --capture capture --out exceptions.json`) writes
  their links exceptions, one row per API link per page (reason "WordPress API link kept as
  captured"), and one per link to a page live answered 404 or 410 (reason "broken on live"),
  rather than dropping the links.
- **Same-origin asset URLs are root-relative, by default.** A `<script src>`, a `<link href>` for
  a stylesheet, icon or preload, an `<img src>` and `srcset`, and a `<video>`, `<audio>` or
  `<source>` `src` (and `poster`) that the captured markup writes absolute to the live origin
  become root-relative (`https://<live host>/wp-content/x.js` to `/wp-content/x.js`), so a local,
  preview or staging build never loads an asset from live: a module script from live fails CORS
  there and breaks styles parity, and the visual review would prove live's files instead of the
  copies under `public/`. One decision row covers the set (topic "same-origin asset URLs
  root-relative"). Other origins, and `<meta>` values such as `og:image`, stay as captured.
  `css-prune.mjs` already rewrites the stylesheet's same-origin `url()` references the same way.

## CSS

- **Each live stylesheet at its live path, each page's head CSS in live order** is the default,
  recorded as a decision in the plan (topic "CSS per live sheet", default "per sheet"). Live
  serves every page its own list of `<link rel="stylesheet">` and `<style>` blocks, interleaved
  in a page-specific order, and rules of equal specificity resolve by that order: merged into one
  file, a later page's copy of a block theme's global layout rule overrides a page's own
  container rule (a post's H1 capped at 792 px instead of 900 px). Coverage first, then prune:
  `capture/css-coverage.json` (phase 2) and `css-prune.mjs`, which reads each page's `<head>`
  from `capture/inventory.json` and the snapshots, prunes every same-origin linked sheet on its
  own (with the coverage of its own href only, so identical sheets a multisite serves under two
  paths never share coverage) into `public/<live path>` (the query string dropped from the file
  name, kept in the link), and every distinct head `<style>` block into
  `src/styles/inline/inline-<page>-<n>.css`. The report's `heads` gives each path its list in
  live order (`{ kind: "link", href, media? }`, `{ kind: "inline", file }`): the content
  extractor copies it into each page's data and the page passes it to `Base.astro` as `css`,
  which prints the links and the `<style>` blocks in that order before the head slot (the 404 and
  thank-you pages pass the list of the page whose head they copy). No `site.css` is written
  (`siteCss: null` in the report), and none is linked when a page passes `css`. A link keeps its
  live `media` attribute; a sheet linked with a media no tested width satisfies (`print`) is kept
  whole, because coverage runs on screen only. Another origin's sheet stays linked as live links
  it (`external`); a same-origin link whose sheet was not captured is left out (`notCaptured`).
  The baseline lists the captured sheets (`baseline/css.json`), so the routes gate takes each
  file at its live path as built, not as an extra. One pathname captured under two queries is one
  file when the bytes are the same; with other bytes the second is served at the query-named
  path (`style.ver-2.css`) and its pages link that. A captured sheet only an `@import` reaches
  (the parent or the child cannot be parsed, so the `@import` stays) is served at its live path
  too. A link to the site on another scheme or the www/apex twin is the site's own sheet.
- `--single-sheet` merges everything into `src/styles/site.css` instead, for a simple classic
  theme only: one theme stylesheet and no `<style>` blocks whose order matters. `Base.astro`
  then imports it by URL (`import siteCss from '../styles/site.css?url'`) and links it before the
  head slot, so a page's own head content comes after it. Never switch to a plain
  `import '../styles/site.css'`: Astro puts that link at the end of `<head>`, after every
  `set:html` head block. The scaffold ships a one-line placeholder `site.css` so it builds before
  the prune replaces it, and `src/styles/pages/` may be absent. The used rules of the head's
  `<style>` blocks are in it, each page's set under a comment naming its pages, except a rule
  another page defines differently (a block theme's counter classes: `.wp-elements-1 a` is white
  on one page and black on the next) and every rule naming its class (a class it styles, not one inside its `:not()`/`:where()`): those go to
  `src/styles/pages/<inline file>`, listed under `pageSheets` (`file`, `pages`, `rules`) in
  `.conversion/css-prune-report.json`. Link each page sheet only on the pages it lists, after
  `site.css` (Base.astro's `pageSheet` prop); never copy its rules into `site.css`. A sheet
  linked with a media attribute is wrapped in that `@media`. Vite processes `site.css`, so
  invalid live CSS (a stray `false;` in an embed's sheet) can fail the build; the default
  serves sheets from `public/` and prints `<style>` blocks raw, untouched by Vite.
- In both modes the pruned files are the stylesheets; they are never rewritten, reformatted or
  "cleaned up". Inline blocks are known by their text, so WordPress 6.9+'s
  `/*# sourceURL=... */` comments change nothing.
  A captured `@import` is replaced by the imported sheet's pruned rules in place; one whose
  target was not captured stays an `@import` and is listed under `unresolvedImports` in
  `.conversion/css-prune-report.json`: check each one loads from the new site or restore its
  rules. A sheet or block css-tree cannot parse is kept byte for byte and listed under
  `unparsed`. Exit 1 means a stylesheet file (`unmatched`) never appeared in coverage and was kept
  whole: re-run coverage on the pages that link it.
  `uncoveredInline` lists the pages' `<style>` sets no coverage run saw (usually pages past the
  coverage cap of 10 per template); they are kept whole. Per sheet they stay on their own pages,
  so nothing is lost but bytes; merged (`--single-sheet`) they reach every page. Add one of
  their pages to the coverage routes and run coverage and the prune again.
- Coverage clicks each menu and accordion toggle once, and the prune keeps every state rule
  (`.open`, `.menu-open`, `.is-active`, `[aria-expanded="true"]`, …) whose element was on a
  covered page: the report counts them as `keptBecause.state` ("kept for state: N rules").
  No screenshot compares an open menu (visual-review's Not covered list says so).
- A diff caused by pruning (a state the coverage run still never saw: a JavaScript-added
  class with an unusual name) is fixed by restoring the original rule from `capture/css/`, copied as written, into
  `src/styles/restored.css` with a comment naming the source file. New CSS is allowed only for a
  difference the static build creates itself (a script that no longer runs), each rule with a
  comment and a decision id.
- Inline `style` attributes and `<style>` blocks in the captured content stay where they are.

## Media and fonts

- **Original paths, always.** `npm run assets:copy` (`copy-assets.mjs --capture capture
  --site .`) does the copying. Mode `repo`: it copies the capture's download
  (`.conversion/media-cache/`) into `public/` so every file is at its site path, every file the
  capture listed, referenced or not
  (WordPress image sizes included). Mode `store` or `live-temporary`: nothing under the media
  prefix goes in `public/`; the host file says how the prefix is reached. In every mode, files
  outside the media prefix are copied to `public/` at their live paths (the media gate checks
  them in `dist/`).
- **Optimiser suffixes are separate files.** `-scaled`, `-e1612345678`, `photo.jpg.webp`,
  `-300x200`: each variant is kept at its own URL. `?ver=` query strings on assets stay in the
  markup as written; the static host ignores them.
- **Lazy images.** Where the live markup holds the real source in `data-src`, `data-srcset` or
  `data-lazy-src` and a script swaps it in, the build writes that value into `src` (and `srcset`)
  so the image shows without the script; the `data-*` attributes stay as captured.
- **Fonts self-hosted.** Every font in `capture/assets/` is served from the site at its original
  path (same-origin fonts) or under `/fonts/` (fonts the live site loaded from a font service),
  with the same families, weights and styles. Replacing a font service link with local
  `@font-face` rules is a decision row; the visual review proves it.
- Logo, favicon, apple-touch-icon and the web manifest from `capture/assets/`, same paths.
- Every `root-icon` entry in `capture/assets/index.json` that has a `file` is copied byte for
  byte to `public/<path>` (`assets/root-favicon.ico` → `public/favicon.ico`,
  `assets/root-apple-touch-icon.png` → `public/apple-touch-icon.png`). One with `file: null` is
  an icon live did not serve at the root (its status and note say why); `npm run assets:copy`
  copies each `root-icon` entry with a `file` to `public/` plus its `path`, and the fonts and
  the web manifest with them.

## Scripts

- Third-party scripts follow the `keep` allowlist (`third-party.md`).
- Same-origin theme and plugin scripts are in the capture (`capture/js/`, listed in
  `baseline/js.json`). The default is to copy each one that drives visible behaviour (a lazy
  loader, a menu toggle, a scroll reveal, a slider), and the vendor library it needs, to its
  live path under `public/`, so the captured `<script src>` tags keep working; the routes gate
  allows those paths. `npm run assets:copy` copies every script the capture saved; a script
  dropped by a decision row loses its `<script>` tag, and its file is left unused. Rebuilding one as a small inline script against the same markup, or
  dropping it, is a decision row per script.
- Scripts that do nothing on a static site (`wp-emoji`, `admin-bar`, `comment-reply`,
  `wp-embed` and the like) are dropped by default, with their `<script>` tags, under one decision
  row for the set.

## Redirects

- `redirects.csv` (from, to, status, source, note) is the single source. `npm run baseline`
  writes it from the capture; a redirect you add (a duplicate slug, a `.html` form, an old URL
  from the intake) is a row with `source` `decision` and the decision id in `note`.
- A URL the live sitemap lists but live answers 404: redirect it to the nearest live parent, or
  the posts archive for a post, as a decision row, because pre-launch requires every predecessor
  URL to resolve.
- `npm run redirects:build` writes `vercel.json` `redirects` or `public/_redirects`. Never edit
  the generated rules by hand. Every chain becomes one hop to the final target. It also writes a
  rewrite per feed (`/feed/` to `/feed/index.xml`, from `baseline/routes.json`), since neither
  host serves `index.xml` for a directory path.
- A static page at a redirect source fails the redirects gate: delete the page or the row.

## Sitemaps, feeds, robots, 404

- Sitemaps and feeds are endpoints at the live URLs (`src/pages/sitemap_index.xml.js`,
  `feed/index.xml.js`, …) generated from `baseline/routes.json` and `capture/feeds/`, never
  hand-typed. The sitemaps gate decides what they must list.
- `src/pages/robots.txt.js` stays as scaffolded; replace its indexable body with the captured
  `capture/robots.txt` (sitemap URLs adjusted only if their file names changed).
- `capture/sitemaps/` holds every sitemap robots.txt names (`state.json` fingerprint
  `robotsSitemaps`), including WordPress core's `/wp-sitemap.xml`, and their children; the
  build serves each at its live URL. `capture/sitemaps/index.json` lists every sitemap URL the
  capture asked for with its status.
- **No live sitemap.** When live publishes none (`baseline/sitemaps.json` is `[]`; a robots.txt
  `Sitemap:` line whose file answered 404 counts as none), the build ships Astro's
  `sitemap-index.xml` (and its `sitemap-<n>.xml`), and the release robots.txt's `Sitemap:` line
  points at `/sitemap-index.xml`: one decision row (topic "no live sitemap"). Never build the
  robots-named file live did not serve: the routes gate calls it an extra, while it always
  allows `sitemap-index.xml` and `sitemap-<n>.xml`, and the sitemaps gate reads them. pre-launch
  then finds no sitemap on live (`predecessor.coverage`), which `prelaunch-reconcile` accepts
  when every crawled page is built (`phases.md` §10).
- `src/pages/404.astro` holds the site's own 404 page in its layout: the markup is in
  `capture/pages/404.html` (visible text in `capture/text/404.txt`), named by `capture/meta.json`
  `notFound.snapshot`. The capture fetched it once from a path that cannot exist; it is not a
  route and is not in `inventory.json`. When `notFound.snapshot` is null the live site has no
  404 page (`notFound.status` is 200 for a soft 404, or a 3xx with `notFound.location`): keep
  the scaffold's 404 page and say so in the PR. The 404 page's own stylesheets, scripts and
  media are not collected (it is not a crawled page): build `src/pages/404.astro` from
  `capture/pages/404.html` markup inside the site layout, using the site's `site.css`; a style
  or image only the 404 page uses is reproduced from that markup or noted in the PR.

## What is never fixed in the build

Shortcode leftovers (`[gallery]`), placeholder text, broken links, missing alt text, duplicate
titles, missing H1s, dead tags: reproduced as live, written to the suggestions. Fixing one is a
proposal. (Redirect chains are the exception the gates require: each becomes one hop.)
