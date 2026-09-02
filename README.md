# Shopify skills for Claude Code

Two skills, one binary. **build-shopify** authors a theme; **verify-shopify** proves the result renders. They share the config, the auth and the browser session, so they live in one repo.

```
build   →   control-shopify section new · nav set · files upload · pages create · theme share
verify  →   control-shopify verify <spec> · eval · screenshot · check · profile
```

`control-shopify` is store-agnostic — each repo points at its store with `.claude/verify-shopify.json`.

- Browser: a real Chromium via [agent-browser](https://www.npmjs.com/package/agent-browser), one isolated session per store.
- Store access: Shopify CLI `theme dev` / `theme check`, and the Admin GraphQL API through `shopify store auth` / `store execute`.
- Output: every command prints JSON, so an agent can branch on it. Failures carry a `hint` that says what to do instead.

## Install

```bash
npm i -g @shopify/cli agent-browser && agent-browser install
git clone https://github.com/aimen08/verify-shopify-skill.git ~/.claude/skills/verify-shopify
ln -s ~/.claude/skills/verify-shopify/bin/control-shopify /usr/local/bin/control-shopify
ln -s ~/.claude/skills/verify-shopify/build-shopify ~/.claude/skills/build-shopify
```

## Start on any store

```bash
control-shopify setup --store <shop>.myshopify.com [--port 9302]
```

One call: writes the repo config, checks the admin token and its scopes, checks the theme session, and prints exactly what a human still has to do. Two OAuth flows need a browser and cannot complete in a non-TTY agent shell, so hand them over:

```
! control-shopify auth --build                      # admin token — MERGES with existing scopes
! shopify theme list --store <shop>.myshopify.com   # theme session, if setup says it is stale
```

Then `control-shopify dev start`.

## Build

```bash
control-shopify products list --limit 10        # real handles, SKUs, variant ids, stock
control-shopify nav get main-menu > menu.json   # real menu shape, not a guess
control-shopify section new "Hero Banner"       # liquid + schema + preset + id-scoped CSS
control-shopify files upload hero.jpg --alt "Hero" --yes
control-shopify pages create summer-sale --title "Summer Sale" --template-suffix summer-sale --yes
control-shopify theme share                     # push an UNPUBLISHED copy, print its preview URL
```

## Verify

```bash
control-shopify verify <spec> --screenshot                     # desktop
control-shopify verify <spec> --viewport 390x844 --screenshot  # mobile
control-shopify verify --all                                   # the whole suite
control-shopify check                                          # theme check, scoped to your changes
```

The unit of work is a **spec** — JSON at `.claude/verify-shopify/specs/<name>.json` describing a route and what must be true on it:

```jsonc
{
  "route": "/products/some-handle",
  "country": "US",             // pin the market; dev geolocates and live does not
  "viewport": "390x844",       // optional; desktop-only assertions ship mobile regressions
  "checks": [
    { "name": "3 bundle items", "selector": "#bundle .item", "count": 3 },
    { "name": "CTA copy", "selector": ".btn", "textContains": "ADD ALL 3" }
  ]
}
```

Specs are the point: cheap to write, they cannot "pass" on a 502 page, and they stay behind as regression tests that `verify --all` re-runs free.

## Safety model

Reads are free. Every write needs `--yes`, and `--dry-run` prints the exact mutation first. A push to the **published** theme is refused outright unless you pass `--live --yes`. `auth` merges with the scopes already on the token, because `shopify store auth` *replaces* the scope set — a re-auth computed from a fixed list silently revokes scopes granted for other work.

## Design

The verify half is deliberately small. An earlier version shipped video recording, a Feature Map generator, route smoke-tests and handle lookups; watching a real session, the loop was **`gql` to find fixtures → `verify` to assert → `eval` to explain a failure → one screenshot to look at**, and the rest was surface area that cost context without earning it. Those were removed rather than left undocumented, and `smoke` became `verify --all`, which runs the specs you already wrote.

Liquid profiling and the cart helpers came back with the build half — both are hard to justify when verifying one diff and hard to do without when building a theme.

Screenshots are kept, with a rule: take one per surface *and read it*. DOM checks tell you pass/fail; only the picture tells you the page looks right.

```
SKILL.md                    verify — the loop, spec vocabulary, gotchas
build-shopify/SKILL.md      build — scaffolds, nav, CDN uploads, pages, shipping
control-shopify.mjs         the CLI, shared by both
references/
  admin-api.md              scopes, fixture-finding, staged uploads, theme-file md5
  storefront-routes.md      routes, AJAX cart endpoints, Section Rendering API
  feature-map-template.md   format for per-store Feature Maps
  browser-tooling.md        why agent-browser; headless-Chrome fallback
```

## Contributing

Issues and PRs welcome. The rule that keeps this small: a command earns its place by being used in a real session, and the docs are the expensive part — `SKILL.md` is what loads into an agent's context, so a feature that needs a paragraph of explanation had better save more than a paragraph of work. If you worked around a command by hand, that is a bug in the command.

Tested against Shopify CLI 4.x on macOS and Linux. Requires Node 20+.

## Maintaining

After any surprise: `doctor` → `verify --all` → write the gotcha into the SKILL.md it belongs to and the store's Feature Map. If you worked around a command by hand, fix the command — agents should run a CLI command, not write throwaway scripts.

## License

MIT — see [LICENSE](LICENSE).
