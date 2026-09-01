# Feature Map template

Keep one `README.md` index plus one file per surface in `.claude/verify-shopify/features/`. Terse; selectors and click paths, not prose. Everything here is a token-saver for an agent that has to drive the page.

## README.md (index)

```markdown
# Feature Map — <store> (<theme name> <version>)

| Surface | File | Reach |
|---|---|---|
| Header, menu, search, cart trigger | header.md | every page |
| Home | home.md | `/` |
| Product page | product.md | `/products/<handle>` |
| Cart drawer + cart page | cart.md | header cart button, `/cart` |
| Collection + filters | collection.md | `/collections/<handle>` |
| Search | search.md | header search, `/search?q=` |
| … | … | … |

Global hooks: body classes, `Theme.routes`, overlays that block clicks on load, app widgets.
Custom elements: see README.generated.md (from `control-shopify map`).
```

## <surface>.md

```markdown
# <Surface name>

One-line description.

## Sub-features
- <id>: what it is (element/selector)
- …

## How to get to it (user POV)
Click path or URL. Mention viewport/touch dependencies.

## Driving it with control-shopify
control-shopify open /path
control-shopify snapshot -s "<root selector>"
control-shopify click "<selector or @ref>"
control-shopify wait --text "…"

- Root: `<custom-element>` / `#id`
- Key hooks: `data-testid=…`, `ref=…`, `on:click="…"`, form action
- Network signal: `POST /cart/add.js`, `?section_id=…`
- Events: `cart:update`, `dialog:open` …

## Gotchas
- Overlay X blocks clicks until `[data-done]`
- Disabled when product sold out
```
