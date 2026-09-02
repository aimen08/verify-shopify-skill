# verify-shopify — a Claude Code verification skill for Shopify themes

A [pstack](https://cursor.com/marketplace/cursor/pstack)-style verification loop for Shopify theme work, packaged as a Claude Code skill. One CLI, `control-shopify`, lets an agent close its own loop on any store:

**edit → `shopify theme dev` → drive the storefront in real Chromium → screenshots / video / console → theme check + Liquid profile → report.**

- Browser driver: [agent-browser](https://www.npmjs.com/package/agent-browser) (real Chromium via CDP, accessibility-tree snapshots with `@eN` refs, isolated session per store).
- Store access: Shopify CLI `theme dev`, `theme check`, `theme profile`, and the Admin GraphQL API through `shopify store auth` / `shopify store execute` (products, inventory, publications, files, navigation menus).
- Store-agnostic: each repo points at its store with `.claude/verify-shopify.json`; the theme-specific Feature Map lives in the repo next to it.

## Install

```bash
# 1. Skill (the launcher assumes this exact path)
git clone git@github.com:aimen08/verify-shopify-skill.git ~/.claude/skills/verify-shopify

# 2. Tools
npm i -g @shopify/cli agent-browser
agent-browser install

# 3. Put `control-shopify` on PATH
ln -sf ~/.claude/skills/verify-shopify/bin/control-shopify "$(npm prefix -g)/bin/control-shopify"
control-shopify help
```

Fallback without the symlink: `node ~/.claude/skills/verify-shopify/control-shopify.mjs <command>`.

## Set up a store repo

```bash
cd <theme repo>
control-shopify init --store <shop>.myshopify.com     # writes .claude/verify-shopify.json + features/ skeleton
control-shopify doctor                                 # node, shopify CLI, agent-browser, token + scopes, dev server
control-shopify auth                                   # interactive OAuth, only if doctor reports missing scopes
control-shopify map                                    # generated Feature Map skeleton from the theme files
```

Then in Claude Code, type `/verify-shopify` (or just ask it to verify a theme change) — `SKILL.md` teaches the agent the loop, the evidence rules, and the gotchas.

## The loop

Write each surface's expectations down once as a **spec**, then verify it in one command:

```bash
control-shopify dev start
control-shopify verify home --screenshot   # open → wait → assert → check-page → screenshot, one JSON verdict
control-shopify smoke --target preview     # every configured route
```

`.claude/verify-shopify/specs/home.json`:

```json
{
  "route": "/",
  "waitFn": "!document.documentElement.hasAttribute('data-cz-intro')",
  "checks": [
    { "name": "hero eyebrow is centred", "selector": ".hero .eyebrow", "centeredIn": ".hero", "tolerance": 2 },
    { "name": "marquee actually moves",  "selector": ".marquee", "animating": true },
    { "name": "og:image", "selector": "meta[property=\"og:image\"]", "attr": "content", "contains": "social-card" },
    { "name": "5 cards", "selector": "li.card", "count": 5 }
  ]
}
```

Checks: `exists`, `count`/`minCount`, `visible`, `textContains`/`textNotContains`/`textEquals`, `attr`+`equals`/`contains`, `css`, `centeredIn`+`tolerance`, `animating`. They all run in a single round trip, each independently try/caught, and `verify` exits 1 if any fails. `centeredIn` and `animating` exist because a screenshot cannot distinguish a centred element from a left-aligned one inside a centred box, nor a moving marquee from a still one.

Lower-level commands, for debugging or exploring a surface before it has a spec:

```bash
control-shopify open /products/<handle>   # retries the dev proxy's intermittent 502 / 401 pages
control-shopify snapshot                  # a11y tree with @eN refs
control-shopify click @e12
control-shopify wait --text "Added"
control-shopify screenshot                # → .shopify/verify/evidence/<ts>-<title>.png
control-shopify check-page                # 502? empty? broken images? uncaught errors?
control-shopify smoke                     # every configured route → report.{json,md} + screenshots
control-shopify check                     # shopify theme check as JSON
control-shopify profile /                 # Liquid render profile + self-time summary
control-shopify cleanup --keep-dev
```

Targets: `--target dev` (local proxy, fast), `--target preview` (`?preview_theme_id=` on the real domain — use for hand-over screenshots), `--target live`.

## Layout

```
SKILL.md                    the skill: setup, loop, command reference, recipes, gotchas, maintenance
control-shopify.mjs         the CLI (Node ≥ 20, zero dependencies)
bin/control-shopify         launcher
references/
  browser-tooling.md        why agent-browser; obscura / Chrome MCP comparison; headless-Chrome fallback
  storefront-routes.md      Shopify routes, AJAX cart endpoints, Section Rendering API, preview/editor
  admin-api.md              scopes and GraphQL recipes (menus, publications, files, inventory, pages)
  feature-map-template.md   format for per-store Feature Maps
```

Per-repo files (not in this repo): `.claude/verify-shopify.json`, `.claude/verify-shopify/features/*.md`, `.claude/verify-shopify/specs/*.json`, and state/evidence under `.shopify/verify/` (gitignore `.shopify/`).

## Working on several stores at once

Give every repo its own `port` in `.claude/verify-shopify.json`. `dev start`, `dev status` and `doctor` refuse a server whose inlined `Shopify.shop` is not the configured store, so another project's `shopify theme dev` on the same port fails loudly instead of being screenshotted and reported as yours.

## Maintain

Weekly, or after any surprise: `doctor` → `map` and diff against the hand-written Feature Map → `smoke --target preview` → add gotchas. If you worked around a command by hand, fix the command.
