# Hosting on Cloudflare Pages

Chosen at intake instead of Vercel. wrangler uploads the local `dist/` (and `functions/`, when
media is in R2), so every build setting, the indexable switch included, belongs to the local
build, never to the Pages dashboard. The kit's `docs/hosting.md` explains the background; this file
is what you run.

You deploy previews. You never change project settings in the dashboard, never add a domain or a
redirect rule there; those are runbook steps for the person.

## Project and staging deploy (phase 10, prelaunch)

Only when `preflight.mjs` reports `wrangler.loggedIn: true`. From `SITE`:

    npx wrangler pages project create <slug> --production-branch main
    npm run build
    npx wrangler pages deploy dist --project-name <slug> --branch astro-rebuild

The preview is `https://astro-rebuild.<slug>.pages.dev`: that is the staging URL,
`S set staging '"<url>"'`. Previews are public by default, so `launch-audit` and `verify-live`
can reach them; the content is still noindexed.

Not logged in: no deploy; `npm run review:serve` locally; the staging audit and `verify-live` go under
"Not covered"; "log in, create the project and deploy" (the three commands above) goes on the
needs-you list.

## Indexing

Staging builds leave `PUBLIC_INDEXABLE` unset, so `Base.astro` puts `noindex, nofollow` on every
page and robots.txt blocks everything. The header comes from the template's `public/_headers`,
which carries a whole-host block for the preview hosts:

    https://*.pages.dev/*
      X-Robots-Tag: noindex

It applies to every `*.pages.dev` address, preview branches included, and never to the custom
domain, so production needs no change to it. Do not remove it.

Production is `PUBLIC_INDEXABLE=true npm run build` then
`npx wrangler pages deploy dist --project-name <slug> --branch main`, which reaches production
only when the project's production branch is `main`.

## Redirects

`npm run redirects:build` writes `public/_redirects` (every line with its status; static rules
first). Pages allows 2,000 static and 100 dynamic rules; beyond that the runbook points the person
to Bulk Redirects.

**Query redirects.** `_redirects` cannot match a query string, so `?p=` shortlinks and other query
rows go to `cloudflare-query-redirects.csv` beside `redirects.csv`; the redirects gate lists them
as skipped (not passed). Each one is a Single Redirect the person creates in the zone (a rule on
`http.request.uri.query`, the status from the csv). That is a needs-you item with the csv's row
count, and it must be done before DNS moves.

Pages' own slash redirects are 308; where live used 301 for the same pair, the redirects gate
shows it, and accepting it is an exception.

## Headers

`public/_headers` ships nosniff, the referrer policy, `SAMEORIGIN` framing and an immutable cache
on `/_astro/*`. `_headers` and `_redirects` do not apply to a Pages Function's responses.

## Media in R2

**Store.** With `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in
the environment (never in chat or the repo):

    node $KIT/skills/convert-site/scripts/media-upload.mjs --store r2 --dir .conversion/media-cache --manifest media-manifest.json --prefix /wp-content/uploads/ --media capture/media.json

Rerun until it exits 0 (it resumes); commit `media-manifest.json`. Each entry's `url` is the
file's site path (`/wp-content/uploads/…`), never the private API address. Pages cannot rewrite
to another origin, so a Pages Function serves the prefix from the bucket. No public bucket and no
R2 custom domain are needed; the function reads the bucket through its binding:

1. Copy `$KIT/skills/convert-site/templates/cloudflare/r2-media-function.js` to
   `functions/<prefix without its leading slash>[[path]].js`, for example
   `functions/wp-content/uploads/[[path]].js`. Commit it.
2. Bind the bucket as `MEDIA`: add `wrangler.toml` with `name = "<slug>"`,
   `pages_build_output_dir = "dist"` and `[[r2_buckets]]` `binding = "MEDIA"`,
   `bucket_name = "<bucket>"`. (Or the person adds the binding in the dashboard; then it is a
   needs-you item.)
3. Deploy, then request one media URL on the preview and confirm 200, the content type and the
   byte size; `verify-live --media-manifest media-manifest.json` samples the rest, checking each
   site-path `url` at `<base><path>` on the deploy.

A redirect row under the media prefix is not applied on the function's route: handle it in the
function or list it as a runbook step.

`media-plan.mjs`'s `rewriteConfig('store', …, { store: 'r2', bucket })` prints these same steps
for the runbook.

**Live-temporary.** No R2 credentials: the plan says `live-temporary`. Add the 302 line it
prints, before any other rule matching the prefix, to `public/_redirects` (after
`redirects:build`, which rewrites that file, or as a row in `redirects.csv` with `source`
`decision`, status 302, which survives regeneration; prefer the row). The local review serves
the build with `npm run review:serve`, which applies `dist/_redirects` when the site has no
`vercel.json` (the simple `source destination [status]` lines, in file order, splats and
`:placeholders`, 301/302 redirects and 200 rewrites; it warns on any other line), so the 302
sends each image to live there as on the preview:

    node --input-type=module -e "import { rewriteConfig } from '$KIT/skills/convert-site/scripts/media-plan.mjs'; console.log(rewriteConfig('live-temporary', '$LIVE', '/wp-content/uploads/', { store: 'r2' }))"

The needs-you item: create the bucket, put the R2 credentials in the environment, run the upload,
add the function and binding, remove the 302 row, rerun `media-plan.mjs` without `--mode`
(`--out docs/media-plan.json`), and rerun the gates. Live-temporary must be gone before DNS
moves.

## Production (the person, on launch day)

The production deploy above, then the custom domain in the Pages project and the records it
shows: apex and `www` only.
