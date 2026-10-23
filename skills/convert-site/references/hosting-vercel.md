# Hosting on Vercel

The default host. The site is a static project with no adapter; `vercel.json` carries the headers,
the URL mode, the redirects (from `redirects.csv`) and, when media is not in the repo, one rewrite.
The kit's `docs/hosting.md` explains the background; this file is what you run.

You create and link the project, protect it before its first deploy and deploy staging. You
never change any other project setting, never add a domain, and never set an environment
variable other than the one the runbook names for launch day.

## Project and staging deploy (phase 10, prelaunch)

Only when `preflight.mjs` reports `vercel.loggedIn: true`. From `SITE`, in this order, with
`<scope>` the team slug from the intake (`S get intake.vercelScope`) and `<body>` the
protection file below:

    npx vercel link --yes --project <slug> --scope <scope>
    npx vercel api /v9/projects/<slug> --method PATCH --input <body> --scope <scope>
    npx vercel api /v9/projects/<slug> --scope <scope>
    npx vercel deploy --yes --scope <scope>

**Scope.** The CLI runs non-interactively for an agent: `link` without `--scope` exits 1 with a
JSON `missing_scope` answer and creates nothing, and it never picks a team for you. The scope is
`intake.vercelScope`: preflight's `vercel.scope` (the default team's slug, read with `vercel
teams ls --json` and the user's `defaultTeamId`) unless the person named another. A personal
account's scope is its own team slug (for example `<name>s-projects-xxxx`), never the username:
`--scope <username>` is rejected ("You cannot set your Personal Account as the scope"). When
`intake.vercelScope` is null, do not link; the link is a needs-you line.

**Link.** `link --yes` creates the project when it does not exist, writes `.vercel/`, connects
the GitHub repository from the local git remote (production branch `main`, so the person's merge
deploys production from Git) and writes `.env.local` holding a `VERCEL_OIDC_TOKEN`. The scaffold's
`.gitignore` already lists `.vercel` and `.env*`; check `git status --short` is clean afterwards.
`vercel git connect` is not needed after `link`. Only when `link` reports no Git connection, run
`npx vercel git connect <repo url> --yes` (without `--yes` it prints a y/N prompt and exits 0
having done nothing).

**Protection, before the first deploy.** The first deploy of a new project is a production
deploy, aliased to `<slug>.vercel.app`, and the default protection covers previews and
deployment URLs, not that alias: left alone, the alias is public. So the intake asks whether
staging may be public before launch (`S get intake.publicStaging`, default `false`). Write the
body to a file outside the repository (for example `$TMPDIR/vercel-protection.json`):

| `publicStaging` | `<body>` | The GET must show | Then |
|---|---|---|---|
| `false` (default) | `{"ssoProtection":{"deploymentType":"all"}}` | `"ssoProtection": {"deploymentType": "all"}` | every deployment, the alias included, is protected; `verify-live` needs the bypass secret (Deployment protection, below) |
| `true` | `{"ssoProtection":null}` | `"ssoProtection": null` | Vercel Authentication is off; `verify-live` and the audit run without `--bypass`; pages still carry the staging noindex and previews send `X-Robots-Tag: noindex` |

If the PATCH fails or the GET shows another value, do not deploy; the needs-you line is "set
Deployment Protection on the project (Settings, Deployment Protection, Vercel Authentication:
All Deployments, or off when staging may be public), then `npx vercel deploy --yes --scope
<scope>`". This is the one project setting you change, on the project you just created; in the
`false` case launch day sets it back to the default (runbook).

**Deploy.** `vercel deploy --yes` ends with a JSON block: read `deployment.url` (the staging URL)
and `deployment.target` from it rather than the text above it. `target` is `"production"` on the
first deploy of a new project and `null` (a preview) after that; with `deploymentType` `"all"`
both are protected. Never pass `--prod`. Record the URL: `S set staging '"<url>"'`. Staging builds
without `PUBLIC_INDEXABLE`, so every page is noindexed whatever the target.

**Upload.** The CLI does not read `.gitignore`: it uploads everything except `.vercelignore`'s
paths (and `node_modules`, `.git`, `.vercel`, `.env.local`). The scaffold's `.vercelignore` lists
`/dist/`, `/.conversion/` (run state and the media download), `/review/` and the ignored
`/capture/screens/` and `/capture/lighthouse-live/`; `capture/` itself is uploaded, because the
remote build reads it.

**Node.** The deploy warns that `engines` `>=22.23.4 <23 || >=24.22.1` lets Vercel move the build
to the next Node major on its own; that is expected, and a build that breaks on a new major is
fixed by pinning the range.

When a step fails, record its needs-you line and go on as the next paragraph says for the
steps after it:

- `link` fails (no access to the scope): "`npx vercel teams ls`, then
  `npx vercel link --yes --project <slug> --scope <scope>`, the protection PATCH and
  `npx vercel deploy --yes --scope <scope>`"; no deploy.
- The repository is not connected (no remote yet, or the Vercel GitHub app cannot see it):
  "connect the Vercel project to <owner>/<slug>: `npx vercel git connect <repo url> --yes`, or
  Project Settings, Git, in the dashboard"; the staging deploy still runs from the CLI.

Not logged in, or no deploy: `npm run build` and `npm run preview` locally, the staging audit
and `verify-live` go under "Not covered", and "log in (`npx vercel login`), then
`npx vercel link --yes --project <slug> --scope <scope>`, the protection PATCH and
`npx vercel deploy --yes --scope <scope>`" goes on the needs-you list.

## Indexing

Staging builds leave `PUBLIC_INDEXABLE` unset, so `Base.astro` puts `noindex, nofollow` on every
page and robots.txt blocks everything. Vercel adds an `X-Robots-Tag: noindex` header to preview
and deployment URLs itself (on the protection redirect too), so nothing is added to `vercel.json`
for staging. The production alias `<slug>.vercel.app` gets no such header; there the pages'
`noindex` and the blocking robots.txt do the work. Production is the build with `PUBLIC_INDEXABLE=true`, set for the Production
environment only, on launch day, by the person: `npx vercel env add PUBLIC_INDEXABLE production`
with the value `true`. Never for Preview.

## Redirects

`npm run redirects:build` writes the `redirects` array of `vercel.json` (with explicit
`statusCode`, never `permanent`, and the slash rules last). More than about 1,800 routes warns:
Vercel's limit is 2,048 rules across redirects, rewrites and headers; beyond it, the runbook
points the person to the project's bulk redirects.

## Media outside the repo

**Store (Blob).** The uploader needs a public store and its static read-write token. The CLI has
no `blob store add`; when there is no token yet, the person makes both (a needs-you item):

    npx vercel blob create-store <slug>-media --access public --scope <scope>
    npx vercel storage connect <store id> --project <slug> -e development --auth token --add-rw-token --scope <scope> --yes

`create-store` prints the store id (`store_...`) and gives no token; `storage connect` with
`--auth token --add-rw-token` adds `BLOB_READ_WRITE_TOKEN` to the project's Development
environment (the default, `--auth oidc`, writes no static token); `--yes` answers its
confirmation prompt, which otherwise waits forever in a non-interactive shell. Run `create-store` outside a
linked directory, or it connects the store to that project for every environment. The token's
value does not start with `vercel_blob_rw_` (what `vercel env ls` shows begins `eyJ`), so never
rely on a prefix to spot or redact it. It never goes in chat or in a file in the repo.

Upload with the token only in the uploader's environment. `npx vercel env run -e development --
<cmd>` reads the child's flags as its own, even after `--`, so give it a flagless wrapper: a
script outside the repository (for example `$TMPDIR/upload-media.sh`) holding the full command

    node $KIT/skills/convert-site/scripts/media-upload.mjs --store blob --dir .conversion/media-cache --manifest media-manifest.json --prefix /wp-content/uploads/ --media capture/media.json

then, from `SITE`, `npx vercel env run --environment development -- $TMPDIR/upload-media.sh`.
When the token is already in your shell's environment, run the command directly. A large
library (thousands of files) goes faster with `--concurrency 8` (default 1, at most 32); the
store's 429 answers are retried. Rerun until
it exits 0 (it resumes: a rerun with the same manifest skips what is uploaded). Commit
`media-manifest.json`. `.conversion/media-cache/` is the capture's download, on the machine that
ran the capture; it stays out of git. Then write the rewrite, with the store origin taken from
any `url` in the manifest:

    node --input-type=module -e "import { rewriteConfig } from '$KIT/skills/convert-site/scripts/media-plan.mjs'; console.log(JSON.stringify(rewriteConfig('store', '<store origin>', '/wp-content/uploads/', { store: 'blob' })))"

and add the printed object to `vercel.json` `"rewrites"`. The media gate reads the manifest in
`store` mode; `verify:live` takes `--media-manifest media-manifest.json`.

**Live-temporary.** No token: the plan says `live-temporary`, and the rewrite points at the live
site (staging only):

    node --input-type=module -e "import { rewriteConfig } from '$KIT/skills/convert-site/scripts/media-plan.mjs'; console.log(JSON.stringify(rewriteConfig('live-temporary', '$LIVE', '/wp-content/uploads/')))"

The media gate counts every file as skipped (not a pass). The needs-you item: create the store
and its token with the two commands above, run the upload above, rerun `media-plan.mjs` without
`--mode` (`--out docs/media-plan.json`), replace the rewrite with the store one, and rerun the
gates. Live-temporary must be gone before DNS moves: when the old host goes, the media goes with
it.

In both modes, nothing under the media prefix goes in `public/` (a file there would win over the
rewrite).

## Deployment protection

This applies when `publicStaging` is `false`. A protected deployment answers a request without
the bypass with a `302` to
`https://vercel.com/sso-api?...`, not a 401 or a login page. `verify-live` recognises it and stops
with exit 3 and `deployment protection: ...` at the first such answer. A new project has no
bypass secret: it exists only after a person creates it (Settings, Deployment Protection,
Protection Bypass for Automation), and then reaches you as `VERCEL_AUTOMATION_BYPASS_SECRET` in
your environment. With it, pass `--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` to `verify-live`;
`launch-audit` cannot send it. Without it, both go under "Not covered" with the reason, and the
needs-you line is: "create the Protection Bypass for Automation secret (Settings, Deployment
Protection), put it in the environment as `VERCEL_AUTOMATION_BYPASS_SECRET`, and I rerun
`verify-live`". You never create the secret or loosen the protection yourself.

## Production (the person, on launch day)

When staging was protected (`publicStaging` `false`), first restore the default so the
production alias and the domain are public and previews stay protected: the PATCH above with
the body `{"ssoProtection":{"deploymentType":"preview"}}` (check with the GET). Then `npx vercel deploy --prod --scope <scope>` from `main` after the
merge, or the deploy the Git integration makes on the merge. Then the domain:
`npx vercel domains add <domain>` and the records it prints. All are runbook steps, not yours.
