---
name: capture-site
description: Crawl a live website, read-only and paced, into a capture/ folder that a rebuild is checked against — every page's HTML, text and head tags, redirects with every hop, links, third-party scripts, the media set, stylesheets, fonts, logo and icons, feeds, templates, and live screenshots at three widths. Use before converting or rebuilding a site, when asked to crawl, capture, snapshot or inventory a site, or when a capture stopped on blocks and needs resuming.
---

# capture-site

Save everything the live site serves, once, so every later step works from the capture.

## The golden rule

**The live site is read-only, and the capture is read-only afterwards.** The scripts only make
paced GET and HEAD requests; never submit a form, log in, or fetch by hand to fill a gap. Once the
notes are written, nothing under `capture/` is edited: it is the evidence every gate reads.

## When to use

Step 2 of a conversion (`convert-site` runs it), or any time a live site has to be inventoried
(a staging or new site is `launch-audit`'s job). A capture that exited 3 resumes, as below.

## Pacing

Every script sends a desktop Chrome user agent. The capture scripts (`capture`, `media`,
`assets`, `fingerprint`) share a per-host limiter: by default request starts are **400 ms apart
with up to 4 in flight** (`media`: 6), so a host that answers quickly is read in minutes. The
Chromium steps (`shoot`, `css-coverage`, `styles`) load one page at a time, 500 ms apart, and `launch-audit` and `pre-launch` keep their own pacing. The limiter adapts by itself:

- a 429 or 503 doubles that host's delay (up to 32 times) and drops it to **one request at a
  time**; after every 30 s of clean answers it recovers one step (half the delay, one more in
  flight) until it is back to the defaults;
- an answer that takes more than 5 s halves the requests in flight on that host (not again while
  halved), and it recovers the same way, one more in flight per 30 s of clean answers;
- a 403 or a network error counts towards the 3-in-a-row stop below, as before.

`--polite` is the old pace: one request at a time, 2500 ms apart (`capture`, `media`, `assets`).
Use it from the start on shared hosting with a bot wall (SiteGround's `/.well-known/sgcaptcha/`,
hosts that answer 429 or 503 to a few quick requests), or when a run stopped on blocks: resume
with `--polite`. `--delay <ms>` and `--concurrency <n>` override the defaults or `--polite`. Keep
the defaults or `--polite` against a live site (`--delay 0` is for local fixtures only), and
never change `--ua` to get past a block.

- `capture` fetches up to `--concurrency` queued URLs ahead and records them in queue order, so
  the capture is the same as a one-at-a-time crawl. It tries each URL 3 times. A
  URL still blocked after that (403, 429, 503 or a network error) is recorded with its status and
  `attempts` in `inventory.json` (a sitemap or REST list in `meta.json` `discoveryErrors`) and
  the crawl moves on. It stops only after **3 different URLs in a row used up their tries**
  with no success between them, state saved, those three queued again with fresh tries.
  It never requests `wp-admin`, `wp-login`, `xmlrpc.php` or `?s=` searches.
- `media` tries each file 3 times: a persistent 429 or 503 stops it at once; a 403 or network
  error is recorded as that file's status, and 3 such files in a row (in the order the answers
  arrive) stop it. Files already downloading when it stops are let finish. It saves
  `media.json` every 100 files, so a run that is killed resumes close to where it was.
- `fingerprint` does not retry: a blocked home page, or one that is a bot challenge, is exit 3. `assets` and `shoot` back off and
  stop after 3 blocked responses in a row.

## The command sequence

Run from the folder that will hold `capture/` (the site repository's root). `<skill-dir>` is the
absolute path of this skill's folder, in a copy of the kit where `npm install` has run (the
scripts import its packages). Every script prints `--help`; run it rather than reading the
source. Run each step as its own command, in this order:

1. **Fingerprint**, then read the platform reference for what it names (table below):

       node <skill-dir>/scripts/fingerprint.mjs https://www.example.com

2. **Capture.** Discovery is the sitemaps (every `Sitemap:` line in robots.txt, plus the
   platform's default index), the REST lists (WordPress, when the fingerprint finds
   REST; `--no-rest` skips), the link crawl, and `--seed <path>` or `--seed-file <file>` (one
   path or URL per line, `#` comments) for paths the crawl cannot reach (old URLs, an old
   `.htaccess`). After the crawl, Wayback paths it did not find go to `wayback-unverified.txt`
   (`--no-wayback` skips; a listing that fails is asked for once more 10 s later before
   `meta.json` `wayback` records `failed`). `?p=` shortlinks are recorded unverified and never fetched unless you
   pass `--verify-shortlinks`. After the crawl it requests one path that cannot exist
   (`/<32 hex>/`) once, so the site's own 404 page is saved as `pages/404.html` (`meta.json`
   `notFound`; a site that answers 200 or redirects there is recorded with no page), and asks
   for `/favicon.ico` and `/apple-touch-icon.png` once each, redirects followed (`meta.json`
   `icons`: path to `{ status, file, contentType, bytes }`); one that answers 200 is saved byte
   for byte as `assets/root-favicon.ico` or `assets/root-apple-touch-icon.png` (an HTML answer
   is not saved and has a `note`; one over 5 MB is status `"too-large"`), and `assets.mjs` lists
   it in `assets/index.json` as kind `"root-icon"` with its `path`, so the build ships it there.
   URLs are keyed with upper-case percent escapes (`%c3%a9` and `%C3%A9` are one URL),
   so a page linked with both spellings is captured once. A sitemap robots.txt names that answers 404 (or any non-200) is listed in
   `sitemaps/index.json` with its status and in `meta.json` `discoveryErrors`. A sitemap on
   another host (robots.txt naming a sister site's, or an index listing one; www and apex count
   as one host) is listed there as `{ url, host, skipped: "other host" }` and never fetched, so
   none of its URLs enter the crawl. Two sitemap URLs with the same file name never overwrite
   each other: the second is saved with a suffix from its directory path (`page-sitemap-es.xml`).
   `--exclude <prefix>[,<prefix>...]` leaves parts of the host out (a WordPress multisite's
   sub-sites such as `/president/`, or a section the owner keeps): a URL whose path starts with
   one is never requested, whether a sitemap, the REST lists, a link or a redirect leads there.
   A sitemap under one is listed in `sitemaps/index.json` as `{ url, skipped: "excluded" }`; a
   redirect into one is recorded with that target, unrequested; links to one stay in the saved
   HTML and are listed in `links.json` `excluded`, not `internal`; `meta.json` `excluded` names
   the prefixes and the baseline carries them. Prefixes and paths compare in one form, so
   `/présidence/`, `/pr%c3%a9sidence/` and `/pr%C3%A9sidence/` are the same prefix. A stylesheet
   or root icon that redirects under one is not followed there (the sheet is listed with status
   `"excluded"`). `--resume` keeps them; a prefix added on `--resume` removes what was already
   captured under it (its pages with their `pages/` and `text/` files, redirects from it, feeds
   and sitemaps under it, and stylesheets and scripts only those pages used) and prints what it
   removed. `media.mjs` and `assets.mjs` skip files under them too.

       node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture

   Then the **Wayback second pass**, when `wayback-unverified.txt` is not empty: it requests each
   archived path once, so the ones that still redirect land in `capture/redirects.json` with
   source `seed` (the baseline's redirects pick them up) and the rest are recorded with their
   status in `inventory.json`. `--seed`, `--seed-file` and `--include-query` all apply on
   `--resume`, and the Wayback Machine is not asked again:

       node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture --resume --seed-file capture/wayback-unverified.txt

3. **Media.** Lists every media file in `capture/media.json` and saves it under
   `.conversion/media-cache/`, the conversion's working directory, which stays out of git:

       node <skill-dir>/scripts/media.mjs --capture capture --download .conversion/media-cache

   It downloads six files at a time. By default (`--sizes referenced`) it fetches the originals
   and every size the site uses: one a page, stylesheet, srcset, og tag or sitemap points at, or
   whose file name appears anywhere in the captured pages, stylesheets or scripts (data-thumb,
   data-bg, JSON settings, slider scripts). A WordPress size only the REST media list names is
   listed with `downloaded: false, reason: "unreferenced size"` and not requested. It prints the
   split, e.g. `920 originals + referenced sizes (downloaded), 4,520 unreferenced sizes (listed
   only)`: repeat that line to the person. Use `--sizes all` when the owner says old
   emails or other sites may link to those sizes.

   Hosts that resize by query string (WordPress VIP, Jetpack Photon: `photo.jpg?w=1024`,
   `?resize=300,200`) serve every size at the same path. The original is the bare path, so that
   is what is requested and saved; each query string seen is listed under `variants` (not
   requested; `--sizes all` saves them as `<path>%3F<query>` under a sibling folder,
   `.conversion/media-cache-variants/`, so the media cache that is uploaded or copied into the
   repo holds bare paths only). When the bare path answers an error (4xx or 5xx; a redirect is
   recorded with its location, and a too-large file is asked again once the cap is raised), a
   variant is saved in its place and the entry's `downloadedFrom` is the URL it came from. A cache-busting query (no
   `w`, `h`, `resize`, `crop`, `fit`, `quality`, `format` or `s` parameter, e.g. `?ver=3`) is the
   same file, so it is preferred and nothing else is marked; otherwise the widest variant is saved
   and the entry also says `resized: true`. The run prints a line per file and a count (`2
   originals unavailable (resized: true) ...`), baseline/media.json keeps both fields, and the
   media gate repeats the count as `N resized (original unavailable on live)` without failing,
   since it compares against the bytes actually saved. Repeat that count to the person and list
   those files in the plan and runbook as originals the live site no longer serves.

4. **Templates.** Clusters the pages that answered 200 into `capture/templates.json`. On
   WordPress, pages group by template body class first (`home`, `page`, `single-post`,
   `archive`, template classes) and a page whose markup is clearly different (Jaccard below 0.5)
   splits off as `page-2`; other platforms merge by markup at Jaccard 0.6, as `template-<n>`:

       node <skill-dir>/scripts/templates.mjs --capture capture

5. **Assets.** Logo, favicon, apple-touch-icon, the `<link rel=manifest>` web manifest and every
   `@font-face` font into `capture/assets/`, plus the root `/favicon.ico` and
   `/apple-touch-icon.png` (`root-favicon.*`, `root-apple-touch-icon.*`) when `meta.json` `icons`
   recorded them at 200:

       node <skill-dir>/scripts/assets.mjs --capture capture

   The logo is looked for on the home page inside the `<header>` first, then inside any other
   element whose class or id names a logo (`.logo`, `.site-logo`, `#logo-wrap`). In each: an
   `<img>` whose src, alt, class or id has the word "logo" (not "logout"), then an inline `<svg>`
   with "logo" in its class, id, aria-label or `<title>` (saved as `logo.svg`, `url: null` in
   `assets/index.json`; its note says so when it only `<use>`s a symbol defined elsewhere on the
   page, which renders empty on its own), then the first `<img>` in a link to the home page, then
   the first `<img>`. Check `assets/logo.*` by eye: an account
   avatar or a sponsor mark can still win on an unusual header. The favicon and
   apple-touch-icon are saved as served from their `<link>` href, query string included, so
   one that points at a resize (`?w=32`, `?w=180`) of an uploads file differs in bytes from
   that file's entry in `media.json`: keep the saved icon, not the original.

6. **Live screenshots**, one per template at 390, 768 and 1440, with the visual-review shooter:

       node <skill-dir>/../visual-review/scripts/shoot.mjs --base https://www.example.com --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live

7. **Lighthouse (optional).** Only when `npx --no-install lighthouse --version` answers; never
   install it unasked; if it is missing, say so in the notes (a skip, not a pass). Run `mkdir -p
   capture/lighthouse-live`, then one run per `representative` in `templates.json`, in turn:

       npx --no-install lighthouse https://www.example.com/ --quiet --chrome-flags="--headless=new" --output json --output html --output-path capture/lighthouse-live/home

8. **README.** Summarises the capture in `capture/README.md`; its `## Notes` open with generated
   lines, rewritten on every run (how many Wayback paths the second pass verified and what each
   answered: status, redirect target; a Wayback listing that failed or was refused for size;
   every URL still failing after its retries). Run it last,
   and after any rerun:

       node <skill-dir>/scripts/readme.mjs --capture capture

| Script | Exit |
|---|---|
| `fingerprint` | 0 done, 2 usage or unreachable, 3 blocking or a bot challenge |
| `capture` | 0 done, 2 usage, 3 stopped on blocks, unreachable, a bot challenge (all resumable), or no page answered 200 |
| `media` | 0 done (missing files included), 2 usage, no capture or no page that answered 200, 3 stopped on blocks |
| `assets` | 0 done (missing files included), 2 usage or no capture, 3 stopped on blocks |
| `templates` | 0 done, 2 usage, no `inventory.json`, or "no captured pages" (none answered 200) |
| `readme` | 0 done, 2 usage or no `inventory.json` |
| `shoot` | 0 all shot, 1 a route failed, 2 usage, 3 stopped on blocks |

## On exit 3

The site is blocking requests or cannot be reached. Wait (minutes, not seconds), then:

- `fingerprint`: run it again.
- `capture`: run the same command with `--resume`. The URLs still queued are retried with a fresh
  set of tries; a URL already recorded as still failing after its retries is not requested again.
  The URLs that stopped the run get one more set of tries: if they fail again they are recorded
  with their status, so URLs that are down for good stop the capture once, not on every resume.
  After two stops on the same URLs, tell the person which ones (paths and status) and carry on.
- `media`, `assets`: run the same command again; work already done is kept.
- After a stop, up to concurrency − 1 URLs may have been requested but not recorded;
  `--resume` asks them again.
- If it stopped at the default pace, add `--polite` to the resumed command (and to the later
  steps on that site): the host wants one request at a time.
- `shoot`: rerun with a longer `--delay`.

Never retry in a tight loop. After two stops in a row, tell the person and carry on with the rest.

A `capture` that stops with **no page answered 200** has nothing to build from: never go on to
templates, media or a baseline (they refuse it, exit 2). Read `inventory.json` for what each
URL answered; it is usually a block or a challenge (below), or a wrong origin.

## Protected sites

Some hosts and firewalls answer a script with a bot challenge instead of the page: SiteGround
answers `202` with a page of a few hundred bytes that refreshes to `/.well-known/sgcaptcha/`;
Cloudflare answers `403` or `503` with `cf-mitigated: challenge` and a "Just a moment..." page
loading `/cdn-cgi/challenge-platform/h/...` (the Bot Fight Mode script `.../scripts/jsd/main.js`
alone, which Cloudflare adds to every page, is not a challenge); others send a tiny page with no title, or one that
redirects to a captcha path. Every page then looks the same, so a capture of it is worthless.

- `fingerprint` prints `blocked: <host> anti-bot challenge (<cause>)` and exits 3.
- A tiny untitled page alone (no known signature) stops a run only as the capture's first HTML
  answer or the third in a row; a single one mid-crawl (a stub, an empty archive) is recorded
  with status `"suspect-challenge"`, listed under `## Notes`, and the crawl goes on. Open each
  in a browser and note whether it is a real page. Such a stop happens once per URL: if the
  page is real, `--resume` records it as a suspect and goes on, and `--seed` supplies pages the
  crawl cannot reach from it.
- `capture` stops at the first challenge on the site (exit 3, state saved): the URL is in
  `inventory.json` with status `"challenge"` (never counted as a page) and in `meta.json`
  `challenge`, and the README's `## Notes` name the cause. It is never retried: waiting does not
  get past a challenge.
- Put this in the needs-you list and carry on with what does not need the capture: **"Allowlist
  the capture machine's public IP on the host or in the WAF for the capture window, or send a URL list."**
- A real-browser capture (a headless or headed browser that solves or waits out the challenge)
  is not part of this kit. Do not improvise one, or change `--ua` to get past the challenge,
  without the site owner's written consent; the read-only, paced rule above still holds.
- Once the person confirms the allowlist, run the same command with `--resume`:

      node <skill-dir>/scripts/capture.mjs https://www.example.com --out capture --resume

  The challenge row is dropped and that URL is asked again first.

## What lands in capture/

    inventory.json        one record per page: status, head tags, JSON-LD, headings, forms, links
    pages/  text/         raw HTML and visible text per page
    redirects.json        every redirect, chains collapsed, hops kept; shortlinks marked verified or not
    links.json            { internal, external } maps of link -> [pages that carry it]; with
                          --exclude also "excluded": { "<path>": [pages] }, the links under an
                          excluded prefix (kept in the HTML, never in internal, never requested)
    scripts.json          third-party vendors with their ids and pages
    media.json            every media file with sources, pages, status, type and bytes; a size
                          only the REST list names: downloaded: false, "unreferenced size";
                          query-string sizes under variants; resized: true when only a
                          resized copy could be saved, downloadedFrom when a variant stood in
    css/                  every stylesheet, inline <style> blocks, manifest.json; the sheets a
                          stylesheet @imports (any host, 5 levels deep) too, their manifest
                          entries with importedBy: [importer hrefs] and the importer's pages;
                          one deeper still is listed with status "too-deep", not fetched;
                          a redirected sheet records finalUrl (its url()s and @imports
                          resolve against it)
    js/                   the site's own script files (theme JavaScript, <script type=module src>,
                          every URL its <script type=importmap> imports or scopes name, and
                          <link rel=modulepreload> files) and manifest.json: [{ file, src, kind,
                          pages }] (kind "script", "module", "importmap" or "modulepreload"),
                          or { file: null, src, kind, pages, status } for a file
                          not saved (an HTTP status, "off-site" for a redirect off the host,
                          "too-large" over 5 MB); [] when the site has none
    templates.json        template clusters with a representative page each
    assets/               logo, icons, fonts, index.json; root-favicon.ico and
                          root-apple-touch-icon.png when live served them at the root
    screens/live/         live screenshots and manifest.json (gitignored)
    lighthouse-live/      Lighthouse reports, when run (gitignored)
    pages/404.html        the site's own 404 page (meta.json notFound: path, status, snapshot, text)
    sitemaps/             every sitemap robots.txt names, the default index, and their children;
                          index.json: every sitemap URL asked for { url, status, file }, and
                          { url, host, skipped: "other host" } for one on another host,
                          { url, skipped: "excluded" } for one under an --exclude prefix
    feeds/ robots.txt wp-rest/ wayback-unverified.txt meta.json state.json
    README.md             the generated summary and its ## Notes

## What you write by hand

Under `## Notes` in `capture/README.md` (kept when the README is regenerated): every resume and
why; every `discoveryErrors` entry (the URLs still failing after retries are generated); the
Wayback status from `meta.json`, and whether the second pass ran (its results are generated);
whether shortlinks were verified; seeds you passed and where they came from; media
hosts other than the site's own (a platform CDN) seen in `pages/`; every `bannerClosed`,
`heightMismatch` and `error` in `screens/live/manifest.json`; a template split or merge that looks
wrong; Lighthouse run or skipped; the platform oddities. Facts with paths, before the commit.

## Size, time and address limits

- Every request has a total timeout (30 s; media size checks 120 s; a download 6 hours, so a
  large file is in practice bounded by the 30 s idle timeout) and gives up after 30 s with no
  data. Downloads (media, fonts, PDFs) stream to disk; one larger than `--max-file-bytes`
  (`media`, `assets`; default 2 GB) is recorded `"too-large"` and not saved. Pages, stylesheets,
  sitemaps and REST lists are capped at 20 MB after decompression (`"too-large"`).
- A request to any host but the origin's own (stylesheets, fonts and icons on other hosts, a
  redirect to another host) is refused when the host resolves to a loopback, private,
  link-local or cloud-metadata address, and recorded `"blocked-address"`. The origin itself may
  be such an address (a local or staging copy).

## Platform references

| Fingerprint | Read |
|---|---|
| `wordpress` | `references/wordpress.md` |
| `drupal` | `references/drupal.md` |
| `webflow`, `squarespace`, `wix` | `references/webflow-squarespace-wix.md` |
| `static`, `joomla`, anything else | `references/static-and-unknown.md` |

`shopify` is a store and out of scope for conversion: stop and tell the person.

## Not covered

Repeat this list to the person verbatim. None of it was captured:

- Classes and states added by JavaScript after load (open menus, sliders); coverage runs later.
- A gzipped sitemap that decodes past 20 MB: not read, listed in `meta.json` `discoveryErrors`
  with status `too-large`.
- CSS `@import` inside inline `<style>` blocks: not followed (only linked stylesheets' imports).
- CSS `@import` more than 5 levels below a linked stylesheet (listed `too-deep` in
  `css/manifest.json`, never fetched).
- Media on other hosts (platform CDNs, image services): not listed in `media.json`.
- A URL that still answered 403, 429, 503 or nothing after 3 tries: recorded with that status
  and listed under `## Notes`; its content is not captured.
- Indexing directives from `<meta name="robots">` only; `X-Robots-Tag` headers are not read.
- Anything only a login, a form submission or a search reveals.
- Any page behind an anti-bot challenge (SiteGround, Cloudflare and the like): the capture
  stops there until the capture machine is allowed through.
- A file over `--max-file-bytes` or a page or stylesheet over 20 MB (`"too-large"`), and
  anything on a host that resolves to a private address (`"blocked-address"`).
- A host whose DNS answer changes between the address check and the request.
- Requests made by the browser: the live screenshots and Lighthouse load pages in headless
  Chromium with no address guard, so a page's frames, images and scripts can reach a private
  address.
