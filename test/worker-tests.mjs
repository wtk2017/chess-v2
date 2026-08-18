#!/usr/bin/env node
/*
 * Link-preview worker tests. Run with:  node test/worker-tests.mjs
 *
 * Node's CompressionStream / fetch / Request match the Cloudflare Workers
 * runtime closely enough to exercise the whole worker without deploying:
 * PNG encoding, board rendering, OG tag construction and injection, and
 * request routing (with the GitHub Pages origin stubbed out).
 */
import assert from "node:assert";
import fs from "node:fs";
import { encodePNG, renderBoardPNG, buildMeta, injectTags, handle } from "../worker/worker.mjs";
import E from "../engine.js";

let checks = 0;
function ok(label) {
  checks += 1;
  console.log("  ✓ " + label);
}

// ---------------------------------------------------------------------------
// buildMeta
// ---------------------------------------------------------------------------

{
  const meta = buildMeta("v=1&m=e2e4");
  assert.strictEqual(meta.title, "♟️ 1. e4 — your move");
  assert.ok(meta.description.startsWith("Black to move"), meta.description);
  ok("meta for a live game names the last move and side to move");

  const fresh = buildMeta("v=1");
  assert.strictEqual(fresh.title, "♟️ ChessMate — you take White");
  ok("meta for a blank invite");

  const mate = buildMeta("v=1&m=f2f3,e7e5,g2g4,d8h4");
  assert.strictEqual(mate.title, "♟️ Checkmate — Black wins 0–1");
  ok("meta for checkmate carries the score");

  const offer = buildMeta("v=1&m=e2e4&do=w");
  assert.ok(offer.description.startsWith("White offers a draw."), offer.description);
  ok("meta mentions a pending draw offer");

  assert.strictEqual(buildMeta("v=1&m=e2e5"), null);
  assert.strictEqual(buildMeta("garbage"), null);
  ok("illegal and garbage payloads produce no meta");

  const withId = buildMeta("v=1&id=abc12345&m=e2e4");
  assert.strictEqual(withId.title, "♟️ 1. e4 — your move");
  ok("game ids pass through the preview pipeline");
}

// ---------------------------------------------------------------------------
// injectTags
// ---------------------------------------------------------------------------

const FAKE_HTML = [
  "<html><head>",
  '<meta property="og:title" content="♟️ ChessMate — your move">',
  '<meta property="og:description" content="generic">',
  "<title>ChessMate — chess over iMessage links</title>",
  "</head><body>app</body></html>",
].join("\n");

{
  const meta = buildMeta("v=1&m=e2e4");
  const out = injectTags(FAKE_HTML, meta, "https://cm.example/og.png?g=v%3D1%26m%3De2e4");
  assert.ok(out.includes('content="♟️ 1. e4 — your move"'), "og:title replaced");
  assert.ok(out.includes('<meta property="og:image" content="https://cm.example/og.png?g=v%3D1%26m%3De2e4">'));
  assert.ok(out.includes('chessmate-rich-links'), "rich-links flag injected");
  assert.ok(out.includes("<title>1. e4 — your move — ChessMate</title>"), "document title updated");
  ok("OG tags stamped into the HTML");

  const generic = injectTags(FAKE_HTML, null, null);
  assert.ok(generic.includes('content="♟️ ChessMate — your move"'), "generic tags untouched");
  assert.ok(generic.includes("chessmate-rich-links"), "flag still injected without payload");
  assert.ok(!generic.includes("og:image"), "no image tag without payload");
  ok("payload-less pages keep generic tags but gain the flag");
}

// ---------------------------------------------------------------------------
// PNG encoding + board rendering
// ---------------------------------------------------------------------------

function pngDims(png) {
  assert.deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

{
  const tiny = await encodePNG(new Uint8Array([255, 0, 0, 255]), 1, 1);
  assert.deepStrictEqual(pngDims(tiny), { width: 1, height: 1 });
  ok("PNG encoder produces a valid 1x1 image");

  const game = E.Game.fromUciMoves(["e2e4"]);
  const png = await renderBoardPNG(game);
  assert.deepStrictEqual(pngDims(png), { width: 630, height: 630 });
  assert.ok(png.length > 5000 && png.length < 400000, "plausible size: " + png.length);
  ok("board render is a 630x630 PNG (" + (png.length / 1024).toFixed(0) + " KB)");

  // Orientation follows the side to move: same position, different mover,
  // must produce different pixels.
  const white = await renderBoardPNG(E.Game.fromUciMoves(["e2e4", "e7e5"]));
  const black = await renderBoardPNG(E.Game.fromUciMoves(["e2e4"]));
  assert.notDeepStrictEqual([...white.slice(0, 2000)], [...black.slice(0, 2000)]);
  ok("orientation differs by side to move");

  // Samples for eyeballing.
  const outDir = process.env.PNG_OUT;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outDir + "/og-sample-opening.png", png);
    const midgame = E.Game.fromUciMoves(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5c6", "d7c6"]);
    fs.writeFileSync(outDir + "/og-sample-midgame.png", await renderBoardPNG(midgame));
    const check = E.Game.fromUciMoves(["e2e4", "f7f6", "d1h5"]);
    fs.writeFileSync(outDir + "/og-sample-check.png", await renderBoardPNG(check));
    console.log("  (samples written to " + outDir + ")");
  }
}

// ---------------------------------------------------------------------------
// Request routing (Pages origin stubbed)
// ---------------------------------------------------------------------------

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.endsWith("/index.html")) {
      return new Response(FAKE_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.endsWith("/engine.js")) {
      return new Response("// engine", { status: 200, headers: { "Content-Type": "text/javascript" } });
    }
    return new Response("nope", { status: 404 });
  };

  try {
    const page = await handle(new Request("https://cm.example/?g=v%3D1%26m%3De2e4"), {});
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("1. e4 — your move"), "per-position title served");
    assert.ok(html.includes("/og.png?g=v%3D1%26m%3De2e4"), "image URL points at the worker");
    ok("HTML route stamps tags for ?g= requests");

    const plain = await handle(new Request("https://cm.example/"), {});
    const plainHtml = await plain.text();
    assert.ok(plainHtml.includes("chessmate-rich-links") && !plainHtml.includes("og:image"));
    ok("HTML route without payload stays generic (plus flag)");

    const img = await handle(new Request("https://cm.example/og.png?g=v%3D1%26m%3De2e4"), {});
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get("Content-Type"), "image/png");
    const bytes = new Uint8Array(await img.arrayBuffer());
    assert.deepStrictEqual(pngDims(bytes), { width: 630, height: 630 });
    ok("image route serves the board PNG");

    const bad = await handle(new Request("https://cm.example/og.png?g=v%3D1%26m%3De2e5"), {});
    assert.strictEqual(bad.status, 404);
    const tampered = await handle(new Request("https://cm.example/og.png?g=v%3D1%26m%3De2e4,e2e4"), {});
    assert.strictEqual(tampered.status, 404);
    ok("illegal payloads get no image");

    const asset = await handle(new Request("https://cm.example/engine.js"), {});
    assert.strictEqual(asset.status, 200);
    assert.strictEqual(await asset.text(), "// engine");
    ok("asset routes proxy to the Pages origin");

    const post = await handle(new Request("https://cm.example/", { method: "POST" }), {});
    assert.strictEqual(post.status, 405);
    ok("non-GET methods are refused");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nWorker tests: all " + checks + " checks passed.");
