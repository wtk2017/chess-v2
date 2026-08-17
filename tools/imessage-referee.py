#!/usr/bin/env python3
"""
imessage-referee.py — the optional "third party in the group chat".

A Mac that is a member of an iMessage group chat becomes the referee: people
text plain moves ("e4", "Nf3", "O-O", or UCI like "e2e4") and the referee
validates them against the running game, announces the move in SAN, prints a
Unicode board, and posts the ChessMate v2 link so everyone can tap into the
graphical board. The two phones play; the Mac only keeps score.

This is a companion to the main link-based design (see DESIGN.md §5), not a
requirement — two players need no third party at all. It exists for group
games and for circles that prefer texting bare notation.

STATUS: experimental, macOS only, best-effort by nature. Apple has no
supported API for reading Messages; this uses the two well-worn community
techniques (reading the chat.db SQLite database, sending via AppleScript),
both of which Apple occasionally disturbs in OS updates.

Requirements
------------
- macOS with Messages signed in and a member of the group chat.
- Full Disk Access for your terminal app (System Settings → Privacy &
  Security), or reading ~/Library/Messages/chat.db will fail.
- Automation permission for Messages (macOS prompts on first send).
- pip install python-chess

Usage
-----
  # Find your group chat's GUID (look for its display name):
  python3 tools/imessage-referee.py --list-chats

  # Referee that chat:
  python3 tools/imessage-referee.py --chat-guid "iMessage;+;chat123456789" \
      --site https://wtk2017.github.io/chess-v2/

  # Sanity-check the chess logic with no Mac services touched:
  python3 tools/imessage-referee.py --selftest

In-chat commands: a SAN or UCI move on its own line makes a move (the first
two people to move claim White and Black, as in v1); "board" reposts the
position; "resign" resigns; "new game" starts over.
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

try:
    import chess
except ImportError:
    chess = None

DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
POLL_SECONDS = 3.0
COMMAND_RE = re.compile(r"^(new game|new|board|moves|resign)$", re.IGNORECASE)
# Something that *looks like* a move (SAN, UCI, or castling) even when it is
# not legal right now — used to answer move attempts after the game has ended
# while staying silent for ordinary chatter.
MOVE_SHAPE_RE = re.compile(
    r"^(?:[a-h][1-8][a-h][1-8][qrbnQRBN]?"
    r"|[O0]-[O0](?:-[O0])?"
    r"|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$"
)


# ---------------------------------------------------------------------------
# Game state — deliberately the same shape as the v2 wire format.
# ---------------------------------------------------------------------------

class Referee:
    def __init__(self, site):
        self.site = site.rstrip("/") + "/" if site else None
        self.reset()

    def reset(self):
        self.board = chess.Board()
        self.moves = []          # UCI strings, the canonical record
        self.seats = {}          # {"w": handle, "b": handle}
        self.resigned_by = None  # "w" | "b" | None

    def link(self):
        if not self.site:
            return ""
        payload = "v=1"
        if self.moves:
            payload += "&m=" + ",".join(self.moves)
        if self.resigned_by:
            payload += "&rb=" + self.resigned_by
        return self.site + "#" + payload

    def side_to_move(self):
        return "w" if self.board.turn == chess.WHITE else "b"

    def seat_of(self, handle):
        for color, owner in self.seats.items():
            if owner == handle:
                return color
        return None

    def try_move(self, text, handle):
        """Returns a reply string if `text` was a move for `handle`, else None."""
        if self.resigned_by or self.board.outcome(claim_draw=True):
            if MOVE_SHAPE_RE.match(text):
                return "The game is over — text “new game” for another."
            return None

        move = None
        try:
            move = self.board.parse_san(text)
        except ValueError:
            try:
                move = chess.Move.from_uci(text.lower())
                if move not in self.board.legal_moves:
                    move = None
            except ValueError:
                move = None
        if move is None:
            return None  # ordinary chat (or an illegal move) — stay silent

        mover = self.side_to_move()
        seated = self.seat_of(handle)
        if seated is None and mover not in self.seats:
            self.seats[mover] = handle  # first (then second) mover claims the seat
            seated = mover
        if seated != mover:
            return None  # not their turn, or a spectator: stay silent

        san = self.board.san(move)
        number = self.board.fullmove_number
        prefix = f"{number}. " if self.board.turn == chess.WHITE else f"{number}… "
        self.board.push(move)
        self.moves.append(move.uci())

        outcome = self.board.outcome(claim_draw=True)
        if outcome:
            if outcome.winner is None:
                verdict = f"Draw — {outcome.termination.name.replace('_', ' ').lower()}."
            else:
                winner = "White" if outcome.winner == chess.WHITE else "Black"
                verdict = f"Checkmate — {winner} wins!"
            return f"♟️ {prefix}{san}. {verdict}\n{self.unicode_board()}\n{self.link()}"

        turn = "White" if self.board.turn == chess.WHITE else "Black"
        return (f"♟️ {prefix}{san} — {turn} to move.\n"
                f"{self.unicode_board()}\n"
                f"Tap for the board: {self.link()}")

    def resign(self, handle):
        seated = self.seat_of(handle)
        if seated is None:
            return None
        self.resigned_by = seated
        winner = "White" if seated == "b" else "Black"
        return f"♟️ {'White' if seated == 'w' else 'Black'} resigns — {winner} wins. {self.link()}"

    def unicode_board(self):
        return self.board.unicode(empty_square="·")

    def status_text(self):
        turn = "White" if self.board.turn == chess.WHITE else "Black"
        return f"♟️ {turn} to move after {len(self.moves)} half-moves.\n{self.unicode_board()}\n{self.link()}"


# ---------------------------------------------------------------------------
# Messages database (read) — needs Full Disk Access.
# ---------------------------------------------------------------------------

def open_db():
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

def list_chats():
    with open_db() as db:
        rows = db.execute(
            "SELECT guid, COALESCE(display_name, ''), chat_identifier FROM chat ORDER BY ROWID DESC"
        ).fetchall()
    for guid, name, identifier in rows:
        print(f"{guid}\t{name or identifier}")

def latest_rowid(db, chat_guid):
    row = db.execute(
        """SELECT COALESCE(MAX(m.ROWID), 0) FROM message m
           JOIN chat_message_join j ON j.message_id = m.ROWID
           JOIN chat c ON c.ROWID = j.chat_id WHERE c.guid = ?""",
        (chat_guid,),
    ).fetchone()
    return row[0]

def new_messages(db, chat_guid, after_rowid):
    rows = db.execute(
        """SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, COALESCE(h.id, 'me')
           FROM message m
           JOIN chat_message_join j ON j.message_id = m.ROWID
           JOIN chat c ON c.ROWID = j.chat_id
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           WHERE c.guid = ? AND m.ROWID > ? ORDER BY m.ROWID""",
        (chat_guid, after_rowid),
    ).fetchall()
    out = []
    for rowid, text, blob, is_from_me, handle in rows:
        body = text or decode_attributed_body(blob)
        if body:
            out.append((rowid, body.strip(), bool(is_from_me), handle))
    return out

def decode_attributed_body(blob):
    """Newer macOS often leaves message.text NULL and stores the string inside
    the typedstream attributedBody. This is the community-standard best-effort
    extraction — good enough for short move texts."""
    if not blob:
        return None
    try:
        index = blob.find(b"NSString")
        if index == -1:
            return None
        content = blob[index + len(b"NSString") + 5:]
        if content[0] == 0x81:
            length = int.from_bytes(content[1:3], "little")
            start = 3
        else:
            length = content[0]
            start = 1
        return content[start:start + length].decode("utf-8", errors="ignore")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Messages sending (AppleScript). Addressing by chat GUID is the method that
# still works for group chats on current macOS; Apple breaks this
# periodically, hence "experimental".
# ---------------------------------------------------------------------------

def send_message(chat_guid, text):
    script = (
        'on run {targetGuid, theText}\n'
        '  tell application "Messages"\n'
        '    send theText to chat id targetGuid\n'
        '  end tell\n'
        'end run'
    )
    subprocess.run(["osascript", "-e", script, chat_guid, text], check=True)


# ---------------------------------------------------------------------------

def run(chat_guid, site):
    referee = Referee(site)
    with open_db() as db:
        cursor = latest_rowid(db, chat_guid)  # start from "now"; old chatter is not moves
    print(f"Refereeing {chat_guid} from message {cursor}. Ctrl-C to stop.")
    while True:
        time.sleep(POLL_SECONDS)
        with open_db() as db:
            batch = new_messages(db, chat_guid, cursor)
        for rowid, body, is_from_me, handle in batch:
            cursor = rowid
            if is_from_me:
                continue  # never react to our own posts
            reply = handle_message(referee, body, handle)
            if reply:
                try:
                    send_message(chat_guid, reply)
                except subprocess.CalledProcessError as error:
                    print(f"send failed ({error}); reply was:\n{reply}", file=sys.stderr)

def handle_message(referee, body, handle):
    command = COMMAND_RE.match(body)
    if command:
        word = command.group(1).lower()
        if word in ("new", "new game"):
            referee.reset()
            return f"♟️ New game — first to move takes White. {referee.link()}"
        if word in ("board", "moves"):
            return referee.status_text()
        if word == "resign":
            return referee.resign(handle)
    return referee.try_move(body, handle)


def selftest():
    """Exercises the pure chess logic with no macOS services."""
    referee = Referee("https://example.test/chess/")
    assert referee.try_move("hello everyone", "alice") is None, "chatter ignored"
    reply = referee.try_move("e4", "alice")
    assert reply and "1. e4" in reply and "#v=1&m=e2e4" in reply, reply
    assert referee.try_move("d4", "alice") is None, "same player can't move twice"
    reply = referee.try_move("e7e5", "bob")  # UCI accepted too
    assert reply and "1… e5" in reply and "m=e2e4,e7e5" in reply, reply
    assert referee.try_move("Ke7", "carol") is None, "third person spectates"
    referee.reset()
    for who, move in [("a", "f3"), ("b", "e5"), ("a", "g4")]:
        assert referee.try_move(move, who)
    reply = referee.try_move("Qh4", "b")
    assert reply and "Checkmate — Black wins!" in reply, reply
    assert "The game is over" in referee.try_move("a3", "a")
    referee.reset()
    referee.try_move("e4", "a")
    resigned = referee.resign("a")
    assert resigned and "rb=w" in resigned, resigned
    print("selftest: all good")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--list-chats", action="store_true", help="print chat GUIDs and exit")
    parser.add_argument("--chat-guid", help="GUID of the group chat to referee")
    parser.add_argument("--site", default="", help="base URL of the ChessMate v2 page for links")
    parser.add_argument("--selftest", action="store_true", help="test the chess logic only")
    args = parser.parse_args()

    if chess is None:
        sys.exit("python-chess is required: pip install python-chess")
    if args.selftest:
        selftest()
        return
    if args.list_chats:
        list_chats()
        return
    if not args.chat_guid:
        parser.error("--chat-guid is required (find it with --list-chats)")
    if sys.platform != "darwin":
        sys.exit("This referee reads the macOS Messages database — run it on a Mac.")
    run(args.chat_guid, args.site)


if __name__ == "__main__":
    main()
