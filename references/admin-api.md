# Admin API via Shopify CLI

`control-shopify gql` wraps `shopify store execute --store <store> --query … --json`. Reads run as-is; **mutations need `--allow-mutations`** and should be dry-run first:

```bash
control-shopify gql '{ shop { name primaryDomain { url } } }'
control-shopify gql @query.graphql --variables '{"handle":"main-menu"}'
control-shopify gql 'mutation … ' --allow-mutations --dry-run     # prints the exact shopify command
```

Pin an API version with `--version 2025-10` when a recipe depends on it. Validate a query before running it with the Shopify dev MCP tools (`validate_graphql_codeblocks`) or `shopify-plugin:shopify-admin` skill if available.

## Scopes

| Scope | Unlocks |
|---|---|
| `read_products` / `write_products` | Product, ProductVariant, Collection (+ `*_purchase_options` for selling plans) |
| `read_inventory` / `write_inventory` + `read_locations` | InventoryLevel, `inventorySetQuantities`, Location |
| `write_publications` | `publishablePublish` (publish products/collections to Online Store) |
| `write_files` | `stagedUploadsCreate`, `fileCreate` (Files → theme images/videos) |
| `read_online_store_navigation` / `write_online_store_navigation` | `menus`, `menu`, `menuCreate`, `menuUpdate`, `menuDelete` |
| `write_content` | pages, blogs, articles (`pageCreate` with `templateSuffix`) |
| `read_themes` / `write_themes` | themes list, `themeFilesUpsert` — not requested by default; the theme CLI has its own auth |

`shopify store auth` issues a token for exactly the scopes requested (re-auth replaces). `control-shopify doctor` reads the granted list via `currentAppInstallation { accessScopes { handle } }`.

## Recipes

### Finding fixtures (the main event)

Most verification time goes on "which product actually exercises this branch?". Batch-query candidates by handle rather than guessing:

```graphql
fragment H on Product {
  handle title status totalInventory templateSuffix
  metafield(namespace: "custom", key: "bundle_partners") {
    references(first: 10) { nodes { ... on Product { handle status totalInventory } } }
  }
}
{ p0: productByHandle(handle: "a") { ...H }  p1: productByHandle(handle: "b") { ...H } }
```

Forty aliases per request is fine. Then simulate the Liquid branch over the result to pick the fixture that actually reaches the code you changed.

- **`availableForSale` is Storefront-only.** In Admin queries use `status` + `totalInventory`, or variant `inventoryQuantity` / `inventoryPolicy`.
- **Metafield filters fail open.** `products(query: "metafields.custom.x:true")` can silently return the entire catalogue. Always run a control query before trusting a filtered count.
- Products by template: `products(first: 250, query: "template_suffix:amazon status:active")`.

### Proving a theme carries your code

```graphql
{ theme(id: "gid://shopify/OnlineStoreTheme/<id>") {
    name role
    files(filenames: ["snippets/x.liquid","templates/y.json"], first: 10) {
      nodes { filename checksumMd5 body { ... on OnlineStoreThemeFileBodyText { content } } }
    } } }
```

md5 `content` against the local file. Liquid matches byte-for-byte. **JSON templates never will** — Shopify rewrites their formatting — so parse both and compare flattened key paths instead. `themes(first: 5, roles: MAIN)` finds the published theme; the dev theme id is in `.shopify/verify/dev.json`.

### Products & variants
```graphql
{ productByHandle(handle: "x") { id title status onlineStoreUrl variants(first: 10) { nodes { id title sku price availableForSale inventoryQuantity } } } }
{ products(first: 5, query: "status:active") { nodes { handle title } } }
```
Publish to Online Store: `{ publications(first: 5) { nodes { id name } } }` → `mutation { publishablePublish(id: "gid://shopify/Product/…", input: [{ publicationId: "gid://shopify/Publication/…" }]) { userErrors { message } } }`.

### Inventory
```graphql
{ locations(first: 5) { nodes { id name } } }
mutation { inventorySetQuantities(input: { name: "available", reason: "correction", ignoreCompareQuantity: true,
  quantities: [{ inventoryItemId: "gid://shopify/InventoryItem/…", locationId: "gid://shopify/Location/…", quantity: 10 }] })
  { userErrors { field message } } }
```
Inventory item id: `productVariant(id: …) { inventoryItem { id } }`.

### Pages (for `page.<suffix>` templates)
```graphql
mutation { pageCreate(page: { title: "Launch", handle: "launch", templateSuffix: "launch", isPublished: true }) { page { id handle } userErrors { message } } }
{ pages(first: 20) { nodes { id handle title templateSuffix } } }
```

### Files
1. `stagedUploadsCreate(input: [{ resource: FILE, filename: "hero.jpg", mimeType: "image/jpeg", httpMethod: POST }])` → upload with curl to the returned URL + parameters.
2. `fileCreate(files: [{ originalSource: "<resourceUrl>", contentType: IMAGE, alt: "…" }])`.
3. Poll `{ files(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { ... on MediaImage { image { url } } fileStatus } } }`.

### Themes
```graphql
{ themes(first: 20) { nodes { id name role createdAt } } }
```
Use `shopify theme list --json` for the same without extra scopes.
