---
name: verify-shopify
description: Verification loop for Shopify theme work on any store. Starts `shopify theme dev`, drives the storefront in a real Chromium via agent-browser (snapshot refs, clicks, screenshots, video, console), runs theme check + Liquid profiling, and reaches the Admin GraphQL API through `shopify store auth/execute` (products, inventory, publications, files, navigation menus). Use whenever you change a Shopify theme and must prove it works, reproduce a storefront bug, verify store data, or hand over screenshots/video as evidence.
allowed-tools: Bash(control-shopify:*), Bash(node /Users/mac/.claude/skills/verify-shopify/control-shopify.mjs:*), Bash(agent-browser:*), Bash(shopify:*)
---

# verify-shopify

One CLI, `control-shopify`, closes the loop: **edit → dev server → drive the page in a real browser → capture evidence → lint/profile → report**. It is store-agnostic; each repo points it at its store with `.claude/verify-shopify.json`.

```bash
# `control-shopify` is on PATH (symlinked from ~/.claude/skills/verify-shopify/bin). Fallback: node ~/.claude/skills/verify-shopify/control-shopify.mjs
control-shopify help
```

Every structured command prints JSON. Failures print `{"ok":false,"error":…,"hint":…}` on stderr and exit 1 — read the `hint`, it tells you what to do instead.

## 0. One-time setup per repo

```bash
control-shopify init --store <shop>.myshopify.com [--port 9292] [--gitignore]   # writes .claude/verify-shopify.json
control-shopify doctor                                                          # node, shopify CLI, agent-browser, token + scopes, dev server
control-shopify auth                    # only if doctor reports missing scopes — interactive OAuth in the browser
control-shopify map                     # generated Feature Map skeleton → .claude/verify-shopify/features/README.generated.md
```

Prereqs (global, once per machine): `npm i -g @shopify/cli agent-browser && agent-browser install`.

Default admin scopes requested by `auth` (edit `scopes` in the config to change):
`write_products, read_products, write_inventory, read_inventory, read_locations, write_publications, write_files, write_purchase_options, read_online_store_navigation, write_online_store_navigation, write_content`.
`*_online_store_navigation` = menus (`menuCreate` / `menuUpdate`). `write_content` = pages/blogs (needed to create the admin page behind `page.<suffix>` templates). Re-auth **replaces** the token's scopes, so always request the full list.

Tokens from `shopify store auth` expire daily. `doctor` proves the token with a live query; if `storeAuth.ok` is false, run `auth`.

## 1. The verification loop

```bash
control-shopify dev start                          # uploads the dev theme, waits for the banner, prints preview/share/editor URLs
control-shopify open /products/<handle>            # real Chromium, isolated session per store, retries the proxy's 502 page
control-shopify snapshot                           # a11y tree with @eN refs (default -i -c); re-snapshot after ANY page change
control-shopify click @e12                         # act on refs; find role/text/label when refs are stale
control-shopify wait --text "Added"                # wait for a specific signal, never a bare sleep
control-shopify screenshot                         # PNG → .shopify/verify/evidence/<ts>-<title>.png (path printed)
control-shopify check-page                         # 502? empty body? broken images? uncaught errors? (exit 1 on problems)
control-shopify errors && control-shopify console              # uncaught exceptions / console (noise like [HotReload] is filtered in smoke/check-page)
control-shopify check                              # shopify theme check (Liquid + JSON lint) as JSON
control-shopify smoke                              # every configured route: open → errors → screenshot → report.{json,md}
control-shopify cleanup --keep-dev                 # close the browser session (leave the dev server for the next task)
```

Rules:
- **Never claim "verified" without evidence**: a screenshot path (or `record` video) and the `check-page`/`smoke` JSON. Quote the file paths in your report.
- **Visual fidelity comes from `--target preview`**, not the local proxy. `127.0.0.1:<port>` sometimes serves broken images and intermittently 502s; the share URL (`https://<store>/…?preview_theme_id=<dev theme id>`) renders the same development theme on the real domain. Use `dev` for fast iteration, `preview` for the screenshots you hand over, `live` only to compare against production.
- **Re-snapshot after every action**; refs die on any DOM change (drawer open, variant change, navigation).
- **Wait for the right thing**: `wait @ref`, `wait --text`, `wait --url "**/cart"`, `wait --load networkidle`, `wait --fn "<js>"`. Shopify themes patch the DOM via the Section Rendering API (`?section_id=`) — wait for the visible result, not for the request.
- **Read the Feature Map first** (`.claude/verify-shopify/features/README.md`) when you need a click path, a selector, or a gotcha. Add what you learn back to it.
- **Never push to the live theme** as part of verification. The dev theme is disposable; `theme push --unpublished` is the way to share a branch.

## 2. Targets

| target | base URL | use for |
|---|---|---|
| `dev` (default) | `http://127.0.0.1:<port>` via `shopify theme dev` | fast iteration, hot reload |
| `preview` | `https://<store>/<path>?preview_theme_id=<dev theme id>` | pixel-accurate screenshots, video, images/CDN, apps |
| `live` | primary domain (discovered by `doctor`) | before/after comparison |

`open`, `smoke` and `urls` accept `--target`. Password-protected stores: `export SHOPIFY_STORE_PASSWORD=…` — `dev start` passes it to the CLI and `open` submits `/password` automatically for preview/live.

## 3. Command reference (grouped)

- **Inspection:** `snapshot [-i -c -s <css> -u]`, `get text|html|attr|url|title|count <sel>`, `is visible|enabled <sel>`, `read`, `check-page`, `screenshot [file] [--full] [--annotate]`, `urls`
- **Navigation:** `open <path|url> [--target …]`, `back`, `reload`, `tab …`, `scroll <dir> [px]`, `scrollintoview <sel>`
- **Interaction:** `click|dblclick|hover|focus <sel|@ref>`, `fill|type <sel> <text>`, `press <Key>`, `select <sel> <value>`, `check|uncheck`, `find role|text|label|placeholder|testid <value> <action>`, `eval "<js>"` / `eval --stdin`, `cart add <variantId> [qty] | get | clear | open`
- **Performance:** `profile [/path]` (Liquid render profile, saved to evidence/), `trace start|stop`, `profiler start|stop`, `wait --load networkidle`
- **Streaming / logs:** `console [--clear]`, `errors [--clear]`, `network requests [--filter …]`, `network har start|stop`, `record start [file.webm] | stop`
- **Store / admin:** `gql '<query>' | @file [--variables …] [--allow-mutations] [--dry-run]`, `handles`, `auth`, `check`, `dev …`
- **Health & cleanup:** `doctor`, `dev status|logs|restart|stop`, `close`, `cleanup [--keep-dev]`

Anything not listed is forwarded to `agent-browser` verbatim inside the store's session (`agent-browser --help` for the full surface). Global flags: `--store`, `--port`, `--target`, `--session`, `--theme <id>`, `--dry-run`, `--headed`, `--strict`, `--json`.

Mutations are refused unless you pass `--allow-mutations`. Use `--dry-run` first to see the exact `shopify store execute` line, and say in your report which mutations you ran. See `references/admin-api.md` for recipes (menus, publications, files, inventory, pages, themes).

## 4. Recipes

**Prove a product-page change**
```bash
control-shopify dev start && control-shopify open "/products/$( control-shopify handles | node -pe 'JSON.parse(require("fs").readFileSync(0)).products[0].handle' )"
control-shopify snapshot -i -c -s "product-form-component"     # scoped snapshot of the buy form
control-shopify click @e5 && control-shopify wait --text "Added" ; control-shopify screenshot ; control-shopify check-page
control-shopify open <same path> --target preview && control-shopify screenshot   # the screenshot you hand over
```

**Reproduce a bug report** — open the route the user named, `record start`, replay their steps with `find text "…" click`, `record stop`, attach the .webm and the `errors` output.

**Perf** — `control-shopify profile /` before, apply the fix, `control-shopify profile /` after; compare `summary.totalMs` and `summary.topBySelfTime` (Liquid frames: sections, snippets, filters). Re-summarize a saved run without the network: `control-shopify profile --from .shopify/verify/evidence/<ts>-profile.json`. For the browser side: `trace start` → `open` → `trace stop`.

**Verify store data** — `control-shopify gql '{ menu(handle: "main-menu") { items { title url } } }'`; product by handle: `{ productByHandle(handle: "x") { id status variants(first: 5) { nodes { id title inventoryQuantity } } } }`.

**Cart flow without the UI** — `cart add <variantId> 1` then `cart get` (runs in the page's own session so cookies persist), then `open /cart` and screenshot.

## 5. Feature Map

Location: `.claude/verify-shopify/features/README.md` (index) + one file per surface. It is materialized memory for this store's theme: what each feature is, how a user reaches it, the DOM hooks (custom elements, `data-testid`, `ref=`, form actions), the network signals, and gotchas. Format: `references/feature-map-template.md`.

Building one for a new store:
1. `control-shopify map` — generated skeleton from the theme files (templates → section order, section groups, custom elements, routes).
2. Read `README.md`, `layout/theme.liquid`, `snippets/scripts.liquid`, the header/cart/product/collection/search sections and their JS in `assets/`. Note `data-testid`, `ref=`, `on:click="…"` handlers, form actions, `Theme.routes`, and every `customElements.define`.
3. Write the index + one file per surface following the template. Keep it terse; selectors and click paths, not prose.
4. `open` each surface once and confirm the click paths with `snapshot`.

## 6. Gotchas (learned on real stores)

- `shopify theme dev` prints nothing for 60–120 s while it uploads; `dev start` waits up to 240 s (`--wait N`). If the port is already listening it adopts that server instead of starting a second one.
- The local proxy returns **"Failed to render storefront with status 502"** intermittently, with a normal page title in agent-browser's own output. `open`/`smoke` detect it via the title and retry with backoff. Persistent 502s: `dev logs`, then `dev restart`.
- Third-party apps (reviews, rewards, chat) log noisy console lines and inject floating widgets; filter with `consoleNoise` in the config and prefer `errors` (uncaught) over `console` for pass/fail. `--strict` makes console `[error]` lines fail too.
- Sold-out products render disabled quantity/add buttons — pick a variant with `available: true` from `handles`. `available` comes from the Admin API and ignores markets/publications: the storefront can still say "Unavailable" for the viewer's country while `cart add` succeeds. Read the button text (`get text "button[name=add]"`) when the buy flow itself is under test.
- `--target preview` pages carry Shopify's preview-bar iframe (`#PBarNextFrame`), which covers the bottom of the viewport and swallows clicks; `open` removes it (`previewBarRemoved` in its output). If you navigate by clicking links instead of `open`, run `eval "document.getElementById('PBarNextFrame')?.remove()"` again.
- Storefront password pages, store redirects to a custom primary domain, and `preview_theme_id` cookies all persist in the session; `close`/`cleanup` resets everything.
- agent-browser's default (unnamed) session is shared machine-wide. This tool always uses `verify-<store prefix>`; pass `--session` to run two stores side by side (with different `--port`s).
- `shopify theme check` needs the theme root as cwd; the CLI runs it from the repo root it found (`.claude/verify-shopify.json` or `.git`).
- Shopify CLI network calls (`store execute`, `theme profile`, `theme dev` uploads) intermittently time out to Shopify's edge (`connect ETIMEDOUT …:443`) on some networks while the browser is fine. `handles`, `smoke` and `doctor` retry three times; if `profile` or `gql` fails with that error, just re-run it.
- Never run `theme push` / `theme publish` from a verification session; `dev` uploads to the development theme only.

## 7. Maintain this skill

Run weekly, or whenever a verification step surprised you:
1. `control-shopify doctor` — fix anything red (token, scopes, missing binaries).
2. `control-shopify map` and diff `README.generated.md` against the hand-written Feature Map; add new sections/elements, delete removed ones.
3. `control-shopify smoke --target preview` — every route green; new routes go into `routes` in the config.
4. Add new gotchas to the Feature Map and to §6 above. Prune `consoleNoise`.
5. If a command in `control-shopify.mjs` had to be worked around by hand, fix the command — agents should run a CLI command, not write throwaway scripts.

References: `references/browser-tooling.md` (why agent-browser; obscura findings; headless-Chrome fallback), `references/storefront-routes.md` (Shopify URL/AJAX/Section Rendering map), `references/admin-api.md` (scopes + GraphQL recipes), `references/feature-map-template.md`.
