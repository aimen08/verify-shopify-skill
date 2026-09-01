# Shopify storefront map (theme-agnostic)

## Routes → templates

| Route | Template | Notes |
|---|---|---|
| `/` | `index` | |
| `/collections` | `list-collections` | |
| `/collections/all` | `collection` | always exists |
| `/collections/<handle>` | `collection` | `?sort_by=`, `?filter.v.price.gte=`, `?filter.v.availability=1`, `?page=2` |
| `/products/<handle>` | `product` | `?variant=<id>` preselects a variant; `.js` suffix returns product JSON (`/products/<handle>.js`) |
| `/collections/<c>/products/<p>` | `product` | collection-scoped |
| `/cart` | `cart` | |
| `/search?q=<term>&type=product` | `search` | `type` ∈ product, article, page |
| `/blogs/<blog>` / `/blogs/<blog>/<article>` | `blog` / `article` | |
| `/pages/<handle>` | `page` or `page.<suffix>` | suffix is set on the page in admin (`templateSuffix`) |
| `/password` | `password` | only when storefront password is on |
| `/gift_cards/<shop_id>/<code>` | `gift_card` | |
| `/policies/<handle>` | policy | refund-policy, privacy-policy, terms-of-service, shipping-policy |
| `/account`, `/account/login` | new customer accounts (Shopify-hosted) on modern themes | redirects off-theme |
| `/<anything>` | `404` | |
| `/localization` (POST) | — | country/language switch form |
| `/contact` (POST) | — | contact + newsletter forms (`form 'contact'` / `'customer'`) |

## AJAX endpoints (same-origin, cookie session)

| Endpoint | Method | Body / notes |
|---|---|---|
| `/cart.js` | GET | current cart JSON |
| `/cart/add.js` | POST JSON | `{ "items": [{ "id": <variantId>, "quantity": 1 }], "sections": "cart-drawer,…" }` |
| `/cart/change.js` | POST JSON | `{ "id": "<line key>" or "line": 1, "quantity": 0 }` |
| `/cart/update.js` | POST JSON | `{ "note": "…", "attributes": {…}, "updates": {…} }` |
| `/cart/clear.js` | POST | empties the cart |
| `/search/suggest.json?q=…&resources[type]=product` | GET | predictive search JSON |
| `/products/<handle>.js` | GET | product + variants JSON |
| `/recommendations/products?product_id=…&limit=4&intent=related` | GET | |

`control-shopify cart add|get|clear` wraps the first three inside the page session.

## Section Rendering API

Any storefront URL accepts `?section_id=<section id>` (one section's HTML) or `?sections=a,b` (JSON map of several). Horizon-generation themes use this for variant changes, facets, sorting, predictive search and cart updates, then morph the DOM. For verification: wait for the **visible** result (`wait --text`, `wait @ref`), or `network requests --filter section_id` to see that the request fired.

## Theme preview & editor

- Development theme: `shopify theme dev` uploads to a per-developer theme and proxies it at `http://127.0.0.1:9292` (hot reload; `[HotReload]` console noise is normal).
- Any theme can be previewed on the real domain with `?preview_theme_id=<theme id>`; Shopify sets a cookie so subsequent pages stay on that theme until the session ends. `control-shopify open --target preview` adds the param on every navigation anyway.
- Editor: `https://<store>.myshopify.com/admin/themes/<id>/editor`. In the editor the page runs with `window.Shopify.designMode === true` and `<html class="shopify-design-mode">`; themes fire `shopify:section:load`, `shopify:block:select`, etc.
- `window.Shopify.theme` → `{ id, name, role: 'main' | 'unpublished' | 'development', schema_name, schema_version }` — `check-page` reports it so you can prove which theme rendered.

## Useful globals in the page

- `Shopify.shop`, `Shopify.currency`, `Shopify.locale`, `Shopify.country`, `Shopify.routes.root`
- Theme-specific `Theme.routes` / `theme.routes` objects usually expose `cart_add_url`, `predictive_search_url`, `search_url`.
- `document.body.classList` often encodes the template (`template--<suffix>` on this store's theme).

## Common verification signals

- Product added: `POST /cart/add.js` → 200 and cart bubble count increments; drawer opens (`theme-drawer#cart-drawer[open]` on Pitch/Horizon).
- Variant switched: URL gains `?variant=`; price node text changes; `input[name=id]` value changes.
- Filters applied: URL query updates via `history.pushState`; results count node changes.
- Storefront error page: `[role=alert]` containing "Failed to render storefront" (local proxy only).
