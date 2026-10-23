# The visual review procedure

The loop is: shoot new, diff, styles, sheet, look and write down every difference, fix, repeat.
Templates first at every width, then every page at 390 and 1440. This file carries the detail
behind each step.

Every command runs from the root of a site made by `convert-site`, whose `package.json` maps
`npm run review:shoot|diff|styles|sheet` to the copies in `scripts/review/`; the data paths
(`capture/`, `review/`) are relative to that root. Outside a converted site, run
`node <skill-dir>/scripts/<name>.mjs <options>` from the folder that holds `capture/` and
`review/`.

**Exit codes in the loop.** Exit 1 from `review:diff` and `review:styles` is expected while
differences remain: it is the measurement, not a crash. Carry on to the sheet. Run each step as
its own command; do not chain them with `&&`, or the sheet is never built when it is needed most.
Exit 2 is a usage or environment problem: fix the command. Exit 3 from `review:shoot` means the
site answered 403, 429, 503 or network errors three times in a row: wait several minutes, then
rerun with a longer `--delay` (for example 5000). Never retry in a tight loop.

## Before the first run

- **Live screenshots already exist.** The capture step ran `shoot.mjs` against the live site into
  `capture/screens/live/` (one `<route>/<width>.png` per route and width, plus `manifest.json`).
  They are the reference for every run. Do not re-shoot the live site to get a better match: the
  live site is read-only and the reference must stay fixed while you work. If a live shot is
  missing or broken (its manifest row has `error`, or `file` is null), re-run that capture step for
  that route, then carry on. The only other live shoot is the one-time full set for rollout
  (step 7), into its own folder.
- **Know the routes.** `--routes` takes a templates file (`[{ name, representative, paths[] }]`,
  from the capture step, e.g. `capture/templates.json`) or a comma list of paths. With a templates
  file the folder is the template name and only the representative path is shot. With a path list,
  or with `--full`, the folder is the path slug (`/` is `home`, `/a/b/` is `a__b`). The new shoot
  must use the same `--routes`, the same `--full` choice and the same widths as the live shoot, or
  the folders will not line up and every row fails as missing.
- **Serve the new site.** For iteration `npm run dev`; for a run whose result you will report,
  `npm run build && npm run review:serve`, because the built output is what ships; it applies
  `vercel.json` (or `dist/_redirects`) like staging does, so media and scripts rewritten to
  another origin load. `npm run preview` only when the site's media is in the repo. Either is a
  local origin such as `http://localhost:4321`.

## 1. Shoot new

    npm run review:shoot -- --base http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/new --delay 0

Options (all from `--help`):

| Option | Default | Meaning |
|---|---|---|
| `--base` | required | Origin to shoot |
| `--routes` | required | Templates file or comma list of paths |
| `--out` | required | Output folder |
| `--widths` | `390,768,1440` | Viewport widths in CSS pixels |
| `--delay` | `500` | Milliseconds between page loads, doubled on 429 or 503; `0` is fine against your own local server only |
| `--wait` | `1500` | Milliseconds to settle before each capture |
| `--full` | off | With a templates file, shoot every path of every template |
| `--scale` | `1` | Device scale factor 0.1 to 1; `0.5` for half-size previews (diff only like with like) |
| `--allow-analytics` | off | Let analytics, tag, pixel and chat hosts load (below) |

Writes `<out>/<route>/<width>.png` and `<out>/manifest.json`, one row per shot:
`{ route, width, file, heightPx, bannerClosed, scrollHeight, heightMismatch }`, plus `error` on a
route that failed (its `file` is null). Exit 0 all shot, 1 a route failed (the rest are still
shot), 2 usage error, 3 stopped after 3 consecutive 403/429/503/network errors.

What it does to every page, on both sides alike, so the two are comparable:

- **Motion frozen.** `prefers-reduced-motion` is set and injected CSS turns off every animation
  and transition.
- **Reveals forced visible.** Common scroll-reveal classes (`.reveal`, `[data-aos]`, `.wow`,
  `.animate__animated`, `.elementor-invisible`) are made visible with no transform, whether or not
  a script ever reveals them. A reveal library using other class names is not covered: if a section
  is blank on one side, that is why.
- **Lazy images loaded by scrolling** to the bottom and back, capped at 60 viewports or 30 s. A
  page that keeps growing hits the cap, and anything below it may be unloaded.
- **Web fonts awaited** before capture.
- **Cookie banners closed** when a button says accept, agree, got it or ok, and reported as
  `bannerClosed`. A banner with other wording stays in the shot.
- **Analytics, tag, pixel and chat hosts blocked** (Google Analytics and Tag Manager, Meta pixel,
  Hotjar, Clarity, HubSpot tracking, Intercom, Drift, LinkedIn insight, TikTok, Pinterest,
  Segment, Mixpanel, Plausible, Fathom, Matomo cloud, Crisp, Tawk, Zendesk), so a screenshot run
  never shows up as visits in the live site's reports and a chat bubble that loads late never
  lands in one shot and not the other. They do not draw the page; `--allow-analytics` lets them
  load when you need to see a widget. HubSpot's form embed (`js.hsforms.net`) is not blocked.
- **Tall pages checked.** A screenshot more than 2 px off the page's `scrollHeight` is flagged
  `heightMismatch` with a warning: the image does not cover the page as it measured
  when shot, often because the page changed height while being captured. Treat that pair's diff with suspicion and say so.

## 2. Diff

    npm run review:diff -- --a capture/screens/live --b review/new --out review/diff

Overrides are read from `docs/visual-overrides.json` when that file exists; there is nothing to
add to the command.

| Option | Default | Meaning |
|---|---|---|
| `--a`, `--b` | required | Screenshot folders (live, new) |
| `--out` | required | Where diff images and `diff.json` go |
| `--threshold` | `0.5` | Pass line in percent of differing pixels |
| `--overrides` | `docs/visual-overrides.json` | Overrides file (below); absent means none, but a file named here must exist |

Every `<route>/<width>.png` in either folder is compared with pixelmatch threshold 0.1 and
anti-aliasing ignored. Output: `review/diff/<route>/<width>.png` (differing pixels in red) and
`review/diff/diff.json`, one row per pair:
`{ route, width, percent, pass, heightA, heightB, heightMismatch, percentUnaligned, offset, threshold, reason, decision }`,
plus `error` when a side is missing or unreadable.

**Height differences are counted, not ignored.** When the two images differ in height, every row
the taller one has and the shorter one lacks counts as differing pixels and is painted red at the
foot of the diff image. A new page that lost its footer fails on those rows alone. `heightMismatch`
is true on such a row, pass or fail; a pass with `heightMismatch` means only a few rows differ,
and is still worth a look.

A pair passes when **both** of these hold:

- `percent` (the extra rows included) is at most the threshold (0.5 % unless overridden);
- the widths are equal.

**The 1 px offset search.** When the aligned comparison fails, the new image is compared again
moved by up to 1 px in each direction (the eight neighbours, overlapping area only) and the lowest
percentage is kept. This absorbs sub-pixel rounding that shifts a layout by one pixel. `offset` is
the `[dx, dy]` used and `percentUnaligned` is the aligned result. Shifts wider than 1 px are never
searched; a 2 px shift is a real difference and fails. A pass with a non-zero `offset` is a pass,
but if `percentUnaligned` is large, mention it: something is consistently one pixel off.

Exit 0 every pair passes, 1 any pair fails (each listed on stdout with its reason), 2 usage error
(including a malformed overrides file).

## 3. Styles

    npm run review:styles -- --live https://www.example.com --new http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/styles.json

| Option | Default | Meaning |
|---|---|---|
| `--live`, `--new` | required | The two origins |
| `--routes` | required | Templates file (its representatives) or comma list of paths |
| `--widths` | `390,1440` | Viewport widths; the default skips 768, so pass `390,768,1440` for the template set |
| `--out` | `styles.json` | Output file; always pass `review/styles.json` |
| `--delay` | `500` | Milliseconds between page loads, both origins |
| `--allow-analytics` | off | Let analytics, tag, pixel and chat hosts load on both origins (blocked by default, as in shoot) |

This step loads the live site, once per route per width. Keep the default delay; never pass
`--delay 0` with a live origin.

On the first match of each sampled selector (`h1`, `h2`, `h3`, `h4`, `p`, `a`, `button`, `.btn`,
`[class*=button]`, `nav a`, `input`, `textarea`, `select`, `blockquote`, `li`, `header`,
`footer`) it compares font-family (first family, case-insensitive), font-size, font-weight,
line-height, letter-spacing (`normal` equals `0px`), color, background-color, text-transform,
margin-top, margin-bottom and the four paddings. Lengths pass within 1 px; colours, weights,
keywords and families must match exactly.

Rows: `{ route, width, selector, property, live, new, pass }`. Two special rows:

- **`present`**: the selector matches on one side only. It fails. Usually a missing element, or an
  element rendered as a different tag.
- **`status`** (selector `document`): the route was not 2xx on the live or the new side. One
  failing row replaces all the others for that route and width. Fix the route before anything
  else.

Exit 0 every row passes, 1 a row fails, 2 usage or environment error.

## 4. Sheet

    npm run review:sheet -- --live capture/screens/live --new review/new --diff review/diff/diff.json --styles review/styles.json --out review/index.html

One self-contained HTML file: per route, a row per width with the live, new and diff images side
by side, the differing-pixel percent, pass or fail, both heights, "banner closed" where a banner
was dismissed, and the failing style rows beneath. Each style row also carries the page `path`
it was sampled on. Every image is embedded as data, so the file
opens anywhere with nothing beside it, and on a big site it can run to tens of megabytes. Leave
`--styles` off if you skipped step 3; the sheet then shows diff rows only. Exit 0 written, 2 usage
or environment error.

The sheet does not show `offset`, `percentUnaligned`, override `reason`, `heightMismatch` or shoot
`error`. Read those from `review/diff/diff.json` and the two `manifest.json` files.

## 5. Look, and write it down

This is the step that cannot be scripted, and the one most often skipped.

Open `review/index.html`. For **every** pair, failing or passing, write down in plain words every
visible difference between live and new, before changing any code. Go top to bottom of the page:
header and navigation, hero, each section, footer. Look at the diff image to find where the red
is, then at live and new to say what it is. One line each, for example:

    services @390: hero heading wraps after "Roofing" on new, after "and" on live
    services @390: card grid gap looks wider on new (red band under each card)
    services @1440: footer logo missing on new
    services @1440: (passes, 0.12 %) nav underline is 1 px lower on new

Keep the list in the working notes for the task. A difference you noticed on a passing pair still
goes on the list: 0.4 % on a narrow page can be a missing button.

Common causes, to point the fix:

| What you see | Usually |
|---|---|
| Whole page red below a point | Something above it changed height: a font, a missing element, margin collapse |
| Text red, layout the same | Font family, weight or rendering; check the `font-family` style row and that the WOFF2 loaded |
| A block blank on one side | A reveal class not in the freeze list, a lazy image past the cap, or a missing asset |
| `heightMismatch`, a red band at the foot | Missing or extra section, or an embed that renders differently statically |
| `present` row fails | An element missing, or marked up as a different tag |
| Banner closed on one side only | The new build kept or dropped the consent banner |

## 6. Fix, then repeat

Fix from `capture/`: copy the markup, CSS and media the live site uses; do not restyle by eye.
Work one difference at a time when they interact (a height change upstream causes everything
below to fail). Then re-shoot new, re-diff, re-run styles, rebuild the sheet, and look again. Never
re-shoot the live side to make a pair pass.

### Overrides

Some pages cannot reach 0.5 % honestly: a rotating testimonial, a live map tile, a date that
changes. Then and only then, record a decision for it (its id, e.g. `d12`, is what the entry
names) and add an entry to `docs/visual-overrides.json`, keyed by the route folder name (the
template name, or the path slug with `--full`). The file is committed with the site, so every
looser threshold is in the pull request for a person to see:

    {
      "home": { "id": "d12", "threshold": 1.5, "reason": "rotating testimonial changes per load" }
    }

All three fields are required, and the threshold is at most **2 %**. An entry without an `id` or
a `reason`, with a non-numeric `threshold`, or with one above 2 makes `review:diff` exit 2. A
difference over 2 % is not something an override can carry: fix it. The decision id, threshold
and reason are copied onto the row in `diff.json` and printed with it. Use the smallest
threshold that covers the cause, and never use an override to hide a difference you could fix.
Report every override.

### "Better" is not parity

Anything you would change deliberately (a typo, misaligned spacing on the live site, a blurry
image you could replace, a contrast you could improve) is a proposal. It goes in `proposals.json`
with what and why, and ships only in a `PROPOSALS=on` build after a person approves it. The
site's `AGENTS.md`, section "Exceptions and proposals", says what an entry holds and how it ships;
follow it rather than inventing a format. The
default build matches the live site, flaws included. If you catch yourself fixing a diff by making
the new page look nicer than the live one, stop: that is a proposal.

## 7. Roll out to every page

Only when every template pair passes at every width (390, 768 and 1440 by default), move to all
pages at 390 and 1440:

1. Live: this needs a live screenshot of every page. If the capture step shot only
   representatives, run the live shoot once more as a capture step, read-only and at the default
   pacing, into its own folder so the template set is kept:

       npm run review:shoot -- --base https://www.example.com --routes capture/templates.json --full --widths 390,1440 --out capture/screens/live-all

2. New, same options against the local origin, into its own folder:

       npm run review:shoot -- --base http://localhost:4321 --routes capture/templates.json --full --widths 390,1440 --out review/new-all --delay 0

3. Diff (overrides in `docs/visual-overrides.json` apply; with `--full` their keys are path
   slugs) and build the sheet:

       npm run review:diff -- --a capture/screens/live-all --b review/new-all --out review/diff-all
       npm run review:sheet -- --live capture/screens/live-all --new review/new-all --diff review/diff-all/diff.json --out review/all.html

4. Open `review/all.html`, look and write down every difference exactly as in step 5, fix,
   reshoot new (step 2 here), and repeat until every page passes.

A failure on one page of a template that passed usually means content the representative did not
have (a long title, a missing image, a table). Fix the template so it handles it; do not special-
case the page.

## 8. Done means

- `npm run review:check` exits 0. It re-reads `review/diff/diff.json`, `review/diff-all/diff.json`
  (when present) and `review/styles.json` and exits 1 when any row fails, when a required file is
  missing or empty, or when a diff row's threshold is above 2 % or above 0.5 % without an
  override's decision id; it prints the worst failing pair. It reads what the last runs wrote, so
  rerun diff and styles after the last fix, then check;
- you have looked at every pair in the final sheet and your written list has no open item that is
  not a recorded override or a proposal;
- every `heightMismatch`, closed banner and override is reported to the person.

## If your agent has a browser of its own

Use it to open `review/index.html`, and to look at a live page and its new page side by side at
the same width when a diff image does not explain itself (hover, a font swap, a sticky header).
It is a pair of eyes, never a substitute for the diff: a page that looks right in a browser has
passed nothing until `review:diff` and `review:styles` say so. Keep its visits to the live site few and
spaced; the live site is read-only.

## Not covered

Say these out loud when you report; none of them were compared, and not covered is never a pass:

- hover, focus and active states, open menus, modals and anything that needs a click (the CSS
  pruning keeps the rules a menu toggle turns on, but no shot shows an open menu: whether the
  mobile menu opens was not compared);
- video, carousels and animations past their first frozen frame;
- widths other than the ones shot, and browsers other than Chromium;
- content below a lazy-scroll cap, and pages flagged `heightMismatch`;
- cookie banners whose button wording was not recognised (they are in both shots, or one);
- the styles comparison samples only the first match of each selector, not every element.
