# The runbook: docs/LAUNCH.md

The scaffold writes `docs/LAUNCH.md` with four sections, every command complete with its
arguments. In phase 12 (`pr`) you fill it for this run: the `STAGING_URL` line, `FORM_ENDPOINT`
once the form id is known, and every line concrete (the real host, project, counts, commands and
URLs), in the order a person does them. It is the person's document; you never tick a box in it on their behalf.

## A. Needs you

Everything only a person with the accounts can do, from `state.needsYou`, in the order it is
needed, each with the exact command or the exact place to click and what it unblocks. Then the
pre-launch human checklist, one line per id, in its fixed order (never reordered):

    - [ ] forms         every form reaches a person (send the one test, confirm it arrived)
    - [ ] analytics     the production property records a visit and one conversion
    - [ ] hosting       the project, its environment variables, the production branch
    - [ ] payments      (only when the repository uses a payment SDK)
    - [ ] legal         legal pages and contact details are correct
    - [ ] gsc-baseline  the Search Console export, BEFORE DNS moves
    - [ ] dns           the cutover plan written down: apex and www only
    - [ ] signoff       copy and imagery signed off in writing
    - [ ] rollback      the rollback plan named

Each is confirmed by the person with
`node <kit>/skills/pre-launch/scripts/pre-launch.mjs --dir . --predecessor-url <live> --confirm <id>`
after doing it; `--progress` shows where they are. You never run `--confirm`.

Typical run-specific lines (keep the ones that apply):

- "create the store, upload, regenerate rewrites; live-temporary must be gone before DNS moves"
  with the commands from the host file;
- Cloudflare: create one Single Redirect per row of `cloudflare-query-redirects.csv` (n rows);
- Vercel, only when the owner opted in to protecting staging: create the Protection Bypass for
  Automation secret (Settings, Deployment Protection) and put it in the environment as
  `VERCEL_AUTOMATION_BYPASS_SECRET` so `verify-live` can be rerun, or accept the "Not covered"
  gap;
- push the repo and open the PR (when `gh` was not logged in);
- sign off every entry in `exceptions.json`; approve or decline every proposal id (an approved
  proposal's records move to `exceptions.json` with the approver's name);
- the form id, when the PR is still a draft because `placeholders.form-id` fails;
- the out-of-scope features and the option chosen for each.

## B. Closeout (before the merge)

- [ ] `npm run build` then `npm run verify -- --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/`
      passes on `astro-rebuild` (paste the summary line).
- [ ] The visual review passes for templates and every page (`review/all.html`) and
      `npm run review:check` exits 0: 0.5 % or fewer differing pixels per page and width; a
      looser threshold is a `docs/visual-overrides.json` entry with its decision id, at most 2 %.
- [ ] `npm run redirects:build` output committed.
- [ ] Staging: `<staging url>`, noindexed (`npm run verify:live -- --base <staging url> --expect-noindex`).
      Vercel with the default public staging: every staging redeploy is
      `npx vercel deploy --prod --yes --scope <team slug>` from `astro-rebuild`, until launch;
      before the domain is attached (launch day, from `main`) the production alias
      `<project>.vercel.app` is staging. With protection opted in, redeploys stay
      `npx vercel deploy --yes --scope <team slug>` previews.
- [ ] The one test submission sent to the intake address (date), receipt confirmed by the person.
- [ ] `docs/suggestions.md` read; the items wanted are picked for `--apply` after launch.
- [ ] The PR reviewed and merged by the person.

## C. Launch day (in this order)

1. Walk the pre-launch human checklist (section A) to the end with `--confirm`, one item at a
   time; `gsc-baseline` before anything below touches DNS.
2. Media: no `live-temporary` left (`docs/media-plan.json` mode is `repo` or `store`, and the
   media gate passes without skips).
3. Cloudflare only: every Single Redirect from `cloudflare-query-redirects.csv` exists.
4. A day ahead: lower the TTL of the apex and `www` records.
5. `PUBLIC_INDEXABLE=true npm run build` then
   `npm run verify:release -- --endpoint <endpoint> --honeypot _gotcha --thank-you /thank-you/`:
   must exit 0. Then `PUBLIC_INDEXABLE=true node <kit>/skills/pre-launch/scripts/pre-launch.mjs
   --dir . --production-url <live> --predecessor-url <live> --ignore-dir capture --out review/pre-launch`
   and `node <kit>/skills/convert-site/scripts/prelaunch-reconcile.mjs --findings
   review/pre-launch/gate.json --baseline baseline --plan docs/plan.md`, which must exit 0.
   `PUBLIC_INDEXABLE=true` in these commands sets it for that one local command only, never
   the host; the host's switch is step 6.
6. Set the switch for production (Vercel: `npx vercel env add PUBLIC_INDEXABLE production`,
   value `true`; Cloudflare: it is on the local build). With the default public staging there
   is no protection step: go straight to the production deploy. Vercel, only when the owner
   opted in to protecting staging (`publicStaging` `false`): restore the default protection,
   previews only, so the production alias and the domain answer the public: write
   `{"ssoProtection":{"deploymentType":"preview"}}` to a file outside the repository, run
   `npx vercel api /v9/projects/<project> --method PATCH --input <that file> --scope <team slug>`,
   and check `npx vercel api /v9/projects/<project> --scope <team slug>` shows `"preview"`.
   Then deploy production (`npx vercel deploy --prod --scope <team slug>`, or the wrangler
   production deploy).
7. Add the domain to the project, then change the DNS records for the apex and `www` only, to
   what the host shows. Nothing else in the zone changes (mail, verification records stay).
8. When the certificate is issued:
   `node <kit>/skills/post-launch/scripts/post-launch.mjs --mode cutover --url <production url> --baseline docs/launch/audit-baseline.json --redirects docs/launch/audit-redirects.csv --staging-url <staging url> --expect-analytics <measurement id> --expect-dns apex=<ip>,www=<host> --out website-launch/cutover`
   and `npm run verify:live -- --base <production url>`.
9. Submit the sitemap in Search Console. Keep the old host running, untouched, through section D.

## D. 30-day watch

Once a day, days 1 to 30:

    node <kit>/skills/post-launch/scripts/post-launch.mjs --mode watch --url <production url>

It prints what is due that day and reruns the automated checks. On day 1 and day 30 also run
`npm run verify:live -- --base <production url>`; on day 1 read the host's 404 log, add a row to
`redirects.csv` (`source` `decision`) for each missed old URL, run `npm run redirects:build`,
and redeploy. Day 3: forms received and analytics events arriving. Day 7: Search Console
coverage. Day 14: organic traffic against the same period before launch. Day 30: the old host
can be retired by its owner.

Replace `<kit>` with the kit's absolute path in the written runbook, so every command runs as
pasted.
