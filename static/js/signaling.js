/**
 * SignalingClient — HTTP-polling wrapper around the Flask REST API.
 * Stores and retrieves SDP offers, answers, and ICE candidates.
 */
class SignalingClient {
  /**
   * @param {string}   baseUrl      - e.g. "" (same origin) or "http://localhost:5000"
   * @param {string}   roomId
   * @param {string}   peerId
   * @param {string}   displayName
   */
  constructor(baseUrl, roomId, peerId, displayName) {
    this.baseUrl      = baseUrl || "";
    this.roomId       = roomId;
    this.peerId        = peerId;
    this.displayName  = displayName;
    this._intervals    = [];
  }

  // ── Room ───────────────────────────────────────────────────────────────────

  /** Create a new room. Returns { room_id }. */
  async createRoom() {
    const res = await fetch(`${this.baseUrl}/api/rooms`, { method: "POST" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    this.roomId = json.data.room_id;
    return json.data;
  }

  /** Fetch room info + current peer list. */
  async getRoom() {
    const res = await fetch(`${this.baseUrl}/api/rooms/${this.roomId}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    return json.data;
  }

  // ── Peer registration ─────────────────────────────────────────────────────

  /** Register (or re-register) the local peer in the room. */
  async register() {
    const res = await fetch(`${this.baseUrl}/api/rooms/${this.roomId}/peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id: this.peerId, display_name: this.displayName }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    return json.data.peer;
  }

  /** Send a heartbeat so the server knows we're still alive. */
  async heartbeat() {
    try {
      await fetch(`${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}/heartbeat`, {
        method: "POST",
      });
    } catch (_) { /* fire-and-forget */ }
  }

  /** Leave the room (delete our peer record). */
  async leave() {
    try {
      await fetch(`${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}`, {
        method: "DELETE",
      });
    } catch (_) { /* fire-and-forget */ }
  }

  // ── Offers ────────────────────────────────────────────────────────────────

  /**
   * Push an SDP offer aimed at a specific remote peer.
   * The server stores it; the target retrieves it via getOffer().
   */
  async sendOffer(remotePeerId, sdp, type = "offer") {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${remotePeerId}/offer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp, type, from_peer_id: this.peerId }),
      }
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
  }

  /** Retrieve pending offers directed at the local peer (all senders). */
  async getOffers() {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}/offer`
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    return json.data.offers || [];
  }

  // ── Answers ────────────────────────────────────────────────────────────────

  async sendAnswer(remotePeerId, sdp, type = "answer") {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${remotePeerId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp, type, from_peer_id: this.peerId }),
      }
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
  }

  async getAnswers() {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}/answer`
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    return json.data.answers || [];
  }

  // ── ICE Candidates ────────────────────────────────────────────────────────

  async sendIceCandidate(remotePeerId, candidate) {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${remotePeerId}/candidates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate, from_peer_id: this.peerId }),
      }
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
  }

  async getIceCandidates() {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}/candidates`
    );
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    return json.data.candidates || [];
  }

  // ── Polling helpers ───────────────────────────────────────────────────────

  /**
   * Start polling for incoming offers, answers, candidates, and peer list.
   * Each callback receives the relevant data.
   */
  startPolling({ onOffers, onAnswers, onCandidates, onPeers } = {}) {
    // Fast poll: offers / answers / candidates  (1 s)
    const fast = setInterval(async () => {
      if (onOffers) {
        const offers = await this.getOffers().catch(() => []);
        if (offers.length) onOffers(offers);
      }
      if (onAnswers) {
        const answers = await this.getAnswers().catch(() => []);
        if (answers.length) onAnswers(answers);
      }
      if (onCandidates) {
        const cands = await this.getIceCandidates().catch(() => []);
        if (cands.length) onCandidates(cands);
      }
    }, 1000);
    this._intervals.push(fast);

    // Slow poll: peer list (3 s)
    if (onPeers) {
      const slow = setInterval(async () => {
        const data = await this.getRoom().catch(() => null);
        if (data) onPeers(data.peers || []);
      }, 3000);
      this._intervals.push(slow);
    }

    // Heartbeat every 30 s
    const hb = setInterval(() => this.heartbeat(), 30000);
    this._intervals.push(hb);
  }

  stopPolling() {
    this._intervals.forEach(clearInterval);
    this._intervals = [];
  }
}
