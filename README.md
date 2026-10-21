# ProxiSpeak — Geospatial Proximity Audio Ecosystem

ProxiSpeak is an immersive 2D virtual office platform with real-time geospatial audio and spatial dynamics. Rather than rigid video conference rooms where only one person speaks at a time, ProxiSpeak lets users navigate an interactive office map where audio volume and panning dynamically adjust based on proximity to other avatars.

---

## Repository Structure

```text
proxyspeak/
├── server/                   # Backend (Node.js, Express, Socket.IO)
│   ├── public/               # Interactive 2D Canvas testing client
│   ├── src/
│   │   ├── index.js          # Express server and REST API endpoints
│   │   ├── sockets/          # Real-time Socket.IO room & movement handlers
│   │   └── services/         # Proximity & spatial calculation helpers
│   ├── verify.js             # Automated 9-module test suite
│   ├── package.json          # Dependencies and scripts
│   └── README.md             # Detailed backend API & event documentation
└── README.md                 # Project overview
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
Runs the full 9-module verification suite covering API endpoints (`/api/health`, `/api/status`), Socket.IO connection/disconnection lifecycles, real-time avatar movements, and room switching.

### 4. Interactive 2D Visual Demo
Open [http://localhost:5000/demo](http://localhost:5000/demo) in two separate browser windows to test real-time avatar movement, proximity boundaries, and live room switching between Main Office, Meeting Rooms, and the Lounge!

---

## Detailed Documentation
For detailed REST API endpoints, Socket.IO event specifications, and connection lifecycle handling, please refer to the [Backend Documentation](server/README.md).
