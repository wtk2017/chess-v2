/*
 * ChessMate web app. All game state lives in the URL fragment (never sent to
 * any server); this file is the glue between the rules engine and the DOM.
 *
 * The flow mirrors the v1 iMessage extension: an incoming payload is decoded
 * and re-validated by replay, the viewer plays the side to move, and their
 * action is *staged* — nothing is final until they send the produced link
 * themselves (in v1, Apple required the human to hit send; here the share
 * sheet does the same job).
 */
(function () {
  "use strict";

  var E = ChessMate;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    landing: $("landing"),
    corrupt: $("corrupt"),
    game: $("game"),
    board: $("board"),
    statusLine: $("statusLine"),
    statusDetail: $("statusDetail"),
    drawBanner: $("drawBanner"),
    drawBannerText: $("drawBannerText"),
    sendPanel: $("sendPanel"),
    sendTitle: $("sendTitle"),
    sendCaption: $("sendCaption"),
    linkPeek: $("linkPeek"),
    actionBar: $("actionBar"),
    offerDrawBtn: $("offerDrawBtn"),
    overPanel: $("overPanel"),
    overTitle: $("overTitle"),
    overDetail: $("overDetail"),
    movesText: $("movesText"),
    fenText: $("fenText"),
    flipBtn: $("flipBtn"),
    promoOverlay: $("promoOverlay"),
    promoChoices: $("promoChoices"),
    smsBtn: $("smsBtn"),
  };

  var GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  var TEXT_STYLE = "\uFE0E"; // force text presentation (iOS renders ♟ as emoji otherwise)
  var PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

  var incoming = null;   // MatchState currently on the board
  var game = null;       // Game replayed from `incoming`
  var seat = null;       // the side this viewer plays ("w" | "b")
  var staged = null;     // { state, game, kind } — action awaiting send
  var selection = -1;    // selected 0x88 square, or -1
  var pendingPromotion = null; // { from, to } while the picker is open
  var offerDraw = false; // "offer draw with move" toggle
  var drawDeclined = false; // hide an incoming offer after "Play on"
  var orientationOverride = null;

  function baseURL() {
    return location.href.split("#")[0];
  }

  function colorName(color) {
    return color === E.WHITE ? "White" : "Black";
  }

  // ---------------------------------------------------------------------------
  // Boot / routing
  // ---------------------------------------------------------------------------

  function boot() {
    staged = null;
    selection = -1;
    pendingPromotion = null;
    offerDraw = false;
    drawDeclined = false;
    orientationOverride = null;
    els.promoOverlay.classList.add("hidden");

    var hash = location.hash;
    if (!hash || hash === "#") {
      incoming = null;
      game = null;
      show("landing");
      return;
    }
    var state = E.MatchState.decode(hash);
    var replayed = state && state.makeGame();
    if (!state || !replayed) {
      show("corrupt");
      return;
    }
    incoming = state;
    game = replayed;
    seat = game.position.turn;
    show("game");
    render();
  }

  function startFreshGame() {
    incoming = new E.MatchState();
    game = new E.Game();
    seat = E.WHITE;
    staged = null;
    selection = -1;
    offerDraw = false;
    drawDeclined = false;
    orientationOverride = null;
    if (location.hash) {
      // Clear the fragment without reloading; boot() must not re-route us.
      history.replaceState(null, "", baseURL());
    }
    show("game");
    render();
  }

  function show(screen) {
    els.landing.classList.toggle("hidden", screen !== "landing");
    els.corrupt.classList.toggle("hidden", screen !== "corrupt");
    els.game.classList.toggle("hidden", screen !== "game");
    els.flipBtn.classList.toggle("hidden", screen !== "game");
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    var displayState = staged ? staged.state : incoming;
    var displayGame = staged ? staged.game : game;
    var position = displayGame.position;
    var verdict = displayState.verdict(displayGame);
    var live = !staged && !verdict;

    renderStatus(displayState, displayGame, verdict);
    renderBoard(position, displayGame, live);
    renderPanels(displayState, displayGame, verdict, live);

    els.movesText.textContent = displayGame.moveListText() || "No moves yet.";
    els.fenText.textContent = "FEN " + position.fen();
    document.title = staged
      ? "Send your move — ChessMate"
      : verdict
        ? "Game over — ChessMate"
        : "Your move — ChessMate";
  }

  function renderStatus(state, currentGame, verdict) {
    var line = els.statusLine;
    var detail = els.statusDetail;
    line.textContent = "";
    detail.textContent = "";

    if (staged) {
      var titles = {
        move: "Move staged — now send it",
        resign: "Resignation staged",
        accept: "Draw accepted",
        rematch: "Rematch ready",
      };
      line.textContent = titles[staged.kind] || "Ready to send";
      detail.textContent = "Nothing is final until the link below reaches your opponent.";
      return;
    }

    if (verdict) {
      if (verdict.winner) {
        var prefix = verdict.reason === "checkmate" ? "Checkmate — " : "";
        line.textContent = prefix + colorName(verdict.winner) + " wins";
      } else {
        line.textContent = "Draw";
      }
      detail.textContent = "By " + E.endReasonName(verdict.reason) + ". " + summary(currentGame);
      return;
    }

    var status = currentGame.status();
    line.textContent = "Your move — you're " + colorName(seat);
    var last = currentGame.lastMoveDescription();
    detail.textContent = last ? "They played " + last + ". " : "New game — make the first move. ";
    if (status.kind === "ongoing" && status.inCheck) {
      var alert = document.createElement("span");
      alert.className = "status-check";
      alert.textContent = "You're in check!";
      detail.appendChild(alert);
    }
  }

  function summary(currentGame) {
    var count = currentGame.sanHistory.length;
    return count === 0 ? "" : count + (count === 1 ? " half-move played." : " half-moves played.");
  }

  function renderBoard(position, displayGame, live) {
    var orient = orientationOverride || seat || E.WHITE;
    var lastMove = displayGame.moves.length > 0 ? displayGame.moves[displayGame.moves.length - 1] : null;
    var checkedKing = -1;
    var status = displayGame.status();
    if (status.kind === "checkmate" || (status.kind === "ongoing" && status.inCheck)) {
      checkedKing = position.kingSquare(position.turn);
    }
    var targets = {};
    if (live && selection >= 0) {
      position.legalMovesFrom(selection).forEach(function (move) {
        targets[move.to] = true;
      });
    }

    els.board.textContent = "";
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        var file = orient === E.WHITE ? col : 7 - col;
        var rank = orient === E.WHITE ? 7 - row : row;
        var sq = E.makeSquare(file, rank);
        var piece = position.pieceAt(sq);

        var cell = document.createElement("button");
        cell.type = "button";
        cell.className = "sq " + (((file + rank) % 2 === 1) ? "light" : "dark");
        cell.dataset.sq = sq;
        var label = E.algebraic(sq);
        if (piece) {
          label += " — " + (E.colorOf(piece) === E.WHITE ? "white " : "black ") + PIECE_NAMES[E.kindOf(piece)];
        }
        cell.setAttribute("aria-label", label);

        var tint = document.createElement("span");
        tint.className = "tint";
        cell.appendChild(tint);

        if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cell.classList.add("lastmove");
        if (sq === selection) cell.classList.add("selected");
        if (sq === checkedKing) cell.classList.add("incheck");
        if (targets[sq]) cell.classList.add(piece ? "ring" : "dot");

        if (piece) {
          var glyph = document.createElement("span");
          glyph.className = "glyph " + E.colorOf(piece);
          glyph.textContent = GLYPHS[E.kindOf(piece)] + TEXT_STYLE;
          cell.appendChild(glyph);
        }

        var isBottomRow = row === 7;
        var isLeftCol = col === 0;
        if (isLeftCol) {
          var rankLabel = document.createElement("span");
          rankLabel.className = "coord rank";
          rankLabel.textContent = rank + 1;
          cell.appendChild(rankLabel);
        }
        if (isBottomRow) {
          var fileLabel = document.createElement("span");
          fileLabel.className = "coord file";
          fileLabel.textContent = String.fromCharCode(97 + file);
          cell.appendChild(fileLabel);
        }

        if (live) cell.addEventListener("click", onSquareTap);
        els.board.appendChild(cell);
      }
    }
  }

  function renderPanels(state, currentGame, verdict, live) {
    // Incoming draw offer: shown only while live and not already declined.
    var offered = live && !drawDeclined && state.drawOfferedBy && state.drawOfferedBy !== seat;
    els.drawBanner.classList.toggle("hidden", !offered);
    if (offered) {
      els.drawBannerText.textContent =
        colorName(state.drawOfferedBy) + " offers a draw. Accept, or just play your move to decline.";
    }

    els.actionBar.classList.toggle("hidden", !live);
    els.offerDrawBtn.setAttribute("aria-pressed", String(offerDraw));

    els.overPanel.classList.toggle("hidden", !(verdict && !staged));
    if (verdict && !staged) {
      els.overTitle.textContent = verdict.winner
        ? colorName(verdict.winner) + " wins — " + E.endReasonName(verdict.reason)
        : "Draw — " + E.endReasonName(verdict.reason);
      els.overDetail.textContent =
        "Good game! A rematch link hands White to whoever opens it.";
    }

    els.sendPanel.classList.toggle("hidden", !staged);
    if (staged) {
      var link = baseURL() + "#" + staged.state.encode();
      var caption = buildCaption();
      els.sendCaption.textContent = caption;
      els.linkPeek.textContent = link;
      els.sendTitle.textContent = {
        move: "Send your move",
        resign: "Send your resignation",
        accept: "Send the draw agreement",
        rematch: "Send the rematch invite",
      }[staged.kind] || "Send";
      var body = caption + " " + link;
      var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      els.smsBtn.href = ios
        ? "sms:&body=" + encodeURIComponent(body)
        : "sms:?body=" + encodeURIComponent(body);
    }
  }

  function buildCaption() {
    if (!staged) return "";
    if (staged.kind === "resign") {
      return "♟️ ChessMate — I resign. You win, good game!";
    }
    if (staged.kind === "accept") {
      return "♟️ ChessMate — draw accepted. Good game!";
    }
    if (staged.kind === "rematch") {
      return "♟️ ChessMate — rematch? You take White this time. Tap to make the first move.";
    }
    var desc = staged.game.lastMoveDescription();
    var verdict = staged.state.verdict(staged.game);
    if (verdict && verdict.reason === "checkmate") {
      return "♟️ ChessMate — " + desc + ". Checkmate — good game!";
    }
    if (verdict) {
      return "♟️ ChessMate — " + desc + ". " + E.endReasonName(verdict.reason) + " — it's a draw.";
    }
    var text = staged.game.moves.length === 1
      ? "♟️ ChessMate — new game! I opened " + desc + ". You're Black — your move."
      : "♟️ ChessMate — " + desc + ". Your move.";
    if (staged.state.drawOfferedBy === seat) {
      text += " (I offer a draw.)";
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  function onSquareTap(event) {
    if (staged) return;
    var sq = parseInt(event.currentTarget.dataset.sq, 10);
    var position = game.position;
    var piece = position.pieceAt(sq);

    if (selection >= 0) {
      var candidates = position.legalMovesFrom(selection).filter(function (m) { return m.to === sq; });
      if (candidates.length > 0) {
        if (candidates[0].promo) {
          pendingPromotion = { from: selection, to: sq };
          showPromotionPicker(position.turn);
          return;
        }
        commitMove(candidates[0]);
        return;
      }
    }
    if (piece && E.colorOf(piece) === position.turn && sq !== selection) {
      selection = sq;
    } else {
      selection = -1;
    }
    render();
  }

  function commitMove(move) {
    var state = incoming.clone();
    state.moves.push(E.moveToUci(move));
    state.drawOfferedBy = offerDraw ? seat : null;
    var next = state.makeGame();
    if (!next) return; // impossible for a legal move; guard anyway
    staged = { state: state, game: next, kind: "move" };
    selection = -1;
    render();
  }

  function showPromotionPicker(color) {
    els.promoChoices.textContent = "";
    ["q", "r", "b", "n"].forEach(function (kind) {
      var btn = document.createElement("button");
      btn.type = "button";
      var glyph = document.createElement("span");
      glyph.className = "glyph " + color;
      glyph.textContent = GLYPHS[kind] + TEXT_STYLE;
      btn.appendChild(glyph);
      btn.setAttribute("aria-label", "Promote to " + PIECE_NAMES[kind]);
      btn.addEventListener("click", function () {
        var move = { from: pendingPromotion.from, to: pendingPromotion.to, promo: kind };
        pendingPromotion = null;
        els.promoOverlay.classList.add("hidden");
        commitMove(move);
      });
      els.promoChoices.appendChild(btn);
    });
    els.promoOverlay.classList.remove("hidden");
  }

  function stageSimple(kind, mutate) {
    var state = incoming.clone();
    mutate(state);
    staged = { state: state, game: game, kind: kind };
    selection = -1;
    render();
  }

  function copyText(text, button) {
    function flash() {
      var original = button.textContent;
      button.textContent = "Copied ✓";
      setTimeout(function () { button.textContent = original; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { fallbackCopy(text); flash(); });
    } else {
      fallbackCopy(text);
      flash();
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (error) { /* nothing more we can do */ }
    document.body.removeChild(area);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  $("newGameBtn").addEventListener("click", startFreshGame);
  $("corruptNewBtn").addEventListener("click", startFreshGame);

  $("flipBtn").addEventListener("click", function () {
    var current = orientationOverride || seat || E.WHITE;
    orientationOverride = E.opponent(current);
    render();
  });

  $("offerDrawBtn").addEventListener("click", function () {
    offerDraw = !offerDraw;
    render();
  });

  $("resignBtn").addEventListener("click", function () {
    if (!window.confirm("Resign this game?")) return;
    stageSimple("resign", function (state) { state.resignedBy = seat; });
  });

  $("acceptDrawBtn").addEventListener("click", function () {
    stageSimple("accept", function (state) { state.drawAgreed = true; });
  });

  $("declineDrawBtn").addEventListener("click", function () {
    drawDeclined = true;
    render();
  });

  $("rematchBtn").addEventListener("click", function () {
    var fresh = new E.MatchState();
    staged = { state: fresh, game: new E.Game(), kind: "rematch" };
    render();
  });

  $("undoBtn").addEventListener("click", function () {
    staged = null;
    offerDraw = false;
    render();
  });

  $("shareBtn").addEventListener("click", function () {
    if (!staged) return;
    var link = baseURL() + "#" + staged.state.encode();
    var caption = buildCaption();
    if (navigator.share) {
      navigator.share({ text: caption, url: link }).catch(function () { /* user cancelled */ });
    } else {
      copyText(caption + " " + link, $("shareBtn"));
    }
  });

  $("copyBtn").addEventListener("click", function () {
    if (!staged) return;
    copyText(baseURL() + "#" + staged.state.encode(), $("copyBtn"));
  });

  els.promoOverlay.addEventListener("click", function (event) {
    if (event.target === els.promoOverlay) {
      pendingPromotion = null;
      els.promoOverlay.classList.add("hidden");
    }
  });

  window.addEventListener("hashchange", boot);
  boot();
})();
