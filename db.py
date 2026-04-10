"""SQLite database setup and helpers for PairDrop Clone."""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "pairdrop.db"
LOCK = threading.Lock()

# ── connection ──────────────────────────────────────────────────────────────────

@contextmanager
def get_db():
    with LOCK:
        conn = sqlite3.connect(str(DB_PATH), timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

# ── init ────────────────────────────────────────────────────────────────────────

def init_db():
    with get_db() as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS rooms (
                room_id        TEXT PRIMARY KEY,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS peers (
                id                  TEXT PRIMARY KEY,
                room_id             TEXT,
                display_name        TEXT,
                last_seen           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                offer_sdp           TEXT,
                offer_type          TEXT,
                answer_sdp          TEXT,
                answer_type         TEXT,
                ice_candidates      TEXT DEFAULT '[]',
                pending_offers      TEXT DEFAULT '[]',
                pending_answers     TEXT DEFAULT '[]',
                pending_candidates  TEXT DEFAULT '[]',
                FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_peers_room ON peers(room_id)
        """)

# ── room helpers ────────────────────────────────────────────────────────────────

def create_room(room_id: str) -> dict:
    with get_db() as conn:
        c = conn.cursor()
        c.execute("INSERT OR IGNORE INTO rooms (room_id) VALUES (?)", (room_id,))
        return get_room(room_id)

def get_room(room_id: str) -> dict | None:
    with get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id,))
        row = c.fetchone()
        return dict(row) if row else None

def touch_room(room_id: str):
    with get_db() as conn:
        c = conn.cursor()
        c.execute(
            "UPDATE rooms SET last_activity = CURRENT_TIMESTAMP WHERE room_id = ?",
            (room_id,)
        )

# ── peer helpers ───────────────────────────────────────────────────────────────

def add_peer(peer_id: str, room_id: str, display_name: str) -> dict:
    with get_db() as conn:
        c = conn.cursor()
        c.execute("""
            INSERT OR IGNORE INTO peers (id, room_id, display_name)
            VALUES (?, ?, ?)
        """, (peer_id, room_id, display_name))
        return get_peer(peer_id)

def get_peer(peer_id: str) -> dict | None:
    with get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM peers WHERE id = ?", (peer_id,))
        row = c.fetchone()
        return _parse_peer(row) if row else None

def get_peers(room_id: str) -> list[dict]:
    with get_db() as conn:
        c = conn.cursor()
        c.execute(
            "SELECT * FROM peers WHERE room_id = ? ORDER BY last_seen DESC",
            (room_id,)
        )
        return [_parse_peer(row) for row in c.fetchall()]

def update_peer(peer_id: str, **fields):
    """Update arbitrary columns on a peer record."""
    if not fields:
        return get_peer(peer_id)
    cols, vals = zip(*fields.items())
    set_clause = ", ".join(f"{col} = ?" for col in cols)
    with get_db() as conn:
        c = conn.cursor()
        c.execute(
            f"UPDATE peers SET {set_clause} WHERE id = ?",
            (*vals, peer_id)
        )
    return get_peer(peer_id)

def touch_peer(peer_id: str):
    with get_db() as conn:
        c = conn.cursor()
        c.execute(
            "UPDATE peers SET last_seen = CURRENT_TIMESTAMP WHERE id = ?",
            (peer_id,)
        )

def remove_peer(peer_id: str):
    with get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM peers WHERE id = ?", (peer_id,))

# ── signaling helpers ──────────────────────────────────────────────────────────

def _json_col(peer_id: str, col: str) -> list:
    """Return a mutable copy of a JSON column."""
    p = get_peer(peer_id)
    return json.loads(p[col]) if p and p[col] else []

def _save_json_col(peer_id: str, col: str, data: list):
    update_peer(peer_id, **{col: json.dumps(data)})

def push_offer(from_peer_id: str, to_peer_id: str, sdp: str, sdp_type: str):
    """Push an offer (from_peer → to_peer) onto the target peer's pending_offers."""
    offers = _json_col(to_peer_id, "pending_offers")
    offers = [o for o in offers if o["from_peer"] != from_peer_id]  # dedup
    offers.append({"from_peer": from_peer_id, "sdp": sdp, "type": sdp_type})
    _save_json_col(to_peer_id, "pending_offers", offers)

def pop_offer(peer_id: str, from_peer_id: str) -> dict | None:
    """Pop and return the oldest offer from from_peer_id, or None."""
    offers = _json_col(peer_id, "pending_offers")
    result = None
    offers = [o for o in offers if o["from_peer"] != from_peer_id]
    # Actually pop only the one we want
    remaining = []
    for o in offers:
        if o["from_peer"] == from_peer_id and result is None:
            result = o
        else:
            remaining.append(o)
    _save_json_col(peer_id, "pending_offers", remaining)
    return result

def get_pending_offers(peer_id: str) -> list[dict]:
    return _json_col(peer_id, "pending_offers")

def push_answer(from_peer_id: str, to_peer_id: str, sdp: str, sdp_type: str):
    answers = _json_col(to_peer_id, "pending_answers")
    answers = [a for a in answers if a["from_peer"] != from_peer_id]
    answers.append({"from_peer": from_peer_id, "sdp": sdp, "type": sdp_type})
    _save_json_col(to_peer_id, "pending_answers", answers)

def pop_answer(peer_id: str, from_peer_id: str) -> dict | None:
    answers = _json_col(peer_id, "pending_answers")
    result = None
    remaining = []
    for a in answers:
        if a["from_peer"] == from_peer_id and result is None:
            result = a
        else:
            remaining.append(a)
    _save_json_col(peer_id, "pending_answers", remaining)
    return result

def get_pending_answers(peer_id: str) -> list[dict]:
    return _json_col(peer_id, "pending_answers")

def push_ice_candidate(from_peer_id: str, to_peer_id: str, candidate: dict):
    """Push an ICE candidate from from_peer onto the target peer's pending_candidates."""
    cands = _json_col(to_peer_id, "pending_candidates")
    cands = [c for c in cands if not (c["from_peer"] == from_peer_id and c["candidate"] == candidate)]
    cands.append({"from_peer": from_peer_id, "candidate": candidate})
    _save_json_col(to_peer_id, "pending_candidates", cands)

def pop_candidates_for(peer_id: str, from_peer_id: str) -> list[dict]:
    """Return and clear all cached ICE candidates from from_peer_id."""
    all_cands = _json_col(peer_id, "pending_candidates")
    ours = [c["candidate"] for c in all_cands if c["from_peer"] == from_peer_id]
    remaining = [c for c in all_cands if c["from_peer"] != from_peer_id]
    _save_json_col(peer_id, "pending_candidates", remaining)
    return ours

def get_pending_candidates(peer_id: str) -> list[dict]:
    return _json_col(peer_id, "pending_candidates")

def save_offer_sdp(peer_id: str, sdp: str, sdp_type: str):
    update_peer(peer_id, offer_sdp=sdp, offer_type=sdp_type)

def save_answer_sdp(peer_id: str, sdp: str, sdp_type: str):
    update_peer(peer_id, answer_sdp=sdp, answer_type=sdp_type)

# ── cleanup ─────────────────────────────────────────────────────────────────────

def cleanup_stale(max_age_seconds: int = 60):
    """Remove peers with no heartbeat for > max_age_seconds."""
    with get_db() as conn:
        c = conn.cursor()
        c.execute("""
            DELETE FROM peers
            WHERE last_seen < datetime('now', ?)
        """, (f"-{max_age_seconds} seconds",))

def cleanup_orphaned_rooms():
    """Remove rooms with no peers."""
    with get_db() as conn:
        c = conn.cursor()
        c.execute("""
            DELETE FROM rooms
            WHERE room_id NOT IN (SELECT DISTINCT room_id FROM peers)
        """)

# ── internals ───────────────────────────────────────────────────────────────────

def _parse_peer(row: sqlite3.Row) -> dict:
    d = dict(row)
    for col in ("ice_candidates", "pending_offers", "pending_answers", "pending_candidates"):
        if d.get(col):
            try:
                d[col] = json.loads(d[col])
            except Exception:
                d[col] = []
        else:
            d[col] = []
    return d
