# Intake: the one message

Send this once, after preflight and the fingerprint, and never send a second question message.
If your environment cannot wait for a reply (a non-interactive run), apply every default and
go. Estimate, roughly, the time the live site is read: the capture and media steps at 0.4 s per
request (1 per page, 1 per referenced media file), and the browser steps at about 2 s per page
load (per page, 2 full-set live shots at 390 and 1440; per coverage page, up to 10 per template,
3 coverage loads; per template, 3 live shots and 3 style loads per review round). 200 pages in 4
templates with 1,000 media files: (200 + 1,000) × 0.4 s + (200 × 2 + 40 × 3 + 4 × 6) × 2 s,
about 26 minutes. With `--polite` (a host with a bot wall) the capture and media part is 2.5 s
per request: about 68 minutes. Say "about": the estimate leaves out the Wayback second pass,
retries and back-off after 429 or 503, assets and fonts, Lighthouse runs, each extra review
round, and the reads of phase 10 (`launch-audit --old-url`, `pre-launch --predecessor-url`).
Fill every `<...>` from what preflight and the fingerprint found; delete a question only when
you already know the answer, and say what you found instead. Ask only what the owner knows:
form counts, analytics ids, media size and server-side features (search, comments, store,
logins) come from the capture in phase 2 and go into the plan and the status message after it,
never into this message. Keep each default exactly as stated, so a person who answers
"go" gets a predictable run. For an `experience: new` person, add one plain sentence under the
opening explaining what a repository, a staging deploy and a pull request are.

## The template

    I'm about to convert <LIVE> (<platform>, found <n sitemap URLs / REST pages>) into a static
    Astro site that matches it: same URLs, content, titles, media and look, proven by checks
    against a saved copy of the live site. The live site is only read, at a pace it can take (it
    slows down by itself if the host pushes back); nothing on it changes. I'll ask everything now and then work through to a pull
    request without stopping. Answer only what you want to change; every line has a default.

    1. Repository. Default: a new private GitHub repo <gh user>/<slug>, in <folder>/<slug>.
       Name another owner (an organisation) or an existing empty repo if you prefer.
       <If gh is not logged in: "Run `gh auth login` in a terminal if you want me to create it;
       otherwise the repo stays on this machine and pushing it is on your list.">
    2. Hosting. Default: Vercel. Or Cloudflare Pages. <Logged in: "You're logged in to <cli>, so
       I'll create a project and a noindexed staging deploy." Not logged in: "Run `npx vercel
       login` (or `npx wrangler login`) if you want a staging deploy; otherwise you get a local
       preview and the deploy is on your list.">
       <Vercel: "Which Vercel team should the project live in? Default: your default team
       (<preflight's vercel.scope>). A personal account is its own team slug, not your
       username." When preflight's `vercel.scope` is null: "Default: none; name the team slug
       from `npx vercel teams ls`, or the deploy goes on your list." And: "Staging stays public
       (noindexed) unless you say otherwise. Protect it behind Vercel Authentication? Default:
       no; anyone with the staging link can open it, and every page tells search engines not to
       index it. Yes: every deployment stays behind Vercel's login, and you create a bypass
       secret so I can check it.">
    3. Domain. Default: <host of LIVE> stays the domain; the new site replaces the old one there
       on launch day (you move DNS, not me).
    4. Forms that send a message (contact, quote). Default: they post to Formspree, with the
       same fields; a search box stays as it is. If you prefer another form service, name it. (I'll ask for the form id when I wire the forms; nothing waits on it.)
       The answer is applied only if the capture finds a form that posts (`method="post"`); if
       it finds none, nothing is rewired and no form item goes on your list.
    5. Test address. One test submission goes to the address you give here, once, from the
       staging copy; never to an address found on the site. Default: none, and no test is sent.
    6. Search Console. Default: you export the current Search Console data before DNS moves (it
       is on your launch list). Say if there is no Search Console property for the site.
    7. Consent and tags I cannot see. Default: every tag the capture finds carries over
       unchanged. Name any consent tool, server-side tag or tag to drop.
    8. Redirects. Default: every redirect the crawl finds. If you have an old .htaccess, a
       redirect plugin export or a list of old URLs, send the file.
    9. Pages that must not change, or must be left out. Default: none; every page converts.
    10. Components. Default: off. Say "components" if you want repeated blocks (cards, calls
        to action) turned into Astro components after everything matches.

    What is missing and what happens:
    <one line per gap, from the list below>

    Reply with any changes, or just "go". Reading the live site takes about <estimate> for <n>
    pages and <m> media files, and after the capture I'll send one status message and keep
    going; I won't ask anything else.

## What is missing and what happens

Include each line that applies, worded for this run. Each becomes a `state.needsYou` item and a
`docs/LAUNCH.md` section A line if it is still missing when the phase that needs it comes.

| Missing | What happens |
|---|---|
| `gh` not logged in | The repo stays local; "create the repo, push `main` and `astro-rebuild`, open the PR from `.conversion/pr-body.md`" goes on your list |
| Hosting CLI not logged in | No staging deploy; `npm run review:serve` locally; the staging audit and `verify-live` are "Not covered"; "deploy staging" goes on your list |
| No form id yet (asked at the forms step, never here; only when the capture found a POST form) | Forms post to `https://formspree.io/f/REPLACE`; `pre-launch` fails on `placeholders.form-id` until you give the id; the PR opens as a draft; "create the form, send me the id" goes on your list |
| No test address | No test submission; the `forms` launch check waits on you |
| No store credentials and media over the limits | Media is served from the live site on staging only (`live-temporary`); "create the store, upload, regenerate rewrites" goes on your list and must be done before DNS moves |
| Vercel protection bypass secret (only when you chose protection) | The project is protected before its first deploy, so `launch-audit` and `verify-live` cannot reach staging and are "Not covered" until you create the Protection Bypass for Automation secret and put it in the environment |
| Cloudflare query redirects (`?p=` shortlinks) | Created by you as Single Redirects from `cloudflare-query-redirects.csv` |
| Search Console access | The baseline export before DNS moves is yours (`gsc-baseline`) |
| DNS access | The cutover is yours; the runbook names the two records to change |

## Recording the answers

Write each answer, or the default that stood, to state before the capture starts. The state
lives in `$SITE/.conversion/` from the start; `init-site.mjs` scaffolds around it later:

    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set site '"<LIVE>"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set hosting '"vercel"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set repo '"<owner>/<slug>"'
    node $KIT/skills/convert-site/scripts/state.mjs --dir $SITE set intake '{"forms":{"service":"formspree"},"testAddress":"you@example.com","domain":"<host>","vercelScope":"<team slug>","publicStaging":true,"consent":[],"keepPages":[],"components":false}'

`intake.vercelScope` is preflight's `vercel.scope` (the default team's slug) unless the person
named another team slug; never the username, which the CLI refuses ("You cannot set your
Personal Account as the scope"), and never a team you picked yourself. With no scope from
either, it is `null` and the link goes on the needs-you list. `publicStaging` is the staging-protection
answer: `true` (public and noindexed, the default) unless the person asked for protection, then
`false`. Record it as a decision too (topic "staging protection"), so `docs/plan.md` and the PR
show it.

Every default you applied is also a decision (`state.mjs decision`), so the PR shows it. Add each
missing item to `needsYou` as `{ "item": "...", "command": "...", "before": "<phase or DNS>" }`:
read the array with `state.mjs get needsYou`, append, and write it back with `set needsYou`.

## Exceptions and proposals, said once

For `new` and `some` people, add one sentence each to the message: the default build copies the
live site exactly, faults included; a difference the static build cannot avoid is an exception
they sign off in the PR; an improvement is a proposal that ships only when they approve it. The
rule itself is in SKILL.md, "Decisions, exceptions, proposals".
