// convert-site's own docs: the rules a run follows that no script can enforce for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = join(import.meta.dirname, '..', '..', 'skills', 'convert-site');
const read = (path) => readFileSync(join(SKILL, path), 'utf8');

test('phases.md: CSS coverage runs on up to 10 pages per template, and says the full-page diff catches over-pruning', () => {
  const phases = read('references/phases.md');
  const call = phases.split('\n').find((line) => line.includes('css-coverage.mjs'));
  assert.ok(call, 'the css-coverage call');
  assert.match(call, /--routes "\$\(node -e .*capture\/templates\.json.*slice\(0,10\).*\)"/);
  assert.doesNotMatch(call, /--routes capture\/inventory\.json/);
  assert.match(phases, /up to 10 pages per template/);
  assert.match(phases, /full-page diff[^.]*over-prun/);
});

test('phases.md: review:check is the proof of phases 8 and 12; overrides and blocked analytics are stated', () => {
  const phases = read('references/phases.md');
  const section = (n) => phases.split(/^## /m).find((s) => s.startsWith(`${n}. `));
  for (const n of [8, 12]) assert.match(section(n), /\*\*Proof:\*\* `npm run review:check` exits 0/);
  assert.match(phases, /`docs\/visual-overrides\.json`[\s\S]*"threshold": <at most 2>/);
  assert.match(phases.replace(/\s+/g, ' '), /blocks analytics, tag, pixel and chat hosts/);
});

test('phases.md §2: the Wayback second pass, its Notes proof, and route statuses in the proof', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. '));
  assert.match(capture, /capture\.mjs \$LIVE --out capture --resume --seed-file capture\/wayback-unverified\.txt/);
  assert.match(capture, /Wayback second pass: N of M archived paths verified/);
  assert.match(capture, /Still failing after retries: <path> \(<status> after 3 attempts\)/);
  const proof = capture.split('**Proof:**')[1].replace(/\s+/g, ' ');
  assert.match(proof, /no route with a status other than 200\/3xx\/404\/410, or an exception for each/);
});

test('build-rules.md copies media outside the prefix; SKILL.md names routes as an exception field', () => {
  assert.match(read('references/build-rules.md').replace(/\s+/g, ' '), /files outside the media prefix are copied to `?public\/`? at their live paths/);
  const skill = read('SKILL.md').replace(/\s+/g, ' ');
  assert.match(skill, /`routes`[^.]*a route the capture could not read: `from` is its status as a string, `to` is `"skip"` or the built replacement path/);
  assert.doesNotMatch(skill, /Forms, routes and scripts are not exception fields/);
});

test('intake.md: the message asks only what the owner knows, the Vercel team included', () => {
  const template = read('references/intake.md').split('## The template')[1].split('\n## ')[0];
  assert.match(template.replace(/\s+/g, ' '), /Default: your default team \(<preflight.s vercel\.scope>\)/);
  assert.match(read('references/intake.md').replace(/\s+/g, ' '), /`intake\.vercelScope` is preflight.s `vercel\.scope`/);
  assert.match(template.replace(/\s+/g, ' '), /Staging stays public \(noindexed\) unless you say otherwise\. Protect it behind Vercel Authentication\? Default: no/);
  assert.match(read('references/intake.md'), /"publicStaging":true/);
  assert.doesNotMatch(read('references/intake.md'), /"publicStaging":false/);
  assert.match(read('references/intake.md').replace(/\s+/g, ' '), /\| Vercel protection bypass secret \(only when you chose protection\) \|/);
  for (const asked of [/Repository\./, /Hosting\./, /Vercel team/, /`npx vercel teams ls`/, /Domain\./, /Test address\./, /Search Console\./, /Consent/]) {
    assert.match(template, asked);
  }
  // What the capture answers is never asked before it.
  assert.doesNotMatch(template, /<n> found|Found: <GA4|Out of scope \(needs a server\)|Large media/);
});

test('hosting-vercel.md: link with the team slug, deploy, protection only when the owner opted in, and the needs-you line when a step fails', () => {
  const vercel = read('references/hosting-vercel.md');
  // The default path: link, then deploy, nothing in between.
  assert.ok(vercel.includes('    npx vercel link --yes --project <slug> --scope <scope>\n    npx vercel deploy --prod --yes --scope <scope>\n'), 'the default two steps');
  const flatAll = vercel.replace(/\s+/g, ' ');
  assert.match(flatAll, /every staging deploy is a production deploy: `npx vercel deploy --prod --yes --scope <scope>` from `astro-rebuild`, every time, until launch/);
  assert.match(flatAll, /Before the custom domain is attached \(launch day, from `main`\), the production alias `<slug>\.vercel\.app` is staging/);
  assert.match(flatAll, /taken from `deployment\.productionUrl` in the same JSON/);
  assert.match(flatAll, /`https:\/\/<slug>\.vercel\.app` as the fallback/);
  assert.match(flatAll, /one GET that answers 200 with the staging noindex/);
  assert.match(flatAll, /Never the raw deployment URL/);
  const optIn = vercel.split('**Protection, only when the owner opted in.**')[1];
  assert.ok(optIn, 'the opt-in paragraph');
  const steps = [
    'npx vercel link --yes --project <slug> --scope <scope>',
    'npx vercel api /v9/projects/<slug> --method PATCH --input <body> --scope <scope>',
    'npx vercel api /v9/projects/<slug> --scope <scope>',
    'npx vercel deploy --yes --scope <scope>',
  ];
  const at = steps.map((s) => optIn.indexOf(`    ${s}\n`));
  assert.ok(at.every((i) => i > 0) && at.every((i, n) => n === 0 || at[n - 1] < i), 'the four opt-in steps in order');
  const flat = vercel.replace(/\s+/g, ' ');
  assert.match(flat, /never the username/);
  assert.match(flat, /preflight.s `vercel\.scope`/);
  assert.match(flat, /`npx vercel teams ls`/);
  assert.match(flat, /`\.env\.local` holding a `VERCEL_OIDC_TOKEN`/);
  assert.match(flat, /`vercel git connect` is not needed after `link`/);
  assert.match(flat, /first deploy of a new project is a production deploy/);
  assert.match(flat, /read `deployment\.url` and `deployment\.target`/);
  assert.match(flat, /`S set staging '"<alias>"'`/);
  assert.match(flat, /does not read `\.gitignore`/);
  assert.match(flat, /`\/dist\/`, `\/\.conversion\/`/);
  assert.match(flat, /`302` to `https:\/\/vercel\.com\/sso-api\?\.\.\.`, not a 401/);
  assert.match(flat, /Protection Bypass for Automation/);
  assert.doesNotMatch(flat, /vercel curl/);
  assert.match(flat, /npx vercel blob create-store <slug>-media --access public/);
  assert.match(flat, /npx vercel storage connect <store id> --project <slug> -e development --auth token --add-rw-token/);
  assert.match(flat, /never rely on a prefix/);
  assert.match(flat, /flagless wrapper/);
  const rows = vercel.split('\n').filter((l) => /^\| `(true|false)`/.test(l));
  assert.match(rows[0], /^\| `true` \(default\) \| none: no PATCH \|/, 'the default row comes first');
  assert.match(rows[1], /^\| `false` \(opted in\) \| `\{"ssoProtection":\{"deploymentType":"all"\}\}` \|/);
  assert.doesNotMatch(vercel, /\{"ssoProtection":null\}/);
  assert.match(flat, /default Deployment Protection covers preview deployments and raw deployment URLs but leaves the production alias public/);
  assert.match(flat, /never the raw `\*-<hash>\.vercel\.app` deployment URL/);
  assert.match(vercel, /^## Deployment protection \(only when the owner opted in\)$/m);
  assert.match(vercel, /"ssoProtection":\{"deploymentType":"preview"\}/);
  assert.doesNotMatch(vercel, /--body/);
  assert.match(vercel, /`link` fails[^\n]*`npx vercel teams ls`/);
});

test('runbook.md launch day sets protection back to preview before the production deploy, only when the owner opted in', () => {
  const launch = read('references/runbook.md').split('## C. Launch day')[1].split('\n## ')[0];
  assert.match(launch, /--method PATCH --input <that file>/);
  const patch = launch.indexOf('"deploymentType":"preview"');
  assert.ok(patch > 0, 'the PATCH back to preview');
  assert.ok(patch < launch.indexOf('npx vercel deploy --prod'), 'before the production deploy');
  const flat = launch.replace(/\s+/g, ' ');
  const opted = flat.indexOf('only when the owner opted in to protecting staging');
  const flatPatch = flat.indexOf('"deploymentType":"preview"');
  assert.ok(opted > 0 && opted < flatPatch, 'the PATCH sits inside the opt-in conditional');
  assert.doesNotMatch(flat.slice(opted, flatPatch), / \d+\. [A-Z]/, 'in the same step');
  assert.match(flat, /[Ww]ith the default public staging there is no protection step/);
  const sectionA = read('references/runbook.md').split('## A.')[1].split('\n## ')[0].replace(/\s+/g, ' ');
  assert.match(sectionA, /Vercel, only when the owner opted in to protecting staging: create the Protection Bypass for Automation secret/);
  const closeout = read('references/runbook.md').split('## B. Closeout')[1].split('\n## ')[0].replace(/\s+/g, ' ');
  assert.match(closeout, /every staging redeploy is `npx vercel deploy --prod --yes --scope <team slug>` from `astro-rebuild`/);
});

test('phases.md: the staging deploy links, deploys and takes the alias; the protection PATCH only in the opt-in branch', () => {
  const prelaunch = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('10. ')).replace(/\s+/g, ' ');
  assert.match(prelaunch, /on Vercel: link with the team slug, deploy, take the URL from the deploy JSON/);
  assert.match(prelaunch, /only when the owner opted in to protection \(`publicStaging` `false`\), the protection PATCH comes between link and deploy/);
  assert.match(prelaunch, /never the raw deployment URL/);
  assert.match(prelaunch, /`npx vercel deploy --prod --yes --scope <scope>` from `astro-rebuild`/);
  assert.match(prelaunch, /every redeploy before launch updates what reviewers and the audit see/);
});

test('a protected site ends the run with the resume command; SKILL.md has the nvm line and the scaffold exception', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. ')).replace(/\s+/g, ' ');
  assert.match(capture, /\*\*A protected site\.\*\* The host is serving a bot challenge/);
  assert.match(capture, /capture\.mjs \$LIVE --out capture --resume`/);
  assert.match(capture, /Nothing is scaffolded/);
  const skill = read('SKILL.md').replace(/\s+/g, ' ');
  assert.match(skill, /Every Node command in a fresh shell starts with `source ~\/\.nvm\/nvm\.sh && nvm use 22\.23\.4`/);
  assert.match(skill, /init-site makes one commit on `main`, the exception to "never commit to main"/);
});

test('build-rules.md: the 404 page from capture/meta.json notFound, and every sitemap robots.txt names', () => {
  const rules = read('references/build-rules.md').replace(/\s+/g, ' ');
  assert.match(rules, /`src\/pages\/404\.astro` holds the site's own 404 page in its layout: the markup is in `capture\/pages\/404\.html`/);
  assert.match(rules, /When `notFound\.snapshot` is null the live site has no 404 page/);
  assert.doesNotMatch(rules, /holds the captured 404 page's markup/);
  assert.match(rules, /`capture\/sitemaps\/` holds every sitemap robots\.txt names/);
});

test('phases.md §2: the three meanings of capture exit 3; a bot challenge is the protected site', () => {
  const capture = read('references/phases.md').split(/^## /m).find((s) => s.startsWith('2. ')).replace(/\s+/g, ' ');
  assert.match(capture, /\*\*Exit 3 from the capture\*\* means one of three things/);
  assert.match(capture, /blocked: <host> anti-bot challenge \(<cause>\)/);
  assert.match(capture, /Allowlist the capture machine's public IP on the host or in the WAF/);
  assert.match(capture, /never continue to templates, media or the baseline/);
});

test('forms.md: GET forms are compared with live and need no endpoint', () => {
  const forms = read('references/forms.md').replace(/\s+/g, ' ');
  assert.match(forms, /A `GET` form, such as a search box, is not a contact form/);
  assert.match(forms, /applies to POST forms only/);
});

test('round 3 lines: styles spelled out, redirects:build after the first build, hygiene.pushed in the proof, 404 assets, suspect-challenge, the estimate is "about"', () => {
  const phases = read('references/phases.md').replace(/\s+/g, ' ');
  assert.match(phases, /npm run review:styles -- --live \$LIVE --new http:\/\/localhost:4321 --routes capture\/templates\.json --widths 390,768,1440 --out review\/styles\.json/);
  assert.match(phases, /`npm run redirects:build`, and again after the first `npm run build`/);
  const proof = phases.split('## 10. prelaunch')[1].split('**Proof:**')[1];
  assert.match(proof, /accepts `hygiene\.pushed` only while the repository has no remote and the push is on the needs-you list/);
  assert.match(phases, /A route with status "suspect-challenge"/);
  assert.match(read('references/build-rules.md').replace(/\s+/g, ' '), /The 404 page's own stylesheets, scripts and media are not collected/);
  const intake = read('references/intake.md').split('\n## ')[0].replace(/\s+/g, ' ');
  assert.match(intake, /Say "about": the estimate leaves out/);
});

test('intake.md: the time estimate counts every live read per page, per coverage page, per template and per media file', () => {
  const intake = read('references/intake.md');
  const estimate = intake.split('\n## ')[0];
  for (const part of [/capture/, /coverage/, /live shots/, /style/, /media file/, /2\.5 s/]) assert.match(estimate, part);
});

test('SKILL.md: at most 200 lines; the read-only rule names every script that reads live, and blocked analytics', () => {
  const skill = read('SKILL.md');
  const lines = skill.trimEnd().split('\n').length;
  assert.ok(lines <= 200, `${lines} lines`);
  const rule = /^2\. \*\*The live site is read-only\.\*\*[\s\S]*?(?=\n\d\. )/m.exec(skill)?.[0];
  assert.ok(rule, 'golden rule 2');
  for (const name of ['capture scripts', 'shoot.mjs', 'styles.mjs', 'css-coverage.mjs', 'launch-audit --old-url', 'pre-launch --predecessor-url']) {
    assert.ok(rule.replace(/\s+/g, ' ').includes(name), name);
  }
  assert.match(rule, /[Aa]nalytics (are|is) blocked/);
});

const flat = (text) => text.replace(/\s+/g, ' ');

test('PUBLIC_INDEXABLE=true in phases §7, §10 and the runbook is a local build-only variable, never the hosting setting', () => {
  const phases = flat(read('references/phases.md'));
  const gates = phases.split('## 7. gates')[1].split('## 8. visual')[0];
  assert.match(gates, /`PUBLIC_INDEXABLE=true` here is a variable for that one local build, never the hosting setting/);
  assert.match(gates, /still allows this build, `verify:release` and the pre-launch run/);
  const prelaunch = phases.split('## 10. prelaunch')[1].split('## 11.')[0];
  assert.match(prelaunch, /never the hosting setting: "leave it unset on the host" \(or in the intake\) still means run this command with it/);
  assert.match(flat(read('references/runbook.md')), /`PUBLIC_INDEXABLE=true` in these commands sets it for that one local command only, never the host/);
});

test('build-rules.md: content links stay as captured; same-origin asset URLs are root-relative by default, one decision row', () => {
  const rules = flat(read('references/build-rules.md'));
  assert.match(rules, /\*\*Content links stay as captured\.\*\*/);
  assert.match(rules, /never rewrite one to root-relative or to another host/);
  assert.match(rules, /is a `links` exception/);
  assert.match(rules, /\*\*Same-origin asset URLs are root-relative, by default\.\*\*/);
  for (const part of ['`<script src>`', '`<img src>` and `srcset`', '`<source>`', 'preload']) assert.ok(rules.includes(part), part);
  assert.match(rules, /a module script from live fails CORS/);
  assert.match(rules, /One decision row covers the set/);
});

test('no live sitemap: build-rules and phases ship sitemap-index.xml as a decision row, and the routes gate allows it', () => {
  const rules = flat(read('references/build-rules.md'));
  assert.match(rules, /\*\*No live sitemap\.\*\*[^*]*Astro's `sitemap-index\.xml`[^*]*points at `\/sitemap-index\.xml`: one decision row/);
  assert.match(rules, /Never build the robots-named file live did not serve/);
  const phases = flat(read('references/phases.md'));
  assert.match(phases, /The routes gate never calls `sitemap-index\.xml` or `sitemap-<n>\.xml` an extra/);
});

test('phases.md: serve the build with review:serve (vercel.json applied) before shoot and styles, and stop it', () => {
  const phases = read('references/phases.md');
  const text = flat(phases);
  assert.match(phases, /\*\*Serve, then wait\.\*\*/);
  assert.match(text, /serve it with `npm run review:serve` \(it applies `vercel\.json` like staging does\) and use that origin for every `review:\*` step/);
  assert.match(text, /`npm run preview` is only for sites whose media is in the repo/);
  assert.match(phases, /^ {4}npm run review:serve -- --stop\n {4}npm run review:serve -- --background --port 4321$/m);
  assert.match(text, /port 4321 is in use by another process \(pid <n>, <command>\); pass --port/);
  assert.match(flat(phases.split('## 8. visual')[1]), /Serve the full build and wait for it first/);
  assert.doesNotMatch(phases, /preview-ready|npm run preview -- --background/);
  const visual = flat(readFileSync(join(SKILL, '..', 'visual-review', 'SKILL.md'), 'utf8'));
  assert.match(visual, /serve the build with `npm run review:serve` \(it applies `vercel\.json` like staging does/);
  assert.match(visual, /`npm run preview` is only for sites whose media is in the repo/);
  assert.match(text, /On Cloudflare \(no `vercel\.json`\) it applies `dist\/_redirects` the same way\. It re-reads either file when it changes/);
  const procedure = flat(readFileSync(join(SKILL, '..', 'visual-review', 'references', 'review-procedure.md'), 'utf8'));
  assert.match(procedure, /`npm run build && npm run review:serve`, because the built output is what ships; it applies `vercel\.json` \(or `dist\/_redirects`\) like staging does/);
  assert.doesNotMatch(procedure, /npm run build && npm run preview/);
  const cloudflare = flat(read('references/hosting-cloudflare.md'));
  assert.match(cloudflare, /`npm run review:serve`, which applies `dist\/_redirects` when the site has no `vercel\.json`/);
});

test('SKILL.md: the post-plan status is required non-interactively, state.mjs calls one at a time with the reason, one commit per template, stop the preview', () => {
  const skill = flat(read('SKILL.md'));
  assert.match(skill, /required in a non-interactive run too/);
  assert.match(skill, /never chained with `&&`: each rewrites `state\.json`/);
  assert.match(skill, /One commit per template/);
  assert.match(skill, /Stop any review server you started \(`npm run review:serve -- --stop`, and `npx astro preview stop` if you used the preview\)/);
});

test('build-rules and phases: site.css linked by URL before the head slot, page sheets from pageSheets, uncoveredInline', () => {
  const rules = flat(read('references/build-rules.md'));
  assert.match(rules, /linked once by `Base\.astro`: the template imports it by URL \(`import siteCss from '\.\.\/styles\/site\.css\?url'`\) and links it before the head slot/);
  assert.match(rules, /Never switch to a plain `import '\.\.\/styles\/site\.css'`/);
  assert.match(rules, /those go to `src\/styles\/pages\/<inline file>`, listed under `pageSheets` \(`file`, `pages`, `rules`\) in `\.conversion\/css-prune-report\.json`/);
  assert.match(rules, /Link each page sheet only on the pages it lists, after `site\.css` \(Base\.astro's `pageSheet` prop\); never copy its rules into `site\.css`/);
  assert.match(rules, /WordPress 6\.9\+'s `\/\*# sourceURL=\.\.\. \*\/` comments change nothing/);
  assert.match(rules, /`uncoveredInline` lists the pages' `<style>` sets no coverage run saw/);
  const phases = flat(read('references/phases.md'));
  assert.match(phases, /When it prints `wrote N per-page sheet\(s\)`, give each page its `pageSheet` from the report's `pageSheets`/);
  assert.match(phases, /css-prune clears the old `inline-\*\.css` in `src\/styles\/pages\/` on each run, so commit the folder as it leaves it/);
  assert.match(rules, /every rule naming its class \(a class it styles, not one inside its `:not\(\)`\/`:where\(\)`\): those go to/);
});

test('phases and build-rules: VIP concatenated scripts, --allow-extra on routes only, WordPress API link exceptions, Lighthouse optional', () => {
  const phases = flat(read('references/phases.md'));
  assert.match(phases, /`\/_static\/\?\?a\.js,b\.js`\) cannot be served by a static host and `assets\.mjs` does not rewrite them: you save each concatenation as one file at `\/_static\/concat\/<hash>\.js`/);
  assert.match(phases, /pass `--allow-extra '\/_static\/concat\/\*'` on every routes gate run/);
  assert.match(phases, /Only `routes\.mjs` \(and `npm run verify`, which hands it on\) accepts `--allow-extra`; the other single gate scripts exit 2 on it/);
  assert.match(phases, /Lighthouse is optional: when it is not installed the step is reported as skipped, never as a failure/);
  const rules = flat(read('references/build-rules.md'));
  assert.match(rules, /\*\*WordPress API head links are kept as captured\.\*\*/);
  assert.match(rules, /The build generates their links exceptions, one row per API link \(reason "WordPress API link kept as captured"\), rather than dropping the links/);
});

test('intake and plan: the forms answer applies only when the capture finds a POST form', () => {
  const intake = flat(read('references/intake.md'));
  assert.match(intake, /The answer is applied only if the capture finds a form that posts \(`method="post"`\); if it finds none, nothing is rewired and no form item goes on your list/);
  assert.match(intake, /\| No form id yet \(asked at the forms step, never here; only when the capture found a POST form\) \|/);
  const phases = flat(read('references/phases.md'));
  assert.match(phases, /The intake's forms answer is applied only if `inventory\.json` lists a POST form/);
  assert.match(phases, /If it lists none, the status message says "Forms: none to rewire" and no form needs-you item is created/);
});
