# Browser tooling decision record

## Choice: agent-browser (real Chromium, CLI)

`control-shopify` drives the storefront through [agent-browser](https://www.npmjs.com/package/agent-browser) (`npm i -g agent-browser && agent-browser install`). Reasons, measured on a live Shopify storefront (2026-09-01, macOS arm64):

| | agent-browser | Chrome MCP (claude-in-chrome) | obscura 0.2.1 |
|---|---|---|---|
| Engine | real Chromium (CDP) | the user's real Chrome | independent Rust engine |
| Open live storefront | 4.8 s | ~similar, but tool-call round trips | **failed** (request stalls after TLS, 30 s deadline, plain and `--stealth`) |
| Screenshot | 0.15 s, PNG path | image returned inline into the context | works on simple pages (example.com) |
| Page model for the agent | a11y tree with `@eN` refs (~200–400 tokens) | screenshots + read_page | `--dump text/html/markdown` |
| Isolation | named sessions, parallel browsers | shares the user's tabs/profile | per-process |
| Isolated from the user's browser | yes | no | yes |
| Scriptable from a CLI | yes (the whole point) | no, MCP tool calls only | yes |

Why it beats Chrome MCP for verification: every step is a shell command, so it composes and scripts, does not touch the user's own tabs, and costs a fraction of the tokens (ref-based snapshots instead of screenshots-as-context). Chrome MCP stays useful when you need the user's logged-in browser (e.g. the Shopify admin UI).

## Why not obscura / obscura-worker

- `obscura-worker` is not a separate viewer; it is the worker binary for the parallel `obscura scrape` command. Rendering (screenshots, screencast, PDF) lives in `obscura` itself in the render-enabled builds.
- The build in this repo does render (`obscura fetch https://example.com --screenshot x.png` → 1280×720 PNG in 0.18 s), and it can screenshot a Shopify storefront, but on this machine 4 of 5 fetches of the store timed out after the TLS handshake (`error sending request for url` / `navigation exceeded deadline`, with and without `--stealth`, with a Chrome UA, raw `--dump original` too). The Shopify CLI's own node fetch showed the same intermittent `ETIMEDOUT 23.227.38.74:443` while curl and Chromium never failed, so part of this is the local network path, not obscura alone — but agent-browser was reliable throughout and obscura was not.
- The one successful obscura render of the home page had a **visibly wrong layout**: the primary menu rendered as a vertical bulleted list, the header actions were misplaced, the hero video/poster was missing (solid black), the CTA button lost its styling. An independent engine is the wrong instrument for *visual* verification of a Horizon-generation theme (container queries, `svh` units, `<dialog>`, scroll-snap, view transitions, web components): "long-tail CSS may differ from Chromium" means the screenshot is wrong in exactly the places you are checking.
- Keep it in mind for what it is good at: fast parallel text/HTML extraction of public pages, with `--allow-private-network` for localhost.

## Fallback: headless Chrome one-liner

If agent-browser is unavailable, the system Chrome renders the storefront correctly in ~7 s:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1280,720 --virtual-time-budget=8000 --screenshot=/tmp/page.png "https://<store>/?preview_theme_id=<id>"
```

No interaction, no console — evidence only.

## agent-browser essentials used by control-shopify

- `AGENT_BROWSER_SESSION=verify-<store>` isolates cookies/tabs per store; `AGENT_BROWSER_DEFAULT_TIMEOUT` (ms) bounds each action (default here 45000 because Shopify storefronts keep `load` pending with video/analytics; `open` may report a timeout while the page is actually ready, so `control-shopify open` checks `get title` afterwards).
- `snapshot -i -c` (interactive, compact), `-s <css>` to scope, `-u` to include hrefs, `--json` for machines.
- `find role button click --name "Cart"` when refs are stale.
- `eval --stdin` for any JS with quotes; promises are awaited.
- `agent-browser skills get core --full` prints the version-matched manual.
