# {{SITE_NAME}}

This site was converted with astro-conversion-kit: a static Astro rebuild of {{ORIGIN}}.
Scaffolded on {{DATE}}; hosted on {{HOSTING}}.

Requires Node 22.23.4 or newer (`nvm use`), then `npm install`.

| Script | What it does |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` | Static build into `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm test` | Unit tests under `test/` |
| `npm run baseline` | Build `baseline/` from `capture/` |
| `npm run links:exceptions` | Add the WordPress API and broken-on-live link exceptions to `exceptions.json` |
| `npm run assets:copy` | Copy captured scripts, fonts, icons and media outside the media prefix to `public/` |
| `npm run verify` | Run every parity gate against `dist/` |
| `npm run verify:proposals` | Gates with approved-pending proposals switched on |
| `npm run verify:release` | Gates for the indexable launch build |
| `npm run redirects:build` | Generate host redirect rules from `redirects.csv` |
| `npm run verify:live` | Check the live host after launch |
| `npm run review:shoot` | Screenshot live and local pages at 390, 768 and 1440 px |
| `npm run review:diff` | Pixel diff of the screenshots |
| `npm run review:styles` | Computed-style comparison |
| `npm run review:sheet` | Contact sheet of the review |
| `npm run review:check` | Re-reads every diff and style result; exits 1 if any row fails |
| `npm run review:serve` | Serve `dist/` with vercel.json applied, for the visual review |

See `AGENTS.md` for the working rules and `docs/LAUNCH.md` for launch steps.
