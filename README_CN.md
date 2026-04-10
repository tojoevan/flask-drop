# PairDrop Clone — 自建 P2P 文件传输工具

一款自托管、纯浏览器运行的点对点文件传输工具。无需账号、插件或第三方服务器，文件直接在浏览器之间通过 WebRTC DataChannel 传输。

---

## 功能特性

- **P2P 文件传输** — 支持任意类型、任意大小的文件，浏览器直连
- **文字消息** — 向已连接的设备发送文本
- **无需注册** — 只需共享房间码即可连接
- **全平台兼容** — 任何浏览器都能用，纯 HTML/JS，无插件依赖
- **轮询信令** — 无需 WebSocket 服务器，Flask + SQLite 即可运行

---

## 快速启动

```bash
# 安装依赖
pip install -r requirements.txt

# 启动服务
python app.py
```

然后在**两个浏览器窗口**（或同一局域网内的两台设备）打开 **http://localhost:5000**。

---

## 跨网络连接

默认使用 Google 免费的 STUN 服务器，适用于同一局域网或简单 NAT 场景。

对于不同 NAT 后的设备（如家里电脑 + 手机流量），需要配置 **TURN 中继服务器**。在 `static/js/webrtc.js` 中添加：

```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // 添加 TURN 服务器，例如：
  // {
  //   urls: 'turn:your-turn-server.com:3478',
  //   username: 'user',
  //   credential: 'pass',
  // },
]
```

可自建 [coturn](https://github.com/coturn/coturn) 或使用云端 TURN 服务。

---

## 工作原理

1. **创建/加入房间** — 获取一个 8 位房间码
2. **分享房间码** — 另一台设备使用相同房间码进入
3. 两台设备轮询 Flask 服务器，获取信令消息（SDP offer/answer、ICE 候选）
4. WebRTC 通过 STUN 建立直连 P2P 通道
5. 连接建立后，文件传输**完全绕过服务器**，直接在浏览器之间进行

---

## 项目结构

```
pairdrop-clone/
├── app.py              Flask 服务端 + REST API（信令）
├── db.py               SQLite 数据库初始化与操作封装
├── templates/
│   └── index.html      单页应用前端
├── static/
│   ├── css/style.css
│   └── js/
│       ├── app.js          主应用逻辑 + UI
│       ├── webrtc.js       RTCPeerConnection 封装
│       └── signaling.js    信令 HTTP 轮询客户端
├── requirements.txt
├── README.md
└── README_CN.md
```

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST`   | `/api/rooms` | 创建新房间 |
| `GET`    | `/api/rooms/<id>` | 获取房间信息与成员列表 |
| `POST`   | `/api/rooms/<id>/peers` | 注册设备到房间 |
| `POST`   | `/api/rooms/<id>/peers/<pid>/heartbeat` | 心跳保活 |
| `DELETE` | `/api/rooms/<id>/peers/<pid>` | 从房间移除设备 |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/offer` | 获取/提交 SDP offer |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/answer` | 获取/提交 SDP answer |
| `GET/POST` | `/api/rooms/<id>/peers/<pid>/candidates` | 获取/提交 ICE 候选 |

---

## 技术要点

- **字典序建连规则**：`peerId < remotePeerId` 决定由谁发起 offer，避免双方同时发起导致重复连接
- **ICE 候选缓冲**：ICE 候选在远端描述设置前先缓存，设置好后再按序注入
- **文件分片传输**：64KB/片，base64 编码，通过有序 DataChannel 传输
- **心跳清理**：后台线程每 30 秒清理超过 60 秒无心跳的失效节点
