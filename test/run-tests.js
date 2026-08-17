#!/usr/bin/env node
/*
 * ChessMate engine test suite. Run with:  node test/run-tests.js
 *
 * The heart is perft: exhaustive move-tree node counts compared against the
 * published values for the six community-standard test positions — the same
 * suite (same depths) the v1 Swift engine runs. Those numbers only match if
 * castling rights, en passant pins, promotions, and check evasion are all
 * exactly right. Set PERFT_DEEP=1 for the slower depth-5/depth-4 checks.
 */
"use strict";

var engine = require("../engine.js");
var Position = engine.Position;
var Game = engine.Game;
var MatchState = engine.MatchState;

var failures = 0;
var checks = 0;

function assertEqual(actual, expected, label) {
  checks += 1;
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  if (a !== b) {
    failures += 1;
    console.error("  FAIL " + label + "\n       expected " + b + "\n       actual   " + a);
  }
}

function assertTrue(value, label) {
  assertEqual(!!value, true, label);
}

function section(name) {
  console.log("• " + name);
}

// ---------------------------------------------------------------------------
section("perft — six reference positions");
// ---------------------------------------------------------------------------

function perft(position, depth) {
  if (depth === 0) return 1;
  var moves = position.legalMoves();
  if (depth === 1) return moves.length;
  var total = 0;
  for (var i = 0; i < moves.length; i++) {
    total += perft(position.applying(moves[i]), depth - 1);
  }
  return total;
}

var deep = process.env.PERFT_DEEP === "1";
var perftSuite = [
  [engine.START_FEN, deep ? [20, 400, 8902, 197281, 4865609] : [20, 400, 8902, 197281]],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
   deep ? [48, 2039, 97862, 4085603] : [48, 2039, 97862]],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ["r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", [46, 2079, 89890]],
];

var started = Date.now();
perftSuite.forEach(function (entry, index) {
  var position = Position.fromFEN(entry[0]);
  assertTrue(position !== null, "perft position " + (index + 1) + " parses");
  entry[1].forEach(function (expected, depthIndex) {
    assertEqual(perft(position, depthIndex + 1), expected,
      "perft(" + (depthIndex + 1) + ") of position " + (index + 1));
  });
});
console.log("  (" + ((Date.now() - started) / 1000).toFixed(1) + "s)");

// ---------------------------------------------------------------------------
section("FEN round-trips");
// ---------------------------------------------------------------------------

[engine.START_FEN,
 "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
 "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
 "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
].forEach(function (fen) {
  var position = Position.fromFEN(fen);
  assertTrue(position !== null, "FEN parses: " + fen.split(" ")[0]);
  if (position) assertEqual(position.fen(), fen, "FEN round-trip: " + fen.split(" ")[0]);
});
assertEqual(Position.fromFEN("not a fen"), null, "garbage FEN rejected");
assertEqual(Position.fromFEN("8/8/8/8/8/8/8/8 w - - 0 1"), null, "kingless FEN rejected");
assertEqual(Position.fromFEN("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1"), null,
  "FEN with short rank rejected");
assertEqual(Position.fromFEN("5k2/4P3/8/8/8/8/8/4K3 w - - 0 1"), null,
  "position with the side not on move in check rejected");

// ---------------------------------------------------------------------------
section("castling rules");
// ---------------------------------------------------------------------------

(function () {
  // Black rook on f3 covers f1: kingside castling is through check, queenside fine.
  var position = Position.fromFEN("4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1");
  var uci = position.legalMoves().map(engine.moveToUci);
  assertTrue(uci.indexOf("e1g1") === -1, "castling through an attacked square denied");
  assertTrue(uci.indexOf("e1c1") !== -1, "queenside castling still available");

  // In check: no castling at all.
  position = Position.fromFEN("4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1");
  uci = position.legalMoves().map(engine.moveToUci);
  assertTrue(uci.indexOf("e1g1") === -1 && uci.indexOf("e1c1") === -1,
    "castling out of check denied");

  // Capturing a rook on its home square voids that right (the b8 knight
  // blocks the resulting rank check so black can still move freely).
  position = Position.fromFEN("rn2k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  var afterRxa8 = position.applying(engine.moveFromUci("a1a8"));
  assertEqual(afterRxa8.castling.q, false, "black queenside right gone after Rxa8");
  assertEqual(afterRxa8.castling.Q, false, "white queenside right gone once a1 empties");
  assertEqual(afterRxa8.castlingFEN(), "Kk", "kingside rights survive on both sides");
  var blackUci = afterRxa8.legalMoves().map(engine.moveToUci);
  assertTrue(blackUci.indexOf("e8g8") !== -1, "black can still castle kingside");

  // Castling actually moves the rook.
  position = Position.fromFEN("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
  var castled = position.applying(engine.moveFromUci("e1g1"));
  assertEqual(castled.pieceAt(engine.parseSquare("f1")), "R", "rook lands on f1 after O-O");
  assertEqual(castled.pieceAt(engine.parseSquare("h1")), null, "h1 empty after O-O");
})();

// ---------------------------------------------------------------------------
section("en passant");
// ---------------------------------------------------------------------------

(function () {
  // 1. e4 d5 2. e5 f5 → exf6 e.p. is legal and removes the f5 pawn.
  var game = Game.fromUciMoves(["e2e4", "d7d5", "e4e5", "f7f5"]);
  assertTrue(game !== null, "en-passant setup replays");
  var uci = game.position.legalMoves().map(engine.moveToUci);
  assertTrue(uci.indexOf("e5f6") !== -1, "en passant capture offered");
  game.make(engine.moveFromUci("e5f6"));
  assertEqual(game.position.pieceAt(engine.parseSquare("f5")), null,
    "captured pawn removed from f5");
  assertEqual(game.sanHistory[game.sanHistory.length - 1], "exf6", "en passant SAN");

  // En passant pin: capturing would expose the king along the fourth rank.
  var pinned = Position.fromFEN("8/8/8/8/k2Pp2Q/8/8/K7 b - d3 0 1");
  var pinnedUci = pinned.legalMoves().map(engine.moveToUci);
  assertTrue(pinnedUci.indexOf("e4d3") === -1, "en passant denied when it exposes the king");
  assertTrue(pinnedUci.indexOf("e4e3") !== -1, "plain pawn push still legal");
  assertTrue(!pinned.hasLegalEnPassantCapture(), "repetition key ignores unusable ep square");
  assertTrue(pinned.repetitionKey().slice(-1) === "-", "repetition key ends with -");

  // After 1. e4 no capture exists, so the ep square must not enter the key.
  var afterE4 = Position.initial().applying(engine.moveFromUci("e2e4"));
  assertTrue(afterE4.ep >= 0, "double push records ep square");
  assertTrue(afterE4.repetitionKey().slice(-1) === "-", "unused ep square not in repetition key");
})();

// ---------------------------------------------------------------------------
section("promotion");
// ---------------------------------------------------------------------------

(function () {
  var position = Position.fromFEN("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  var moves = position.legalMoves().filter(function (m) { return m.from === engine.parseSquare("a7"); });
  assertEqual(moves.length, 4, "four promotion choices generated");
  assertTrue(position.isLegal(engine.moveFromUci("a7a8n")), "underpromotion is legal");
  assertTrue(!position.isLegal(engine.moveFromUci("a7a8")), "promotion without a piece is illegal");
  assertEqual(position.san(engine.moveFromUci("a7a8q")), "a8=Q+", "promotion SAN with check");
  var after = position.applying(engine.moveFromUci("a7a8q"));
  assertEqual(after.pieceAt(engine.parseSquare("a8")), "Q", "promoted piece on the board");
})();

// ---------------------------------------------------------------------------
section("game endings");
// ---------------------------------------------------------------------------

(function () {
  // Fool's mate.
  var game = Game.fromUciMoves(["f2f3", "e7e5", "g2g4", "d8h4"]);
  assertEqual(game.status(), { kind: "checkmate", winner: "b" }, "fool's mate is checkmate");
  assertEqual(game.sanHistory[3], "Qh4#", "mate SAN gets #");

  // Stalemate.
  var stale = new Game(Position.fromFEN("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"));
  assertEqual(stale.status(), { kind: "stalemate" }, "stalemate detected");

  // Fifty-move rule: quiet rook move crosses 100 half-moves.
  var fifty = new Game(Position.fromFEN("4k3/8/8/8/8/8/8/4K2R w - - 99 70"));
  fifty.make(engine.moveFromUci("h1h2"));
  assertEqual(fifty.status(), { kind: "fiftyMoveRule" }, "fifty-move rule declared");

  // ...but a pawn move resets the clock.
  var reset = new Game(Position.fromFEN("4k3/8/8/8/8/8/P7/4K3 w - - 99 70"));
  reset.make(engine.moveFromUci("a2a3"));
  assertEqual(reset.status().kind, "ongoing", "pawn move resets the fifty-move clock");

  // Threefold repetition by knight shuffle.
  var shuffle = Game.fromUciMoves([
    "g1f3", "g8f6", "f3g1", "f6g8",
    "g1f3", "g8f6", "f3g1", "f6g8",
  ]);
  assertEqual(shuffle.status(), { kind: "threefoldRepetition" }, "threefold repetition declared");

  // Insufficient material.
  assertEqual(new Game(Position.fromFEN("4k3/8/8/8/8/8/8/4K3 w - - 0 1")).status(),
    { kind: "insufficientMaterial" }, "K vs K is dead");
  assertEqual(new Game(Position.fromFEN("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1")).status(),
    { kind: "insufficientMaterial" }, "K+B vs K is dead");
  assertEqual(new Game(Position.fromFEN("4k3/8/8/8/5b2/8/8/2B1K3 w - - 0 1")).status(),
    { kind: "insufficientMaterial" }, "same-colored bishops are dead");
  assertEqual(new Game(Position.fromFEN("4k3/8/8/8/4b3/8/8/2B1K3 w - - 0 1")).status().kind,
    "ongoing", "opposite-colored bishops play on");
  assertEqual(new Game(Position.fromFEN("4k1n1/8/8/8/8/8/8/1N2K3 w - - 0 1")).status().kind,
    "ongoing", "knight vs knight plays on");

  // Ongoing check flag.
  var check = Game.fromUciMoves(["e2e4", "f7f6", "d1h5"]);
  assertEqual(check.status(), { kind: "ongoing", inCheck: true }, "check flagged while ongoing");

  // No moves accepted after the game ends.
  var over = Game.fromUciMoves(["f2f3", "e7e5", "g2g4", "d8h4"]);
  var threw = null;
  try { over.make(engine.moveFromUci("a2a3")); } catch (error) { threw = error.message; }
  assertEqual(threw, "gameIsOver", "moves rejected after checkmate");
})();

// ---------------------------------------------------------------------------
section("SAN details");
// ---------------------------------------------------------------------------

(function () {
  // Two knights that can reach the same square: file disambiguation.
  var knights = Position.fromFEN("4k3/8/8/8/8/8/8/N1N1K3 w - - 0 1");
  assertEqual(knights.san(engine.moveFromUci("a1b3")), "Nab3", "file disambiguation");
  var ranks = Position.fromFEN("N3k3/8/8/8/N7/8/8/4K3 w - - 0 1");
  assertEqual(ranks.san(engine.moveFromUci("a4b6")), "N4b6", "rank disambiguation");

  var game = Game.fromUciMoves(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
  assertEqual(game.moveListText(), "1. e4 e5 2. Nf3 Nc6 3. Bb5", "move list text");
  assertEqual(game.lastMoveDescription(), "3. Bb5", "white move description");
  game.make(engine.moveFromUci("g8f6"));
  assertEqual(game.lastMoveDescription(), "3… Nf6", "black move description");

  var castle = Position.fromFEN("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
  assertEqual(castle.san(engine.moveFromUci("e1g1")), "O-O", "kingside castling SAN");
  var capture = Game.fromUciMoves(["e2e4", "d7d5"]);
  assertEqual(capture.position.san(engine.moveFromUci("e4d5")), "exd5", "pawn capture SAN");
})();

// ---------------------------------------------------------------------------
section("MatchState codec");
// ---------------------------------------------------------------------------

(function () {
  var state = new MatchState();
  assertEqual(state.encode(), "v=1", "fresh state encodes to v=1");

  state.moves = ["e2e4", "e7e5"];
  state.drawOfferedBy = "w";
  assertEqual(state.encode(), "v=1&m=e2e4,e7e5&do=w", "moves and draw offer encode");

  var decoded = MatchState.decode("#" + state.encode());
  assertEqual(decoded, state, "round-trip through encode/decode");

  // A v1 bubble URL query still decodes: seat UUIDs are unknown keys.
  var v1 = MatchState.decode("?v=1&m=e2e4,e7e5,g1f3&w=6F9619FF-8B86-D011-B42D-00CF4FC964FF&b=7F9619FF-8B86-D011-B42D-00CF4FC964FF");
  assertTrue(v1 !== null, "v1-style payload decodes");
  assertEqual(v1.moves, ["e2e4", "e7e5", "g1f3"], "v1 move list preserved");

  assertEqual(MatchState.decode("v=1&m=e2z9"), null, "bad move token rejected");
  assertEqual(MatchState.decode("v=1&do=x"), null, "bad draw-offer color rejected");
  assertEqual(MatchState.decode("m=e2e4"), null, "missing version rejected");
  assertEqual(MatchState.decode(""), null, "empty payload rejected");

  // Legal-looking but illegal move lists fail at replay, not decode.
  var tampered = MatchState.decode("v=1&m=e2e4,e7e5,e2e4");
  assertTrue(tampered !== null, "tampered payload decodes syntactically");
  assertEqual(tampered.makeGame(), null, "tampered payload rejected on replay");

  // Verdicts.
  var live = MatchState.decode("v=1&m=e2e4");
  assertEqual(live.verdict(live.makeGame()), null, "live game has no verdict");
  var resigned = MatchState.decode("v=1&m=e2e4&rb=b");
  assertEqual(resigned.verdict(resigned.makeGame()), { winner: "w", reason: "resignation" },
    "resignation verdict");
  var agreed = MatchState.decode("v=1&m=e2e4&da=1");
  assertEqual(agreed.verdict(agreed.makeGame()), { winner: null, reason: "agreement" },
    "legacy da=1 agreed-draw verdict");
  assertEqual(agreed.drawAgreedBy, null, "legacy da=1 leaves the accepter unknown");
  var agreedBy = MatchState.decode("v=1&m=e2e4&da=b");
  assertEqual(agreedBy.drawAgreed, true, "colored da decodes as agreed");
  assertEqual(agreedBy.drawAgreedBy, "b", "colored da names the accepter");
  assertEqual(agreedBy.encode(), "v=1&m=e2e4&da=b", "colored da round-trips");
  assertEqual(MatchState.decode("v=1&da=x"), null, "bad da value rejected");
  var mate = MatchState.decode("v=1&m=f2f3,e7e5,g2g4,d8h4");
  assertEqual(mate.verdict(mate.makeGame()), { winner: "b", reason: "checkmate" },
    "checkmate verdict");
})();

// ---------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.error(failures + " of " + checks + " checks FAILED");
  process.exit(1);
} else {
  console.log("All " + checks + " checks passed.");
}
