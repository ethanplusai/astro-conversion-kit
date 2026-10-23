---
name: convert-site
description: Convert a live website (WordPress first; Drupal, Webflow, Squarespace, Wix and static sites too) into a static Astro site with the same URLs, content, head tags, media, redirects and look, proven by parity gates and a pixel-level visual review, ending in one pull request, a noindexed staging deploy and a launch runbook. Use when asked to convert, rebuild, migrate or clone a site to Astro, when handed a site URL with this kit's link, to resume a conversion from .conversion/state.json, or with --apply <id> to apply one suggestion as a proposal.
---

# convert-site

The orchestrator. It asks one message of questions, then runs every other skill in order without
stopping again, and ends with a pull request the person merges and a runbook they launch from.

## The golden rules

1. **One intake message, then no stops.** Every question carries a default. Anything that later
   needs an account, a login or a token you do not have goes on the "needs you" list
   (`state.needsYou` and `docs/LAUNCH.md` section A) and the run carries on.
2. **The live site is read-only.** Only these read it, paced: the capture scripts, `shoot.mjs`
   and `styles.mjs` on live, `css-coverage.mjs`, `launch-audit --old-url` and `pre-launch
   --predecessor-url`. Analytics are blocked on their live page loads, so no visit is counted.
   Never submit a form on it, log in, or fetch a page by hand to fill a gap.
3. **The default build equals live, faults included.** Content is moved from captured markup,
   never retyped or tidied. Every oddity is a decision row that says "reproduce live by default".
   A forced difference is an exception; an improvement is a proposal (`PROPOSALS=on` only).
4. **Gates on every commit, never softened.** Never edit `baseline/` to pass (only the `keep`
   flags in `baseline/scripts.json`). A skip is not a pass; "Not covered" is never a pass.
5. **`main` gets the scaffold commit and nothing else.** On a new, empty repository init-site
   makes one commit on `main`, the exception to "never commit to main": the PR needs a base.
   Everything after it is on `astro-rebuild`, one PR. Never force-push, never merge, never
   touch DNS, the old host or a dashboard setting.
6. **No secrets in chat or in the repository.** Never ask the person to paste a token.
   Credentials come from the environment or a CLI's own login.

## Names used below

`KIT` is the absolute path of this kit (the folder holding `skills/` and `package.json`).
`LIVE` is the live origin. `SITE` is the absolute path of the new site repository (default
`<current folder>/<slug>`); the capture and the run state are written into it from the start,
and `init-site.mjs` scaffolds around them. Run every command from `SITE`. Every script prints
`--help`; run that rather than reading the source. Every Node command in a fresh shell starts
with `source ~/.nvm/nvm.sh && nvm use 22.23.4` (or runs in a shell that reads `.nvmrc`).

## Step 0a: a kit that can run

The scripts import `parse5`, `playwright` and the rest from the kit's `node_modules`. If
`$KIT/package.json` or `$KIT/node_modules` is missing (an install that copied only the skill
folders has neither), clone the kit and install it, then use the clone as `KIT`:

    git clone https://github.com/ethanplusai/astro-conversion-kit <folder>/astro-conversion-kit
    npm install --prefix <folder>/astro-conversion-kit

## Step 0: preflight and fingerprint (before the intake message)

    node $KIT/skills/convert-site/scripts/preflight.mjs --json
    node $KIT/skills/capture-site/scripts/fingerprint.mjs $LIVE

Install what is missing that you can install yourself, without asking: `npx playwright install
chromium` when `playwright.chromium` is false; `vercel` and `wrangler` run through `npx`. A CLI
that is present but not logged in is the person's to log in: name the command (`gh auth login`,
`npx vercel login`, `npx wrangler login`) in the intake message and check again at the scaffold.

`experience` sets how you talk, not what you do. `new`: one plain sentence per phase on what it
does and why, every term explained once, installs done silently. `some`: one line per phase.
`experienced`: commands and results only. A Shopify fingerprint is a store: stop and say so.

## Step 1: intake (the one message)

Send `references/intake.md`'s template, filled in with what preflight and the fingerprint found:
every question with its default, and the "what is missing and what happens" list. If the person
does not answer, the defaults stand. Never send a second question message.

## The phases

The order is `docs/process.md`'s; `references/phases.md` has every command and each proof. At
each boundary run `node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE phase <name>`; do
not start a phase until the previous one's proof holds. Run `state.mjs` calls one at a time, never
chained with `&&`: each rewrites `state.json`, and a chain failing partway leaves it out of step.

| # | Phase (`<name>`) | What happens | Done when |
|---|---|---|---|
| 1 | `intake` | Preflight, fingerprint, the one message | Answered, or defaults stand |
| 2 | `capture` | `capture-site` into `$SITE/capture/`, CSS coverage | Every URL saved or recorded with its status; Notes written |
| 3 | `plan` | Decide hosting, URL form, media mode, templates; decisions in state; drafts under `.conversion/` | Every template, count, oddity and out-of-scope feature has a decision |
| 4 | `scaffold` | Repo, `init-site.mjs` around the capture, then `docs/plan.md` and `docs/media-plan.json` | It builds empty; `main` holds the one scaffold commit |
| 5 | `baseline` | `npm run baseline` (`templates.json` already exists) | `build-baseline.mjs --check` exits 0 |
| 6 | `build` | Layouts and shared parts, one page per template, design lock on the templates, then every page | `npm run build` passes; template gates pass path by path |
| 7 | `gates` | The full gates | `npm run verify` exits 0 |
| 8 | `visual` | Every template at 390, 768, 1440; every page at 390 and 1440 | Every pair passes |
| 9 | `components` | Optional, off by default (`references/components-optional.md`) | Gates and diffs still pass, one separate commit |
| 10 | `prelaunch` | `pre-launch`, staging deploy, `verify-live`, `launch-audit`, one test submission | `prelaunch-reconcile.mjs` exits 0 (`references/phases.md` §10); audit blockers fixed or listed |
| 11 | `suggestions` | `suggest-improvements` with `gates.json` and `review/` | `docs/suggestions.md` with its "From the review" section |
| 12 | `pr` | Runbook, push, PR, final report | The PR quotes gate output and every "Not covered" section |
| 13 | launch | The person's, from `docs/LAUNCH.md` | `post-launch` checks the cutover and watches 30 days |

The skills each phase uses, with their own rules: `capture-site` (2), `parity-gates` (5 to 7),
`visual-review` (6, 8), `pre-launch` and `launch-audit` (10), `suggest-improvements` (11),
`post-launch` (in the runbook). Read each skill's SKILL.md before its phase.

## The build, in one paragraph

`references/build-rules.md` is binding. Layouts and the shared header, navigation and footer are
always components; content blocks are the captured markup, moved by a script. Media at its
original paths, fonts self-hosted, CSS by coverage pruning (`css-coverage.mjs` then
`css-prune.mjs`), never a rewrite. Forms per `references/forms.md`, third-party scripts per
`references/third-party.md`. `redirects.csv` is the single redirect source: a new redirect is a
row whose `source` is `decision` and whose `note` names the decision id, then `npm run
redirects:build`; never hand-edit the generated rules. One commit per template (`feat:
<template> template`, once its path-scoped gates pass), never one for the whole build. The
design is locked on the templates (visual-review) before the rollout to every page. With
subagents, one implementer per template or gate fix, never two on one file; each brief carries
absolute paths and `build-rules.md`, and you review their commits before the next phase.

## Decisions, exceptions, proposals

This section is the rule; the references link here.

- **Decision.** Anything the live site does oddly, and every default you apply, gets
  `state.mjs decision '{"topic":…,"choice":…,"default":…,"reason":…,"costIfWrong":…}'`, which
  prints its id (`d1`, `d2`, …). The one ledger is the Decisions table in `docs/plan.md`: id,
  date, topic, choice, default, reason, cost if wrong. Before the scaffold the decisions live in
  `.conversion/state.json`; the plan table is written from them right after `init-site`. The
  default is always "reproduce live".
- **Exception** (`exceptions.json`, `{ path, field, from, to, reason, approvedBy, date }`): a
  difference the static build cannot avoid; the gates substitute `to` for `from` for that one
  field on that one path. `approvedBy` is `"default, <decision id>"` until a person signs it off
  in the PR. Forms and scripts are not exception fields (they have their own flags). `routes`
  is: a route the capture could not read: `from` is its status as a string, `to` is `"skip"` or
  the built replacement path.
- **Proposal** (`proposals.json`, the same shape plus `id`, the decision id, and
  `approvedBy: "proposed"`; several records may share one id): an improvement. Code switches it
  with `proposalOn(id)`; it ships only in a `PROPOSALS=on` build, gated by `npm run
  verify:proposals`. When a person approves it, the records move to `exceptions.json` with their
  name in `approvedBy`.

## Hosting

Vercel by default, Cloudflare Pages on request: `references/hosting-vercel.md` and
`references/hosting-cloudflare.md`. Every page carries `noindex` unless the production build sets
`PUBLIC_INDEXABLE=true`. Media is `repo`, `store` (`media-upload.mjs`) or `live-temporary`
(staging only; gone before DNS moves), as `media-plan.mjs` decides (`references/phases.md` §3).

## The one message after the plan

After phase 3, send one short status (not a question): platform, page and template counts, the
media decision, out-of-scope features and the options, the decisions taken by default, and the
needs-you list so far. It is required in a non-interactive run too (standing answers, nobody
replying): progress lines do not replace it. Then carry on without waiting.

## The pull request (phase 12)

Push `astro-rebuild` (`main` was pushed at the scaffold), then `gh pr create --base main --head
astro-rebuild --title "Astro rebuild of <host>" --body-file .conversion/pr-body.md`. While
`pre-launch` fails `placeholders.form-id` (no form id yet), add `--draft`, and the final report
names that as the blocker. Without a `gh` login, the body stays in that file and "push and open
the PR" goes on the needs-you list. The body, in this order:

    ## What changed       one paragraph: platform, what was converted, host, media mode
    ## Counts             pages, templates, redirects, media files and size, forms, vendors kept/dropped
    ## Exceptions applied every exceptions.json entry: path, field, reason, decision id
    ## Proposals open     every proposals.json id: paths, what, why (ships only with PROPOSALS=on)
    ## Decisions          the docs/plan.md Decisions table, and every non-default choice
    ## Gate output        `npm run verify` output, verbatim, in a code block, with every skip line;
                          then every row prelaunch-reconcile accepted, as "reproduced from live (dN)"
    ## Visual review      `npm run review:check` output, every docs/visual-overrides.json entry
                          (route, id, threshold, reason), every bannerClosed and heightMismatch; the contact sheets are
                          review/index.html and review/all.html (local; npm run review:sheet)
    ## Staging            the staging URL, verify-live result, the launch-audit blockers and their state
    ## Suggestions        counts per category, the medium and high risk items, the applyable ids
    ## Not covered        pre-launch's and launch-audit's "Not covered" sections, verbatim, each
                          under its own heading; then capture-site's, visual-review's and suggestions'
    ## Waiting on you     every state.needsYou item, in runbook order

## The final report (to the person)

Lead with the PR link (and "draft: waiting on the form id" when it is one), then: what was
converted (counts), gates and visual review in one line each, the staging URL, the needs-you list
under **Waiting on you** read from `state.mjs --dir $SITE get needsYou` (each item with the exact
command or click, in runbook order), then every "Not covered" section verbatim. Say "PR open,
waiting on your merge", never "done" or "live". Stop any review server you started
(`npm run review:serve -- --stop`, and `npx astro preview stop` if you used the preview), then stop.

## Resuming

In a new session, read `node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE get` and
continue from `phase`: rerun that phase's proof first; if it holds, start the next phase. The
capture resumes with `--resume`. Never repeat the intake. Applying a suggestion later is
`convert-site --apply <id>` (`references/apply-suggestion.md`), never part of the run itself.

## References

| File | Covers |
|---|---|
| `references/intake.md` | The one message: questions, defaults, what is missing and what happens |
| `references/phases.md` | Every phase: exact commands, the proof it is done, what to record |
| `references/build-rules.md` | How layouts, content, CSS, media, fonts, lazy images and redirects are built |
| `references/forms.md` | Formspree wiring, field names, honeypot, thank-you, the form id, the one test submission |
| `references/third-party.md` | The `keep` allowlist in `baseline/scripts.json` and `docs/third-party.md` |
| `references/hosting-vercel.md` | Project, public noindexed staging, indexing, Blob media, opt-in protection |
| `references/hosting-cloudflare.md` | Pages project, `_redirects`, `_headers`, R2 media function, query redirects |
| `references/runbook.md` | `docs/LAUNCH.md`: A needs you, B closeout, C launch day, D 30-day watch |
| `references/components-optional.md` | The optional component pass |
| `references/apply-suggestion.md` | `--apply <id>`: proposal records, branch commit, gates, sheet |
