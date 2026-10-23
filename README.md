# ProxiSpeak — Geospatial Proximity Audio Ecosystem

ProxiSpeak is an immersive 2D virtual office platform with real-time geospatial audio and spatial dynamics. Rather than rigid video conference rooms where only one person speaks at a time, ProxiSpeak lets users navigate an interactive office map where audio volume and panning dynamically adjust based on proximity to other avatars.

---

## Repository Structure

```text
proxyspeak/
├── server/                   # Backend (Node.js, Express, Socket.IO)
│   ├── public/               # Interactive 2D Canvas testing client
│   ├── src/
│   │   ├── index.js          # Express server, REST APIs, & process safety nets
│   │   ├── sockets/          # Real-time Socket.IO room, movement, & WebRTC handlers
│   │   └── services/         # Proximity & spatial calculation helpers
│   ├── verify.js             # Automated 12-module integration test suite
│   ├── package.json          # Dependencies and scripts (start, test)
│   └── README.md             # Complete backend API & Socket.IO documentation
└── README.md                 # Project overview & quick start
```

---

## Quick Start (Backend)

### 1. Prerequisites
- Node.js LTS (v24.x or v20.x)
- Git

### 2. Install Dependencies & Start Server
```bash
cd server
npm install
npm start
```
The server will start on `http://localhost:5000`.

### 3. Run Automated Tests
```bash
cd server
npm test
```
Runs the comprehensive 12-module verification suite covering:
- REST API contracts (`/api/health`, `/api/status`, root, and 404 handler)
- Socket.IO connection and ping-pong latency checks
- Real-time multi-client avatar position synchronization
- Strict input validation and boundary clamping `[0, 2000]`
- Room join/leave logic and voice participant management
- Duplicate join and duplicate disconnect event protection
- WebRTC audio signaling relays and offline target validation
- High-churn reconnection and repeated connection resilience

### 4. Interactive 2D Visual Demo
Open [http://localhost:5000/demo](http://localhost:5000/demo) in two separate browser windows to test real-time avatar movement, proximity boundaries, and live room switching between Main Office, Meeting Rooms, and the Lounge!

---

## Detailed Documentation
For detailed REST API endpoint tables, Socket.IO event specifications, frontend integration contracts, and connection lifecycle handling, please refer to the [Backend Documentation](server/README.md).
