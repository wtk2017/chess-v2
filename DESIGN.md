# ChessMate v2 — design

**Goal:** the ChessMate experience — correspondence chess that lives inside your
texts — playable **today**, between **two real iPhones over iMessage**, with
**zero dollars to Apple** and nothing to install.

This document records the study of v1, the options considered, and the design
that was built.

---

## 1. What v1 is, and where it stops

[wtk2017/chess](https://github.com/wtk2017/chess) ("ChessMate") is a native
**iMessage app extension**: a Swift rules engine plus a Messages UI that
encodes the entire match into an `MSMessage` payload URL —
`?v=1&m=e2e4,e7e5&w=<uuid>&b=<uuid>` — so the game travels inside the bubble
with no server and no clock. The engine is verified by perft against the six
community-standard reference positions.

The architecture is genuinely good. The problem is purely **distribution**:

| Path to a friend's phone | Cost | Verdict |
| --- | --- | --- |
| iPhone Simulator | free | works, but it's not your friends |
| Sideload with a free "Personal Team" | free | **your own** devices only, re-signed every 7 days, and the other player would need a Mac + cable too |
| TestFlight | **$99/yr** Apple Developer Program | the intended route |
| App Store | **$99/yr** + review | same gate |
| App Clips, custom Messages stickers, etc. | $99/yr | every native distribution door is the same door |

There is no free way to put an iMessage *extension* on two arbitrary iPhones.
That is the constraint v2 designs around — and v1 saw it coming: its
`MatchState.defaultBaseURL` comment reserves room for "a future web viewer for
non-iMessage recipients," and its README calls a link-playable web app "a
different, also-buildable dream." v2 is that dream, promoted from fallback to
the main act.

## 2. The insight: iMessage already ships our transport

Strip an iMessage app to its essentials and it is three things:

1. a **payload** riding inside a message (the `MSMessage` URL),
2. a **renderer** for that payload (the extension UI),
3. Apple's **transport and human send gesture**.

Only #2 needs Apple's permission slip. Payloads (#1) can ride in the one thing
every messaging app renders for free — **a URL** — and the renderer can be a
web page that reads it. Apple's own design even nudges this way: an MSMessage
*is* a URL; v1 already serialized the whole match into a query string.

So v2 keeps v1's payload design nearly byte-for-byte and swaps the renderer:

```
v1:  MSMessage(session).url = ?v=1&m=e2e4,e7e5&w=<uuid>&b=<uuid>
v2:  https://<pages-host>/chess-v2/#v=1&m=e2e4,e7e5
```

A move is made on the web board; the app produces the next link; the player
sends it **in Messages themselves** (the share sheet is v2's version of v1's
"Apple requires the human to hit send"); the opponent taps it and the page is
their board. The iMessage thread is the game log, the "database," and the
notification system — exactly v1's serverless philosophy, minus the $99 door.

## 3. Options considered

| Option | Runs today? | Two phones over iMessage? | Cost | Notes |
| --- | --- | --- | --- | --- |
| **A. Link-based web board** (chosen) | ✅ | ✅ (link per move) | $0 | Static page on GitHub Pages; state in the URL fragment; no server, no accounts. Bonus: green bubbles (Android/SMS/RCS/WhatsApp) can play too — v1 could never do that. |
| **B. Referee bot in the group chat** (shipped as optional extra) | ✅ with a Mac | ✅ (three-way group chat) | $0 | A Mac in the chat polls its Messages database, validates texted moves ("e4"), and replies with the updated board + link. Real, but needs an always-on Mac with Full Disk Access, and AppleScript group-chat sending is fragile across macOS versions. Right shape for a club chat; wrong shape as the *primary* design. |
| C. Pure manual: text SAN, keep board elsewhere | ✅ | ✅ | $0 | The 1800s called; it works. No validation, no shared board state — this is what A automates away. |
| D. Sideload v1 via free provisioning | partially | ❌ | $0 | 7-day expiry, your own devices only; the opponent's phone is unreachable without their Mac. |
| E. TestFlight / App Store for v1 | ✅ | ✅ | **$99/yr** | The rejected premise. Remains the endgame if native polish ever justifies the fee. |

**Why A wins:** it is the only option that is simultaneously free, immediate,
two-sided, and validated. It also *contains* C (the link is readable text) and
composes with B (the bot posts A's links so the group taps into a graphical
board).

## 4. The chosen design

### 4.1 Architecture

```
┌─ iPhone A ────────────────┐        iMessage         ┌─ iPhone B ────────────────┐
│ Safari: index.html        │  "♟️ 3. Nf3 — your move │ taps the link             │
│  engine.js replays m=...  │   https://…/#v=1&m=…"   │  engine.js replays m=...  │
│  tap a move → new link ───┼────────────────────────▶│  tap a move → new link ───┼──▶ …
└───────────────────────────┘                         └───────────────────────────┘
```

- **Static site, no build step**: `index.html` + `app.js` + `engine.js`.
  Hosted on GitHub Pages (free, HTTPS). Any static host works; the page also
  runs from a local file.
- **State in the URL fragment (`#`)**, not the query string: fragments never
  leave the device in HTTP requests, so even the static host sees no game data.
  Nothing is stored anywhere except the Messages thread itself.
- **Trust by replay** (v1's rule, kept): every incoming payload is replayed
  move-by-move through the rules engine. Illegal or corrupt links land on an
  error screen, never on a wrong board.
- **The human sends**: the app stages the move and offers the share sheet /
  copy / `sms:` composer. Nothing is "official" until the link is delivered —
  same contract as v1's staged `MSMessage`, and undo works until you send.

### 4.2 Wire protocol (v2.1, compatible with v1)

Grammar of the fragment payload:

```
payload   = "v=" version *( "&" field )
field     = "m=" move *( "," move )      ; full UCI move list from the start position
          / "do=" color                  ; draw offered by (rides with the offerer's move)
          / "rb=" color                  ; resigned by
          / "da=" ( color / "1" )        ; draw agreed, by whom ("1" = legacy, accepter unknown)
color     = "w" / "b"
move      = <UCI: from square, to square, optional promotion piece>  ; e2e4, e7e8q
```

Examples:

```
#v=1                              a fresh game (also the rematch invite)
#v=1&m=e2e4                       after 1. e4
#v=1&m=e2e4,e7e5,g1f3&do=w        White played 2. Nf3 and offers a draw
#v=1&m=…&rb=b                     Black resigns
#v=1&m=…&da=w                     draw agreed (White accepted)
```

Design properties, all inherited from v1's codec:

- **The full move list, not a snapshot.** This is what makes replay
  validation, threefold repetition, SAN captions, and future PGN export
  possible. A 100-move game is still well under 1 KB — nothing to a URL.
- **Unknown keys are ignored**, so the format is forward-extensible — and a
  v1 bubble payload (which adds `w=`/`b=` seat UUIDs) decodes in v2 unchanged.
- **Automatic verdicts.** Checkmate, stalemate, the fifty-move rule, threefold
  repetition, and dead positions are declared by the engine; resignation and
  agreed draws are explicit flags. Correspondence chess has no arbiter to
  claim to (v1's phrase, v1's exact rules).

### 4.3 Seats and turns without device identity

v1 used per-device participant UUIDs to answer "am I white, black, or
watching?". The web has no such identity — by design, since identity is what
drags in accounts and servers. v2's rule is simpler:

> **Opening a live game link seats you as the side to move.** Whoever makes
> the first move claims White (v1's rule, kept). Anyone else who taps the link
> is looking at the same board and can spectate; the thread's reply order is
> the seat assignment.

Consequences, stated honestly:

- Between friends this is exactly correspondence chess by postcard: the
  **honor system**, with full tamper *detection* (any rewritten history is a
  different link, and the thread preserves every prior link as evidence) but
  no tamper *prevention*. v1's UUIDs were device-scoped and spoofable in
  spirit too; neither version pretends to be anti-cheat.
- One follow-on simplification: in v1 a draw offer was its own sessionless
  update; in v2 a draw offer **rides with a move** (`do=` set when staging),
  because a moveless update would flip the "side to move = viewer" rule.
  Offering a draw with your move is also just… how chess etiquette works.
  Moving after receiving an offer declines it automatically.
- No "one live bubble per game": v1 reused an `MSSession` so the conversation
  showed a single updating card. Plain links can't do that — each move is a
  new message. The thread-as-scrollable-game-history turns out to read fine,
  and the etiquette caption ("♟️ 12… Nf6 — your move.") makes each bubble
  meaningful on its own.

### 4.4 The engine

`engine.js` is a dependency-free port of v1's Swift engine (0x88 board,
clone-and-apply legality): full legality including castling through/out of
check, en-passant pins, and underpromotion; SAN with disambiguation; FEN;
repetition keys that count the ep square only when an ep capture is actually
legal (FIDE's definition, v1's implementation); v1's dead-position table; and
the `MatchState` codec above.

Verification (`node test/run-tests.js`, CI on every push):

| Position | Depths checked | Nodes |
| --- | --- | --- |
| start position | 1–4 (5 with `PERFT_DEEP=1`) | 197,281 / 4,865,609 |
| Kiwipete | 1–3 (4 with `PERFT_DEEP=1`) | 97,862 / 4,085,603 |
| positions 3–6 | as in v1's Swift suite | 43,238 / 9,467 / 62,379 / 89,890 |

plus ~60 rules/SAN/codec checks, and `test/smoke.js` — a headless-Chromium
test that plays the real two-phone loop through actual generated links:
open link → move → harvest link → reopen as opponent → … → checkmate,
promotion picker, draw offer/accept, resignation, rematch, corrupt-link
rejection.

### 4.5 What's gained, what's traded

| | v1 (extension) | v2 (links) |
| --- | --- | --- |
| Playable by any friend today | ❌ ($99 gate) | ✅ |
| Android / SMS / WhatsApp opponents | ❌ | ✅ |
| Zero install, zero account | ✅ | ✅ |
| Serverless, game lives in the thread | ✅ | ✅ |
| Rules-validated, auto verdicts | ✅ | ✅ |
| Single updating bubble per game | ✅ | ❌ (one link per move) |
| In-drawer native board | ✅ | ❌ (Safari sheet; "Add to Home Screen" gets close) |
| Rich per-position bubble preview | ✅ (rendered board image) | ❌ (static link card — see §6) |

## 5. The optional third party: a referee in the group chat

For circles that would rather **text moves as plain notation** — or want a
club-style group game with an arbiter — `tools/imessage-referee.py` turns any
Mac in the group chat into the third participant the task brief allowed:

- watches the Messages database (`chat.db`, read-only) for texts like `e4`,
  `Nf3`, `resign` in one named group chat;
- validates them with [python-chess](https://python-chess.readthedocs.io/)
  against the running game;
- replies into the chat with the move's SAN, a Unicode board, and — closing
  the loop with the main design — the **v2 link**, so anyone in the group
  taps straight into the graphical board.

Requirements and honest caveats (documented in the script): macOS with
Messages signed in, Full Disk Access for the terminal, `pip install
python-chess`, and Apple's ever-temperamental AppleScript group-chat sending
(reliable when addressed by chat GUID, which the script does; still, Apple
breaks this periodically). It's a companion, not the product — the link flow
needs no third party at all.

## 6. Deployment and the road from here

**Today:** flip the repo public (both free hosting paths — GitHub Pages on
the free plan and the githack raw mirror — serve public repos only; a repo
that must stay private can use Cloudflare Pages/Netlify free tiers instead).
Then open the raw.githack URL for `index.html` (in the README) on two iPhones
and play — no other setup at all.

**This week (one click):** run the `pages.yml` workflow (`workflow_dispatch`
deploys any branch and auto-enables Pages). The site lands at
`https://wtk2017.github.io/chess-v2/`, a stable, pretty URL that iMessage
renders with the OG title "♟️ ChessMate — your move".

**Later, still $0:**
- **Per-position link previews** — the one place a server earns its keep: a
  tiny edge function (Cloudflare Workers free tier) that serves the same
  static page but stamps `og:image` with a rendered board for the `m=` list in
  a *query-string* variant of the payload. Pure additive; the fragment format
  stays canonical.
- Player names in the payload (`wn=`/`bn=`), PGN export, a move-list replayer
  — the full move list already in every link makes these free.
- "Add to Home Screen" polish (icons, standalone display).

**If someone ever pays the $99:** v1 is sitting in the sibling repo, finished,
with the same wire format. The two ship as one product: the extension where
it's installed, the link everywhere else — which is exactly the hybrid Apple's
own `MSMessage.url` design anticipates.
