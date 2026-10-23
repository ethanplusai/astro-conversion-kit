---
name: parity-gates
description: Freeze a site capture into baseline/ and prove an Astro build matches it — every route, redirect (one hop, through a simulation of the host), SEO head field, visible text, internal link, media file, sitemap entry, feed, form, third-party script and security header — with approved differences in exceptions.json and improvements in proposals.json. Use after a capture to build the baseline, when compiling redirects.csv for Vercel or Cloudflare, before calling any conversion page done, when a gate fails and needs reading, or to check a staging deploy against the baseline.
---

# parity-gates

Build the baseline once from `capture/`, then gate every build against it until every gate
passes. The gates read only `baseline/`, never the live site, so a build can still be verified
after the old host is gone.

## The golden rule

**The default build equals live, and a gate is never softened.** No flag turns a failure into a
warning. Four more that follow from it:

1. **Never edit `baseline/` by hand.** The one exception: `keep` in `baseline/scripts.json`,
   which is how a vendor is dropped (set it to `false`, and record the decision).
2. **A difference is an entry, not an edit.** Unavoidable: `exceptions.json`. An improvement:
   `proposals.json`, active only with `PROPOSALS=on`. Both are in `references/exceptions.md`.
3. **A skip is not a pass.** A gate that could not check something says `N skipped (reason)`
   on its summary line. Report every skip.
4. **Report a wrong gate as a kit bug; never change the gate in the site**, nor the baseline.

## Running the scripts

A site made by `convert-site` has the scripts in `scripts/`; run them from the site root as the
npm scripts below, options after `--`. Outside a scaffolded site, run the `node` form shown under
each step from the site root, where `<skill-dir>` is the absolute path of this skill's folder in
a copy of the kit where `npm install` has run. Every script prints `--help`; run it rather than
reading the source. Exit 0 pass, 1 failed gate or drift, 2 usage or missing input.

## 1. Baseline (once)

    npm run baseline
    node <skill-dir>/scripts/build-baseline.mjs --capture capture --out baseline    # fallback

It needs `capture/inventory.json`, `media.json` (capture's `media.mjs`) and `templates.json`
(`templates.mjs`), and exits 2 naming the step to run when one is missing. It writes
`baseline/{routes,seo,redirects,media,forms,scripts,meta,counts}.json` and `baseline/text/`, and
`redirects.csv` at the site root. A shortlink with no target is left out and named on stderr.
Each intermediate hop of a captured chain gets its own row straight to the final target
(`/old-services` → `/old-services/` → `/services/` also gives `/old-services/,/services/`, note
`hop of /old-services`), unless that hop is itself a built route, so a link to any URL of the
chain lands in one hop.
Commit `baseline/` and `redirects.csv` together. `--check` recounts `baseline/` against
`counts.json` (exit 1 on drift). Every file's shape is in `references/contracts.md`.

## 2. Redirects

`redirects.csv` (`from,to,status,source,note`) is the single source of the site's redirects.
`source` is `crawl`, `sitemap`, `shortlink` or `seed` from the capture; a row you add is
`decision`, its `note` naming the decision id. Never hand-edit the compiled output; compile:

    npm run redirects:build
    node <skill-dir>/scripts/build-redirects.mjs --csv redirects.csv --host vercel --out vercel.json --trailing-slash always    # fallback

`--host cloudflare --out public/_redirects` for Pages (Astro copies it into `dist/`). Vercel: the
`redirects` key is replaced, every other key kept, and `trailingSlash` is removed and written as
the compiler's own 308 slash rules after the site's, so an unslashed source is still one hop.
Only a path ending in a static-file extension counts as a file to those rules, in any letter
case: the web types, the document, media and archive types an upload folder holds (docx, xlsx,
csv, mov, wav, heic, gz, ...), and every extension found in `dist/` (else `public/`), so rerun
it after the build; `/upgrade-guide/3.5/` is a page and keeps its slash. A built file the rules
would still redirect fails the redirects gate as `built file redirected`.
Cloudflare: a query row (`/?p=7`) cannot be matched by `_redirects` and goes to
`cloudflare-query-redirects.csv`, to be created as a Single Redirect (a "needs you" item). A
query row whose target is its own path (`/?p=2` to `/`) is a no-op and is left out on both hosts.

A captured row (any `source` but `decision`) is a live URL and holds no parameters: for Vercel
every `:` and `*` in it is escaped (`/foo:bar/` is written `/foo\:bar/`, and so is
`/trackshttps://www.example.com/x/`, a broken live href the capture followed); `//` is kept.
Only a `decision` row uses `:name` parameters and `*` splats, and even there a `:` before a
digit (a port) is escaped. Vercel rejects a bare `:`, and so does the gates' simulation of it.
A source with no valid form (no leading `/`, whitespace, a control character; on Cloudflare also
a captured `:<name>` or `*`, which `_redirects` cannot escape) is dropped, named on stderr and
listed as `{ source, reason }` in `redirects-skipped.json`. That file sits beside
`redirects.csv` (the site root), never under `public/`, so it is not deployed. The redirects gate
and `verify-live` count a listed row as skipped, never passed. When the path should simply have no redirect, record a "no redirect" exception
instead (section 4): `{ "kind": "redirect", "path": "<source>", "reason": "...", "action": "none", "approvedBy": "...", "date": "..." }`.

## 3. Verify

    npm run build
    npm run verify -- --endpoint https://forms.example.com/f/abc --thank-you /thank-you/
    node <skill-dir>/scripts/verify/run-all.mjs --endpoint https://forms.example.com/f/abc --thank-you /thank-you/    # fallback

`run-all` runs the ten gates in alphabetical order, gives each one only the options it accepts,
and stops at the first failure. Shared options: `--paths` (comma list, `*` matches anything),
`--json`, `--origin` (links, seo, sitemaps: the host the build is for), `--allow-extra` (routes),
`--endpoint`, `--honeypot`, `--thank-you` (forms; `--endpoint` is required when the baseline has a
POST form), `--host`, `--config` (redirects, links), `--csv` (redirects), `--media-plan` (media). Fix the first failure,
rebuild, rerun. One gate alone: `node <skill-dir>/scripts/verify/<gate>.mjs`.

| Gate | Passes when | A skip means |
|---|---|---|
| `forms` | Each live form is on its page with the same field names in order and method; a POST form's action is `--endpoint` and it carries `--honeypot`; a GET form (a search box) keeps live's action path and needs neither ("N search/GET forms compared"); a POST form whose live action is on another registrable domain (a newsletter list host; www, http, subdomains and WordPress handlers such as `admin-ajax.php` or `?wpcf7` count as the site) is kept as is, compared like a GET form by its full action URL, and needs no `--endpoint` ("N forms kept as is (posts to <host>)") | No `--thank-you`: the thank-you page of the POST forms was not checked |
| `headers` | Host config sends nosniff, Referrer-Policy, X-Frame-Options or CSP frame-ancestors on every path, and, when not indexable, `X-Robots-Tag: noindex` on every path or (Vercel) the meta robots noindex on every built page; a preview-host rule (`https://*.pages.dev/*`) counts only for the preview host; with `PUBLIC_INDEXABLE=true` noindex on every path is forbidden | |
| `links` | Every internal href and src resolves to a built page or file, a redirect source or baseline media, or lands on a built page in one hop through the compiled rules (`vercel.json` or `dist/_redirects`: the slash rules and every `redirects.csv` row), as live redirected it ("N links resolved through redirects"); two hops or a missing target fail; with no host config, `/about` where the build serves `/about/` fails | |
| `media` | Every baseline media file is served by the build with the same bytes (`--paths` picks a file by its path or by a page that references it): in `dist/` in plan mode `repo`; under the plan's `prefix`, in the store manifest (`store`) or still on live (`live-temporary`); outside the prefix, in `dist/` in every mode. With `PUBLIC_INDEXABLE=true`, `live-temporary` fails every file under the prefix (a release build may not serve media from the live site; a plan without a prefix covers every file) and still checks the files outside it in `dist/` | Plan mode `live-temporary` on a staging build: files under the prefix are served from live, not checked |
| `redirects` | Every baseline redirect and csv row answers in one hop with the same status, and the target answers 200 in `dist/` (or is external, or under a prefix in baseline `meta.json` `excluded`: then only the first hop is checked); no source is also a built file; no built page or file is redirected away from its own URL (`built page redirected by rule <rule>`; no exception covers it, fix the rule); a path with a "no redirect" exception (`kind: "redirect"`, `action: "none"`) is not redirected at all | A no-op query row, any query row on Cloudflare, or a source with no valid form that `redirects-skipped.json` lists with a reason (`not compiled`) |
| `routes` | Every page, post, archive and feed at 200 is built, noindex routes still say noindex, nothing extra is built (the capture's own scripts in `baseline/js.json` and stylesheets in `baseline/css.json` at their live paths, the live sitemap names in `baseline/sitemaps.json`, and the launch icon set are not extras); a route captured at any status other than 200, 3xx, 404 or 410 fails as `not captured: <status>` unless a `routes` exception skips it or names its built replacement | A `routes` exception with `to: "skip"`: that route was never captured |
| `scripts` | Each kept vendor is on exactly its live pages with the same ids; a dropped one on none; no new vendor | |
| `seo` | Title, description, canonical, robots, lang, h1, h2, og and JSON-LD @types equal per page; site URLs on the site's origin. Unless `PUBLIC_INDEXABLE=true`, robots must carry the staging `noindex, nofollow` and the rest of it equals live's past those two; a release build compares robots exactly | |
| `sitemaps` | Every top sitemap in `dist/` (Astro's `sitemap-index.xml`, or a live name in `baseline/sitemaps.json` such as `wp-sitemap.xml` or `sitemap_index.xml`) lists exactly the indexable 200 pages on the origin (percent escapes compare case-blind: `%c3` is `%C3`); every robots.txt `Sitemap:` line is on the origin and names a file in `dist/`, or is a line the live robots.txt (`capture/robots.txt`) carried verbatim; every feed is built with as many items | |
| `text` | Each page's visible text equals `baseline/text/` (word diff, 5 words of context) | |

A capture made with `--exclude` records its path prefixes in `baseline/meta.json` `excluded`: the
`links` gate does not check a link under one (like a link to another host, noted "N links under
excluded paths ... not checked"), and the `sitemaps` gate accepts a robots.txt `Sitemap:` line under
one when the live robots.txt carried it verbatim (a multisite sub-site's sitemap on the same host).

## 4. Differences and decisions

When the build cannot or should not match live, read `references/exceptions.md`. In short: an
entry is `{ path, field, from, to, reason, approvedBy, date }`; `from: ""` records a value the
build adds, `to: ""` one it removes; an exception that no longer matches, or names a path the gate
does not check, **fails** the gate. Every oddity on the live site (a missing H1, a dead tag, a
broken link) is reproduced by default and gets a decision row (id, topic, choice, default,
reason, cost if wrong) saying so and what the fix would be.

One record has a `kind` instead of a `field`: `{ "kind": "redirect", "path": "<source>",
"reason": "...", "action": "none", "approvedBy": "...", "date": "..." }` means "no redirect for
this path, on purpose" (a live redirect recorded for a broken href that nothing should
redirect). Every key is required: it removes a live behaviour, so it is signed off like any
exception. The redirects gate requests the path and passes it only when the rules do not
redirect it; on a path the gate does not check it fails as `path not checked`; `verify-live`
skips it with the reason. Every other gate ignores it.

## 5. Staging, proposals and release builds

`PUBLIC_INDEXABLE` and `PROPOSALS` change what Astro builds, so set them on the **build**, not
only on the gate run; a gate run on a build made without them checks the wrong site. Pass
`--origin` only when the build itself was made for that host; a scaffolded build's `site` is the
live origin, so its canonicals and sitemap stay on it.

    npm run build && npm run verify -- --endpoint ... --thank-you ...                                       # staging
    PROPOSALS=on npm run build && npm run verify:proposals -- --endpoint ... --thank-you ...                 # proposals
    PUBLIC_INDEXABLE=true npm run build && npm run verify:release -- --endpoint ... --thank-you ...          # release

After a staging deploy, check it over HTTP against the baseline. A release deploy is checked
the same way without `--expect-noindex`:

    npm run verify:live -- --base https://my-site.vercel.app --expect-noindex
    node <skill-dir>/scripts/verify-live.mjs --base https://my-site.vercel.app --expect-noindex    # fallback

`--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` applies only when staging was deliberately
protected (the bypass value from the environment, never pasted in chat); a public staging alias
needs none.

It checks every baseline route at 200 (or a `--sample`), every redirect in one hop with the same
kind of status, noindex on pages iff `--expect-noindex`, the sitemap, and 20 media files by
bytes (or `--media-manifest`, whose `url` may be the store's absolute URL or a site path checked
at `<base><path>`). A redirect listed in `redirects-skipped.json` or covered by a "no redirect"
exception (`--skipped`, `--exceptions`; both read from the site root by default) is skipped and
named with its reason. Every request times out after 30 s, a failure of that check rather than a
block. Exit 3 means it was blocked: wait and rerun. Exit 3 with `deployment protection:` means
Vercel answered with its login redirect (302 to `vercel.com/sso-api`): use the project's
production alias (public by default) rather than the raw deployment URL; only when staging was
deliberately protected, pass `--bypass`, or the bypass secret has to be created first (a
needs-you item), then rerun. A failure marked
`unverified live` is a shortlink the capture never requested.

## Present the result

1. **Every gate's summary line**, failures first, with the failing lines quoted.
2. **Every skip**, with its count and reason: none of it was checked.
3. **Every exception and proposal** with its reason, and every `keep: false` vendor.
4. **Every decision row** added in this run, and every `decision` row in `redirects.csv`.
5. **Not covered, verbatim**: the list below, every line, in the PR and in your report.

## Not covered

Repeat this list to the person verbatim. No gate checks any of it:

- Content rendered by JavaScript after load: the gates read the built HTML only.
- Hover, focus and open states (menus, sliders, accordions).
- Headers on a route served by a Function (a media store route): the headers gate reads config.
- Media served from the live site in staging (`live-temporary`): skipped, not compared (files
  outside the media prefix are still checked in `dist/`).
- Shortlinks the capture did not request: their targets are unverified until `verify-live` passes.
- Whether a form submission is delivered: the forms gate checks markup only.
- `feed/index.xml` is checked in `dist/`; on Vercel, `/feed/` may need a rewrite to serve it.

## References

| File | Covers |
|---|---|
| `references/contracts.md` | Every baseline file's shape, `redirects.csv`, the gates' `--json` output |
| `references/exceptions.md` | Exceptions, proposals, `PROPOSALS=on`, reproduce live by default, decision rows |
