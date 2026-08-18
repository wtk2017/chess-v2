/*
 * ChessMate link-preview worker (Cloudflare Workers, free tier).
 *
 * iMessage and friends generate link previews by fetching a URL WITHOUT its
 * #fragment and WITHOUT running JavaScript, so the static app can only ever
 * show a generic card. This worker is the thin dynamic layer that fixes
 * that: it serves the exact same app (proxied from GitHub Pages), but
 * understands a query-string form of the payload —
 *
 *     https://<worker>/?g=v%3D1%26m%3De2e4
 *
 * — and stamps per-position Open Graph tags into the HTML, including an
 * og:image rendered by this same worker at /og.png?g=…  The board image is
 * composed from pre-baked RGBA sprites (worker/sprites.generated.mjs) and
 * encoded as a PNG with zero dependencies (CompressionStream provides the
 * zlib layer). Payloads are validated by full replay through the very same
 * engine.js the app ships.
 *
 * The fragment form stays canonical and private; ?g= is the opt-in that
 * trades host-visible state for rich previews. The worker injects
 * <meta name="chessmate-rich-links"> so the app emits ?g= links when — and
 * only when — it is served through this worker.
 */

import E from "../engine.js";
import { SPRITES, SPRITE_SIZE } from "./sprites.generated.mjs";

const DEFAULT_PAGES_ORIGIN = "https://wtk2017.github.io/chess-v2";

// Image geometry: 8 sprite-sized squares plus a frame.
const SQUARE = SPRITE_SIZE; // 76
const MARGIN = 11;
const IMG = SQUARE * 8 + MARGIN * 2; // 630

// Board palette (matches the app's CSS).
const LIGHT = [0xf0, 0xd9, 0xb5, 255];
const DARK = [0xb5, 0x88, 0x63, 255];
const FRAME = [0x6d, 0x51, 0x38, 255];
const LAST_MOVE = [155, 199, 0, 102]; // rgba(155,199,0,0.40)
const CHECK = [217, 46, 46, 140]; // rgba(217,46,46,0.55)

// ---------------------------------------------------------------------------
// PNG encoding (RGBA8, filter 0, zlib via CompressionStream("deflate"))
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encodes an RGBA buffer (width*height*4) as a PNG file. */
export async function encodePNG(rgba, width, height) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const idat = await deflate(raw);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------

function fillRect(buf, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    let i = (y * IMG + x0) * 4;
    for (let x = 0; x < w; x++) {
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = 255;
      i += 4;
    }
  }
}

/** Source-over blend of a translucent color onto a rectangle. */
function tintRect(buf, x0, y0, w, h, color) {
  const alpha = color[3] / 255;
  for (let y = y0; y < y0 + h; y++) {
    let i = (y * IMG + x0) * 4;
    for (let x = 0; x < w; x++) {
      buf[i] = Math.round(color[0] * alpha + buf[i] * (1 - alpha));
      buf[i + 1] = Math.round(color[1] * alpha + buf[i + 1] * (1 - alpha));
      buf[i + 2] = Math.round(color[2] * alpha + buf[i + 2] * (1 - alpha));
      i += 4;
    }
  }
}

const spriteCache = {};

function sprite(key) {
  if (!spriteCache[key]) {
    const binary = atob(SPRITES[key]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    spriteCache[key] = bytes;
  }
  return spriteCache[key];
}

function blitSprite(buf, x0, y0, key) {
  const src = sprite(key);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const s = (y * SPRITE_SIZE + x) * 4;
      const alpha = src[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((y0 + y) * IMG + x0 + x) * 4;
      buf[d] = Math.round(src[s] * alpha + buf[d] * (1 - alpha));
      buf[d + 1] = Math.round(src[s + 1] * alpha + buf[d + 1] * (1 - alpha));
      buf[d + 2] = Math.round(src[s + 2] * alpha + buf[d + 2] * (1 - alpha));
    }
  }
}

/**
 * Renders the final position of a replayed game as a PNG. Oriented with the
 * side to move at the bottom — the receiver's point of view. Highlights the
 * last move and a checked king, like the app.
 */
export async function renderBoardPNG(game) {
  const position = game.position;
  const orient = position.turn;
  const lastMove = game.moves.length > 0 ? game.moves[game.moves.length - 1] : null;
  const checkedKing = position.isInCheck ? position.kingSquare(position.turn) : -1;

  const buf = new Uint8Array(IMG * IMG * 4);
  fillRect(buf, 0, 0, IMG, IMG, FRAME);

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = orient === E.WHITE ? col : 7 - col;
      const rank = orient === E.WHITE ? 7 - row : row;
      const sq = E.makeSquare(file, rank);
      const x = MARGIN + col * SQUARE;
      const y = MARGIN + row * SQUARE;
      fillRect(buf, x, y, SQUARE, SQUARE, (file + rank) % 2 === 1 ? LIGHT : DARK);
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) {
        tintRect(buf, x, y, SQUARE, SQUARE, LAST_MOVE);
      }
      if (sq === checkedKing) {
        tintRect(buf, x, y, SQUARE, SQUARE, CHECK);
      }
      const piece = position.pieceAt(sq);
      if (piece) {
        blitSprite(buf, x, y, E.colorOf(piece) + E.kindOf(piece));
      }
    }
  }
  return encodePNG(buf, IMG, IMG);
}

// ---------------------------------------------------------------------------
// Open Graph tags
// ---------------------------------------------------------------------------

function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorName(color) {
  return color === E.WHITE ? "White" : "Black";
}

/**
 * Title and description for a validated payload. Returns null when the
 * payload is corrupt (callers fall back to the generic static tags).
 */
export function buildMeta(payload) {
  const state = E.MatchState.decode(payload);
  const game = state && state.makeGame();
  if (!state || !game) return null;

  const verdict = state.verdict(game);
  if (verdict) {
    const score = verdict.winner ? (verdict.winner === E.WHITE ? "1–0" : "0–1") : "½–½";
    const title = verdict.winner
      ? `♟️ ${verdict.reason === "checkmate" ? "Checkmate — " : ""}${colorName(verdict.winner)} wins ${score}`
      : `♟️ Draw ${score} — ${E.endReasonName(verdict.reason)}`;
    return { title, description: "Tap to see the final position — and send a rematch.", game };
  }

  const last = game.lastMoveDescription();
  const title = last ? `♟️ ${last} — your move` : "♟️ ChessMate — you take White";
  let description = last
    ? `${colorName(game.position.turn)} to move. Tap to open the live board.`
    : "A fresh board is waiting. Tap to make the first move.";
  if (state.drawOfferedBy) {
    description = `${colorName(state.drawOfferedBy)} offers a draw. ` + description;
  }
  return { title, description, game };
}

/** Stamps per-position OG tags (and the rich-links flag) into the app HTML. */
export function injectTags(html, meta, imageURL) {
  let out = html;
  if (meta) {
    out = out
      .replace(/(<meta property="og:title" content=")[^"]*(">)/, `$1${escapeAttr(meta.title)}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(">)/, `$1${escapeAttr(meta.description)}$2`)
      .replace(/(<title>)[^<]*(<\/title>)/, `$1${escapeAttr(meta.title.replace(/^♟️ /, ""))} — ChessMate$2`);
  }
  const extras = [
    '<meta name="chessmate-rich-links" content="1">',
    meta && imageURL ? `<meta property="og:image" content="${escapeAttr(imageURL)}">` : "",
    meta && imageURL ? `<meta property="og:image:width" content="${IMG}">` : "",
    meta && imageURL ? `<meta property="og:image:height" content="${IMG}">` : "",
    meta && imageURL ? '<meta name="twitter:card" content="summary_large_image">' : "",
  ].filter(Boolean).join("\n");
  return out.replace("</head>", extras + "\n</head>");
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function cachedFetch(url) {
  return fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = (env && env.PAGES_ORIGIN) || DEFAULT_PAGES_ORIGIN;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  // Board image for a payload.
  if (url.pathname === "/og.png") {
    const payload = url.searchParams.get("g") || "";
    const state = E.MatchState.decode(payload);
    const game = state && state.makeGame();
    if (!state || !game) return new Response("bad payload", { status: 404 });
    const png = await renderBoardPNG(game);
    return new Response(request.method === "HEAD" ? null : png, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  // The app shell (any payload state), with OG tags stamped in.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const upstream = await cachedFetch(origin + "/index.html");
    if (!upstream.ok) return new Response("upstream unavailable", { status: 502 });
    const html = await upstream.text();
    const payload = url.searchParams.get("g");
    const meta = payload ? buildMeta(payload) : null;
    const imageURL = meta ? `${url.origin}/og.png?g=${encodeURIComponent(payload)}` : null;
    return new Response(injectTags(html, meta, imageURL), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // Everything else (engine.js, app.js, screenshots…) proxies straight through.
  const asset = await cachedFetch(origin + url.pathname);
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(asset.body, { status: asset.status, headers });
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
