# The phases

The order is `docs/process.md`'s. Every phase starts with `state.mjs phase <name>` and ends with
its proof. Do not start the next phase until the proof holds; if it does not, fix and rerun,
never move on with a note. `S` below is `node $KIT/skills/convert-site/scripts/state.mjs --dir
$SITE`. Commands run from `SITE`, each as its own command, not chained with `&&` where a non-zero
exit is expected (diff, styles, a gate you are fixing).

Record results as you go: `S set phases.<name>.result '<json>'` with the counts and exit codes,
and `S set counts.<key> <n>` for pages, templates, redirects, media, forms and vendors.

Before the scaffold, `SITE` holds only `capture/`, `.conversion/` (state, drafts and the media
download) and, when the repository was cloned first, `.git`, `.gitignore` and a README.
`init-site.mjs` refuses anything else, so nothing else is written there until phase 4.

## 1. intake

    mkdir -p $SITE
    S phase intake
    node $KIT/skills/convert-site/scripts/preflight.mjs --json
    node $KIT/skills/capture-site/scripts/fingerprint.mjs $LIVE

Then the one message (`intake.md`) and the answers into state.

**Proof:** `S get intake` holds every answer or default, and every gap is in `needsYou`.

## 2. capture

Follow the `capture-site` skill exactly, from `SITE`, with `KIT` paths:

    S phase capture
    node $KIT/skills/capture-site/scripts/capture.mjs $LIVE --out capture

When `capture/wayback-unverified.txt` is not empty, run the Wayback second pass, then carry on
(`readme.mjs` runs last below):

    node $KIT/skills/capture-site/scripts/capture.mjs $LIVE --out capture --resume --seed-file capture/wayback-unverified.txt

Archived paths that still redirect are in `capture/redirects.json` with `source: "seed"`, so
build-baseline carries them into the baseline's redirects. Then:

    node $KIT/skills/capture-site/scripts/media.mjs --capture capture --download .conversion/media-cache
    node $KIT/skills/capture-site/scripts/templates.mjs --capture capture
    node $KIT/skills/capture-site/scripts/assets.mjs --capture capture
    node $KIT/skills/visual-review/scripts/shoot.mjs --base $LIVE --routes capture/templates.json --widths 390,768,1440 --out capture/screens/live
    node $KIT/skills/convert-site/scripts/css-coverage.mjs --base $LIVE --routes "$(node -e "const t=require('./capture/templates.json');console.log(t.flatMap(x=>[x.representative,...x.paths.filter(p=>p!==x.representative)].slice(0,10)).join(','))")" --out capture/css-coverage.json

Then the optional Lighthouse step, exactly as `capture-site` step 7 says: only when
`npx --no-install lighthouse --version` answers (never install it unasked), one run per
template representative into `capture/lighthouse-live/<template>`; if it is missing, write that
in the Notes. Lighthouse is optional: when it is not installed the step is reported as skipped,
never as a failure, and nothing waits on it. `suggest-improvements` reads `capture/lighthouse-live` and lists its performance
checks as "Not covered" without it. Last:

    node $KIT/skills/capture-site/scripts/readme.mjs --capture capture

`templates.mjs` must run before the baseline (phase 5 reads `templates.json`) and before the
coverage run, which loads up to 10 pages per template (the representative first) at three widths
at the default pacing: a capture step against the live site, landing in `capture/`. Pages of one
template share their CSS, so ten of them find the rules in use; a rule only some other page needs
is pruned, and the full-page diff of every page in phase 8 catches that over-pruning (restore the
rule from `capture/css/`, `build-rules.md`). Every Chromium load of a page (`review:shoot`,
`review:styles` and `css-coverage`) blocks analytics, tag, pixel and chat hosts (Google
Analytics and Tag Manager, Meta pixel, Hotjar, Clarity, HubSpot tracking, Intercom, Drift,
LinkedIn, TikTok, Pinterest, Segment, Mixpanel, Plausible, Fathom, Matomo cloud, Crisp, Tawk,
Zendesk), so the conversion never counts as visits in the live site's reports and late widgets
never land in a shot; `--allow-analytics` on shoot and styles lets them load. The media download
goes under `.conversion/media-cache/`, which the scaffold's `.gitignore` keeps out of git.

**Exit 3 from the capture** means one of three things. Blocks (403, 429, 503 or network errors
in a row): wait, then `--resume`, as the skill's "On exit 3" says; after two stops in a row with
pages saved, tell the person in one line and carry on with what was captured. A bot challenge
(fingerprint or capture prints `blocked: <host> anti-bot challenge (<cause>)`, and the README
names the cause): a protected site, below. No page answered 200: stop and read
`capture/inventory.json`; never continue to templates, media or the baseline, which refuse it
with exit 2.

**A protected site.** The host is serving a bot challenge, not the site, so there is nothing to
convert. Do not scaffold, build templates or a baseline from it. Add the needs-you item
"Allowlist the capture machine's public IP on the host or in the WAF for the capture window, or
send a URL list; then resume with `node $KIT/skills/capture-site/scripts/capture.mjs $LIVE
--out capture --resume`", `S set phases.capture.result '{"stopped":"blocked"}'`, finish what
needs no capture (the intake answers in state, the repo when the intake asked for one), tell
the person in one line with that command, and end the run cleanly. Nothing is scaffolded; when
the person confirms, a later session resumes at phase 2 (SKILL.md, "Resuming") with the same
capture command and `--resume`. Never improvise a real-browser capture or change the user agent
without the site owner's written consent.

Pass `--seed <path>` for every old URL from the intake (`.htaccess`, redirect exports). Write the
`## Notes` section of `capture/README.md` by hand, as the skill says. List files under `capture/`
over 25 MB (`find capture -size +25M`) in the Notes: they are added to `.gitignore` at the
scaffold, before its commit.

**Proof:** `capture/README.md` exists with Notes; `capture/templates.json` and
`capture/css-coverage.json` exist; every URL in `inventory.json` has a status; no route with
a status other than 200/3xx/404/410, or an exception for each (`routes`, SKILL.md). After a
Wayback second pass, `## Notes` opens with `Wayback second pass: N of M archived paths verified`
and one line per path with its status or redirect target. `## Notes` also lists every URL still
failing after its retries (`Still failing after retries: <path> (<status> after 3 attempts)`)
and a Wayback listing that failed or was refused for size: repeat those to the person.

A route with status "suspect-challenge" (a tiny untitled page the capture could not tell from a
bot challenge) fails the routes gate as "not captured" until you decide: open it in a browser
and record what it is with a routes exception `{ path, field: "routes", from:
"suspect-challenge", to: "skip" | "<built path>", reason }`.

## 3. plan

    S phase plan

The plan phase decides; the scaffold writes. Every decision goes into state with `S decision`
(it prints `d1`, `d2`, …), and any file output stays under `.conversion/` until phase 4.

1. **Hosting**, from the intake: `S set hosting '"vercel"'` (or `"cloudflare"`).
2. **URL form**, the majority of pages answering 200 (the home page left out):

       node -e "const i=require('./capture/inventory.json').filter(r=>r.status===200&&r.path!=='/');const s=i.filter(r=>r.path.endsWith('/')).length;console.log(s>=i.length-s?'always':'never')"

   `S set trailingSlash '"always"'` (or `"never"`); the minority form becomes redirect rows.
3. **Media**:

       node $KIT/skills/convert-site/scripts/media-plan.mjs --media capture/media.json --host <hosting> --out .conversion/media-plan.json

   Without `--prefix` the plan takes the longest folder holding at least 90 % of the media
   bytes, never a theme or plugin folder (`/wp-content/themes/`, `/wp-content/plugins/`: those
   files stay in `public/` and are counted outside the prefix) and never a WordPress year or
   month folder. Exit 2 with "no media folder holds at least 90 %": choose the prefix that holds
   most of the bytes, pass `--prefix`, and record a decision. Mode `store` with no store credentials in the environment
   (`BLOB_READ_WRITE_TOKEN`, or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET`): rerun with `--mode live-temporary`, record the decision, and add the needs-you
   item "create the store, upload, regenerate rewrites; live-temporary must be gone before DNS
   moves". When `media-plan` prints "N unreferenced sizes listed, not downloaded; pass --sizes all
   to the capture if old links may use them", put that line in the plan's media decision and
   the status message as printed: those WordPress sizes are in `baseline/media.json` with
   `downloaded: false`, never built, and the media gate counts them as skipped. Rerun
   `media.mjs --sizes all` (then the plan and the baseline) only if the owner says old emails
   or other sites may link to them.
4. **Templates**, from `capture/templates.json`: a split or merge that looks wrong is a decision.
5. **Oddities**, one decision each, default "reproduce live": a missing or second H1, a dead
   tag, a broken internal link, a redirect chain, a sitemap URL that 404s, a slug claimed twice
   (category base), a shortcode printed as text, an `http://` canonical, mixed content, a
   noindex page in the sitemap, a font loaded from a font service, theme scripts (`build-rules.md`).
6. **Out-of-scope features** the capture found (search, comments, store, logins), with the
   options; the default reproduces the markup as it is (the feature stops working) and the
   options are a third-party embed, keeping it on the old platform under a subdomain, or a
   separate project. The forms, analytics ids and media size found go into the plan and the
   status message too; the intake never asked for them.
7. **Forms.** The intake asked about forms before the capture could know whether one posts. The
   intake's forms answer is applied only if `inventory.json` lists a POST form (`forms.md`: a
   `GET` search form is not rewired, nor a form a third-party script draws at runtime, which
   `third-party.md` covers). If it lists none, the status
   message says "Forms: none to rewire" and no form needs-you item is created (no form id is
   asked for and `placeholders.form-id` does not apply).

For example:

    S decision '{"topic":"missing h1 on /services/","choice":"reproduce live","default":"reproduce live","reason":"parity; the fix is a proposal","costIfWrong":"none for launch; SEO stays as it is today"}'

Draft the plan in `.conversion/plan.md` from the capture, never from memory: the templates table,
counts from `inventory.json`, `media.json` and `redirects.json`, the media decision with its
numbers and reasons, the redirect source, the forms table (`inventory.json` forms), the analytics
IDs (`capture/scripts.json`) and the out-of-scope features. Exceptions and proposals follow
SKILL.md, "Decisions, exceptions, proposals". Then send the one status message (SKILL.md, "The
one message after the plan") and carry on.

**Proof:** every template, count, oddity and out-of-scope feature has a decision in `S get
decisions` and a line in the draft.

## 4. scaffold

    S phase scaffold

With `gh` logged in and no repo yet, `gh repo create <owner>/<slug> --private` (an empty repo).
Then, from the folder that holds `SITE`, with the plan's choices:

    node $KIT/skills/convert-site/scripts/init-site.mjs --dir $SITE --origin $LIVE --name "<site name>" --host <hosting> --trailing-slash <always|never> --repo https://github.com/<owner>/<slug>.git

`init-site` keeps `capture/` and `.conversion/` and makes the one scaffold commit on `main`,
capture included (screenshots, Lighthouse reports and the media download stay ignored), then
switches to `astro-rebuild`. If a capture file over 25 MB was listed in phase 2, add it to
`.gitignore` before running `init-site`. If `npm install` fails inside it, follow the next step
it prints, which includes `git add -A`: the capture is meant to be in that commit.

Right after, on `astro-rebuild`:

1. `docs/plan.md` from `.conversion/plan.md`, and its Decisions table filled from
   `S get decisions`, one row per decision:

       | Id | Date | Topic | Choice | Default | Reason | Cost if wrong |

   This table is the one decision ledger. Every later decision adds a row here.
2. `mv .conversion/media-plan.json docs/media-plan.json` (the media gate reads it there).
3. Commit `docs: conversion plan`, then `git push -u origin main`, so the PR has a base.

Never commit to `main` again.

**Proof:** `npm run build` exits 0; `main` has one commit more than before init-site (`git
rev-list --count main` before and after; on a new, empty repository that is exactly one); you
are on `astro-rebuild`.

## 5. baseline

    S phase baseline
    npm run baseline
    node $KIT/skills/parity-gates/scripts/build-baseline.mjs --out baseline --check

`npm run baseline` also writes `redirects.csv` (from, to, status, source, note). Commit
`chore: baseline from capture`. From here `baseline/` is never edited, apart from the `keep`
flags in `baseline/scripts.json` (`third-party.md`).

**Proof:** the `--check` run exits 0.

## 6. build

    S phase build

Read `build-rules.md`, `forms.md`, `third-party.md` and your host file first. In this order:

1. Media (`build-rules.md`, "Media") and fonts; for `store`, upload now (host file).
2. CSS: `node $KIT/skills/convert-site/scripts/css-prune.mjs --css capture/css --coverage capture/css-coverage.json --out src/styles/site.css --report .conversion/css-prune-report.json`. When it prints `wrote N per-page sheet(s)`, give each page its `pageSheet`
   from the report's `pageSheets`. css-prune clears the old `inline-*.css` in
   `src/styles/pages/` on each run, so commit the folder as it leaves it.
   Exit 1 means a stylesheet had no coverage and was kept whole: record a decision.
3. One layout per template, with the header, navigation and footer as components.
4. The representative page of each template, its content moved from the captured markup.
5. Forms (`forms.md`) and third-party scripts (`third-party.md`).
6. Redirects: `npm run redirects:build`, and again after the first `npm run build`, so the
   slash rules pick up every file type the build ships (the compiler scans `dist/`).

**Gates on every template commit.** `npm run verify` stops at the first failing gate, and links,
redirects and sitemaps are expected to fail until every page exists. So during the template work
run the path-scoped gates one by one, with `P` set once to the comma list of the
representatives:

    P="/,/about/,/blog/,/hello-world/"
    npm run build
    node scripts/verify/forms.mjs --paths "$P" --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/
    node scripts/verify/headers.mjs --paths "$P"
    node scripts/verify/media.mjs --paths "$P"
    node scripts/verify/routes.mjs --paths "$P"
    node scripts/verify/scripts.mjs --paths "$P"
    node scripts/verify/seo.mjs --paths "$P"
    node scripts/verify/text.mjs --paths "$P"

The media gate with `--paths` checks the media those pages reference (`referencedBy` in
`baseline/media.json`), so "media: 0 checked" means those pages reference no media file. Add `--allow-extra /thank-you/` to the routes gate when that page is new (`forms.md`).
Query-concatenated script URLs (WordPress VIP's `/_static/??a.js,b.js`) cannot be served by a
static host and `assets.mjs` does not rewrite them: you save each concatenation as one file at
`/_static/concat/<hash>.js`, point the markup at it (a decision row), and pass
`--allow-extra '/_static/concat/*'` on every routes gate run. Only `routes.mjs` (and
`npm run verify`, which hands it on) accepts `--allow-extra`; the other single gate scripts
exit 2 on it with "Unknown option '--allow-extra'" and their usage text. Each of
the seven must exit 0 before the commit (`feat: <template> template`). `links`,
`redirects` and `sitemaps` are not run yet; they run in phase 7.

**Design lock.** When every template is built, follow the `visual-review` skill's loop on the
template set: shoot new at 390, 768 and 1440, diff against `capture/screens/live`, styles, sheet,
look, write down every difference, fix from `capture/`, repeat. Never reshoot live to get a
match. The proof is `npm run review:diff -- --a capture/screens/live --b review/new --out
review/diff` and `npm run review:styles -- --live $LIVE --new http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/styles.json` exiting 0 for the template set (with `npm run review:serve` serving the build). From here a fix goes
in the template, never in one page.

**Serve, then wait.** Before every `review:shoot` or `review:styles` against the build, serve
it with `npm run review:serve` (it applies `vercel.json` like staging does) and use that origin for
every `review:*` step. Its redirects keep their status codes, `dist/` answers next, and a rewrite to
another origin is proxied: media left on live in `live-temporary` mode or not yet in the store, an
`importmap` target rewritten to live. `astro preview` ignores `vercel.json`, so every rewritten
image 404s there and every pixel diff fails: `npm run preview` is only for sites whose media is in
the repo. On Cloudflare (no `vercel.json`) it applies `dist/_redirects` the same way. It re-reads
either file when it changes. Stop any leftover server first, then start it in the background; it returns once it
answers, and it reads `dist/` on every request, so a rebuild needs no restart:

    npm run review:serve -- --stop
    npm run review:serve -- --background --port 4321

A port another process holds exits 2 ("port 4321 is in use by another process (pid <n>,
<command>); pass --port") instead of binding another interface, where Chromium would reach the
other server: pass a free `--port` and use that origin. Stop it with
`npm run review:serve -- --stop` when the review is done, and before the run ends.

**Overrides.** A looser visual threshold lives in the committed `docs/visual-overrides.json`,
keyed by route folder: `{ "<route>": { "id": "<decision id>", "threshold": <at most 2>,
"reason": "<why>" } }`. Record the decision first (`S decision …`); its id goes in `id`.
`review:diff` reads the file by default and exits 2 on an entry without an id or reason or with
a threshold above 2 %. Every override is listed in the PR body. Height differences are counted,
not ignored: the rows one screenshot has beyond the other count as differing pixels.

**Rollout.** Every remaining page through its template's route, from captured markup
(`build-rules.md`), plus sitemaps, feeds, the 404 page and robots. Sitemaps follow
`build-rules.md` ("Sitemaps, feeds, robots, 404"): the live names when live had them; when live
publishes none (`baseline/sitemaps.json` is `[]`, a robots-named sitemap that 404s included),
Astro's `sitemap-index.xml`, with the release robots.txt `Sitemap:` line pointing at it, as one
decision row. The routes gate never calls `sitemap-index.xml` or `sitemap-<n>.xml` an extra,
and does call a robots-named file live never served one. With subagents, one implementer per
template.

**Proof:** `npm run build` passes with every route built, and the seven path-scoped gates pass
for every path.

## 7. gates

    S phase gates
    npm run build
    npm run verify -- --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/

The form flags go on the command line every time, as the `parity-gates` skill shows; add
`--allow-extra /thank-you/` when that page is new (`forms.md`). With `proposals.json` entries,
also `PROPOSALS=on npm run build` and `npm run verify:proposals -- <the same flags>`, then rebuild
without it. Keep the plain-text `npm run verify` output for the PR, skip lines included.

Then the release build, which compares robots exactly (a page that lost its own live noindex
passes the staging comparison, never this one), and rebuild staging:

    PUBLIC_INDEXABLE=true npm run build
    npm run verify:release -- <the same flags>
    npm run build

`PUBLIC_INDEXABLE=true` here is a variable for that one local build, never the hosting
setting: nothing is deployed from it, and the plain `npm run build` after it puts the staging
build back. An instruction to leave `PUBLIC_INDEXABLE` unset (the intake's, the host's, the
person's) is about the host's environment and still allows this build, `verify:release` and the
pre-launch run in phase 10. Skipping them is not an option.

**Proof:** `npm run verify` exits 0 on the full build, `npm run verify:release` on the
`PUBLIC_INDEXABLE=true` build (and `verify:proposals` when there are proposals). No PR is opened
before this holds.

## 8. visual

    S phase visual

Serve the full build and wait for it first (phase 6, "Serve, then wait"; after every rebuild).
The template set is locked (phase 6); rerun its loop once on the full build to confirm it still
passes. Then the `visual-review` reference, step 7: shoot live once more into
`capture/screens/live-all` (a capture step, default pacing), shoot new into `review/new-all`,
diff into `review/diff-all`, sheet into `review/all.html`, look, fix the template, repeat.
Rerun the phase 7 gates after every fix.

**Proof:** `npm run review:check` exits 0: it re-reads `review/diff/diff.json`,
`review/diff-all/diff.json` and `review/styles.json` and fails on any failing row, printing the
worst pair.

## 9. components (optional)

Only when the intake said "components" or the person asked: `components-optional.md`. Otherwise
`S phase components` then `S set phases.components.result '"skipped: off by default"'`.

## 10. prelaunch

    S phase prelaunch
    git add -A
    git commit -m "chore: state before pre-launch"
    git push -u origin astro-rebuild
    PUBLIC_INDEXABLE=true node $KIT/skills/pre-launch/scripts/pre-launch.mjs --dir $SITE --production-url $LIVE --predecessor-url $LIVE --ignore-dir capture --out $SITE/review/pre-launch

pre-launch fails a tree with uncommitted changes or no upstream, and `state.json` changes with
every `S` call, so commit and push first. It runs `npm run build` itself: `PUBLIC_INDEXABLE=true`
makes that the production build it is meant to gate (without it, the staging build's robots.txt
blocks everything and fails the robots check). That `PUBLIC_INDEXABLE=true` is a variable for
this one local command, never the hosting setting: "leave it unset on the host" (or in the
intake) still means run this command with it, as written. Without a `gh` login there is no remote to push
to; `hygiene.pushed` then fails until the person pushes, and that is a needs-you line (the
reconcile accepts it only then: no remote, and a needs-you item that says to push).

Then reconcile what failed with live:

    node $KIT/skills/convert-site/scripts/prelaunch-reconcile.mjs --findings review/pre-launch/gate.json --baseline baseline --plan docs/plan.md

A failing check is accepted only when every row it names (title, description, h1, canonical,
og:image, favicon, placeholder text) is what live had for that path and a `docs/plan.md`
decision row names the check id, or the path and its field (the home page as `` `/` ``, the
404 page as `` `404.html` ``, compared with the captured 404): a decision that only lists paths,
such as the templates one, accepts nothing. Also `hygiene.pushed` with no remote while the push
is on the needs-you list; also `placeholders.form-id` while the form id is missing (the PR is
then a draft, `forms.md`); the two predecessor slash checks when every row is a trailing-slash
rule or a slash-only redirect (a known launch-skills limitation); and `predecessor.coverage`
when live publishes no sitemap (the capture saved none) and every page the crawl found is
built or on a decision row. A missing root icon counts as live's when the capture's probe
(`capture/meta.json` `icons`) saw live answer 404; never invent one to pass. Everything
else blocks and is fixed on the branch, as the `pre-launch` skill's triage says. Keep its
accepted lines for the PR. Never pass `--confirm`: the human checklist ids (`forms`,
`analytics`, `hosting`, `payments`, `legal`, `gsc-baseline`, `dns`, `signoff`, `rollback`) go to
`docs/LAUNCH.md` section A for the person.

Then the staging deploy (host file; on Vercel: link with the team slug, deploy, take the URL
from the deploy JSON: the production alias from `deployment.productionUrl`,
`https://<slug>.vercel.app` when the field is missing, confirmed with one GET that answers 200 with the staging noindex,
never the raw deployment URL; only when the owner opted in to protection (`publicStaging`
`false`), the protection PATCH comes between link and deploy). On the default public path every
staging deploy is `npx vercel deploy --prod --yes --scope <scope>` from `astro-rebuild`: until
the domain is attached on launch day the production alias is staging, so every redeploy before
launch updates what reviewers and the audit see. Then:

    npm run verify:live -- --base <staging url> --expect-noindex
    node $KIT/skills/launch-audit/scripts/launch-audit.mjs --url <staging url> --staging --ignore-robots --old-url $LIVE --out $SITE/review/launch-audit

`--ignore-robots` is a bare flag (`--ignore-robots true` prints the help): staging's robots.txt
blocks everything, and without it the audit crawls no page. Links the captured content writes
absolute to the live origin (as WordPress does) are off-origin on staging, so the audit crawls
only what is linked relatively and lists the rest as dropped: copy that line into the PR's Not
covered.
On Vercel with the default public staging, no `--bypass` is needed; an exit 3 with
`deployment protection: ...` there means the run was pointed at the raw deployment URL: rerun
on the alias. Only when the owner opted in to protection, add
`--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` to `verify:live` when that variable is set in your
environment (a new project has none until a person creates it; without it `verify-live` stops
with exit 3, `deployment protection: ...`, and the staging check goes under "Not covered" with
the needs-you line from the host file); with media in a store add `--media-manifest media-manifest.json`. Copy
the audit's `baseline.json` and `redirects.csv` to `docs/launch/audit-baseline.json` and
`docs/launch/audit-redirects.csv` (the cutover reads them). Fix every audit blocker on the
branch, or list it in the PR with why it cannot be fixed. Then the one test submission
(`forms.md`).

**Proof:** `prelaunch-reconcile` exits 0 (with no `gh` login it accepts `hygiene.pushed` only
while the repository has no remote and the push is on the needs-you list; the PR cannot be
opened until then); `verify-live` exits 0 or its gap is listed; every audit blocker is fixed or
listed.

## 11. suggestions

    S phase suggestions

Collect `gates.json` now, from the build as it stands after every fix (one JSON document per
gate, gathered into an array):

    npm run build
    npm run --silent verify -- --json --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/ > .conversion/gates.out
    node -e "const fs=require('fs');const t=fs.readFileSync('.conversion/gates.out','utf8');const d=t.split(/^(?=\{$)/m).map(s=>s.replace(/^All \d+ gates passed\s*$/m,'').trim()).filter(Boolean).map(JSON.parse);fs.writeFileSync('.conversion/gates.json',JSON.stringify(d,null,2)+'\n')"
    node $KIT/skills/suggest-improvements/scripts/suggest.mjs --capture capture --baseline baseline --review review --gates .conversion/gates.json --out docs/suggestions.md --json suggestions.json

Then add the "From the review" section by hand, as the `suggest-improvements` skill says. Apply
nothing.

**Proof:** `docs/suggestions.md` exists, ends with "From the review", and its Not covered list is
copied for the PR.

## 12. pr

    S phase pr

Write `docs/LAUNCH.md` (`runbook.md`), the PR body (SKILL.md), commit `docs: launch runbook`,
then `npm run build` and the full phase 7 gates once more, push `astro-rebuild` and open the PR
(`--draft` while `placeholders.form-id` fails). Finish with the final report.

**Proof:** `npm run review:check` exits 0 (every template pair, every page pair and every style
row passes), and the PR exists (or its body is in `.conversion/pr-body.md` with "open the PR" on
the needs-you list) and quotes the gate output and every "Not covered" section verbatim.
`S set phases.pr.result '{"pr":"<url>","draft":<true|false>}'`.
