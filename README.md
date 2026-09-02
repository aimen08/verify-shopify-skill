# verify-shopify

A Claude Code skill that closes the loop on Shopify theme work:

**edit → `shopify theme dev` → assert the real DOM in Chromium → look at it → report.**

One CLI, `control-shopify`, wraps the whole thing. It is store-agnostic — each repo points at its store with `.claude/verify-shopify.json`.

- Browser: a real Chromium via [agent-browser](https://www.npmjs.com/package/agent-browser), one isolated session per store.
- Store access: Shopify CLI `theme dev`, `theme check`, and the Admin GraphQL API through `shopify store auth` / `shopify store execute`.
- Output: every command prints JSON, so an agent can branch on it. Failures carry a `hint`.

## Install

```bash
npm i -g @shopify/cli agent-browser && agent-browser install
git clone git@github.com:aimen08/verify-shopify-skill.git ~/.claude/skills/verify-shopify
ln -s ~/.claude/skills/verify-shopify/bin/control-shopify /usr/local/bin/control-shopify
ln -s ~/.claude/skills/verify-shopify/build-shopify ~/.claude/skills/build-shopify
```

Two skills, one binary: **verify-shopify** proves a change renders, **build-shopify** authors it. They share the config, the auth and the browser session, so the repo holds both.

## Use

```bash
control-shopify init --store <shop>.myshopify.com --port 9292 --gitignore
control-shopify doctor
control-shopify dev start

control-shopify verify <spec> --screenshot     # open → wait → assert → check-page → PNG
control-shopify verify --all                   # every spec, as a regression suite
control-shopify cleanup --keep-dev
```

The unit of work is a **spec** — JSON at `.claude/verify-shopify/specs/<name>.json` describing a route and what must be true on it:

```jsonc
{
  "route": "/products/some-handle",
  "country": "US",
  "checks": [
    { "name": "3 bundle items", "selector": "#bundle .item", "count": 3 },
    { "name": "CTA copy", "selector": ".btn", "textContains": "ADD ALL 3" }
  ]
}
```

Specs are the point: they are cheap to write, they cannot "pass" on a 502 page, and they stay behind as regression tests.

## Design

The skill is deliberately small. Earlier versions shipped video recording, Liquid profiling, a Feature Map generator, route smoke-tests, cart helpers and handle lookups; in practice the loop is **`gql` to find fixtures → `verify` to assert → `eval` to explain a failure → one screenshot to look at it**, and everything else was surface area that cost context without earning it. Commands were removed rather than left undocumented.

Screenshots are kept, with a rule: take one per surface *and read it*. DOM checks tell you pass/fail; only the picture tells you the page looks right.

```
SKILL.md                    verify — setup, the loop, spec vocabulary, gotchas
build-shopify/SKILL.md      build — scaffolds, nav, CDN uploads, pages, shipping
control-shopify.mjs         the CLI, shared by both
references/
  storefront-routes.md      Shopify routes, AJAX cart endpoints, Section Rendering API
  admin-api.md              scopes + GraphQL recipes
  feature-map-template.md   format for per-store Feature Maps
  browser-tooling.md        why agent-browser; headless-Chrome fallback
```

## Maintaining

After any surprise: `doctor` → re-run `verify --all` → add the gotcha to `SKILL.md` and the store's Feature Map. If you worked around a command by hand, fix the command — agents should run a CLI command, not write throwaway scripts.
