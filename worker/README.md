# Rich link previews

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

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
   (Workers free tier: 100k requests/day).
2. Make an API token: dash → My Profile → API Tokens → **Create Token** →
   template **Edit Cloudflare Workers**.
3. Find your Account ID (dash → Workers & Pages → right-hand sidebar).
4. Add both as repository secrets (repo Settings → Secrets and variables →
   Actions): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run the **deploy-worker** workflow from the Actions tab. It prints the
   worker URL — typically `https://chessmate.<your-subdomain>.workers.dev`.

Play from that URL (bookmark it / add to home screen) and every move link
you send carries a live board preview. The workflow re-deploys automatically
when `worker/` changes on `main`.

## Development

```sh
node test/worker-tests.mjs        # PNG encoder, OG tags, routing — no deploy needed
npx wrangler dev                  # local worker at http://localhost:8787 (needs npm)
```

`sprites.generated.mjs` is committed; regenerate it only if the piece art
changes: `NODE_PATH=$(npm root -g) node worker/bake-sprites.js` (needs
Playwright Chromium — the sprites are rendered from the app's exact glyph
styling).
