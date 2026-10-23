# The process

One site per run. Each phase writes something you can open, and each has a check that says it is
done. The run does not move on until that check passes. The phase, counts, decisions and last gate
results live in `.conversion/state.json` in the site repository, so a run can stop and resume.

| Phase | Produces | Done when |
|---|---|---|
| 1. Intake | Platform fingerprint (at most four requests), tool check, one message of questions with defaults | The person has answered, or the defaults stand |
| 2. Capture | `capture/` | Every URL from sitemaps, platform APIs and the link crawl is saved or recorded with its status |
| 3. Plan | `docs/plan.md` | Every template, count, oddity and out-of-scope feature has a row and a decision |
| 4. Scaffold | The site repository on `astro-rebuild` | It builds empty, and the hosting config is generated |
| 5. Baseline | `baseline/*.json` | Every gate can run without the live site |
| 6. Build | Layouts, pages, CSS, media, forms, scripts | `npm run build` passes |
| 7. Gates | Gate output | `npm run verify` exits 0 |
| 8. Visual review | Screenshots, diffs, style report, contact sheet | Every template passes at 390, 768 and 1440; every page at 390 and 1440 |
| 9. Components (optional) | Astro components for repeated blocks | Gates and visual review still pass, in a separate commit |
| 10. Pre-launch and staging | `pre-launch` report, staging deploy, `launch-audit` report | `pre-launch` exits 0; every audit blocker is fixed or listed |
| 11. Suggestions | `docs/suggestions.md` | Every finding has evidence, effort and risk |
| 12. PR and runbook | The pull request, `docs/LAUNCH.md` | The PR quotes the gate output and every "Not covered" section |
| 13. Launch | The site on its domain | The person launches; `post-launch` checks the cutover and watches 30 days |

## 1. Intake

At most four requests to the live site (the home page, robots.txt and the sitemaps found there)
identify the platform. `preflight.mjs` reports Node, git, gh, the hosting CLI, the Playwright browser and which
CLIs are logged in. Then one message asks for anything the agent could not detect: where the new
repository lives, Vercel or Cloudflare Pages, the form endpoint, the address for the one test
submission, analytics IDs, pages that must not change. Each question has a default. Out-of-scope
features (search, comments, store, logins) are named here with the options. There is no second
stop; anything that later needs an account the agent does not have goes into the runbook.

## 2. Capture

A paced crawl, by default 400 ms between request starts with up to four in flight per host
(`--polite`: one at a time, 2.5 s apart), with a normal browser user agent. A 429 or 503 doubles
the delay and drops the host to one request at a time; it stops after three consecutive blocks,
saving its state so it resumes. The page
set is the union of sitemaps, the platform API (WordPress REST when present) and the link crawl;
legacy URLs from the Wayback Machine are added and marked unverified. For every page it saves the
raw HTML, the visible main text and an inventory: title, description, robots, canonical, hreflang,
Open Graph, JSON-LD types, headings, dates, forms, iframes, third-party scripts, links and images.
It records every redirect hop as the server sends it, the media set with sizes, fonts, feeds, the
404 page, favicons, one screenshot per template at three widths, and CSS coverage per page.
`capture/` is committed (minus screenshots and oversized media) and never edited afterwards.

## 3. Plan

`docs/plan.md`: templates and page counts, the media decision with its numbers, the redirect
source, the forms plan, the third-party scripts and whether each is kept, the out-of-scope features,
and a decisions table. Every oddity on the live site (a missing H1, a dead tag, a broken link) gets
a row that says "reproduce live by default" and what the fix would be.

Media stays in the repository when the total is under 300 MB, no file is over 25 MB and there are
fewer than 10,000 files. Otherwise it goes to Vercel Blob (behind a `vercel.json` rewrite) or
Cloudflare R2 (served by a small Pages Function), so the public URLs do not change. See [hosting.md](hosting.md).

## 4. Scaffold

`init-site.mjs` creates the site repository: Astro with static output and no adapter,
`trailingSlash` and the build format matching the majority of live URLs, `.nvmrc`, the gate and
review scripts, hosting config (`vercel.json`, or `_redirects` and `_headers`), and the
`PUBLIC_INDEXABLE` switch. Every build is `noindex, nofollow` with a blocking robots.txt until a
release build sets `PUBLIC_INDEXABLE=true`. Apart from the scaffold commit that init-site makes on
a new or empty repository, nothing is committed to `main`; all work goes on `astro-rebuild` and
reaches `main` through a pull request the person merges.

## 5. Baseline

`baseline/routes.json`, `seo.json`, `redirects.json` and `media.json` are derived from the capture.
Every gate reads these, never the live site, so the site can still be verified after the old host
is switched off.

## 6. Build

Layouts and the shared header, navigation and footer first, then pages from the captured markup.
Content is moved, not retyped. The captured CSS is the stylesheet, pruned of rules no page used at
any width (with a report of what was removed). Fonts are self-hosted at the same families and
weights. Media keeps its original paths. Forms post to the chosen endpoint with the same field
names, honeypot and thank-you URL. Third-party scripts are carried over from an allowlist in
`docs/third-party.md`, each with its source page and a keep or drop decision. Redirects are
compiled from one `redirects.csv` into the host's format.

## 7. Gates

`npm run verify` checks the build against the baseline: every captured URL builds and nothing
extra does; every redirect resolves in one hop to the same target; title, description, canonical,
robots, Open Graph, JSON-LD types and hreflang per page; visible text identical after whitespace
normalisation; every internal link resolves; every media URL serves with the same type and size;
sitemap and feeds; form fields, action and method; third-party scripts match the allowlist.
A deliberate difference is an entry in `exceptions.json` with a reason. Improvements are proposals
that ship only in a `PROPOSALS=on` build. No flag turns a failure into a warning.

## 8. Visual review

One page per template, live and new, at 390, 768 and 1440 px, with animations off and scroll
reveals forced visible. A pair passes at 0.5 % differing pixels or fewer (pixelmatch threshold 0.1,
anti-aliasing ignored). A computed-style check compares headings, paragraphs, links, buttons,
navigation and inputs: family, size, weight, line height, letter spacing, colours, margins and
padding. The contact sheet shows live, new and diff side by side. The agent fixes and re-runs until
every pair passes, then diffs every page at 390 and 1440.

## 9. Optional component pass

Off by default. Repeated blocks (cards, calls to action, testimonials, galleries) become Astro
components with scoped styles. The text and pixel gates prove nothing moved. It is one separate
commit, so it can be dropped.

## 10. Pre-launch and staging

`pre-launch` gates the repository and the production build and must exit 0. The branch is deployed
as a noindexed preview, and `launch-audit --url <staging> --staging --old-url <live>` audits it. Blockers are fixed
on the branch. The audit's `baseline.json` and `redirects.csv` are kept for the cutover. One test
form submission goes to the address given at intake.

## 11. Suggestions

`docs/suggestions.md` collects what the run found but did not change: broken links, missing alt
text, duplicate titles, thin or orphaned pages, redirect chains, oversized images, missing H1s,
accessibility failures, dead analytics tags, mobile overflow, inconsistencies seen in the visual
review. Each has where, evidence, why it matters, effort, risk to parity, and whether the kit can
apply it on request.

## 12. PR and runbook

One pull request from `astro-rebuild` to `main`: what was converted, the counts, exceptions,
open proposals, gate output, the staging URL, the contact sheet, the suggestions summary, and the
`pre-launch` and `launch-audit` "Not covered" sections quoted in full. `docs/LAUNCH.md` lists what
the person does, in order, with the commands for their host.

## 13. Launch

The person merges, sets the indexable switch for production, adds the domain, lowers the DNS TTL,
and moves the records. `post-launch --mode cutover` verifies DNS, the certificate, the http and
www redirects, robots, the sitemap, every mapped redirect, forms, analytics and headers, then
diffs production against the staging baseline. The watch runs for 30 days. The kit never touches
DNS or the old host.
