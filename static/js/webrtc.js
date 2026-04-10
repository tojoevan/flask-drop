/**
 * PeerConnection — wraps RTCPeerConnection with a polling SignalingClient.
 * Manages one peer; handles offer/answer/ICE exchange and file transfer.
 */
class PeerConnection {
  /**
   * @param {string}          peerId       - remote peer ID
   * @param {SignalingClient} signaling
   * @param {object}          callbacks
   *   onMessage(msg: string)
   *   onFileChunk(chunk: {id, index, total, data})
   *   onFileComplete(meta: {id, name, size, mimeType})
   *   onStatusChange(state: 'connecting'|'connected'|'disconnected')
   */
  constructor(peerId, signaling, callbacks = {}) {
    this.peerId     = peerId;
    this.signaling  = signaling;
    this.onMessage       = callbacks.onMessage       || (() => {});
    this.onFileChunk     = callbacks.onFileChunk     || (() => {});
    this.onFileComplete  = callbacks.onFileComplete  || (() => {});
    this.onStatusChange  = callbacks.onStatusChange  || (() => {});

    this._pc          = null;
    this._dc          = null;   // primary DataChannel (we are the creator)
    this._dcReady     = false;
    this._pendingCands = [];    // ICE candidates buffered before remote desc is set
    this._initiator   = false;
    this._localDescSet = false;
    this._role        = null;   // "initiator" | "answerer" | null

    // File transfer state
    this._sendQueue   = [];     // files waiting to be sent
    this._recvBuffers = new Map(); // fileId → { meta, chunks[], received }
  }

  // ── Connection setup ────────────────────────────────────────────────────

  /** Begin a connection where we are the initiator (create offer). */
  async connectAsInitiator() {
    this._initiator = true;
    this._role      = "initiator";
    this._createPeerConnection();
    this._dc = this._pc.createDataChannel("file-transfer", { ordered: true });
    this._setupDataChannel();
    await this._createOffer();
    // Wait for ICE gathering to complete so candidates are sent promptly
    await new Promise((res) => {
      if (this._pc.iceGatheringState === "complete") { res(); return; }
      this._pc.onicegatheringstatechange = () => {
        if (this._pc.iceGatheringState === "complete") res();
      };
    });
    this.onStatusChange("connecting");
  }

  /** Accept an incoming connection (we are the answerer). */
  async acceptConnection() {
    this._initiator = false;
    this._role      = "answerer";
    this._createPeerConnection();
    this.onStatusChange("connecting");
  }

  _createPeerConnection() {
    const config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    };

    this._pc = new RTCPeerConnection(config);

    this._pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.sendIceCandidate(this.peerId, e.candidate.toJSON());
      }
    };

    this._pc.onconnectionstatechange = () => {
      const state = this._pc.connectionState;
      if (state === "connected") {
        this._dcReady = true;
        this._flushSendQueue();
        this.onStatusChange("connected");
      } else if (state === "disconnected" || state === "failed" || state === "closed") {
        this._dcReady = false;
        this.onStatusChange("disconnected");
      }
    };

    this._pc.ondatachannel = (e) => {
      // Remote side opened a data channel (we are answerer)
      this._dc = e.channel;
      this._setupDataChannel();
    };
  }

  _setupDataChannel() {
    this._dc.onopen = () => {
      this._dcReady = true;
      this._flushSendQueue();
      this.onStatusChange("connected");
    };

    this._dc.onclose = () => {
      this._dcReady = false;
      this.onStatusChange("disconnected");
    };

    this._dc.onmessage = (e) => this._handleMessage(e.data);
  }

  // ── Signaling flow ───────────────────────────────────────────────────────

  async _createOffer() {
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    this._localDescSet = true;
    this._applyBufferedCandidates();
    await this.signaling.sendOffer(this.peerId, offer.sdp, offer.type);
  }

  /** Called by app.js when we receive an offer meant for us. */
  async handleOffer(sdp, type, fromPeerId) {
    if (!this._pc) await this.acceptConnection();

    // Guard against race: if we're already stable, the handshake is done — ignore stale offer.
    if (this._pc.signalingState !== "have-local-offer") {
      await this._pc.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
      this._applyBufferedCandidates();

      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._localDescSet = true;
      this._applyBufferedCandidates();
      await this.signaling.sendAnswer(this.peerId, answer.sdp, answer.type);
    }
  }

  /** Called by app.js when we receive an answer. */
  async handleAnswer(sdp, type) {
    if (!this._pc) return;
    // Guard against race: ignore if we're already stable (answer arrived after handshake completed).
    if (this._pc.signalingState === "stable") return;
    await this._pc.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
    this._applyBufferedCandidates();
  }

  /** Buffer or apply an ICE candidate depending on remote desc state. */
  handleIceCandidate(candidate) {
    if (this._localDescSet && this._pc && this._pc.remoteDescription) {
      this._pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    } else {
      this._pendingCands.push(candidate);
    }
  }

  _applyBufferedCandidates() {
    const pc = this._pc;
    if (!pc) return;
    for (const c of this._pendingCands) {
      pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    this._pendingCands = [];
  }

  // ── File transfer ───────────────────────────────────────────────────────

  /** Public: send a File object to the remote peer. */
  sendFile(file) {
    const meta = {
      id:       `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name:     file.name,
      size:     file.size,
      mimeType: file.type || "application/octet-stream",
    };
    this._sendQueue.push({ file, meta });
    this._flushSendQueue();
    return meta.id;
  }

  _flushSendQueue() {
    if (!this._dcReady || !this._dc) return;
    while (this._sendQueue.length) {
      const { file, meta } = this._sendQueue.shift();
      this._sendFileImpl(file, meta);
    }
  }

  _sendFileImpl(file, meta) {
    const CHUNK_SIZE = 64 * 1024; // 64 KB

    // 1. Send metadata
    this._dc.send(JSON.stringify({ type: "file-meta", ...meta }));

    // 2. Stream chunks
    let offset = 0;
    const readNext = () => {
      const slice  = file.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const data = ev.target.result;
        this._dc.send(JSON.stringify({
          type:  "file-chunk",
          id:    meta.id,
          index: Math.floor(offset / CHUNK_SIZE),
          total: Math.ceil(file.size / CHUNK_SIZE),
          data:  btoa(
            new Uint8Array(data).reduce(
              (s, b) => s + String.fromCharCode(b), ""
            )
          ), // base64
        }));
        offset += CHUNK_SIZE;
        if (offset < file.size) {
          readNext();
        } else {
          // 3. Done
          this._dc.send(JSON.stringify({ type: "file-done", id: meta.id }));
        }
      };
      reader.readAsArrayBuffer(slice);
    };
    readNext();
  }

  _handleMessage(data) {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === "file-meta") {
        this._recvBuffers.set(msg.id, {
          meta:      msg,
          chunks:    new Array(msg.total || 1).fill(null),
          received:  0,
        });
        this.onFileComplete({ ...msg });

      } else if (msg.type === "file-chunk") {
        const buf = this._recvBuffers.get(msg.id);
        if (!buf) return;
        // Decode base64 chunk
        const binary  = atob(msg.data);
        const len     = binary.length;
        const bytes   = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        buf.chunks[msg.index] = bytes;
        buf.received++;
        this.onFileChunk({
          id:     msg.id,
          index:  msg.index,
          total:  msg.total,
          data:   bytes,
          name:   buf.meta.name,
          size:   buf.meta.size,
        });

      } else if (msg.type === "file-done") {
        const buf = this._recvBuffers.get(msg.id);
        if (!buf) return;
        // Reassemble
        const totalLen = buf.chunks.reduce((s, c) => s + (c ? c.length : 0), 0);
        const merged   = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of buf.chunks) {
          if (chunk) { merged.set(chunk, pos); pos += chunk.length; }
        }
        const blob = new Blob([merged], { type: buf.meta.mimeType });
        this._downloadBlob(blob, buf.meta.name);
        this._recvBuffers.delete(msg.id);
      }
    }
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Text message ─────────────────────────────────────────────────────────

  sendText(text) {
    if (!this._dcReady || !this._dc) {
      console.warn("[PeerConnection] sendText: DataChannel not ready", this._dc?.readyState);
      return false;
    }
    this._dc.send(JSON.stringify({ type: "text", text, ts: Date.now() }));
    return true;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close() {
    if (this._dc)  { this._dc.close();  this._dc  = null; }
    if (this._pc)  { this._pc.close();  this._pc  = null; }
    this._dcReady      = false;
    this._localDescSet = false;
    this._role         = null;
    this._pendingCands = [];
    this._recvBuffers  = new Map();
    this._sendQueue    = [];
  }

  get isConnected() { return this._dcReady; }
}
