# WordPress

The first-class case. Read this after `fingerprint.mjs` says `wordpress`, before the capture.
Everything below is either done by the scripts or something to look for in the capture and write
under `## Notes`. Nothing here is a reason to request the live site by hand.

## REST lists

When the fingerprint finds REST (`/wp-json/` or `api.w.org` in the page or the `Link` header),
`capture.mjs` pages through `wp/v2/pages`, `posts`, `media`, `categories`, `tags` and `users` at
100 per page, following `X-WP-TotalPages` (or, without it, until a short or empty page), and saves
each list as `capture/wp-rest/<type>.json`. Pages and posts found there are crawled with
`foundBy: rest`, so pages the sitemap forgot are captured too.

- The API only returns what is public: drafts and private content never appear.
- `users` is often closed; its absence is not an error. Any other list that fails is in
  `meta.json` `discoveryErrors`. A list cut short at 1000 pages is recorded there too.
- `--no-rest` skips it. Use that only when the person asks or the API itself is broken.

## Every image size (srcset)

WordPress writes resized copies of each upload (`photo-300x200.jpg`, `photo-1024x683.jpg`) and
lists them in `srcset` and in the media list's `media_details.sizes`. `media.mjs` lists every
registered size from `wp-rest/media.json`, referenced by a page or not (`source: rest`). It
downloads the originals and the sizes something on the site uses (a srcset, an attribute, or
the file name anywhere in a captured page, stylesheet or script); a size only the REST list
names is listed with `downloaded: false, reason: "unreferenced size"` and not requested, so the
media plan and the launch runbook know it exists (a block theme registers many sizes: 886
uploads can carry 5,440 URLs). Run it with `--sizes all` when other sites or old emails may link
to any size. A size that 404s is listed with that status.

## `?p=` shortlinks

`/?p=123` redirects to the post or page with that id. The capture reads them from each page's
`<link rel=shortlink>` and from links, and records them in `redirects.json` with
`source: shortlink` and `verified: false`, **without requesting them**. Pass
`--verify-shortlinks` to request each one and record its real chain; on a large site that is one
paced request per page, so say in the notes which you chose. Unknown ids 404 live and stay 404.

## Category-base collisions

`/category/news/` next to a page called `/news/`, or a plugin that strips the category base so
archives and pages share one namespace. Look in `inventory.json` for two paths that end in the
same slug, and in `redirects.json` for one redirecting to the other. Note every slug claimed twice
and which one the live site serves; the build serves the same one.

## Shortcodes

A leftover `[gallery]`, `[contact-form-7 id="12"]` or `[et_pb_section]` in `text/` means a plugin
was removed or never rendered it. Search `text/` for `\[[a-z_-]+` and list each page in the
notes. The build reproduces what the live page shows, raw brackets included.

## Lazy-load attributes

Themes and plugins put the real image in `data-src`, `data-lazy-src` or `data-original` (and
`data-srcset`, `data-lazy-srcset`), often with a `<noscript>` copy. The capture and the media list
read the real source from those attributes first, and the screenshots scroll the page so the
swap happens. A lazy-load attribute other than these is not read: if `pages/` shows one, note it
with an example path.

## Optimiser suffixes

Image and cache plugins add `-scaled` (large uploads), `-e1612345678` (edited images),
`photo.jpg.webp` next to the original, and `?ver=` on assets. Each variant the site serves is a
separate file at a separate URL and is kept as one; never fold them together. Note the plugin
(from the fingerprint's `plugins`) so the conversion knows where the variants came from.

## Page builders

The template body classes (`page`, `single-post`, `archive`, `page-template-*`) still group pages
on every builder; per-page classes like `elementor-page-12` are ignored. What differs is markup:

- **Elementor**: deep `elementor-section` / `e-con` wrappers, per-page CSS in
  `/wp-content/uploads/elementor/css/post-<id>.css` (captured in `css/`), and motion classes
  (`elementor-invisible`, `animated`) added by script. Expect `page` to split into `page-2`,
  `page-3` where layouts differ; check each split's representative is a real layout.
- **Divi**: `et_pb_` classes, `[et_pb_*]` shortcodes left in content when Divi is gone, and an
  inline `<style>` per page (saved as `css/inline-<slug>.css`).
- **Gutenberg** (the block editor): `wp-block-*` classes and the global styles in an inline
  `<style id="global-styles-inline-css">`. Block markup is plain and usually clusters cleanly.

## Feeds, sitemaps and forms

`/feed/`, category feeds, core `wp-sitemap.xml` and plugin sitemaps (`sitemap_index.xml`,
`post-sitemap.xml`) are captured under `feeds/` and `sitemaps/`. A sitemap URL that 404s is a
record with status 404 in `sitemaps/index.json` (and, when robots.txt names it, in `meta.json`
`discoveryErrors`), not dropped. Plugin forms post to `admin-ajax.php` or a REST route; the
inventory records each form's action and field names, which the conversion rewires.
