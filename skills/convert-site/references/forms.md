# Forms

A static site cannot receive a form, so every form posts to a third-party endpoint. Formspree is
the default; any endpoint that accepts a plain HTML `POST` works the same way. The live site's
form is never submitted.

## Which forms this covers

Only forms that send something (`method="post"`: contact, quote, sign-up). A `GET` form, such
as a search box, is not a contact form: it is reproduced as captured and compared with live,
and needs no endpoint, honeypot or thank-you page. The endpoint question (and the form id, the
test submission and `placeholders.form-id`) applies to POST forms only; a site whose only form
is a GET search box has none of them.

Only a POST form that posts **to the old site** is rewired: an empty action, a relative one, an
action on any host of the site's own domain (`www.` or not, `http:` or `https:`, a subdomain
such as a staging copy, a protocol-relative `//host/`), and a WordPress form handler on any host
(`/wp-admin/admin-ajax.php`, `/wp-admin/admin-post.php`, `/wp-comments-post.php`, a `?wpcf7`
or `wp-json/contact-form-7` URL). A POST form whose `action` is on another site, a different
registrable domain (a Mailchimp signup posting to `*.list-manage.com`, HubSpot's
`hsforms.com`, `formspree.io`, a Netlify-style endpoint), already works on a static host: keep it exactly as captured, action included. It gets
no placeholder, no honeypot or thank-you field and no needs-you item, and it is not the test
submission. List each one in the plan's "Forms plan" under **Forms kept as is**, with its page
and its action host (`/about/: example.us1.list-manage.com`). The forms gate compares it with
live like a GET form (the same full action URL, method and fields) and notes "N forms kept as
is (posts to <host>)"; rewiring one to the endpoint fails the gate. A site whose POST forms
all post elsewhere needs no `--endpoint` and no form id.

## Forms the static site cannot serve

A login, account, cart or checkout form needs a server, and rewiring it to a form service would
send passwords or payment details there. Never rewire one. How to handle it is a judgement for
the site: keep it switched off, link out to wherever that feature will live, or replace it with
an embed. A form kept but switched off gets an action that sends nowhere and a row in
`inert-forms.json` (`{ path, form, reason }`); the PR and runbook say it does not work.

## What stays the same

The forms gate compares each built form with `baseline/forms.json`: the same field names in
order (every named `input`, `select` and `textarea`, without buttons) and the same method. Keep
the captured form markup, labels, classes, order and every captured field exactly, the
platform's hidden ones (nonces, `_wpcf7*`, `form_id`) included: they are harmless, and forms is
not an exception field. On a form that posts to the old site, change only:

- `action` to the endpoint (`https://formspree.io/f/<form id>`), `method="POST"`;
- add the honeypot and thank-you fields below.

## The form id

Asked here, at the forms step, never at intake, and never a stop: send the person one line
("create a form at formspree.io, send me the id after /f/; ids are not secret") and carry on with
the placeholder `https://formspree.io/f/REPLACE`. Add the needs-you item. While the placeholder is
in the build, `pre-launch` fails `placeholders.form-id`, the PR is opened with `--draft`, and the
final report names the form id as the blocker. When the id arrives, replace the placeholder,
rerun the gates and `pre-launch`, and mark the PR ready.

**One endpoint.** The gate takes one `--endpoint`, so every form on the site posts to the same
form id. A site whose forms need distinct endpoints (different inboxes, different services) is
a recorded decision, and "forms after the first posting to their own endpoints were not checked
by the forms gate" is a "Not covered" line in the PR.

## Honeypot

Keep the live honeypot field (the fixture's is `website`) where it was. Add Formspree's own,
hidden from people and from assistive technology:

    <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="display:none" aria-hidden="true">

The gate allows a honeypot the live form did not have when it is named with `--honeypot`.

## Thank-you page

Every form leads to one thank-you page, through a hidden field holding the absolute URL on the
canonical host:

    <input type="hidden" name="_next" value="https://<canonical host>/thank-you/">

The gate is given the path (`--thank-you /thank-you/`). It accepts the field as that path, or as
an absolute URL whose host is the baseline's `canonicalOrigin` (its `origin` when `meta.json` has
none) and whose pathname equals `--thank-you`; the page must be built.

Use the live site's thank-you URL when it has one (it is a captured page and already built).
When it has none, build `/thank-you/` from the site's plain page template with a one-line
message, `noindex` robots and its own canonical (`https://<canonical host>/thank-you/`;
pre-launch fails a utility page without either), keep it out of the sitemaps, pass
`--allow-extra /thank-you/` to the routes gate, and record a decision. Whether the
endpoint honours `_next` depends on its plan: if it does not, that is a needs-you line.

## The gate flags

The form flags go on the command line every time the gates run, as the `parity-gates` skill
does; they are never written into `package.json`:

    npm run verify -- --endpoint https://formspree.io/f/<id> --honeypot _gotcha --thank-you /thank-you/

The same flags follow `npm run verify:proposals --` and `npm run verify:release --`, and the
path-scoped `node scripts/verify/forms.mjs` run in the build phase.

## The one test submission

Once, after the staging deploy, and only when the intake gave a test address and the form id is
real:

1. Open the staging contact page (with Playwright, or your agent's own browser).
2. Fill each field with an obvious test value (`Conversion test`, the intake test address in the
   email field, `Test submission from the staging copy` as the message), leave the honeypots
   empty, and submit once. Note where it lands (the thank-you page, or the endpoint's own page).
3. Record it: `S set forms.testSentAt '"<ISO time>"'` and the page you used.

Never submit on the live site, never to an address found on the site, never more than once per
run. A new Formspree form sends a confirmation email to its owner on the first submission; that
is the person's to click. Whether the message arrived is the person's to confirm: it is the
`forms` item of the pre-launch checklist, in `docs/LAUNCH.md` section A. Never confirm it.
