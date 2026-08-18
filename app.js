/*
 * ChessMate web app. All game state lives in the URL fragment (never sent to
 * any server); this file is the glue between the rules engine and the DOM.
 *
 * The flow mirrors the v1 iMessage extension: an incoming payload is decoded
 * and re-validated by replay, the viewer plays the side to move, and their
 * action is *staged* — nothing is final until they send the produced link
 * themselves (in v1, Apple required the human to hit send; here the share
 * sheet does the same job).
 *
 * Seat guard: links this device has sent are remembered in localStorage, so
 * reopening your own bubble shows a read-only "waiting" view instead of
 * mis-seating you as your opponent (an explicit override allows deliberate
 * pass-and-play on one phone).
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
    takeOverBtn: $("takeOverBtn"),
    drawBanner: $("drawBanner"),
    drawBannerText: $("drawBannerText"),
    materialBar: $("materialBar"),
    matBottom: $("matBottom"),
    matTop: $("matTop"),
    stepper: $("stepper"),
    histPrev: $("histPrev"),
    histNext: $("histNext"),
    histLabel: $("histLabel"),
    sendPanel: $("sendPanel"),
    sendTitle: $("sendTitle"),
    sendCaption: $("sendCaption"),
    linkPeek: $("linkPeek"),
    sentNote: $("sentNote"),
    shareBtn: $("shareBtn"),
    undoBtn: $("undoBtn"),
    actionBar: $("actionBar"),
    offerDrawBtn: $("offerDrawBtn"),
    resignBtn: $("resignBtn"),
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
  var PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  var incoming = null;   // MatchState currently on the board
  var game = null;       // Game replayed from `incoming`
  var seat = null;       // the side this viewer plays ("w" | "b")
  var staged = null;     // { state, game, kind, sent } — action awaiting/after send
  var sentMode = false;  // viewing a link this device already sent
  var selection = -1;    // selected 0x88 square, or -1
  var viewPly = null;    // history stepper: ply being viewed, or null for latest
  var pendingPromotion = null; // { from, to } while the picker is open
  var offerDraw = false; // "offer draw with move" toggle
  var drawDeclined = false; // hide an incoming offer after "Play on"
  var resignArmed = false;  // two-step resign confirmation
  var resignTimer = null;
  var orientationOverride = null;

  function baseURL() {
    return location.href.split(/[?#]/)[0];
  }

  /** Served through the link-preview worker? (It injects this meta tag.) */
  function richLinks() {
    return !!document.querySelector('meta[name="chessmate-rich-links"]');
  }

  /**
   * The shareable URL for a state. The #fragment form is canonical (never
   * reaches any server); the ?g= query form opts into per-position link
   * previews when the app is served through the preview worker.
   */
  function linkFor(state) {
    var payload = state.encode();
    return richLinks()
      ? baseURL() + "?g=" + encodeURIComponent(payload)
      : baseURL() + "#" + payload;
  }

  function colorName(color) {
    return color === E.WHITE ? "White" : "Black";
  }

  function scoreString(verdict) {
    if (!verdict.winner) return "½–½";
    return verdict.winner === E.WHITE ? "1–0" : "0–1";
  }

  // ---------------------------------------------------------------------------
  // Sent-link memory (localStorage; payload strings only, capped)
  // ---------------------------------------------------------------------------

  var SENT_KEY = "chessmate.sent.v1";

  function sentList() {
    try {
      var raw = localStorage.getItem(SENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function recordSent(payload) {
    try {
      var list = sentList().filter(function (p) { return p !== payload; });
      list.push(payload);
      if (list.length > 80) list = list.slice(list.length - 80);
      localStorage.setItem(SENT_KEY, JSON.stringify(list));
    } catch (error) { /* private mode etc. — guard simply won't arm */ }
  }

  function wasSentByThisDevice(payload) {
    return sentList().indexOf(payload) !== -1;
  }

  // ---------------------------------------------------------------------------
  // Boot / routing
  // ---------------------------------------------------------------------------

  function resetTransient() {
    staged = null;
    sentMode = false;
    selection = -1;
    viewPly = null;
    pendingPromotion = null;
    offerDraw = false;
    drawDeclined = false;
    disarmResign();
    orientationOverride = null;
    els.promoOverlay.classList.add("hidden");
  }

  function boot() {
    resetTransient();
    var payload = null;
    var hash = location.hash;
    if (hash && hash !== "#") {
      payload = hash.slice(1);
    } else {
      // Query form (?g=…) — used by the link-preview worker.
      var match = /(?:^|[?&])g=([^&]*)/.exec(location.search);
      if (match) {
        try {
          payload = decodeURIComponent(match[1]);
        } catch (error) {
          payload = null;
        }
      }
    }
    if (!payload) {
      incoming = null;
      game = null;
      show("landing");
      return;
    }
    var state = E.MatchState.decode(payload);
    var replayed = state && state.makeGame();
    if (!state || !replayed) {
      show("corrupt");
      return;
    }
    incoming = state;
    game = replayed;
    var mine = wasSentByThisDevice(payload);
    var verdict = incoming.verdict(game);
    if (verdict) {
      seat = seatForVerdict(incoming, replayed, mine);
    } else if (mine && replayed.moves.length > 0) {
      // This device produced this link (blank invites carry no seat to
      // guard): show the sender's waiting view.
      sentMode = true;
      seat = E.opponent(game.position.turn);
    } else {
      seat = game.position.turn;
    }
    show("game");
    render();
  }

  /**
   * Which side does this viewer hold on a finished game? Explicit finals
   * (resignation, agreed draw) name their sender; otherwise the last mover
   * sent the link, so the receiver is the side to move. The sent-link memory
   * identifies a sender reopening their own final link.
   */
  function seatForVerdict(state, finishedGame, mine) {
    if (state.resignedBy) {
      return mine ? state.resignedBy : E.opponent(state.resignedBy);
    }
    if (state.drawAgreed && state.drawAgreedBy) {
      return mine ? state.drawAgreedBy : E.opponent(state.drawAgreedBy);
    }
    var turn = finishedGame.position.turn;
    return mine ? E.opponent(turn) : turn;
  }

  function startFreshGame() {
    resetTransient();
    incoming = new E.MatchState();
    game = new E.Game();
    seat = E.WHITE;
    if (location.hash) {
      // Clear the fragment without reloading; boot() must not re-route us.
      history.replaceState(null, "", baseURL());
    }
    show("game");
    render();
  }

  function stageInvite() {
    resetTransient();
    incoming = new E.MatchState();
    game = new E.Game();
    seat = E.BLACK; // the inviter will answer as Black
    staged = { state: new E.MatchState(), game: new E.Game(), kind: "invite", sent: false };
    if (location.hash) history.replaceState(null, "", baseURL());
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

  function displayed() {
    return {
      state: staged ? staged.state : incoming,
      game: staged ? staged.game : game,
    };
  }

  function render() {
    var current = displayed();
    var verdict = current.state.verdict(current.game);
    var live = !staged && !verdict && !sentMode;
    var maxPly = current.game.moves.length;
    if (viewPly !== null && (viewPly < 0 || viewPly >= maxPly)) viewPly = null;
    var shownPly = viewPly === null ? maxPly : viewPly;
    var position = current.game.positions[shownPly];
    var browsing = viewPly !== null;

    renderStatus(current.state, current.game, verdict);
    renderBoard(position, current.game, shownPly, live && !browsing);
    renderMaterial(position);
    renderStepper(maxPly, shownPly);
    renderPanels(current.state, current.game, verdict, live);

    els.movesText.textContent = current.game.moveListText() || "No moves yet.";
    els.fenText.textContent = "FEN " + position.fen();
    document.title = staged
      ? "Send your move — ChessMate"
      : verdict
        ? "Game over — ChessMate"
        : sentMode
          ? "Waiting — ChessMate"
          : "Your move — ChessMate";
  }

  function renderStatus(state, currentGame, verdict) {
    var line = els.statusLine;
    var detail = els.statusDetail;
    line.textContent = "";
    detail.textContent = "";
    els.takeOverBtn.classList.toggle("hidden", !sentMode);

    if (staged) {
      var stagedVerdict = staged.state.verdict(staged.game);
      if (staged.sent) {
        if (stagedVerdict) {
          line.textContent = "Link sent — game over, " + scoreString(stagedVerdict);
        } else {
          line.textContent = "Link sent — waiting for " +
            (staged.kind === "move" ? colorName(staged.game.position.turn) : "their reply");
        }
        detail.textContent = "You can close this page; the game lives in your chat.";
        return;
      }
      if (stagedVerdict && staged.kind === "move") {
        line.textContent = stagedVerdict.reason === "checkmate"
          ? "Checkmate — send it to finish the game"
          : "This move ends the game — " + E.endReasonName(stagedVerdict.reason);
        detail.textContent = "Nothing is final until the link reaches your opponent.";
        return;
      }
      var titles = {
        move: "Move staged — now send it",
        resign: "Resignation staged",
        accept: "Draw accepted",
        rematch: "Rematch ready",
        invite: "Invite ready",
      };
      line.textContent = titles[staged.kind] || "Ready to send";
      detail.textContent = "Nothing is final until the link below reaches your opponent.";
      return;
    }

    if (verdict) {
      line.textContent = verdict.winner
        ? (verdict.reason === "checkmate" ? "Checkmate — " : "") +
          colorName(verdict.winner) + " wins"
        : "Draw — " + E.endReasonName(verdict.reason);
      var moveCount = Math.ceil(currentGame.sanHistory.length / 2);
      var parts = [scoreString(verdict)];
      if (verdict.winner && verdict.reason !== "checkmate") parts.push("by " + E.endReasonName(verdict.reason));
      if (moveCount > 0) parts.push(moveCount + (moveCount === 1 ? " move" : " moves"));
      detail.textContent = parts.join(" · ");
      return;
    }

    if (sentMode) {
      line.textContent = "Sent — waiting for " + colorName(currentGame.position.turn);
      detail.textContent = "This is the link you sent; it's their move. Browse the game below.";
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

  function renderBoard(position, currentGame, shownPly, interactive) {
    var orient = orientationOverride || seat || E.WHITE;
    var lastMove = shownPly > 0 ? currentGame.moves[shownPly - 1] : null;
    var checkedKing = -1;
    if (position.isInCheck) {
      checkedKing = position.kingSquare(position.turn);
    }
    var targets = {};
    if (interactive && selection >= 0) {
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
        if (sq === selection && interactive) cell.classList.add("selected");
        if (sq === checkedKing) cell.classList.add("incheck");
        if (targets[sq]) cell.classList.add(piece ? "ring" : "dot");

        if (piece) {
          var glyph = document.createElement("span");
          glyph.className = "glyph " + E.colorOf(piece);
          glyph.textContent = GLYPHS[E.kindOf(piece)] + TEXT_STYLE;
          cell.appendChild(glyph);
        }

        if (col === 0) {
          var rankLabel = document.createElement("span");
          rankLabel.className = "coord rank";
          rankLabel.textContent = rank + 1;
          cell.appendChild(rankLabel);
        }
        if (row === 7) {
          var fileLabel = document.createElement("span");
          fileLabel.className = "coord file";
          fileLabel.textContent = String.fromCharCode(97 + file);
          cell.appendChild(fileLabel);
        }

        if (interactive) cell.addEventListener("click", onSquareTap);
        els.board.appendChild(cell);
      }
    }
  }

  /** Captured pieces per side, promotion-aware (per-type deficit vs the start). */
  function capturedBy(position, capturer) {
    var start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    var counts = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    var victim = E.opponent(capturer);
    for (var sq = 0; sq < 128; sq++) {
      if (!E.onBoard(sq)) continue;
      var piece = position.pieceAt(sq);
      if (piece && E.colorOf(piece) === victim) {
        var kind = E.kindOf(piece);
        if (kind !== "k") counts[kind] += 1;
      }
    }
    var taken = [];
    ["q", "r", "b", "n", "p"].forEach(function (kind) {
      for (var i = counts[kind]; i < start[kind]; i++) taken.push(kind);
    });
    return taken;
  }

  function materialPoints(taken) {
    return taken.reduce(function (sum, kind) { return sum + PIECE_VALUES[kind]; }, 0);
  }

  function renderMaterial(position) {
    var orient = orientationOverride || seat || E.WHITE;
    var bottomTaken = capturedBy(position, orient);
    var topTaken = capturedBy(position, E.opponent(orient));
    if (bottomTaken.length === 0 && topTaken.length === 0) {
      els.materialBar.classList.add("hidden");
      return;
    }
    els.materialBar.classList.remove("hidden");
    var diff = materialPoints(bottomTaken) - materialPoints(topTaken);
    fillMaterial(els.matBottom, bottomTaken, E.opponent(orient), diff > 0 ? diff : 0);
    fillMaterial(els.matTop, topTaken, orient, diff < 0 ? -diff : 0);
  }

  function fillMaterial(el, taken, victimColor, plus) {
    el.textContent = "";
    var glyphs = document.createElement("span");
    glyphs.className = "mat-glyphs " + victimColor;
    glyphs.textContent = taken.map(function (kind) { return GLYPHS[kind] + TEXT_STYLE; }).join("");
    el.appendChild(glyphs);
    if (plus > 0) {
      var score = document.createElement("span");
      score.className = "mat-score";
      score.textContent = " +" + plus;
      el.appendChild(score);
    }
  }

  function renderStepper(maxPly, shownPly) {
    if (maxPly === 0) {
      els.stepper.classList.add("hidden");
      return;
    }
    els.stepper.classList.remove("hidden");
    els.histPrev.disabled = shownPly === 0;
    els.histNext.disabled = shownPly === maxPly;
    if (shownPly === maxPly) {
      els.histLabel.textContent = "Latest position";
    } else if (shownPly === 0) {
      els.histLabel.textContent = "Start · 0 of " + maxPly;
    } else {
      var current = displayed().game;
      var ply = shownPly;
      var number = Math.ceil(ply / 2);
      var san = current.sanHistory[ply - 1];
      els.histLabel.textContent =
        "After " + number + (ply % 2 === 1 ? ". " : "… ") + san + " · " + ply + " of " + maxPly;
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
    if (!resignArmed) els.resignBtn.textContent = "Resign";

    els.overPanel.classList.toggle("hidden", !(verdict && !staged));
    if (verdict && !staged) {
      els.overTitle.textContent = "Rematch?";
      els.overDetail.textContent = seat === E.BLACK
        ? "Good game! Colors alternate — you take White this time."
        : "Good game! Colors alternate — the invite hands White to your opponent.";
    }

    els.sendPanel.classList.toggle("hidden", !staged);
    if (staged) {
      var link = linkFor(staged.state);
      var caption = buildCaption();
      els.sendCaption.textContent = caption;
      els.linkPeek.textContent = link;
      els.sendTitle.textContent = {
        move: "Send your move",
        resign: "Send your resignation",
        accept: "Send the draw agreement",
        rematch: "Send the rematch invite",
        invite: "Send the invite",
      }[staged.kind] || "Send";
      var shareLabels = {
        move: "Send your move…",
        resign: "Send your resignation…",
        accept: "Send the draw agreement…",
        rematch: "Send the rematch invite…",
        invite: "Send the invite…",
      };
      els.shareBtn.textContent = navigator.share
        ? (shareLabels[staged.kind] || "Send…")
        : "Copy link";
      $("copyBtn").classList.toggle("hidden", !navigator.share);
      if (staged.kind === "invite") {
        els.undoBtn.textContent = "Never mind";
      } else {
        els.undoBtn.textContent = staged.sent ? "Stage a different move" : "Undo";
      }
      els.sentNote.classList.toggle("hidden", !staged.sent);
      if (staged.sent) {
        els.sentNote.textContent =
          "Sent ✓ — only stage a different move if they haven't opened the first link.";
      }
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
    if (staged.kind === "invite") {
      return "♟️ ChessMate — fancy a game? You take White. Tap the link and make the first move.";
    }
    var desc = staged.game.lastMoveDescription();
    var verdict = staged.state.verdict(staged.game);
    if (verdict && verdict.reason === "checkmate") {
      return "♟️ ChessMate — " + desc + ". Checkmate, " + scoreString(verdict) + " — good game!";
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
    if (staged || sentMode || viewPly !== null) return;
    disarmResign();
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
    staged = { state: state, game: next, kind: "move", sent: false };
    selection = -1;
    viewPly = null;
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
        closePromotionPicker();
        commitMove(move);
      });
      els.promoChoices.appendChild(btn);
    });
    els.promoOverlay.classList.remove("hidden");
  }

  function closePromotionPicker() {
    pendingPromotion = null;
    els.promoOverlay.classList.add("hidden");
  }

  function stageSimple(kind, mutate) {
    var state = incoming.clone();
    mutate(state);
    staged = { state: state, game: game, kind: kind, sent: false };
    selection = -1;
    viewPly = null;
    render();
  }

  function markSent() {
    if (!staged || staged.sent) return void render();
    staged.sent = true;
    var payload = staged.state.encode();
    if (payload !== "v=1") recordSent(payload); // blank invites carry no seat to guard
    render();
  }

  function disarmResign() {
    resignArmed = false;
    if (resignTimer) {
      clearTimeout(resignTimer);
      resignTimer = null;
    }
    if (els.resignBtn) els.resignBtn.textContent = "Resign";
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
  $("inviteBtn").addEventListener("click", stageInvite);

  els.takeOverBtn.addEventListener("click", function () {
    sentMode = false;
    seat = game.position.turn;
    render();
  });

  els.flipBtn.addEventListener("click", function () {
    var current = orientationOverride || seat || E.WHITE;
    orientationOverride = E.opponent(current);
    render();
  });

  els.histPrev.addEventListener("click", function () {
    var maxPly = displayed().game.moves.length;
    var shown = viewPly === null ? maxPly : viewPly;
    if (shown > 0) viewPly = shown - 1;
    selection = -1;
    render();
  });

  els.histNext.addEventListener("click", function () {
    var maxPly = displayed().game.moves.length;
    var shown = viewPly === null ? maxPly : viewPly;
    if (shown < maxPly) viewPly = shown + 1;
    if (viewPly >= maxPly) viewPly = null;
    selection = -1;
    render();
  });

  els.offerDrawBtn.addEventListener("click", function () {
    offerDraw = !offerDraw;
    disarmResign();
    render();
  });

  els.resignBtn.addEventListener("click", function () {
    if (!resignArmed) {
      resignArmed = true;
      els.resignBtn.textContent = "Confirm resign?";
      resignTimer = setTimeout(disarmResign, 4000);
      return;
    }
    disarmResign();
    stageSimple("resign", function (state) { state.resignedBy = seat; });
  });

  $("acceptDrawBtn").addEventListener("click", function () {
    stageSimple("accept", function (state) {
      state.drawAgreed = true;
      state.drawAgreedBy = seat;
    });
  });

  $("declineDrawBtn").addEventListener("click", function () {
    drawDeclined = true;
    render();
  });

  $("rematchBtn").addEventListener("click", function () {
    // Colors alternate: whoever held Black takes White now. A viewer who was
    // Black starts the next game locally (they move first); a viewer who was
    // White sends a blank invite that hands White to the opener.
    if (seat === E.BLACK) {
      startFreshGame();
      return;
    }
    staged = { state: new E.MatchState(), game: new E.Game(), kind: "rematch", sent: false };
    viewPly = null;
    render();
  });

  $("undoBtn").addEventListener("click", function () {
    var wasInvite = staged && staged.kind === "invite";
    staged = null;
    offerDraw = false;
    viewPly = null;
    if (wasInvite) {
      incoming = null;
      game = null;
      show("landing");
      return;
    }
    render();
  });

  els.shareBtn.addEventListener("click", function () {
    if (!staged) return;
    var link = linkFor(staged.state);
    var caption = buildCaption();
    if (navigator.share) {
      navigator.share({ text: caption, url: link }).then(markSent, function () { /* cancelled */ });
    } else {
      copyText(caption + " " + link, els.shareBtn);
      markSent();
    }
  });

  $("copyBtn").addEventListener("click", function () {
    if (!staged) return;
    copyText(linkFor(staged.state), $("copyBtn"));
    markSent();
  });

  els.smsBtn.addEventListener("click", function () {
    markSent();
  });

  $("promoCancelBtn").addEventListener("click", closePromotionPicker);
  els.promoOverlay.addEventListener("click", function (event) {
    if (event.target === els.promoOverlay) closePromotionPicker();
  });

  window.addEventListener("hashchange", boot);
  boot();
})();
