# Baseline contracts

What `build-baseline.mjs` writes, and what every gate reads. All of it is derived from `capture/`
and committed. Nothing here is edited by hand except `keep` in `scripts.json`. `--check`
recounts `routes`, `redirects`, `media`, `forms` and `scripts` against `counts.json`.

## baseline/routes.json

One record per captured page, feed and linked file, sorted by path:

    [{ "path": "/contact/", "status": 200, "kind": "page", "template": "page-2",
       "noindex": false, "snapshot": "pages/contact.html", "foundBy": ["sitemap", "crawl"] }]

- `kind`: `page` | `post` | `archive` | `feed` | `file` | `other`. A WordPress REST dump decides
  page or post; otherwise body classes do (`single-post` is a post, `archive` an archive). Any
  status other than 200 is `other`. A `file` is a media file (a PDF) a page links to.
- `template`: the cluster name from `capture/templates.json`, or `other`.
- `noindex`: the captured robots meta contains `noindex`.
- `snapshot`: the captured file under `capture/` (`pages/<slug>.html`, `feeds/<name>.xml`), or
  `null` for a file.
- `foundBy`: `sitemap`, `rest`, `crawl`, `shortlink`, `seed`, in that order.

## baseline/seo.json

Keyed by path, for every page answering 200 with a snapshot:

    { "/about/": { "title": "About Us | Example", "description": "...", "canonical": "https://www.example.com/about/",
                   "robots": "index, follow", "lang": "en-US", "h1": ["About Us"], "h2": ["Our crew"],
                   "og": { "title": "...", "url": "...", "image": "..." }, "twitter": { },
                   "jsonLd": [ { "@type": "Organization" } ] } }

A missing scalar is `null`. The seo gate compares `jsonLd` by its `@type` values only, and
`twitter` is recorded but not gated.

## baseline/redirects.json

    [{ "from": "/old-services", "to": "/services/", "status": 301, "source": "seed" },
     { "from": "/?p=6", "to": "/contact/", "status": 301, "source": "shortlink", "verified": false }]

From the capture's redirects (chains collapsed to their final target) and shortlinks, plus one
row per intermediate hop of a chain, straight to the final target (see `note` under
redirects.csv). Only
shortlinks carry `verified`: `true` when the capture requested it. A redirect with no target is
left out and named on stderr.

## baseline/media.json

    [{ "path": "/wp-content/uploads/2026/01/brochure.pdf", "bytes": 48213, "contentType": "application/pdf" }]

Every media file that answered 200.

## baseline/forms.json

    { "/contact/": [{ "action": "https://www.example.com/wp-admin/admin-post.php", "method": "post",
                      "fields": [{ "name": "name", "type": "text", "required": true }, ...] }] }

Fields are named `input`, `select` and `textarea` elements in document order, without submit,
button, reset and image inputs.
Every form is recorded, a search box (`method: "get"`) too. The forms gate treats only a `post`
form as a submission form (endpoint, honeypot, thank-you page); a `get` form must keep live's
action path, method and fields, and so must a `post` form whose action is on another registrable domain
(kept as is: it already posts to a third party).

## baseline/scripts.json

    { "ga4": { "id": "G-XXXXXXX", "ids": ["G-XXXXXXX"], "pages": ["/", "/contact/"], "keep": true } }

One entry per third-party vendor, recognised by the same rules the capture uses. `keep` is
written `true`; set it to `false` to drop the vendor from the build. It is the only field that
may be edited.

## baseline/js.json

    [{ "src": "https://www.example.com/wp-content/themes/x/js/menu.js?ver=1.2", "file": "js/1.js",
       "pages": ["/", "/about/"] }]

The site's own script files the capture saved (`capture/js/manifest.json`; `file` is relative to
the capture), `[]` when there are none. The routes gate lets the build serve each at its live
path; built or not, none is an extra.

## baseline/css.json

    [{ "href": "https://www.example.com/wp-content/themes/x/style.css?ver=1.2", "file": "css/1.css",
       "pages": ["/", "/about/"] }]

The site's own stylesheets the capture saved (`capture/css/manifest.json`, on the site's host
with or without `www.`, no inline `<style>` files; `file` is relative to the capture), `[]` when
there are none. css-prune serves each, pruned, at its live path; the routes gate lets the build
serve it there, and built or not, none is an extra.

## baseline/sitemaps.json

    ["page-sitemap.xml", "post-sitemap.xml", "sitemap_index.xml"]

The live site's sitemap file names the capture saved (`capture/sitemaps/`), `[]` when none. The
routes gate lets the build serve each at the root (besides Astro's `sitemap-index.xml` and
`sitemap-<n>.xml`); any other sitemap file name is an extra.
The sitemaps gate reads each of these names that is in `dist/` (WordPress core's `wp-sitemap.xml`
too), besides Astro's `sitemap-index.xml`.

## baseline/text/

`<slug>.txt` per page, the capture's visible text copied as is (`pages/contact.html` pairs with
`text/contact.txt`). The text gate compares it, trimmed, with the built page's visible text.

## baseline/counts.json

    { "routes": 16, "byStatus": { "200": 15, "404": 1 },
      "byTemplate": { "archive": 2, "home": 1, "other": 3, "page": 6, "page-2": 1, "single-post": 3 },
      "redirects": { "seed": 3, "shortlink": 12 }, "media": 20, "forms": 2, "scripts": 2 }

Keys of `byStatus`, `byTemplate` and `redirects` are sorted. `redirects` is counted by
`source`, `forms` is the total number of forms, `scripts` the number of
vendors.

## baseline/meta.json

    { "origin": "https://www.example.com", "canonicalOrigin": "https://www.example.com",
      "capturedAt": "2026-10-22T10:00:00.000Z", "builtAt": "2026-10-22T11:00:00.000Z", "platform": "wordpress" }

`canonicalOrigin` is the default origin for the seo and sitemaps gates.

## redirects.csv (site root)

    from,to,status,source,note
    /old-services,/services/,301,seed,
    /old-services/,/services/,301,seed,hop of /old-services
    /?p=6,/contact/,301,shortlink,unverified shortlink
    /old-blog/*,/blog/:splat,301,decision,d7

- `from`: a root-relative path, optionally with a query (`/?p=7`), or a catch-all: a trailing
  `/*` (the target may use `:splat`) or a `:name*` or `:name+` parameter (the target may use
  `:name`). Catch-alls and parameters are read only on a `decision` row; on a captured row
  every `:` and `*` is a literal character of the live URL.
  Matching is case-sensitive. No spaces: encode them as `%20`.
- `to`: a root-relative path or an absolute URL.
- `status`: 301, 302, 303, 307 or 308.
- `source`: `crawl`, `sitemap`, `shortlink` or `seed` from the capture; `decision` for a row you
  add. Kept as written.
- `note`: free text; `unverified shortlink` from the capture, `hop of <from>` on a row for an
  intermediate hop of a captured chain (A → B → C gives A → C and B → C, with B's row noted
  `hop of A`; a hop that is a built route gets no row), the decision id on a `decision` row.
  A hop row keeps the head's status and source; it is in `baseline/redirects.json` too.

The file is RFC 4180 CSV (quote a field holding a comma). A malformed file makes
`build-redirects.mjs` exit 2 naming the line; a `from` with no valid host form (no leading `/`,
whitespace, a control character) is not malformed: the row is dropped and listed in
`redirects-skipped.json`.

## redirects-skipped.json

Written beside `redirects.csv` by `build-redirects.mjs` when a row's source has no valid form,
removed by a run that drops nothing:

    [{ "source": "/two words/", "reason": "contains whitespace: no host rule can match it" }]

The redirects gate skips a listed row (`not compiled`) when its source really has no valid form
and the reason is not empty; any other row missing from the config fails.

## cloudflare-query-redirects.csv

Written beside `redirects.csv` by `build-redirects.mjs --host cloudflare`:

    from,to,status
    /?p=6,/contact/,301

Each row is created by hand as a Cloudflare Single Redirect; the redirects gate lists them as
skipped.

## Other inputs the gates read

- `docs/media-plan.json`: `{ "mode": "repo" | "store" | "live-temporary", "prefix": "/wp-content/uploads/", ... }`;
  missing means `repo`. `prefix` is the folder the store or the live site serves; media outside
  it (theme fonts) is copied into the build and the media gate checks it in `dist/` in every
  mode. A plan without `prefix` covers every media path.
- `media-manifest.json` (store mode): `[{ "path", "bytes", "url" }]`, one entry per file under
  the prefix. `url` is either an absolute URL (the object in the store) or a site path starting
  with `/` (the file as the site serves it, through its media route); `verify-live
  --media-manifest` requests an absolute `url` as is and a site path at `<base><path>`.
- `exceptions.json`, and `proposals.json` only when `PROPOSALS=on`: see `exceptions.md`.

## Gate output

Text mode prints one line per failure, `  <path> <field>: expected <json>, got <json>` (the text
gate prints a word diff with `[-removed-]` and `{+added+}`), one line per skipped item
(`  <from> skipped: <reason>`), then the summary:

    seo: 13 checked, 0 failed
    redirects: 14 checked, 0 failed, 12 skipped (noop)

`--json` prints `{ "gate", "checked", "failed", "skipped"?, "skipReason"?, "skips"?, "failures":
[{ "path", "field", "expected", "actual", "diff"? }] }`; a text failure carries `diff`, the word
diff as `[{ "op", "text" }]`. A failure with `field: "exception"` is an
exception the gate could not use; its `actual` says why.

`verify-live.mjs --json` prints `{ "checked", "failed", "failures": [{ "check", "path", "field",
"expected", "actual", "unverified"? }], "skipped": [{ "check", "path", "reason" }], "stopped"? }`,
`check` being `route` (a noindex problem is a `route` failure with `field: "x-robots-tag"`),
`redirect`, `sitemap` or `media`. A request with no full response within 30 s fails its check
with `field: "timeout"` (`actual: "timed out"`); it is not a block and never stops the run.
`skipped` lists the routes
and media files that were sampled out (`not sampled`): they were not checked. `stopped` is set
when three blocked responses in a row ended the run (exit 3).
