/**
 * app.js — PairDrop Clone main application.
 * Wires together SignalingClient, PeerConnection, and the DOM.
 */

// ── Utilities ────────────────────────────────────────────────────────────────

function uuid4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function showToast(msg, type = "info", duration = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), duration);
}

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  roomId:      null,
  peerId:      uuid4(),
  displayName: "",
  peers:       new Map(),   // peerId → { display_name, card }
  rtc:         new Map(),   // peerId → PeerConnection
  transfers:   new Map(),   // transferId → { name, size, progress, dir, el }
  signaling:   null,
};

// ── DOM refs ────────────────────────────────────────────────────────────────

const $joinScreen    = document.getElementById("joinScreen");
const $roomScreen    = document.getElementById("roomScreen");
const $joinError     = document.getElementById("joinError");
const $createPanel   = document.getElementById("createPanel");
const $joinPanel     = document.getElementById("joinPanel");
const $createName    = document.getElementById("createName");
const $joinCode      = document.getElementById("joinCode");
const $joinName      = document.getElementById("joinName");
const $emptyState    = document.getElementById("emptyState");
const $peersGrid     = document.getElementById("peersGrid");
const $transferQueue = document.getElementById("transferQueue");
const $dropOverlay   = document.getElementById("dropOverlay");
const $bigRoomCode   = document.getElementById("bigRoomCode");
const $roomCodeLabel = document.getElementById("roomCodeLabel");

// ── Mode tabs ───────────────────────────────────────────────────────────────

document.querySelectorAll(".mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".mode-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    $createPanel.classList.toggle("active", mode === "create");
    $joinPanel.classList.toggle("active",   mode === "join");
    $joinError.classList.add("hidden");
  });
});

// ── Create / Join ──────────────────────────────────────────────────────────

document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const name = ($createName.value || "Guest").trim().slice(0, 20);
  if (!name) { showToast("Please enter your name", "error"); return; }
  state.displayName = name;
  state.signaling = new SignalingClient("", null, state.peerId, name);

  try {
    const data = await state.signaling.createRoom();
    state.roomId = data.room_id;
    await state.signaling.register();
    enterRoom();
  } catch (e) {
    showToast("Failed to create room: " + e.message, "error");
  }
});

document.getElementById("joinRoomBtn").addEventListener("click", async () => {
  const code = ($joinCode.value || "").trim().toLowerCase();
  const name = ($joinName.value || "Guest").trim().slice(0, 20);
  if (!code)    { showErr("Please enter a room code"); return; }
  if (code.length !== 8) { showErr("Room code must be 8 characters"); return; }
  if (!name)    { showErr("Please enter your name"); return; }

  state.displayName = name;
  state.roomId      = code;
  state.signaling   = new SignalingClient("", code, state.peerId, name);

  try {
    // Verify room exists
    await state.signaling.getRoom();
    await state.signaling.register();
    enterRoom();
  } catch (e) {
    if (e.message && e.message.includes("404")) {
      showErr("Room not found. Check the code and try again.");
    } else {
      showErr("Failed to join room: " + e.message);
    }
  }
});

function showErr(msg) {
  $joinError.textContent = msg;
  $joinError.classList.remove("hidden");
}

// ── Room entry / exit ──────────────────────────────────────────────────────

function enterRoom() {
  state.signaling.startPolling({
    onOffers:    handleIncomingOffers,
    onAnswers:   handleIncomingAnswers,
    onCandidates: handleIncomingCandidates,
    onPeers:     handlePeerList,
  });

  // Show room UI
  $joinScreen.classList.remove("active");
  $roomScreen.classList.add("active");
  $bigRoomCode.textContent  = state.roomId.toUpperCase();
  $roomCodeLabel.textContent = state.roomId.toUpperCase();
  document.getElementById("copyRoomBtn").classList.remove("hidden");
  document.getElementById("leaveRoomBtn").classList.remove("hidden");

  showToast(`Joined room ${state.roomId}`, "success");
}

async function leaveRoom() {
  state.signaling.stopPolling();
  state.signaling.leave().catch(() => {});
  for (const [pid, rtc] of state.rtc) rtc.close();
  state.rtc.clear();
  state.peers.clear();
  state.transfers.clear();
  state.roomId = null;
  state.signaling = null;

  $roomScreen.classList.remove("active");
  $joinScreen.classList.add("active");
  document.getElementById("copyRoomBtn").classList.add("hidden");
  document.getElementById("leaveRoomBtn").classList.add("hidden");
  $peersGrid.classList.add("hidden");
  $emptyState.classList.remove("hidden");
  $transferQueue.innerHTML = "";
  $createName.value = "";
  $joinCode.value   = "";
  $joinName.value   = "";
}

document.getElementById("leaveRoomBtn").addEventListener("click", leaveRoom);

// ── Copy room code ────────────────────────────────────────────────────────

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("Copied to clipboard!", "success", 2000);
  }).catch(() => {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Copied to clipboard!", "success", 2000);
  });
}

document.getElementById("copyRoomBtn").addEventListener("click", () => {
  copyToClipboard(state.roomId);
});
document.getElementById("copyCodeBtn").addEventListener("click", () => {
  copyToClipboard(state.roomId);
});

// ── Peer list ──────────────────────────────────────────────────────────────

function handlePeerList(peerList) {
  const remotePeers = peerList.filter((p) => p.id !== state.peerId);

  // Remove cards for peers no longer in the room
  for (const [pid, entry] of state.peers) {
    if (!remotePeers.find((p) => p.id === pid)) {
      if (state.rtc.has(pid)) { state.rtc.get(pid).close(); state.rtc.delete(pid); }
      entry.card.remove();
      state.peers.delete(pid);
    }
  }

  for (const p of remotePeers) {
    if (!state.peers.has(p.id)) {
      // New peer — create card and maybe initiate connection
      const card = buildPeerCard(p);
      $peersGrid.appendChild(card);
      state.peers.set(p.id, { display_name: p.display_name, card });

      // Lexicographic initiator rule: lower ID initiates the offer
      if (state.peerId < p.id) {
        initConnectionTo(p.id);
      }
    }
  }

  updateEmptyState();
}

function updateEmptyState() {
  const hasRemotePeers = [...state.peers.keys()].length > 0;
  $emptyState.classList.toggle("hidden", hasRemotePeers);
  $peersGrid.classList.toggle("hidden", !hasRemotePeers);
}

// ── Connection management ──────────────────────────────────────────────────

function initConnectionTo(peerId) {
  if (state.rtc.has(peerId)) return;  // already exists

  const rtc = new PeerConnection(peerId, state.signaling, {
    onStatusChange: (s) => onRtcStatusChange(peerId, s),
    onMessage:      (msg) => onPeerMessage(peerId, msg, false),
    onFileChunk:    (chunk) => onFileChunk(peerId, chunk),
    onFileComplete: (meta) => onFileComplete(peerId, meta),
  });

  state.rtc.set(peerId, rtc);
  rtc.connectAsInitiator();
}

function onRtcStatusChange(peerId, status) {
  const entry = state.peers.get(peerId);
  const card  = entry?.card;
  if (!card) return;
  card.classList.remove("connected", "connecting");
  if (status === "connected")   card.classList.add("connected");
  if (status === "connecting")  card.classList.add("connecting");

  const statusEl = card.querySelector(".peer-status");
  if (statusEl) statusEl.textContent = status;
}

// ── Incoming signaling ─────────────────────────────────────────────────────

async function handleIncomingOffers(offers) {
  for (const offer of offers) {
    const fromPid = offer.from_peer;

    // Ensure we have a PeerConnection for this peer
    if (!state.rtc.has(fromPid)) {
      const rtc = new PeerConnection(fromPid, state.signaling, {
        onStatusChange: (s) => onRtcStatusChange(fromPid, s),
        onMessage:      (msg) => onPeerMessage(fromPid, msg, false),
        onFileChunk:    (c) => onFileChunk(fromPid, c),
        onFileComplete: (m) => onFileComplete(fromPid, m),
      });
      state.rtc.set(fromPid, rtc);
    }

    const rtc = state.rtc.get(fromPid);

    // If we're the lexicographically lower peer we already initiated,
    // but still got an offer — just apply it (handles race)
    await rtc.handleOffer(offer.sdp, offer.type, fromPid);
  }
}

async function handleIncomingAnswers(answers) {
  for (const answer of answers) {
    const rtc = state.rtc.get(answer.from_peer);
    if (rtc) await rtc.handleAnswer(answer.sdp, answer.type);
  }
}

function handleIncomingCandidates(candidates) {
  for (const cand of candidates) {
    const rtc = state.rtc.get(cand.from_peer);
    if (rtc) rtc.handleIceCandidate(cand.candidate);
  }
}

// ── File transfer ───────────────────────────────────────────────────────────

function onFileComplete(fromPeerId, meta) {
  const entry = state.peers.get(fromPeerId);
  showToast(`Receiving: ${meta.name}`, "info");
}

function onFileChunk(fromPeerId, chunk) {
  const id = chunk.id;
  if (!state.transfers.has(id)) {
    const el = buildTransferItem(id, chunk.name, chunk.size, "in");
    $transferQueue.appendChild(el);
    state.transfers.set(id, { el, progress: 0, dir: "in" });
  }
  const t = state.transfers.get(id);
  t.progress = ((chunk.index + 1) / chunk.total) * 100;
  updateTransferProgress(id, t.progress);
}

function updateTransferProgress(id, progress) {
  const t = state.transfers.get(id);
  if (!t) return;
  const fill  = t.el.querySelector(".progress-fill");
  const meta  = t.el.querySelector(".transfer-meta");
  if (fill)  fill.style.width = `${Math.min(100, progress)}%`;
  if (meta) {
    meta.textContent = `${Math.round(progress)}%`;
    if (progress >= 100) {
      fill?.classList.add("done");
      meta.textContent = "Complete";
      showToast(`Received: ${t.name}`, "success");
      setTimeout(() => removeTransfer(id), 5000);
    }
  }
}

function removeTransfer(id) {
  const t = state.transfers.get(id);
  if (t?.el) t.el.remove();
  state.transfers.delete(id);
}

function sendFileToPeer(peerId, file) {
  const rtc = state.rtc.get(peerId);
  if (!rtc || !rtc.isConnected) {
    showToast("Not connected to that peer yet", "error");
    return;
  }

  // Show outbound progress
  const meta = { id: `${Date.now()}`, name: file.name, size: file.size };
  const id   = rtc.sendFile(file);
  const el   = buildTransferItem(id, file.name, file.size, "out");
  $transferQueue.appendChild(el);

  // Wire up progress via onFileChunk
  const sendId = id;
  const orig   = rtc.onFileChunk;
  rtc.onFileChunk = (chunk) => {
    if (chunk.id === sendId) {
      if (!state.transfers.has(sendId)) {
        $transferQueue.appendChild(el);
        state.transfers.set(sendId, { el, progress: 0, dir: "out", name: file.name });
      }
      const t = state.transfers.get(sendId);
      t.progress = ((chunk.index + 1) / chunk.total) * 100;
      updateTransferProgress(sendId, t.progress);
    }
    orig(chunk);
  };
}

function buildTransferItem(id, name, size, dir) {
  const el = document.createElement("div");
  el.className = "transfer-item";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="transfer-header">
      <div class="transfer-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${dir === "out"
            ? "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/>"
            : "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='17 8 12 3 7 8'/><line x1='12' y1='3' x2='12' y2='15'/>"
          }
        </svg>
      </div>
      <div class="transfer-info">
        <div class="transfer-name">${escHtml(name)}</div>
        <div class="transfer-meta">${formatBytes(size)}</div>
      </div>
      <button class="transfer-close" title="Cancel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
  `;
  el.querySelector(".transfer-close").addEventListener("click", () => removeTransfer(id));
  return el;
}

// ── Page-level drag & drop (send to all connected peers) ──────────────────

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  $dropOverlay.classList.remove("hidden");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) $dropOverlay.classList.add("hidden");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $dropOverlay.classList.add("hidden");
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const connected = [...state.rtc.entries()].filter(([, r]) => r.isConnected);
  if (!connected.length) { showToast("No connected peers to send to", "error"); return; }
  for (const [pid, rtc] of connected) {
    for (const f of files) sendFileToPeer(pid, f);
  }
  if (connected.length) showToast(`Sending ${files.length} file(s) to ${connected.length} peer(s)`, "info");
});

// ── Peer card drag & drop ───────────────────────────────────────────────────

function setupPeerCardDrop(card, peerId) {
  const area = card.querySelector(".peer-transfer-area");
  if (!area) return;

  area.addEventListener("dragover", (e) => {
    e.preventDefault();
    area.classList.add("drag-over");
  });
  area.addEventListener("dragleave", () => area.classList.remove("drag-over"));
  area.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    area.classList.remove("drag-over");
    const files = [...e.dataTransfer.files];
    files.forEach((f) => sendFileToPeer(peerId, f));
  });

  // Also allow click-to-pick
  area.addEventListener("click", () => {
    const input = card.querySelector(".peer-file-input");
    if (input) input.click();
  });

  const input = card.querySelector(".peer-file-input");
  if (input) {
    input.addEventListener("change", () => {
      [...input.files].forEach((f) => sendFileToPeer(peerId, f));
      input.value = "";
    });
  }
}

// ── Peer card builder ──────────────────────────────────────────────────────

function buildPeerCard(peer) {
  const card = document.createElement("div");
  card.className = "peer-card";
  card.dataset.peerId = peer.id;

  const statusText = peer.display_name ? "disconnected" : "connecting";

  card.innerHTML = `
    <div class="peer-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    </div>
    <div class="peer-name">${escHtml(peer.display_name || "Anonymous")}</div>
    <div class="peer-status">${statusText}</div>

    <div class="peer-section">
      <div class="peer-section-label">Transfer</div>
      <div class="peer-transfer-area">
        Drop files here<br/>or click to pick
      </div>
      <input type="file" class="peer-file-input" multiple />
    </div>

    <div class="peer-section">
      <div class="peer-section-label">Messages</div>
      <div class="peer-messages"></div>
      <div class="peer-msg-input-row">
        <textarea class="peer-msg-input" rows="1" placeholder="Send a message…" style="height:32px"></textarea>
        <button class="peer-msg-send" title="Send">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  // Send message
  const textarea = card.querySelector(".peer-msg-input");
  const sendBtn  = card.querySelector(".peer-msg-send");

  const sendMsg = () => {
    const text = textarea.value.trim();
    if (!text) return;
    const rtc = state.rtc.get(peer.id);
    if (!rtc?.isConnected) { showToast("Peer not connected yet", "error"); return; }
    rtc.sendText(text);
    appendMessage(card, text, true);
    textarea.value = "";
    textarea.style.height = "32px";
  };

  sendBtn.addEventListener("click", sendMsg);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
  autoResize(textarea);

  setupPeerCardDrop(card, peer.id);

  // Click card → scroll to transfer area
  card.addEventListener("click", (e) => {
    if (e.target.closest(".peer-msg-input-row") || e.target.closest(".peer-transfer-area")) return;
    card.querySelector(".peer-transfer-area")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  return card;
}

function appendMessage(card, text, isOwn) {
  const container = card.querySelector(".peer-messages");
  const bubble    = document.createElement("div");
  bubble.className = `msg-bubble${isOwn ? " own" : ""}`;
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function onPeerMessage(peerId, text, isOwn) {
  const entry = state.peers.get(peerId);
  if (!entry) return;
  appendMessage(entry.card, text, isOwn);
}

function autoResize(el) {
  el.addEventListener("input", () => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
