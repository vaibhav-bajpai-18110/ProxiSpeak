# ProxiSpeak — Geospatial Proximity Audio Ecosystem

ProxiSpeak is an immersive 2D virtual office platform with real-time geospatial audio and spatial dynamics. Rather than rigid video conference rooms where only one person speaks at a time, ProxiSpeak lets users navigate an interactive office map where audio volume and panning dynamically adjust based on proximity to other avatars.

---

## Repository Structure

```text
proxyspeak/
├── server/                   # Backend (Node.js, Express, Socket.IO)
│   ├── public/               # Interactive multi-tab 2D Canvas testing client with proximity indicators
│   ├── src/
│   │   ├── index.js          # Express server, REST APIs, & process safety nets
│   │   ├── sockets/          # Real-time Socket.IO room, movement, proximity & WebRTC handlers
│   │   └── services/         # Spatial proximity, audio rolloff & stereo panning calculations
│   ├── verify.js             # Automated 19-module integration test suite
│   ├── package.json          # Dependencies and scripts (start, test)
│   └── README.md             # Complete backend API, Socket.IO & proximity documentation
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
Runs the comprehensive 19-module verification suite covering:
- REST API contracts (`/api/health`, `/api/status`, root, and 404 handler)
- Socket.IO connection and ping-pong latency checks
- Real-time multi-client avatar position synchronization
- Strict input validation and boundary clamping `[0, 2000]`
- Room join/leave logic and voice participant management
- Duplicate join and duplicate disconnect event protection
- Repeated connections and high-churn reconnection resilience
- Real-time multi-tab avatar movement synchronization
- Unexpected disconnections & abrupt transport drop recovery
- Exhaustive invalid inputs and edge-case crash resistance
- Simultaneous multi-user virtual office interaction & spatial proximity calculations
- **WebRTC Audio Calling Full Handshake & Bidirectional Signaling (`call-user` $\rightarrow$ `accept-call` $\rightarrow$ `offer`/`answer` $\rightarrow$ `ice-candidate` $\rightarrow$ `mute-status` $\rightarrow$ `end-call`)**
- **Mid-Call Abrupt Disconnection & Communication State Cleanup (instant peer teardown notification & zombie call prevention)**
- **WebRTC Error Handling & Post-Reconnection Call Recovery (offline peer rejection, self-call blocking, call decline, and reconnection resumption)**

### 4. Interactive Multi-Tab Visual & Audio Demo
Open [http://localhost:5000/demo](http://localhost:5000/demo) in two or three separate browser tabs to test real-time avatar movement, audio calling between peers, incoming call banners, mute toggles, and instant disconnect cleanup!

---

## Detailed Documentation
For detailed REST API endpoint tables, Socket.IO event specifications, frontend integration contracts, and connection lifecycle handling, please refer to the [Backend Documentation](server/README.md).
