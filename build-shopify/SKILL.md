---
name: build-shopify
description: Build Shopify themes and store content with concrete commands instead of guesses — scaffold a theme or section, read and rewrite navigation menus, upload images to the store CDN, create and update pages, list real product/collection/page handles, push to an unpublished theme, and profile Liquid render cost. Use when authoring or changing a Shopify theme, adding a section or landing page, wiring menus, or shipping theme work. Pairs with verify-shopify, which proves the result renders.
allowed-tools: Bash(control-shopify:*), Bash(node /Users/mac/.claude/skills/verify-shopify/control-shopify.mjs:*), Bash(shopify:*), Bash(agent-browser:*)
---

# build-shopify

Building half of the loop. `verify-shopify` proves a change renders; this proves you never had to guess a handle, a menu shape, an image URL or a schema key to make it.

Same binary, same config, same auth: **`control-shopify`**. `control-shopify help` lists everything.

Every write is gated: `--dry-run` prints the exact mutation, `--yes` executes. Pushing to the **published** theme is refused outright without `--live --yes`. Never write to a live store without the user's explicit approval on that specific change.

## Start here — one command

```bash
control-shopify setup --store <shop>.myshopify.com [--port 9302]
```

It writes the repo config, checks the admin token and its scopes, checks the theme session, and prints exactly what a human still has to do. Two things need a browser and cannot be completed from an agent shell — hand them to the user with the `!` prefix so they run in their terminal:

```
! control-shopify auth --build                      # admin token (menus, files, pages, themes)
! shopify theme list --store <shop>.myshopify.com   # theme session, if setup says it is stale
```

`auth` **merges** with the scopes already on the token, so re-authing can never revoke something granted for other work. Then:

```bash
control-shopify dev start
```

## Know the store before you build

Guessing handles is the single biggest source of wasted work. Ask instead:

```bash
control-shopify products list --limit 10 --query "status:active"   # handles, SKUs, variant ids, stock
control-shopify collections list --query "title:duffle"
control-shopify pages list --all                                   # handle + templateSuffix
control-shopify nav list && control-shopify nav get main-menu      # real menu shape
control-shopify files list --limit 10                              # what is already on the CDN
control-shopify gql '{ shop { name currencyCode } }'               # anything else
```

`products list` returns variant ids too — that is what `cart add` and bundle wiring need.

## Author

```bash
control-shopify theme new <name> [--clone <git url>]   # scaffold (Dawn by default)
control-shopify section new "Hero Banner"              # sections/hero-banner.liquid + schema + preset
control-shopify snippet new price-badge                # snippets/price-badge.liquid
```

The section scaffold gives you the parts that are easy to get subtly wrong: a `{% schema %}` with settings, a block type, a `presets` entry so it appears in the theme editor, and id-scoped CSS (`#hero-banner-{{ sid }}`) so two instances on one page cannot collide.

Then wire it into a template's JSON (`templates/*.json` → `sections` + `order`) or a section group.

For Liquid semantics — objects, filters, schema key reference — use the `shopify-liquid` skill; this one does not duplicate it.

## Store content

```bash
# Navigation
control-shopify nav get main-menu > menu.json          # edit the items array
control-shopify nav set main-menu --items @menu.json --dry-run
control-shopify nav set main-menu --items @menu.json --yes

# Images -> CDN
control-shopify files upload hero.jpg card.jpg --alt "Hero||Card" --dry-run
control-shopify files upload hero.jpg card.jpg --alt "Hero||Card" --yes

# Pages (a page.<suffix> template needs a real page behind it)
control-shopify pages create summer-sale --title "Summer Sale" --template-suffix summer-sale --yes
control-shopify pages update summer-sale --body @body.html --yes
```

`files upload` runs the whole chain — `stagedUploadsCreate` with `httpMethod: PUT`, the upload, `fileCreate`, then polling until every file is `READY`. Two rules it enforces because both have cost real time:

- **Alt text must be unique per upload.** Returned GIDs are mapped back by alt; two files sharing one alt silently cross-wire. Pass `--alt "A||B||C"`.
- **Never reference a file before `fileStatus: READY`.** Flipping a template to point at a still-processing image leaves a live page rendering broken images.

## Ship

```bash
control-shopify theme share            # push an UNPUBLISHED copy, prints its preview URL
control-shopify theme push --theme <id>
control-shopify theme pull             # pull the dev theme back down
```

`theme share` is the safe default for handing work over. Publishing is a deliberate act — do it in the admin, or `--live --yes` with the user's explicit say-so.

## Then prove it

Building is not done until it renders. Hand off to `verify-shopify`:

```bash
control-shopify verify <spec> --screenshot                    # desktop
control-shopify verify <spec> --viewport 390x844 --screenshot # mobile
control-shopify verify --all                                  # the whole suite
control-shopify check                                         # theme check, scoped to your changes
control-shopify profile /products/<handle>                    # Liquid render cost
```

Write a spec for every surface you build — it costs a minute and becomes the regression test for the next change.

## Gotchas

- **Pin the market.** The dev proxy geolocates from the machine's IP and can render a different market than live. `product.available` is market-dependent, so a section gated on it can vanish on dev and be fine on live. Set `country` in the config and specs.
- **Section settings absent from a template JSON fall back to the schema default**, not to nil. A checkbox with `"default": true` is on until the JSON says otherwise.
- **Richtext settings already contain `<p>`.** Wrapping one in your own `<p>` makes the parser auto-close it, and the text lands in an unstyled sibling. Use a `<div>`.
- **`availableForSale` is Storefront-only.** In Admin queries use `status` + `totalInventory`, or variant `inventoryQuantity`.
- **Metafield filters fail open.** `products(query: "metafields.x.y:true")` can return the entire catalogue. Always run a control query.
- **A missing scope reads as a generic API failure.** The CLI detects it and tells you to run `auth --build`; believe it rather than rewriting the query.
- Theme JSON templates are rewritten by Shopify's editor, so a live template will never md5-match your local copy. Compare them semantically.

Reference: `~/.claude/skills/verify-shopify/references/admin-api.md` (scopes, fixture-finding, staged uploads), `storefront-routes.md` (routes, AJAX cart, Section Rendering).
