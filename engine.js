/*
 * ChessMate engine — the full rules of chess plus the match-state codec,
 * in one dependency-free file that runs identically in a browser
 * (<script src="engine.js"> → window.ChessMate) and in Node
 * (require("./engine.js")).
 *
 * This is a faithful port of the Swift engine in wtk2017/chess
 * (Shared/ChessEngine): same legality rules, same automatic draw
 * declarations, same SAN, and a wire format that keeps v1's URL keys.
 * The perft suite in test/run-tests.js verifies it against the same six
 * published reference positions the Swift tests use.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ChessMate = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var WHITE = "w";
  var BLACK = "b";

  // Board is a 0x88 array: index = rank * 16 + file, rank 0 = rank "1".
  // Squares hold single FEN characters ("P".."k") or null.
  var KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
  var KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];
  var BISHOP_DIRS = [-17, -15, 15, 17];
  var ROOK_DIRS = [-16, -1, 1, 16];
  var PROMOTION_KINDS = ["q", "r", "b", "n"];

  var START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  function onBoard(sq) {
    return (sq & 0x88) === 0;
  }
  function fileOf(sq) {
    return sq & 7;
  }
  function rankOf(sq) {
    return sq >> 4;
  }
  function makeSquare(file, rank) {
    return rank * 16 + file;
  }
  function algebraic(sq) {
    return String.fromCharCode(97 + fileOf(sq)) + (rankOf(sq) + 1);
  }
  function parseSquare(text) {
    if (typeof text !== "string" || text.length !== 2) return -1;
    var file = text.charCodeAt(0) - 97;
    var rank = text.charCodeAt(1) - 49;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
    return makeSquare(file, rank);
  }
  function isLightSquare(sq) {
    return (fileOf(sq) + rankOf(sq)) % 2 === 1;
  }

  function colorOf(piece) {
    return piece >= "a" ? BLACK : WHITE;
  }
  function kindOf(piece) {
    return piece.toLowerCase();
  }
  function coloredPiece(color, kind) {
    return color === WHITE ? kind.toUpperCase() : kind;
  }
  function opponent(color) {
    return color === WHITE ? BLACK : WHITE;
  }

  // ---------------------------------------------------------------------------
  // Move: coordinate form with optional promotion, e.g. { from, to, promo }.
  // UCI text form is "e2e4" / "e7e8q".
  // ---------------------------------------------------------------------------

  function moveFromUci(uci) {
    if (typeof uci !== "string") return null;
    uci = uci.toLowerCase();
    if (uci.length !== 4 && uci.length !== 5) return null;
    var from = parseSquare(uci.slice(0, 2));
    var to = parseSquare(uci.slice(2, 4));
    if (from < 0 || to < 0) return null;
    var promo = null;
    if (uci.length === 5) {
      promo = uci[4];
      if (PROMOTION_KINDS.indexOf(promo) === -1) return null;
    }
    return { from: from, to: to, promo: promo };
  }

  function moveToUci(move) {
    return algebraic(move.from) + algebraic(move.to) + (move.promo || "");
  }

  function sameMove(a, b) {
    return a.from === b.from && a.to === b.to && (a.promo || null) === (b.promo || null);
  }

  // ---------------------------------------------------------------------------
  // Position
  // ---------------------------------------------------------------------------

  function Position() {
    this.board = new Array(128).fill(null);
    this.turn = WHITE;
    this.castling = { K: false, Q: false, k: false, q: false };
    this.ep = -1; // 0x88 square behind a just-double-pushed pawn, or -1
    this.halfmove = 0;
    this.fullmove = 1;
  }

  Position.initial = function () {
    return Position.fromFEN(START_FEN);
  };

  Position.fromFEN = function (fen) {
    if (typeof fen !== "string") return null;
    var fields = fen.trim().split(/\s+/);
    if (fields.length < 4 || fields.length > 6) return null;

    var position = new Position();
    var ranks = fields[0].split("/");
    if (ranks.length !== 8) return null;
    var kings = { w: 0, b: 0 };
    for (var i = 0; i < 8; i++) {
      var rank = 7 - i;
      var file = 0;
      for (var j = 0; j < ranks[i].length; j++) {
        var ch = ranks[i][j];
        if (ch >= "1" && ch <= "8") {
          file += ch.charCodeAt(0) - 48;
        } else if ("pnbrqkPNBRQK".indexOf(ch) !== -1) {
          if (file > 7) return null;
          if (ch === "K") kings.w++;
          if (ch === "k") kings.b++;
          position.board[makeSquare(file, rank)] = ch;
          file += 1;
        } else {
          return null;
        }
      }
      if (file !== 8) return null;
    }
    if (kings.w !== 1 || kings.b !== 1) return null;

    if (fields[1] !== WHITE && fields[1] !== BLACK) return null;
    position.turn = fields[1];

    if (fields[2] !== "-") {
      for (var c = 0; c < fields[2].length; c++) {
        var right = fields[2][c];
        if (!(right in position.castling)) return null;
        position.castling[right] = true;
      }
    }

    if (fields[3] !== "-") {
      var ep = parseSquare(fields[3]);
      if (ep < 0) return null;
      position.ep = ep;
    }

    position.halfmove = fields.length > 4 ? parseInt(fields[4], 10) : 0;
    position.fullmove = fields.length > 5 ? parseInt(fields[5], 10) : 1;
    if (isNaN(position.halfmove) || isNaN(position.fullmove)) return null;

    // No legal position has the side not on move in check; rejecting these
    // also guarantees move generation can never "capture" a king.
    if (position.isAttacked(position.kingSquare(opponent(position.turn)), position.turn)) {
      return null;
    }
    return position;
  };

  Position.prototype.clone = function () {
    var copy = new Position();
    copy.board = this.board.slice();
    copy.turn = this.turn;
    copy.castling = {
      K: this.castling.K,
      Q: this.castling.Q,
      k: this.castling.k,
      q: this.castling.q,
    };
    copy.ep = this.ep;
    copy.halfmove = this.halfmove;
    copy.fullmove = this.fullmove;
    return copy;
  };

  Position.prototype.pieceAt = function (sq) {
    return this.board[sq];
  };

  Position.prototype.piecePlacementFEN = function () {
    var parts = [];
    for (var rank = 7; rank >= 0; rank--) {
      var row = "";
      var empty = 0;
      for (var file = 0; file < 8; file++) {
        var piece = this.board[makeSquare(file, rank)];
        if (piece === null) {
          empty += 1;
        } else {
          if (empty > 0) {
            row += empty;
            empty = 0;
          }
          row += piece;
        }
      }
      if (empty > 0) row += empty;
      parts.push(row);
    }
    return parts.join("/");
  };

  Position.prototype.castlingFEN = function () {
    var text = "";
    if (this.castling.K) text += "K";
    if (this.castling.Q) text += "Q";
    if (this.castling.k) text += "k";
    if (this.castling.q) text += "q";
    return text === "" ? "-" : text;
  };

  Position.prototype.fen = function () {
    return [
      this.piecePlacementFEN(),
      this.turn,
      this.castlingFEN(),
      this.ep >= 0 ? algebraic(this.ep) : "-",
      this.halfmove,
      this.fullmove,
    ].join(" ");
  };

  Position.prototype.kingSquare = function (color) {
    var king = coloredPiece(color, "k");
    for (var sq = 0; sq < 128; sq++) {
      if (onBoard(sq) && this.board[sq] === king) return sq;
    }
    return -1;
  };

  /** True if `color`'s pieces attack `sq`. */
  Position.prototype.isAttacked = function (sq, color) {
    var i, t, piece;
    var knight = coloredPiece(color, "n");
    for (i = 0; i < KNIGHT_OFFSETS.length; i++) {
      t = sq + KNIGHT_OFFSETS[i];
      if (onBoard(t) && this.board[t] === knight) return true;
    }
    var king = coloredPiece(color, "k");
    for (i = 0; i < KING_OFFSETS.length; i++) {
      t = sq + KING_OFFSETS[i];
      if (onBoard(t) && this.board[t] === king) return true;
    }
    // Pawns: a white pawn on p attacks p+15 and p+17.
    if (color === WHITE) {
      if (onBoard(sq - 15) && this.board[sq - 15] === "P") return true;
      if (onBoard(sq - 17) && this.board[sq - 17] === "P") return true;
    } else {
      if (onBoard(sq + 15) && this.board[sq + 15] === "p") return true;
      if (onBoard(sq + 17) && this.board[sq + 17] === "p") return true;
    }
    var rook = coloredPiece(color, "r");
    var queen = coloredPiece(color, "q");
    for (i = 0; i < ROOK_DIRS.length; i++) {
      t = sq + ROOK_DIRS[i];
      while (onBoard(t)) {
        piece = this.board[t];
        if (piece !== null) {
          if (piece === rook || piece === queen) return true;
          break;
        }
        t += ROOK_DIRS[i];
      }
    }
    var bishop = coloredPiece(color, "b");
    for (i = 0; i < BISHOP_DIRS.length; i++) {
      t = sq + BISHOP_DIRS[i];
      while (onBoard(t)) {
        piece = this.board[t];
        if (piece !== null) {
          if (piece === bishop || piece === queen) return true;
          break;
        }
        t += BISHOP_DIRS[i];
      }
    }
    return false;
  };

  Object.defineProperty(Position.prototype, "isInCheck", {
    get: function () {
      return this.isAttacked(this.kingSquare(this.turn), opponent(this.turn));
    },
  });

  Position.prototype.pseudoMoves = function () {
    var moves = [];
    var us = this.turn;
    var them = opponent(us);
    var forward = us === WHITE ? 16 : -16;
    var startRank = us === WHITE ? 1 : 6;
    var promoRank = us === WHITE ? 7 : 0;

    for (var from = 0; from < 128; from++) {
      if (!onBoard(from)) continue;
      var piece = this.board[from];
      if (piece === null || colorOf(piece) !== us) continue;
      var kind = kindOf(piece);
      var i, to, target;

      if (kind === "p") {
        to = from + forward;
        if (onBoard(to) && this.board[to] === null) {
          pushPawnMove(moves, from, to, promoRank);
          var two = from + 2 * forward;
          if (rankOf(from) === startRank && this.board[two] === null) {
            moves.push({ from: from, to: two, promo: null });
          }
        }
        var captures = [from + forward - 1, from + forward + 1];
        for (i = 0; i < 2; i++) {
          to = captures[i];
          if (!onBoard(to)) continue;
          target = this.board[to];
          if (target !== null && colorOf(target) === them) {
            pushPawnMove(moves, from, to, promoRank);
          } else if (to === this.ep && target === null) {
            moves.push({ from: from, to: to, promo: null });
          }
        }
      } else if (kind === "n" || kind === "k") {
        var offsets = kind === "n" ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (i = 0; i < offsets.length; i++) {
          to = from + offsets[i];
          if (!onBoard(to)) continue;
          target = this.board[to];
          if (target === null || colorOf(target) === them) {
            moves.push({ from: from, to: to, promo: null });
          }
        }
      } else {
        var dirs = kind === "r" ? ROOK_DIRS : kind === "b" ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
        for (i = 0; i < dirs.length; i++) {
          to = from + dirs[i];
          while (onBoard(to)) {
            target = this.board[to];
            if (target === null) {
              moves.push({ from: from, to: to, promo: null });
            } else {
              if (colorOf(target) === them) moves.push({ from: from, to: to, promo: null });
              break;
            }
            to += dirs[i];
          }
        }
      }
    }

    // Castling. The king may not castle out of, through, or into check, and
    // the squares between king and rook must be empty.
    var home = us === WHITE ? 0 : 7;
    var kingFrom = makeSquare(4, home);
    var rights = us === WHITE ? ["K", "Q"] : ["k", "q"];
    if (
      this.castling[rights[0]] &&
      this.board[kingFrom] === coloredPiece(us, "k") &&
      this.board[makeSquare(7, home)] === coloredPiece(us, "r") &&
      this.board[makeSquare(5, home)] === null &&
      this.board[makeSquare(6, home)] === null &&
      !this.isAttacked(kingFrom, them) &&
      !this.isAttacked(makeSquare(5, home), them) &&
      !this.isAttacked(makeSquare(6, home), them)
    ) {
      moves.push({ from: kingFrom, to: makeSquare(6, home), promo: null });
    }
    if (
      this.castling[rights[1]] &&
      this.board[kingFrom] === coloredPiece(us, "k") &&
      this.board[makeSquare(0, home)] === coloredPiece(us, "r") &&
      this.board[makeSquare(1, home)] === null &&
      this.board[makeSquare(2, home)] === null &&
      this.board[makeSquare(3, home)] === null &&
      !this.isAttacked(kingFrom, them) &&
      !this.isAttacked(makeSquare(3, home), them) &&
      !this.isAttacked(makeSquare(2, home), them)
    ) {
      moves.push({ from: kingFrom, to: makeSquare(2, home), promo: null });
    }

    return moves;
  };

  function pushPawnMove(moves, from, to, promoRank) {
    if (rankOf(to) === promoRank) {
      for (var i = 0; i < PROMOTION_KINDS.length; i++) {
        moves.push({ from: from, to: to, promo: PROMOTION_KINDS[i] });
      }
    } else {
      moves.push({ from: from, to: to, promo: null });
    }
  }

  /** The position after `move`, which must be at least pseudo-legal. */
  Position.prototype.applying = function (move) {
    var next = this.clone();
    var piece = next.board[move.from];
    var kind = kindOf(piece);
    var us = next.turn;
    var captured = next.board[move.to];

    next.ep = -1;

    if (kind === "p") {
      next.halfmove = 0;
      if (move.to === this.ep && captured === null && fileOf(move.from) !== fileOf(move.to)) {
        // En passant: the captured pawn stands behind the target square.
        next.board[move.to + (us === WHITE ? -16 : 16)] = null;
      }
      if (Math.abs(move.to - move.from) === 32) {
        next.ep = move.from + (us === WHITE ? 16 : -16);
      }
    } else {
      next.halfmove = captured !== null ? 0 : next.halfmove + 1;
    }

    if (kind === "k") {
      if (us === WHITE) {
        next.castling.K = next.castling.Q = false;
      } else {
        next.castling.k = next.castling.q = false;
      }
      if (Math.abs(move.to - move.from) === 2) {
        // Castling: bring the rook across.
        var home = rankOf(move.from);
        if (fileOf(move.to) === 6) {
          next.board[makeSquare(5, home)] = next.board[makeSquare(7, home)];
          next.board[makeSquare(7, home)] = null;
        } else {
          next.board[makeSquare(3, home)] = next.board[makeSquare(0, home)];
          next.board[makeSquare(0, home)] = null;
        }
      }
    }

    // Any move touching a rook home square voids that castling right.
    var corners = [
      [makeSquare(7, 0), "K"],
      [makeSquare(0, 0), "Q"],
      [makeSquare(7, 7), "k"],
      [makeSquare(0, 7), "q"],
    ];
    for (var i = 0; i < corners.length; i++) {
      if (move.from === corners[i][0] || move.to === corners[i][0]) {
        next.castling[corners[i][1]] = false;
      }
    }

    next.board[move.to] = move.promo ? coloredPiece(us, move.promo) : piece;
    next.board[move.from] = null;

    if (us === BLACK) next.fullmove += 1;
    next.turn = opponent(us);
    return next;
  };

  /** True if our king survives `move` (move must be pseudo-legal). */
  Position.prototype.isKingSafeAfter = function (move) {
    var next = this.applying(move);
    return !next.isAttacked(next.kingSquare(this.turn), next.turn);
  };

  Position.prototype.legalMoves = function () {
    var self = this;
    return this.pseudoMoves().filter(function (move) {
      return self.isKingSafeAfter(move);
    });
  };

  Position.prototype.legalMovesFrom = function (sq) {
    return this.legalMoves().filter(function (move) {
      return move.from === sq;
    });
  };

  Position.prototype.isLegal = function (move) {
    if (!move) return false;
    return this.legalMoves().some(function (candidate) {
      return sameMove(candidate, move);
    });
  };

  /** Standard algebraic notation for a legal move in this position. */
  Position.prototype.san = function (move) {
    var piece = this.board[move.from];
    var kind = kindOf(piece);
    var text;

    if (kind === "k" && Math.abs(move.to - move.from) === 2) {
      text = fileOf(move.to) === 6 ? "O-O" : "O-O-O";
    } else {
      var isEnPassant = kind === "p" && move.to === this.ep && fileOf(move.from) !== fileOf(move.to);
      var isCapture = this.board[move.to] !== null || isEnPassant;
      if (kind === "p") {
        text = isCapture ? algebraic(move.from)[0] + "x" : "";
        text += algebraic(move.to);
        if (move.promo) text += "=" + move.promo.toUpperCase();
      } else {
        text = kind.toUpperCase();
        // Disambiguate against other same-kind pieces that can also legally
        // reach the target square.
        var rivals = this.legalMoves().filter(function (other) {
          return (
            other.to === move.to &&
            other.from !== move.from &&
            kindOf(this.board[other.from]) === kind
          );
        }, this);
        if (rivals.length > 0) {
          var sameFile = rivals.some(function (other) {
            return fileOf(other.from) === fileOf(move.from);
          });
          var sameRank = rivals.some(function (other) {
            return rankOf(other.from) === rankOf(move.from);
          });
          if (!sameFile) text += algebraic(move.from)[0];
          else if (!sameRank) text += algebraic(move.from)[1];
          else text += algebraic(move.from);
        }
        if (isCapture) text += "x";
        text += algebraic(move.to);
      }
    }

    var next = this.applying(move);
    if (next.isInCheck) {
      text += next.legalMoves().length === 0 ? "#" : "+";
    }
    return text;
  };

  /**
   * The key used for threefold-repetition counting: placement, side to move,
   * castling rights, and the en-passant file — but the latter only when an
   * en-passant capture is actually legal, matching FIDE's definition (and the
   * v1 Swift engine).
   */
  Position.prototype.repetitionKey = function () {
    var base = this.piecePlacementFEN() + " " + this.turn + " " + this.castlingFEN();
    if (this.ep >= 0 && this.hasLegalEnPassantCapture()) {
      return base + " " + algebraic(this.ep);
    }
    return base + " -";
  };

  Position.prototype.hasLegalEnPassantCapture = function () {
    if (this.ep < 0) return false;
    var behind = this.ep + (this.turn === WHITE ? -16 : 16);
    var pawn = coloredPiece(this.turn, "p");
    var offsets = [-1, 1];
    for (var i = 0; i < 2; i++) {
      var from = behind + offsets[i];
      if (onBoard(from) && this.board[from] === pawn) {
        var move = { from: from, to: this.ep, promo: null };
        if (this.isKingSafeAfter(move)) return true;
      }
    }
    return false;
  };

  /** Dead positions: K vs K, a lone minor, or same-colored bishops only. */
  Object.defineProperty(Position.prototype, "isInsufficientMaterial", {
    get: function () {
      var minors = [];
      for (var sq = 0; sq < 128; sq++) {
        if (!onBoard(sq)) continue;
        var piece = this.board[sq];
        if (piece === null) continue;
        var kind = kindOf(piece);
        if (kind === "k") continue;
        if (kind === "p" || kind === "r" || kind === "q") return false;
        minors.push({ kind: kind, light: isLightSquare(sq) });
      }
      if (minors.length <= 1) return true;
      var allBishops = minors.every(function (m) {
        return m.kind === "b";
      });
      if (allBishops) {
        var first = minors[0].light;
        return minors.every(function (m) {
          return m.light === first;
        });
      }
      return false;
    },
  });

  // ---------------------------------------------------------------------------
  // Game: a start position plus every move played, legality enforced on entry.
  // Draws by repetition / fifty-move / dead position are declared automatically
  // — correspondence chess has no arbiter to claim to.
  // ---------------------------------------------------------------------------

  function Game(start) {
    this.positions = [start || Position.initial()];
    this.moves = [];
    this.sanHistory = [];
  }

  Object.defineProperty(Game.prototype, "position", {
    get: function () {
      return this.positions[this.positions.length - 1];
    },
  });

  Game.prototype.make = function (move) {
    if (this.status().kind !== "ongoing") {
      throw new Error("gameIsOver");
    }
    if (!this.position.isLegal(move)) {
      throw new Error("illegalMove");
    }
    var san = this.position.san(move);
    this.positions.push(this.position.applying(move));
    this.moves.push(move);
    this.sanHistory.push(san);
  };

  /**
   * Status kinds: ongoing (with inCheck), checkmate (with winner), stalemate,
   * fiftyMoveRule, threefoldRepetition, insufficientMaterial.
   */
  Game.prototype.status = function () {
    var current = this.position;
    if (current.legalMoves().length === 0) {
      return current.isInCheck
        ? { kind: "checkmate", winner: opponent(current.turn) }
        : { kind: "stalemate" };
    }
    if (current.isInsufficientMaterial) return { kind: "insufficientMaterial" };
    if (current.halfmove >= 100) return { kind: "fiftyMoveRule" };
    if (this.repetitionCount() >= 3) return { kind: "threefoldRepetition" };
    return { kind: "ongoing", inCheck: current.isInCheck };
  };

  Game.prototype.repetitionCount = function () {
    var key = this.position.repetitionKey();
    var count = 0;
    for (var i = 0; i < this.positions.length; i++) {
      if (this.positions[i].repetitionKey() === key) count += 1;
    }
    return count;
  };

  Game.prototype.uciMoves = function () {
    return this.moves.map(moveToUci);
  };

  /** Rebuilds a game by replaying UCI moves. Null if any move is bad. */
  Game.fromUciMoves = function (uciMoves, start) {
    var game = new Game(start);
    for (var i = 0; i < uciMoves.length; i++) {
      var move = moveFromUci(uciMoves[i]);
      if (move === null) return null;
      try {
        game.make(move);
      } catch (error) {
        return null;
      }
    }
    return game;
  };

  /** "12. Nf3" for a white move, "12… Nf6" for a black move. */
  Game.prototype.lastMoveDescription = function () {
    if (this.sanHistory.length === 0) return null;
    var ply = this.sanHistory.length;
    var number = Math.ceil(ply / 2);
    var san = this.sanHistory[ply - 1];
    return ply % 2 === 1 ? number + ". " + san : number + "… " + san;
  };

  /** "1. e4 e5 2. Nf3 Nc6" */
  Game.prototype.moveListText = function () {
    var parts = [];
    for (var i = 0; i < this.sanHistory.length; i++) {
      if (i % 2 === 0) parts.push(i / 2 + 1 + ".");
      parts.push(this.sanHistory[i]);
    }
    return parts.join(" ");
  };

  // ---------------------------------------------------------------------------
  // MatchState: everything a match needs to travel inside a message. In v1
  // this rode an MSMessage's URL; here it rides the fragment of an ordinary
  // https link. The keys are v1's keys (v, m, do, rb, da); v1's per-device
  // seat UUIDs (w, b) are obsolete on the web and ignored when present.
  // ---------------------------------------------------------------------------

  var MATCH_VERSION = 1;

  function MatchState() {
    this.version = MATCH_VERSION;
    this.moves = []; // UCI strings
    this.drawOfferedBy = null; // "w" | "b" | null
    this.resignedBy = null; // "w" | "b" | null
    this.drawAgreed = false;
    this.drawAgreedBy = null; // "w" | "b" | null (null on legacy "da=1" payloads)
  }

  MatchState.prototype.clone = function () {
    var copy = new MatchState();
    copy.version = this.version;
    copy.moves = this.moves.slice();
    copy.drawOfferedBy = this.drawOfferedBy;
    copy.resignedBy = this.resignedBy;
    copy.drawAgreed = this.drawAgreed;
    copy.drawAgreedBy = this.drawAgreedBy;
    return copy;
  };

  /** Encodes as a URL-fragment-safe query string, e.g. "v=1&m=e2e4,e7e5&do=w". */
  MatchState.prototype.encode = function () {
    var parts = ["v=" + this.version];
    if (this.moves.length > 0) parts.push("m=" + this.moves.join(","));
    if (this.drawOfferedBy) parts.push("do=" + this.drawOfferedBy);
    if (this.resignedBy) parts.push("rb=" + this.resignedBy);
    // "da" carries the accepting color; bare "1" is the legacy v1 form.
    if (this.drawAgreed) parts.push("da=" + (this.drawAgreedBy || "1"));
    return parts.join("&");
  };

  /**
   * Decodes a fragment/query string (leading "#" or "?" allowed). Returns
   * null when the payload is malformed. Unknown keys are ignored for forward
   * compatibility — which also lets v1 bubble URLs (with their w=/b= seat
   * UUIDs) decode cleanly.
   */
  MatchState.decode = function (text) {
    if (typeof text !== "string") return null;
    if (text[0] === "#" || text[0] === "?") text = text.slice(1);
    if (text === "") return null;
    var state = new MatchState();
    var sawVersion = false;
    var pairs = text.split("&");
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf("=");
      if (eq === -1) continue;
      var key = pairs[i].slice(0, eq);
      var value;
      try {
        value = decodeURIComponent(pairs[i].slice(eq + 1));
      } catch (error) {
        return null;
      }
      switch (key) {
        case "v":
          state.version = parseInt(value, 10);
          if (isNaN(state.version)) return null;
          sawVersion = true;
          break;
        case "m":
          var tokens = value.split(",");
          for (var j = 0; j < tokens.length; j++) {
            if (moveFromUci(tokens[j]) === null) return null;
            state.moves.push(tokens[j].toLowerCase());
          }
          break;
        case "do":
          if (value !== WHITE && value !== BLACK) return null;
          state.drawOfferedBy = value;
          break;
        case "rb":
          if (value !== WHITE && value !== BLACK) return null;
          state.resignedBy = value;
          break;
        case "da":
          if (value === WHITE || value === BLACK) {
            state.drawAgreed = true;
            state.drawAgreedBy = value;
          } else if (value === "1") {
            state.drawAgreed = true; // legacy form: accepter unknown
          } else {
            return null;
          }
          break;
        default:
          break; // Unknown keys ignored for forward compatibility.
      }
    }
    if (!sawVersion) return null;
    return state;
  };

  /** Replays the move list into a full game. Null means corrupt/illegal. */
  MatchState.prototype.makeGame = function () {
    return Game.fromUciMoves(this.moves);
  };

  /**
   * The final outcome, or null while the game is live:
   * { winner: "w" | "b" | null, reason: <EndReason> }.
   * Reasons: checkmate, resignation, stalemate, agreement, fiftyMoveRule,
   * threefoldRepetition, insufficientMaterial.
   */
  MatchState.prototype.verdict = function (game) {
    if (this.resignedBy) {
      return { winner: opponent(this.resignedBy), reason: "resignation" };
    }
    if (this.drawAgreed) {
      return { winner: null, reason: "agreement" };
    }
    var status = game.status();
    switch (status.kind) {
      case "ongoing":
        return null;
      case "checkmate":
        return { winner: status.winner, reason: "checkmate" };
      case "stalemate":
        return { winner: null, reason: "stalemate" };
      case "fiftyMoveRule":
        return { winner: null, reason: "fiftyMoveRule" };
      case "threefoldRepetition":
        return { winner: null, reason: "threefoldRepetition" };
      case "insufficientMaterial":
        return { winner: null, reason: "insufficientMaterial" };
    }
    return null;
  };

  var END_REASON_NAMES = {
    checkmate: "checkmate",
    resignation: "resignation",
    stalemate: "stalemate",
    agreement: "draw agreed",
    fiftyMoveRule: "fifty-move rule",
    threefoldRepetition: "threefold repetition",
    insufficientMaterial: "insufficient material",
  };

  // ---------------------------------------------------------------------------

  return {
    WHITE: WHITE,
    BLACK: BLACK,
    START_FEN: START_FEN,
    Position: Position,
    Game: Game,
    MatchState: MatchState,
    moveFromUci: moveFromUci,
    moveToUci: moveToUci,
    sameMove: sameMove,
    algebraic: algebraic,
    parseSquare: parseSquare,
    fileOf: fileOf,
    rankOf: rankOf,
    makeSquare: makeSquare,
    onBoard: onBoard,
    colorOf: colorOf,
    kindOf: kindOf,
    opponent: opponent,
    endReasonName: function (reason) {
      return END_REASON_NAMES[reason] || reason;
    },
  };
});
