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

```bash
control-shopify dev start                 # uploads the dev theme, prints preview / share / editor URLs
control-shopify open /products/<handle>   # retries the dev proxy's intermittent 502 page
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

Per-repo files (not in this repo): `.claude/verify-shopify.json`, `.claude/verify-shopify/features/*.md`, and state/evidence under `.shopify/verify/` (gitignore `.shopify/`).

## Maintain

Weekly, or after any surprise: `doctor` → `map` and diff against the hand-written Feature Map → `smoke --target preview` → add gotchas. If you worked around a command by hand, fix the command.
