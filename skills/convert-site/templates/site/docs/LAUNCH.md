# Launch: {{SITE_NAME}}

Live site: {{ORIGIN}} ({{HOST}}). Host: {{HOSTING}}. Scaffolded {{DATE}}.

Every command runs from the repository root, as written. Set these two once per terminal (the
conversion fills in the staging URL; the form endpoint keeps the placeholder until the form id
arrives):

    export STAGING_URL=""
    export FORM_ENDPOINT="https://formspree.io/f/REPLACE"

## A. Needs you

Things only a person with the accounts can do. Tick each one.

- [ ] Access to the domain's DNS for {{HOST}}.
- [ ] A {{HOSTING}} project connected to this repository.
- [ ] The form id (`FORM_ENDPOINT` above) and the inbox it delivers to. The one test submission
      goes only to the address given at intake, never to one found on the site.
- [ ] Analytics and tag manager access, so the same IDs carry over (see `docs/third-party.md`).
- [ ] Sign-off on every entry in `exceptions.json` and every proposal in `proposals.json`.
- [ ] Search console access for {{HOST}}.

## B. Closeout

- [ ] `npm run build`, then
      `npm run verify -- --endpoint "$FORM_ENDPOINT" --honeypot _gotcha --thank-you /thank-you/ --allow-extra /thank-you/`
      passes on `astro-rebuild` (drop `--allow-extra /thank-you/` when live already had that page).
- [ ] Visual review, on the machine that ran the conversion: `capture/screens/` and `review/`
      are not committed, so a fresh clone cannot run it; there, read the `npm run review:check`
      output quoted in the pull request instead. With `npm run review:serve` running in a second terminal,
      `npm run review:shoot -- --base http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/new`,
      then `npm run review:diff -- --a capture/screens/live --b review/new --out review/diff`
      exits 0,
      `npm run review:styles -- --live {{ORIGIN}} --new http://localhost:4321 --routes capture/templates.json --widths 390,768,1440 --out review/styles.json`
      (it reads the live site, paced),
      `npm run review:sheet -- --live capture/screens/live --new review/new --diff review/diff/diff.json --styles review/styles.json --out review/index.html`
      for a look, and `npm run review:check` exits 0. Every page and width passes at
      0.5 % or fewer differing pixels; a looser threshold for a route is an entry in the committed
      `docs/visual-overrides.json` (`{ "<route>": { "id": "<decision id>", "threshold": <at most 2>, "reason": "…" } }`)
      and needs a decision row in `docs/plan.md` with that id.
- [ ] `npm run redirects:build` run and the output committed.
- [ ] Preview deployment: `{{DEPLOY_PREVIEW}}`
- [ ] Preview is noindex: `npm run verify:live -- --base "$STAGING_URL" --expect-noindex` exits 0.
- [ ] The one test submission on the preview reached the intake address.
- [ ] Pull request from `astro-rebuild` to `main` reviewed and merged by a person.

## C. Launch day

1. Set `PUBLIC_INDEXABLE=true` for production builds only: {{ENV_COMMAND}}
2. `PUBLIC_INDEXABLE=true npm run build`, then
   `npm run verify:release -- --endpoint "$FORM_ENDPOINT" --honeypot _gotcha --thank-you /thank-you/ --allow-extra /thank-you/`
   locally; it must exit 0.
3. Deploy production: `{{DEPLOY_PRODUCTION}}`
4. Point DNS for {{HOST}} at {{HOSTING}}: {{DNS_NOTE}}
5. Once the certificate is issued: `npm run verify:live -- --base {{ORIGIN}}`.
6. Submit `{{SITEMAP_URL}}` in search console.
7. Keep the old host running, untouched, until section D is done.

## D. 30-day watch

- [ ] Day 1: `npm run verify:live -- --base {{ORIGIN}}`; check the host's 404 log for missed
      redirects; add rows to `redirects.csv`, run `npm run redirects:build` and redeploy.
- [ ] Day 3: forms received, analytics events arriving.
- [ ] Day 7: search console coverage and crawl errors.
- [ ] Day 14: compare organic traffic with the same period before launch.
- [ ] Day 30: final `npm run verify:live -- --base {{ORIGIN}}`; then the old host can be retired
      by its owner.
