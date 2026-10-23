# astro-conversion-kit: instructions for agents

This repository is a set of Agent Skills that convert a live website into a static Astro site with
URL, content, SEO and visual parity, then take it through launch. Each skill is a folder under
`skills/` with a `SKILL.md`, plain Node scripts in `scripts/` and, where needed, `references/`.
The scripts do everything that must be exact; the skills tell you when to run them and how to read
what they print.

If a person pasted this repository's link with a site to convert, start with `convert-site`. It
runs every other skill in order.

## Install the skills as one set

The skills call each other and share script libraries, so install all eight together. Any one of
these works:

1. `npx skills add ethanplusai/astro-conversion-kit` installs them into your agent's skills folder.
2. In Claude Code: `/plugin marketplace add ethanplusai/astro-conversion-kit`, then
   `/plugin install astro-conversion@astro-conversion-kit`.
3. From a clone: `git clone https://github.com/ethanplusai/astro-conversion-kit`, `npm install`,
   `npx playwright install chromium`, and read each `skills/<name>/SKILL.md` by path.

Then run `node skills/convert-site/scripts/preflight.mjs` and install whatever it reports missing
that you can install yourself. Never ask the person for a password or a token in chat.

## Which skill when

| Skill | Use it when |
|---|---|
| `convert-site` | Asked to convert, rebuild, migrate or clone a site to Astro. The orchestrator: intake, plan, scaffold, build, PR, runbook. Resumes a run from `.conversion/state.json`. |
| `capture-site` | The live site has to be crawled and saved: pages, head tags, redirects, media, fonts, feeds, screenshots. Read-only and paced. |
| `parity-gates` | Freezing the capture into `baseline/`, or checking a build against it: routes, redirects, SEO, text, links, media, sitemap, feeds, forms, scripts. |
| `visual-review` | Comparing the new site with the live one: screenshots at 390, 768 and 1440 px, pixel diff, computed styles, contact sheet. |
| `suggest-improvements` | The conversion is built and gated, and the person needs the list of things worth fixing that the build reproduced on purpose. |
| `pre-launch` | Before any launch: gates the repository and its production build. Exits 1 if anything fails. |
| `launch-audit` | Auditing a staging or live URL for what would go wrong at launch, including redirect coverage for a domain cutover. |
| `post-launch` | DNS has moved or is about to, and for the 30 days after: verifies the cutover and diffs production against the pre-launch baseline. |

`pre-launch`, `launch-audit` and `post-launch` are vendored from
[website-launch-skills](https://github.com/ethanplusai/website-launch-skills) and also work on
sites this kit did not build.

## The rules

- **The live site is read-only.** Only these read it, paced: the capture scripts, `shoot.mjs`
  and `styles.mjs` on live, `css-coverage.mjs`, `launch-audit --old-url` and `pre-launch
  --predecessor-url`. Analytics are blocked on their live page loads, so no visit is counted.
  The capture scripts (capture, media, assets, fingerprint) pace each host (by default 400 ms
  between request starts, up to 4 in flight, 6 for media; `--polite` for one at a time, 2.5 s
  apart) and drop to one request at a time with a doubled delay on 429 and 503; the Chromium
  steps (`shoot`, `css-coverage`, `styles`) load one page at a time, 500 ms apart;
  `launch-audit` and `pre-launch` keep their own pacing. They stop after three
  consecutive blocks with state saved so a crawl resumes. Never submit a form on it, never log
  in, never change anything.
- **One intake message, then no stops.** Ask everything once, each question with a stated default.
  Anything that later needs an account or token you do not have goes into the runbook's "needs
  you" list, and the run carries on.
- **The default build equals live.** Content is moved from the captured markup, never retyped or
  tidied. A deliberate difference is an entry in `exceptions.json` with a reason; an improvement
  is a proposal in `proposals.json`, shipped only when `PROPOSALS=on` until a person approves it.
- **Gates are not softened.** No flag turns a failure into a warning. Never edit `baseline/` to
  make a gate pass. If a gate is wrong about a site, say so and fix the gate.
- **A skip is not a pass, and "Not covered" is never a pass.** Repeat every "Not covered" section
  to the person verbatim, in the PR and in your report.
- **Nothing is committed to the site's `main` but the scaffold.** Apart from the scaffold commit
  that init-site makes on a new or empty repository, nothing is committed to `main`; all work goes
  on `astro-rebuild` and reaches `main` through a pull request the person merges. Never force-push.
- **Never touch DNS, the old host, or a hosting dashboard setting** beyond the deploys the runbook
  names. The person launches.
- **Test submissions go only to the address the person gave at intake**, never to an address found
  on the site.
- **No secrets in any repository.** Credentials come from the environment or the CLI's own login.

## Agent capabilities

Nothing here needs a particular agent. If your agent can run subagents, the capture and the visual
review can be split across them; if it has its own browser, use it for the judgment step of the
visual review. Without either, run the scripts in order: every gate and diff is a script and runs
anywhere Node runs.

## Resuming

A run writes `.conversion/state.json` in the site repository (phase, counts, decisions, last gate
results). In a new session, open the site repository, read that file with
`node skills/convert-site/scripts/state.mjs --dir <site> get`, and continue from the recorded
phase. The capture keeps its own crawl state and resumes where it stopped.

## Working on this repository

- Node 22.23.4 or newer on the 22 line, or 24.22.1 or newer (`.nvmrc` pins the version CI uses).
- `npm test` runs every test against the fixture site in `test/fixture/`; `npm run hygiene` checks
  tracked files and commit messages. Both must pass before every commit.
- Live sites are never contacted by tests. Tests pass `--delay 0` against the fixture.
- Conventional commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Commit messages
  carry no trailers of any kind: no co-author, session or sign-off lines. The hygiene check fails
  the build on them.
- No real email addresses in code, tests or docs; use `@example.com`.
- Never edit `skills/pre-launch`, `skills/launch-audit` or `skills/post-launch` here. Change them
  upstream, then run `node scripts/sync-launch-skills.mjs`.
- New dependencies need a reason in [docs/dependencies.md](docs/dependencies.md) and are rarely
  the right answer.
- `CLAUDE.md` is a copy of this file and a test keeps them identical. Edit `AGENTS.md`, then copy.
