---
name: visual-review
description: Prove an Astro rebuild looks like the live site it replaces — full-page screenshots of both sides with motion frozen, a pixel diff with a 0.5 % pass line, a computed-style comparison of typography, colour and spacing, and one contact sheet to look at every pair. Use after a template is built, before calling a conversion page done, when someone asks whether the new site matches the old one, or when a diff or style row fails and needs fixing.
---

# visual-review

Screenshot the live site and the new build at the same widths, measure every difference, look at
every pair yourself, fix, and repeat until every template passes. Then do it again for every page.

## The golden rule

**The diff decides, your eyes explain.** A pair passes only when `review:diff` says it passes and
`review:styles` has no failing row for it. Looking at a screenshot and finding it "close enough" is
never a pass. Four more that follow from it:

1. **Write down every visible difference before you change code.** Per pair, in words, from the
   contact sheet. Fixing what you noticed first and skipping the rest is how a page ships wrong.
2. **Parity, not better.** A deliberate improvement (a fixed typo, a tidier spacing, a sharper
   image) never goes into the default build. It goes into `proposals.json`.
3. **A looser threshold needs a decision.** Per-route overrides live in the committed file
   `docs/visual-overrides.json`, each `{ "id": "<decision id>", "threshold": n, "reason": "..." }`
   with `n` at most 2 (%). The decision id, threshold and reason are recorded on the diff row.
4. **A failed or missing shot is a fail, not a skip.** A route that did not load, a screenshot
   present on one side only, or an unreadable PNG fails its row.

## What the scripts do

A site made by `convert-site` carries copies of the scripts in `scripts/review/`. Every command
below runs from the site root as `npm run review:<name> -- <options>`. Outside a converted site,
run `node <skill-dir>/scripts/<name>.mjs <options>` from the folder that holds `capture/` and
`review/`. Every script prints `--help`; run it rather than reading the source.

| Script | Does | Exit |
|---|---|---|
| `review:shoot` | Full-page Chromium screenshots per route and width, plus `manifest.json` | 0 all shot, 1 a route failed, 2 usage, 3 stopped on blocks |
| `review:diff` | Pixel diff of two screenshot folders, diff images plus `diff.json` | 0 all pass, 1 any fail, 2 usage |
| `review:styles` | Computed styles of sampled selectors on both origins, `styles.json` | 0 all match, 1 a row fails, 2 usage or environment |
| `review:sheet` | One self-contained HTML contact sheet: live, new and diff side by side | 0 written, 2 usage or environment |
| `review:check` | Re-reads `review/diff/diff.json`, `review/diff-all/diff.json` (when present) and `review/styles.json`; prints the worst failing pair | 0 every row passes, 1 a row fails or a result is missing, 2 usage |

Exit 1 from diff or styles is expected while differences remain: carry on to the sheet, and run
each step as its own command rather than chaining them with `&&`. Exit 3 from shoot means the
site is blocking requests: wait, then rerun with a longer `--delay`; never retry in a tight loop.

What makes the screenshots comparable, on both sides alike: animations and transitions are
frozen and scroll-reveal content is forced visible; endless GSAP loops (`repeat: -1`, JavaScript
motion the freeze cannot stop) are put back to their start and paused; lazy images are made
eager and loaded by scrolling to the bottom and back (capped at 60 viewports or 30 s), except
`sizes="auto"` ones, which stay lazy so they pick the same `srcset` file every time; the shot
waits only for images the page requested (a hidden slide's lazy image does not hold it) and
for each of them to be decoded, so none paints blank; web fonts are awaited; a cookie banner whose
button says accept, agree, got it or ok is closed and reported as `bannerClosed`. Requests to
analytics, tag, pixel and chat hosts (Google Analytics and Tag Manager, Meta pixel, Hotjar,
Clarity, HubSpot tracking, Intercom, Drift, LinkedIn, TikTok, Pinterest, Segment, Mixpanel,
Plausible, Fathom, Matomo cloud, Crisp, Tawk, Zendesk) are blocked in `review:shoot` and
`review:styles`, so a review run never counts as a visit in the site's reports and a late chat
bubble never lands in a shot; `--allow-analytics` lets them load. A screenshot
more than 2 px off the page's `scrollHeight` is flagged `heightMismatch`.

What the diff measures: pixelmatch at threshold 0.1 with anti-aliasing ignored. A pair passes at
**0.5 % differing pixels or fewer** and equal widths. When the heights differ, every row the
taller image has and the shorter one lacks counts as differing, so a missing footer fails; the
row says `heightMismatch` and the difference is counted, never ignored. When the aligned
comparison fails, the new image is also tried shifted by up to **1 px** in each direction, so a
sub-pixel rounding shift is not reported; the row records the `offset` used and the aligned
`percentUnaligned`. Wider shifts are never searched: 2 px off is a real difference.

What the styles comparison measures: on the first match of `h1`–`h4`, `p`, `a`, `button`,
`.btn`, `[class*=button]`, `nav a`, form fields, `blockquote`, `li`, `header` and `footer`, it
compares first font family, size, weight, line height, letter spacing, colour, background,
text transform, vertical margins and all four paddings. Lengths pass within 1 px; colours and
families must match exactly. A selector present on one side only fails with a `present` row. A
route that is not 2xx on either side fails with one `status` row.

## Where things live

    capture/screens/live/     live screenshots, taken once at capture time (the capture step
                              runs shoot.mjs against the live site); never re-shot to
                              get a match (rollout adds capture/screens/live-all/ once)
    review/new/               new screenshots, from the dev or preview server
    review/diff/              diff images and diff.json
    review/styles.json        style rows
    review/index.html         the contact sheet
    docs/visual-overrides.json
                              per-route thresholds, each with its decision id and reason
                              (optional; committed, so every looser threshold is reviewed)

`capture/` holds the live evidence; `review/` is regenerable and not committed. The contact sheet
embeds every image as data, so one file opens anywhere, and it can be tens of megabytes.

## The loop

Read `references/review-procedure.md` before the first run. In short:

1. **Serve the new site.** `npm run build`, then serve the build with `npm run review:serve`
   (it applies `vercel.json` like staging does, so media and scripts rewritten to another origin
   load) and use that origin, e.g. `http://localhost:4321`, for every `review:*` step.
   `npm run preview` is only for sites whose media is in the repo; `npm run dev` while iterating.
2. **Shoot new** with the same `--routes` and widths the live shots used, so folder names match:

       npm run review:shoot -- --base http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/new --delay 0

3. **Diff** (it reads `docs/visual-overrides.json` when that file exists):

       npm run review:diff -- --a capture/screens/live --b review/new --out review/diff

4. **Styles.** It loads the live site one page at a time, 500 ms apart by default. It defaults to 390
   and 1440, so pass the widths to cover 768 too:

       npm run review:styles -- --live https://www.example.com --new http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/styles.json

5. **Sheet:**

       npm run review:sheet -- --live capture/screens/live --new review/new --diff review/diff/diff.json --styles review/styles.json --out review/index.html

6. **Look.** Open `review/index.html`. For every pair, write down every visible difference you
   can see, failing or not, before you touch any code. Then read `diff.json` for `offset`,
   `percentUnaligned` and `reason`, and both `manifest.json` files for `bannerClosed`,
   `heightMismatch` and `error`: the sheet does not show those.
7. **Fix** from `capture/` (markup, CSS, media), one difference at a time. Then go back to 2.
8. **Roll out** only when every template pair passes at every width: shoot every page
   (`--full`) at 390 and 1440, diff, sheet, look, fix, repeat until every page passes. The
   exact commands are in the reference, step 7.
9. **Check** before the pull request: `npm run review:check` exits 0 only when every template
   pair, every page pair and every style row passes.

## If your agent has a browser of its own

Use it to open the contact sheet and to look at a live page and its new page side by side, at
the same width, when a diff image does not explain itself. Never use it instead of the diff: a
page you looked at and liked has not passed anything.

## Present the result

1. **Pass or fail, per template, then per page.** Lead with what still fails and why.
2. **Every override**, with its threshold and reason, read out. An override is a decision a
   person should see.
3. **Every banner closed and every `heightMismatch`**, with the route: each is a place the
   screenshot may not show what a visitor sees.
4. **Proposals**: what you saw that could be better and put in `proposals.json` instead (the
   site's `AGENTS.md`, "Exceptions and proposals", says what an entry holds and how it ships).
5. **Not covered, verbatim**: the list at the end of `references/review-procedure.md`, every
   line, unedited. None of it was compared, an open mobile menu included. Not covered is never
   a pass.

## References

| File | Covers |
|---|---|
| `references/review-procedure.md` | The full loop, writing down differences, fixing, overrides, rollout, proposals |
