# PairDrop Clone

A self-hosted, browser-based peer-to-peer file and text sharing app — no accounts, no uploads to third-party servers. Files travel directly between browsers using WebRTC DataChannels.

## Features

- **P2P file transfer** — any file type, any size, streamed directly between peers
- **Text messaging** — send messages to connected peers
- **No accounts** — just share a room code to connect
- **Works in any browser** — pure HTML/JS, no plugins required
- **Polling-based signaling** — no WebSocket server needed; works with Flask + SQLite

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Start the server
python app.py
```

Then open **http://localhost:8082** in two browser windows (or on two different devices on the same network).

### Connecting Across Networks

For peers behind different NATs (e.g. your laptop at home and phone on mobile data), you need a **TURN relay** so the connection can punch through. PairDrop Clone uses Google's free STUN servers by default, which work for same-network or simple NAT setups.

For full cross-network support, add a TURN server to `static/js/webrtc.js`:

```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add a TURN server here, e.g.:
  // {
  //   urls: 'turn:your-turn-server.com:3478',
  //   username: 'user',
  //   credential: 'pass',
  // },
]
```

You can run your own [coturn](https://github.com/coturn/coturn) server or use a cloud TURN service.

## How It Works

1. **Create or join a room** — you get an 8-character room code
2. **Share the room code** with another device to connect
3. Both devices poll the Flask server for signaling messages (SDP offers/answers, ICE candidates)
4. WebRTC establishes a direct P2P connection using STUN
5. Once connected, files and messages flow **directly** between browsers, bypassing the server

## Project Structure

```
pairdrop-clone/
├── app.py           Flask server + REST API (signaling)
├── db.py            SQLite setup + helper functions
├── templates/
│   └── index.html   Single-page frontend
├── static/
│   ├── css/style.css
│   └── js/
│       ├── app.js       Main app logic + UI
│       ├── webrtc.js    RTCPeerConnection wrapper
│       └── signaling.js Signaling REST client
├── requirements.txt
└── README.md
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/rooms` | Create a new room |
| `GET`  | `/api/rooms/<id>` | Get room info + peer list |
| `POST` | `/api/rooms/<id>/peers` | Register a peer |
| `POST` | `/api/rooms/<id>/peers/<pid>/heartbeat` | Keep peer alive |
| `DELETE` | `/api/rooms/<id>/peers/<pid>` | Remove peer |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/offer` | Get / post SDP offer |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/answer` | Get / post SDP answer |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/candidates` | Get / post ICE candidates |
