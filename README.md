# ChessMate ♟

Correspondence chess played over links in your texts. No app to install, no
account, no server — the entire game travels inside the URL.

Each move produces a link. Send it in iMessage (or SMS, RCS, WhatsApp,
email — anything that carries a URL); your opponent taps it, sees the live
board, plays, and sends the next link back. The message thread is the game
record.

| Start a game | A link arrives — your move | Send it like a text | Checkmate |
| --- | --- | --- | --- |
| ![Landing screen](docs/screenshots/1-landing.png) | ![Your move view](docs/screenshots/2-your-move.png) | ![Staged move with send panel](docs/screenshots/3-send.png) | ![Checkmate in dark mode](docs/screenshots/4-checkmate.png) |

## Play

1. Open **https://wtk2017.github.io/chess-v2/** on your phone.
2. **Start a game** and make White's first move — or **send an invite** so the
   other player takes White.
3. Tap **Send your move…** and pick the chat.
4. Your opponent taps the link, moves, and sends theirs back. Repeat.

Draw offers ride along with a move; resignation and rematch are one tap
(rematch alternates colors). Checkmate, stalemate, the fifty-move rule,
threefold repetition, and dead positions are declared automatically.

**Hosting:** the site is static files at the repo root. For GitHub Pages, run
the **deploy-pages** workflow from the Actions tab once (it enables Pages
itself and re-deploys on every push to `main`). Any static host works;
`https://raw.githack.com/wtk2017/chess-v2/main/index.html` serves it with no
setup at all.

## Features

- Full rules enforcement: legality (castling, en passant, promotion and
  underpromotion), check, and every game-ending condition
- Tap-to-move board with legal-move hints, automatic orientation, a
  move-history browser, and a captured-material bar
- SAN move list and FEN readout; draw/resign/rematch etiquette built in
- Every incoming link is re-validated by replaying its full move list through
  the engine — tampered or corrupt links are rejected, and illegal moves
  cannot be expressed or transmitted
- Links you have sent reopen on your device as a read-only "waiting" view
  (with an override for pass-and-play)
- Light and dark mode; no dependencies, no build step

## How it works

The URL fragment carries the whole match:

```
https://…/#v=1&m=e2e4,e7e5,g1f3&do=w
            │  │                └─ White offers a draw with this move
            │  └─ full UCI move list — the game itself
            └─ format version
```

`rb=` marks a resignation; `da=` an agreed draw, its value naming the
accepting side. Fragments are never sent to the server, so the host sees no
game data; a 100-move game still encodes in under 1 KB. The full protocol is
specified in [DESIGN.md](DESIGN.md), along with the design rationale and the
alternatives that were considered.

### Rich link previews (optional)

Message apps build previews without the `#fragment` and without running
JavaScript, so links from the static site show a generic card. Deploying the
included [link-preview worker](worker/README.md) (Cloudflare free tier, ~5
minutes, zero dependencies) upgrades every link sent from its URL to a
rendered image of the actual position plus a caption like *"♟️ 12… Nf6 —
your move"*. Games played through the worker use a `?g=` query form of the
same payload; the fragment form stays canonical and both open everywhere.

## Repository

| Path | Contents |
| --- | --- |
| `index.html`, `app.js` | The app — static, dependency-free |
| `engine.js` | Rules engine: legality, SAN, FEN, verdicts, link codec; runs in browser and Node |
| `test/` | Engine suite (perft against the six standard reference positions, plus rules/SAN/codec checks) and a headless-Chromium test that plays full games through real generated links |
| `tools/imessage-referee.py` | Optional macOS bot that referees a group chat from texted moves (experimental) |
| `DESIGN.md` | Design notes, wire protocol, trade-offs |

## Development

```sh
node test/run-tests.js               # engine: perft + rules + codec  (~1s)
PERFT_DEEP=1 node test/run-tests.js  # adds ~9M-node deep perft       (~30s)

npm i playwright && npx playwright install chromium
node test/smoke.js                   # browser: 19 end-to-end scenarios
```

CI runs both suites on every push.

## Limitations

- **Honor system.** Opening a live link seats you as the side to move; there
  are no accounts, so identity is trust between players. Tampering is
  detectable (every link re-validates, and the thread preserves history) but
  not prevented.
- **One link per move.** The thread is the game log; there is no
  self-updating message bubble.
- Link previews show a generic card, not the board position.
