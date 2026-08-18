# Rich link previews

> **Live for this repo:** https://chess-v2.williamkilgallin.workers.dev —
> deployed via Cloudflare Workers Builds connected to this repository, so
> every push to `main` redeploys automatically. (The worker name `chess-v2`
> in `wrangler.toml` matches the connected project's name.)

iMessage (and every other messenger) builds a link preview by fetching the
URL **without its `#fragment`** and **without running JavaScript** — so the
static app can only ever show a generic card. This worker is the thin
dynamic layer that upgrades the preview to the actual board:

```
https://<worker-url>/?g=v%3D1%26m%3De2e4     ← query-string form of the payload
        │
        ├── serves the same app (proxied from GitHub Pages), with
        │   per-position og:title ("♟️ 1. e4 — your move") and og:image
        └── /og.png?g=…  ← the board, rendered by the worker itself
```

The board PNG is composed from pre-baked RGBA sprites and encoded with zero
dependencies (`CompressionStream` provides the zlib layer). Payloads are
validated by full replay through the same `engine.js` the app ships — an
illegal history gets no preview and no board.

When the app is served through the worker it sees an injected
`<meta name="chessmate-rich-links">` and emits `?g=` links; served from
GitHub Pages it keeps the `#fragment` form. The fragment form stays
canonical and private (fragments never reach any server) — `?g=` is the
opt-in that trades host-visible state for rich previews. Either form opens
fine on either host.

## Deploy (free, ~5 minutes, once)

The way this repo is deployed — **Cloudflare Workers Builds** (no secrets
to manage):

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
   (Workers free tier: 100k requests/day).
2. Dash → Workers & Pages → Create → **Import a repository** → pick this
   repo.
3. Settings: build command *empty*, deploy command `npx wrangler deploy`,
   **Path `/worker`**, API token auto-created, no variables.
4. Deploy. Cloudflare prints the worker URL and re-deploys on every push to
   the production branch.

Alternative, secrets-based route: add `CLOUDFLARE_API_TOKEN` (template
*Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID` as repository
Actions secrets and run the **deploy-worker** workflow — it no-ops politely
until the secrets exist.

Play from the worker URL (bookmark it / add to home screen) and every move
link you send carries a live board preview.

## Development

```sh
node test/worker-tests.mjs        # PNG encoder, OG tags, routing — no deploy needed
npx wrangler dev                  # local worker at http://localhost:8787 (needs npm)
```

`sprites.generated.mjs` is committed; regenerate it only if the piece art
changes: `NODE_PATH=$(npm root -g) node worker/bake-sprites.js` (needs
Playwright Chromium — the sprites are rendered from the app's exact glyph
styling).
