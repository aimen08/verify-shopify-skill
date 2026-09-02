---
name: verify-shopify
description: Verification loop for Shopify theme work on any store. Runs `shopify theme dev`, drives the storefront in a real Chromium (agent-browser), asserts the DOM against reusable JSON specs, and reaches the Admin GraphQL API through `shopify store execute`. Use whenever you change a Shopify theme and must prove it works, reproduce a storefront bug, or find real product/page fixtures to test against.
allowed-tools: Bash(control-shopify:*), Bash(node ~/.claude/skills/verify-shopify/control-shopify.mjs:*), Bash(agent-browser:*), Bash(shopify:*)
---

# verify-shopify

One CLI, `control-shopify`, closes the loop: **edit → dev server → assert the real DOM → look at it → report**. Store-agnostic; each repo points at its store with `.claude/verify-shopify.json`.

Every command prints JSON. Failures print `{"ok":false,"error":…,"hint":…}` and exit 1 — the `hint` tells you what to do instead. `control-shopify help` for the full surface.

## Setup (once per repo)

```bash
control-shopify init --store <shop>.myshopify.com --port <free port> --gitignore
control-shopify doctor        # node, CLI, browser, config, dev server, theme session, token scopes
control-shopify auth          # ONLY if doctor reports missing scopes — re-auth REPLACES the scope set
```

Prereqs, once per machine: `npm i -g @shopify/cli agent-browser && agent-browser install`.

## The loop

```bash
control-shopify dev start
control-shopify verify <spec> --screenshot     # open → wait → assert → check-page → PNG
control-shopify verify --all                   # every spec, as a regression suite (--route is per-spec, so it is ignored here)
control-shopify cleanup --keep-dev
```

Write the expectations down once as a **spec**, then let `verify` do the whole round trip. Prefer it over hand-driving `open`/`eval`/`screenshot`: fewer round trips, and it cannot silently "pass" on an error page.

A spec is JSON at `.claude/verify-shopify/specs/<name>.json`:

```jsonc
{
  "route": "/products/some-handle",
  "country": "US",          // pin the market — see gotchas, this one is not optional
  "waitFn": "!document.documentElement.hasAttribute('data-intro')",
  "settleMs": 400,
  "checks": [
    { "name": "3 bundle items", "selector": "#bundle .item", "count": 3 },
    { "name": "sold-out partner excluded", "selector": "#bundle .item[title^=\"Kit\"]", "count": 0 },
    { "name": "CTA copy", "selector": ".btn-label", "textContains": "ADD ALL 3" },
    { "name": "og:image", "selector": "meta[property=\"og:image\"]", "attr": "content", "contains": "hero" }
  ]
}
```

| key | asserts |
|---|---|
| `exists` | `true` → at least one match; `false` → none |
| `count`, `minCount` | exact / minimum matches |
| `visible` | non-zero box, not `display:none` / `visibility:hidden` / `opacity:0` |
| `textContains`, `textNotContains`, `textEquals` | text of **all** matches joined (absence checks pass with 0 matches — that is the point) |
| `attr` + `equals` / `contains` | attribute of the first match |
| `css: {prop: value}` | computed style of the first match |
| `centeredIn` + `tolerance` | horizontal centre vs. that container, in px — **use this for "is it centred"**; a screenshot cannot tell a centred element from a left-aligned one inside a centred box |
| `animating` | a running animation with non-zero duration, scanning every match's subtree |

Two more spec keys matter as much as the checks: `country` pins the market (see gotchas) and `viewport: "390x844"` / `device: "iPhone 12"` pins the screen. Desktop-only assertions are how mobile regressions ship — emulation is reset after each spec, so a `--all` run can mix widths freely.

Specs are the thing that compounds: they stay as regression tests, and `verify --all` re-runs them free after the next change.

## When a check fails

`eval` is the fastest way to find out why — it beats another screenshot every time:

```bash
control-shopify eval "(() => { const e = document.querySelector('.thing');
  return JSON.stringify({ html: e && e.outerHTML.slice(0,300), text: e && e.innerText,
    display: e && getComputedStyle(e).display, country: Shopify.country, currency: Shopify.currency.active }); })()"
```

`snapshot -i -c` for an a11y tree with `@eN` refs; re-snapshot after **any** DOM change, refs die instantly.

## Screenshots

Take one per surface after the checks pass — and then **Read the PNG**. The DOM checks are pass/fail; the screenshot is the only thing that tells you the page looks right. A screenshot you never open is wasted work, so either look at it or don't take it.

Hand-over screenshots come from `--target preview` (or `live`), not the local proxy — the dev proxy serves broken images and intermittently 502s.

## Targets

| target | base | use for |
|---|---|---|
| `dev` (default) | `http://127.0.0.1:<port>` | fast iteration, hot reload |
| `preview` | `https://<store>/…?preview_theme_id=<dev id>` | pixel-accurate screenshots, real CDN/apps |
| `live` | primary domain | comparing against production |

## Admin API

`gql` is how you find real fixtures — which product actually has 3 partners in stock, which page uses a template. This is usually the hard part of a verification, and it beats guessing handles:

```bash
control-shopify gql '{ productByHandle(handle: "x") { title status variants(first:5){ nodes { sku inventoryQuantity } } } }'
control-shopify gql @query.graphql --variables '{"n":5}'
```

Mutations are refused unless you pass `--allow-mutations`; `--dry-run` prints the exact command. Say in your report which mutations you ran. Recipes: `references/admin-api.md`.

## Gotchas

- **Pin the market.** The dev proxy geolocates from the machine's IP and can render a different market than live (ES/EUR vs US/USD). `product.available` is market-dependent, so anything gated on it *silently disappears* — a bundle that renders 3 items on live can render nothing on dev with byte-identical code. Set `country` in the spec or config. Without it, dev and live disagree and the honest-looking conclusion is a regression that does not exist.
- **`"The operation was aborted"` from a `theme` command is an expired session, not a broken CLI.** It starts a device-code OAuth and dies when nobody completes the browser step — impossible from a non-TTY agent shell. Ask the user to run `! shopify theme list --store <shop>` once. `gql` uses a different token and keeps working, which is the tell. Do **not** downgrade the CLI.
- **Verify against `live` only after proving live carries your code.** Read the theme's files over the Admin API and md5 them against local. Liquid matches byte-for-byte; **JSON templates never will** (Shopify rewrites their formatting) — diff those semantically.
- **Match the rendered case.** Text checks read `innerText`, so a `text-transform: uppercase` heading is `"24 MORE HOURS"`, not `"24 More Hours"`.
- **Absence checks can pass vacuously.** A check that an item is *missing* also passes when the container renders nothing at all, or when a loop `break`s before reaching it. Pair every absence check with a positive one (`count: 3`, "the replacement is present"), and pick a fixture where the branch you care about actually executes.
- **A `--full` screenshot captures lazy content as blank.** Sections below the fold have real height in the DOM but never painted, so the lower two-thirds of a tall page can come back white and look like a catastrophic layout bug. Before believing it, measure: `eval` the sections' `getBoundingClientRect().height`. To actually photograph them, scroll (`eval "window.scrollTo(0, N)"`), wait, then take a viewport screenshot.
- **Consent banners and chat widgets sit on top of your evidence.** A cookie dialog covers a corner of every screenshot and swallows clicks in that region. Dismiss or remove it (`eval "document.querySelector('#consent')?.remove()"`) before a hand-over screenshot or a click path.
- **The port may belong to another store.** `dev start`/`doctor` fetch `/` and compare `Shopify.shop` before adopting a listening server. Give each repo its own `port`; never kill another project's server. Stale theme id → delete `.shopify/verify/dev.json`.
- **The dev proxy 502s and 401s intermittently.** `open` proves a storefront actually rendered and retries. Persistent failures: `dev logs`, `dev restart`.
- **`shopify version` is what runs; `npm ls -g` is not.** Multiple installs (npm/bun/homebrew) shadow each other, so a version pin can land on a copy that never executes. `doctor` reports shadowing.
- Sold-out products render disabled buy buttons — pick an available variant. `--target preview` carries a preview-bar iframe that swallows clicks; `open` removes it, but re-run `eval "document.getElementById('PBarNextFrame')?.remove()"` if you navigate by clicking.
- Never run `theme push` / `theme publish` from a verification session.

## Feature Map

`.claude/verify-shopify/features/README.md` — materialized memory for a store's theme. Record **only what you had to discover**: selectors, click paths, DOM hooks, and gotchas that cost you time. Not prose descriptions of what a section is; the code already says that.

Good entries look like: *"no `button[name=add]` on this template, it's `[data-arp-atc]`"*, *"the cap `break` runs before the skip checks, so absence checks pass vacuously"*, *"dev renders ES, live renders US"*.

Building rather than verifying? The **`build-shopify`** skill covers the other half with the same CLI: scaffolds, navigation, CDN uploads, pages, and shipping to an unpublished theme.

References: `references/storefront-routes.md` (URL/AJAX/Section Rendering map), `references/admin-api.md` (scopes + GraphQL recipes), `references/feature-map-template.md`, `references/browser-tooling.md`.
