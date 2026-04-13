"""SQLite database setup and helpers for PairDrop Clone."""
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "pairdrop.db"

# ── connection ──────────────────────────────────────────────────────────────────

def _conn():
    """Return a thread-safe SQLite connection."""
    conn = sqlite3.connect(str(DB_PATH), timeout=10,
                           check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def _rows(cursor):
    return [dict(row) for row in cursor.fetchall()]

def _row(cursor):
    row = cursor.fetchone()
    return dict(row) if row else None

# ── init ───────────────────────────────────────────────────────────────────────

def init_db():
    c = _conn().cursor()
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
    c.execute("CREATE INDEX IF NOT EXISTS idx_peers_room ON peers(room_id)")

# ── room helpers ────────────────────────────────────────────────────────────────

def create_room(room_id: str) -> dict:
    conn = _conn()
    conn.execute("INSERT OR IGNORE INTO rooms (room_id) VALUES (?)", (room_id,))
    conn.commit()
    return get_room(room_id)

def get_room(room_id: str) -> dict | None:
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id,))
    row = c.fetchone()
    return dict(row) if row else None

def touch_room(room_id: str):
    conn = _conn()
    conn.execute(
        "UPDATE rooms SET last_activity = CURRENT_TIMESTAMP WHERE room_id = ?",
        (room_id,)
    )
    conn.commit()

def cleanup_orphaned_rooms():
    conn = _conn()
    conn.execute("""
        DELETE FROM rooms
        WHERE room_id NOT IN (SELECT DISTINCT room_id FROM peers WHERE room_id IS NOT NULL)
    """)
    conn.commit()

# ── peer helpers ───────────────────────────────────────────────────────────────

def add_peer(peer_id: str, room_id: str, display_name: str) -> dict:
    conn = _conn()
    conn.execute("""
        INSERT OR IGNORE INTO peers (id, room_id, display_name)
        VALUES (?, ?, ?)
    """, (peer_id, room_id, display_name))
    conn.commit()
    return get_peer(peer_id)

def get_peer(peer_id: str, raw: bool = False) -> dict | None:
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM peers WHERE id = ?", (peer_id,))
    conn.commit()
    d = _row(c)
    if d is None:
        return None
    if raw:
        return dict(d)
    return _parse_peer(dict(d))

def get_peers(room_id: str) -> list[dict]:
    conn = _conn()
    c = conn.cursor()
    c.execute(
        "SELECT * FROM peers WHERE room_id = ? ORDER BY last_seen DESC",
        (room_id,)
    )
    conn.commit()
    return [_parse_peer(dict(row)) for row in c.fetchall()]

def touch_peer(peer_id: str):
    conn = _conn()
    conn.execute(
        "UPDATE peers SET last_seen = CURRENT_TIMESTAMP WHERE id = ?",
        (peer_id,)
    )
    conn.commit()

def remove_peer(peer_id: str):
    conn = _conn()
    conn.execute("DELETE FROM peers WHERE id = ?", (peer_id,))
    conn.commit()

def update_peer(peer_id: str, **fields):
    if not fields:
        return get_peer(peer_id)
    cols = list(fields.keys())
    vals = list(fields.values())
    set_clause = ", ".join(f"{col} = ?" for col in cols)
    conn = _conn()
    conn.execute(
        f"UPDATE peers SET {set_clause} WHERE id = ?",
        (*vals, peer_id)
    )
    conn.commit()
    return get_peer(peer_id)

# ── signaling helpers ──────────────────────────────────────────────────────────

def _get_json(peer_id: str, col: str) -> list:
    p = get_peer(peer_id, raw=True)
    if not p or not p.get(col):
        return []
    try:
        return json.loads(p[col])
    except Exception:
        return []

def _set_json(peer_id: str, col: str, data: list):
    conn = _conn()
    conn.execute(
        f"UPDATE peers SET {col} = ? WHERE id = ?",
        (json.dumps(data), peer_id)
    )
    conn.commit()

def push_offer(from_peer_id: str, to_peer_id: str, sdp: str, sdp_type: str):
    offers = _get_json(to_peer_id, "pending_offers")
    offers = [o for o in offers if o.get("from_peer") != from_peer_id]
    offers.append({"from_peer": from_peer_id, "sdp": sdp, "type": sdp_type})
    _set_json(to_peer_id, "pending_offers", offers)

def get_pending_offers(peer_id: str) -> list[dict]:
    return _get_json(peer_id, "pending_offers")

def push_answer(from_peer_id: str, to_peer_id: str, sdp: str, sdp_type: str):
    answers = _get_json(to_peer_id, "pending_answers")
    answers = [a for a in answers if a.get("from_peer") != from_peer_id]
    answers.append({"from_peer": from_peer_id, "sdp": sdp, "type": sdp_type})
    _set_json(to_peer_id, "pending_answers", answers)

def get_pending_answers(peer_id: str) -> list[dict]:
    return _get_json(peer_id, "pending_answers")

def push_ice_candidate(from_peer_id: str, to_peer_id: str, candidate: dict):
    cands = _get_json(to_peer_id, "pending_candidates")
    cands.append({"from_peer": from_peer_id, "candidate": candidate})
    _set_json(to_peer_id, "pending_candidates", cands)

def get_pending_candidates(peer_id: str) -> list[dict]:
    return _get_json(peer_id, "pending_candidates")

def save_offer_sdp(peer_id: str, sdp: str, sdp_type: str):
    update_peer(peer_id, offer_sdp=sdp, offer_type=sdp_type)

def save_answer_sdp(peer_id: str, sdp: str, sdp_type: str):
    update_peer(peer_id, answer_sdp=sdp, answer_type=sdp_type)

# ── cleanup ─────────────────────────────────────────────────────────────────────

def cleanup_stale(max_age_seconds: int = 60):
    conn = _conn()
    conn.execute("""
        DELETE FROM peers
        WHERE last_seen < datetime('now', ?)
    """, (f"-{max_age_seconds} seconds",))
    conn.commit()

# ── internals ───────────────────────────────────────────────────────────────────

def _parse_peer(d: dict | None) -> dict | None:
    if not d:
        return None
    for col in ("ice_candidates", "pending_offers", "pending_answers", "pending_candidates"):
        try:
            d[col] = json.loads(d[col]) if d.get(col) else []
        except Exception:
            d[col] = []
    return d

# ── Vault (保险箱) ───────────────────────────────────────────────────────────

def init_vault_table():
    """Create vault_items table if not exists."""
    conn = _conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vault_items (
            id          TEXT PRIMARY KEY,
            code        TEXT UNIQUE NOT NULL,
            type        TEXT NOT NULL CHECK(type IN ('text', 'file')),
            content     TEXT,                    -- text content
            file_path   TEXT,                    -- file storage path
            file_name   TEXT,                    -- original filename
            file_size   INTEGER,
            mime_type   TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at  TIMESTAMP NOT NULL,
            status      TEXT DEFAULT 'active' CHECK(status IN ('active', 'claimed', 'expired'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vault_code ON vault_items(code)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vault_expires ON vault_items(expires_at)")
    conn.commit()

def generate_vault_code() -> str:
    """Generate 6-char base32 code (no 0,O,1,I,L), check for collision."""
    import random
    # 32 chars: 2-9, A-Z excluding O, I, L
    chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    while True:
        code = ''.join(random.choices(chars, k=6))
        if not get_vault_by_code(code):
            return code

def create_vault_item(item_type: str, content: str = None, file_path: str = None,
                      file_name: str = None, file_size: int = None, mime_type: str = None) -> dict:
    """Create a new vault item, return {id, code, expires_at}."""
    import uuid, time
    init_vault_table()
    item_id = str(uuid.uuid4())
    code = generate_vault_code()
    expires_at = time.time() + 1800  # 30 minutes
    
    conn = _conn()
    conn.execute("""
        INSERT INTO vault_items (id, code, type, content, file_path, file_name, file_size, mime_type, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (item_id, code, item_type, content, file_path, file_name, file_size, mime_type, expires_at))
    conn.commit()
    
    return {"id": item_id, "code": code, "expires_at": expires_at}

def get_vault_by_code(code: str) -> dict | None:
    """Get vault item by code, check expiration."""
    init_vault_table()
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM vault_items WHERE code = ? AND status = 'active'", (code,))
    row = c.fetchone()
    if not row:
        return None
    
    item = dict(row)
    import time
    if time.time() > item["expires_at"]:
        # Auto-expire
        conn.execute("UPDATE vault_items SET status = 'expired' WHERE id = ?", (item["id"],))
        conn.commit()
        return None
    return item

def claim_vault_item(code: str) -> dict | None:
    """Mark item as claimed (destroyed), return item data."""
    init_vault_table()
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM vault_items WHERE code = ? AND status = 'active'", (code,))
    row = c.fetchone()
    if not row:
        return None
    
    item = dict(row)
    import time
    if time.time() > item["expires_at"]:
        conn.execute("UPDATE vault_items SET status = 'expired' WHERE id = ?", (item["id"],))
        conn.commit()
        return None
    
    # Mark as claimed
    conn.execute("UPDATE vault_items SET status = 'claimed' WHERE id = ?", (item["id"],))
    conn.commit()
    return item

def cleanup_expired_vault():
    """Delete expired/claimed vault items and their files."""
    init_vault_table()
    import time, os
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT id, file_path FROM vault_items WHERE expires_at < ? OR status != 'active'", (time.time(),))
    rows = c.fetchall()
    
    for row in rows:
        # Delete file if exists
        if row["file_path"] and os.path.exists(row["file_path"]):
            try:
                os.remove(row["file_path"])
            except:
                pass
        # Delete DB record
        conn.execute("DELETE FROM vault_items WHERE id = ?", (row["id"],))
    
    conn.commit()
