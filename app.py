"""Flask backend for PairDrop Clone — signaling server + static file serving."""
import random
import string
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import db

# ── constants ──────────────────────────────────────────────────────────────────

BASE_DIR   = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
STALE_THRESHOLD = 60   # seconds before a peer is considered stale

# ── app factory ────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=str(STATIC_DIR), template_folder=str(TEMPLATE_DIR))
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ── helpers ────────────────────────────────────────────────────────────────────

def gen_room_id(length: int = 8) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choices(chars, k=length))

def json_ok(data=None, status: int = 200):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    return jsonify(payload), status

def json_err(msg: str, status: int = 400):
    return jsonify({"ok": False, "error": msg}), status

# ── static / SPA ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(str(TEMPLATE_DIR), "index.html")

@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(str(STATIC_DIR), filename)

# ── room routes ────────────────────────────────────────────────────────────────

@app.route("/api/rooms", methods=["POST"])
def create_room():
    room_id = gen_room_id()
    room = db.create_room(room_id)
    return json_ok({"room_id": room["room_id"], "created_at": room["created_at"]}), 201

@app.route("/api/rooms/<room_id>", methods=["GET"])
def get_room(room_id: str):
    room = db.get_room(room_id)
    if not room:
        return json_err("Room not found", 404)
    peers = db.get_peers(room_id)
    return json_ok({"room": room, "peers": peers})

# ── peer routes ────────────────────────────────────────────────────────────────

@app.route("/api/rooms/<room_id>/peers", methods=["POST"])
def register_peer(room_id: str):
    room = db.get_room(room_id)
    if not room:
        return json_err("Room not found", 404)

    body = request.get_json() or {}
    peer_id     = body.get("peer_id")
    display_name = body.get("display_name", "Anonymous")

    if not peer_id:
        return json_err("peer_id is required")

    peer = db.get_peer(peer_id)
    if peer:
        # Re-join / heartbeat
        db.touch_peer(peer_id)
    else:
        peer = db.add_peer(peer_id, room_id, display_name)

    db.touch_room(room_id)
    return json_ok({"peer": peer}), 201

@app.route("/api/rooms/<room_id>/peers/<peer_id>/heartbeat", methods=["POST"])
def heartbeat(room_id: str, peer_id: str):
    peer = db.get_peer(peer_id)
    if not peer:
        return json_err("Peer not found", 404)
    db.touch_peer(peer_id)
    db.touch_room(room_id)
    return json_ok()

@app.route("/api/rooms/<room_id>/peers/<peer_id>", methods=["DELETE"])
def unregister_peer(room_id: str, peer_id: str):
    db.remove_peer(peer_id)
    return json_ok()

# ── offer routes ───────────────────────────────────────────────────────────────

@app.route("/api/rooms/<room_id>/peers/<peer_id>/offer", methods=["GET"])
def get_offer(room_id: str, peer_id: str):
    """Return the stored offer from any peer, then clear it for this peer."""
    peer = db.get_peer(peer_id)
    if not peer:
        return json_err("Peer not found", 404)
    # Return any pending offers (for bootstrapping / polling)
    offers = db.get_pending_offers(peer_id)
    return json_ok({"offers": offers})

@app.route("/api/rooms/<room_id>/peers/<peer_id>/offer", methods=["POST"])
def post_offer(room_id: str, peer_id: str):
    """Accept an SDP offer from another peer and store it for retrieval."""
    body = request.get_json() or {}
    sdp     = body.get("sdp")
    sdp_type = body.get("type", "offer")
    from_peer_id = body.get("from_peer_id")

    if not sdp or not from_peer_id:
        return json_err("sdp and from_peer_id are required")

    # Persist the raw offer SDP on the target peer's record
    db.save_offer_sdp(peer_id, sdp, sdp_type)

    # Also push onto pending queue so polling catches it
    db.push_offer(from_peer_id, peer_id, sdp, sdp_type)

    return json_ok()

# ── answer routes ─────────────────────────────────────────────────────────────

@app.route("/api/rooms/<room_id>/peers/<peer_id>/answer", methods=["GET"])
def get_answer(room_id: str, peer_id: str):
    peer = db.get_peer(peer_id)
    if not peer:
        return json_err("Peer not found", 404)
    answers = db.get_pending_answers(peer_id)
    return json_ok({"answers": answers})

@app.route("/api/rooms/<room_id>/peers/<peer_id>/answer", methods=["POST"])
def post_answer(room_id: str, peer_id: str):
    body = request.get_json() or {}
    sdp      = body.get("sdp")
    sdp_type = body.get("type", "answer")
    from_peer_id = body.get("from_peer_id")

    if not sdp or not from_peer_id:
        return json_err("sdp and from_peer_id are required")

    db.save_answer_sdp(peer_id, sdp, sdp_type)
    db.push_answer(from_peer_id, peer_id, sdp, sdp_type)

    return json_ok()

# ── ICE candidate routes ───────────────────────────────────────────────────────

@app.route("/api/rooms/<room_id>/peers/<peer_id>/candidates", methods=["GET"])
def get_candidates(room_id: str, peer_id: str):
    peer = db.get_peer(peer_id)
    if not peer:
        return json_err("Peer not found", 404)
    cands = db.get_pending_candidates(peer_id)
    return json_ok({"candidates": cands})

@app.route("/api/rooms/<room_id>/peers/<peer_id>/candidates", methods=["POST"])
def post_candidates(room_id: str, peer_id: str):
    body = request.get_json() or {}
    candidate      = body.get("candidate")
    from_peer_id   = body.get("from_peer_id")

    if not candidate or not from_peer_id:
        return json_err("candidate and from_peer_id are required")

    db.push_ice_candidate(from_peer_id, peer_id, candidate)
    return json_ok()

# ── stale-peer cleanup thread ─────────────────────────────────────────────────

def _cleanup_loop():
    while True:
        time.sleep(30)
        try:
            db.cleanup_stale(STALE_THRESHOLD)
            db.cleanup_orphaned_rooms()
        except Exception:
            pass   # don't crash the background thread

_thread = threading.Thread(target=_cleanup_loop, daemon=True)
_thread.start()

# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    db.init_db()
    print("Starting PairDrop Clone at http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
