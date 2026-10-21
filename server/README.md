# ProxiSpeak Backend Documentation

## 1. Overview
The **ProxiSpeak Backend** is a high-performance Node.js and Express server powered by Socket.IO. It serves as the real-time signaling, room management, and spatial movement broadcasting engine for the ProxiSpeak Geospatial Proximity Audio Ecosystem.

---

## 2. Tech Stack
- **Node.js** (LTS v24.13+)
- **Express.js** (`^5.3.0`): REST API framework and static client serving.
- **Socket.IO** (`^4.8.4`): Bidirectional, event-driven WebSocket communication.
- **CORS** (`^2.8.6`): Cross-Origin Resource Sharing.
- **dotenv** (`^18.0.7`): Environment variable configuration.

---

## 3. Directory Structure
```text
server/
├── public/
│   └── index.html            # Interactive 2D Canvas testing client
├── src/
│   ├── index.js              # Express app, HTTP server, and route definitions
│   ├── sockets/
│   │   └── socketHandlers.js # Socket.IO lifecycle, validation, room, & movement handlers
│   └── services/
│       └── proximityService.js # Spatial distance calculations helper
├── .env                      # Environment configurations (PORT=5000)
├── .gitignore                # Excludes node_modules and secrets
├── package.json              # Package manifest and scripts (start, test)
├── test-client.js            # Standalone Socket.IO test client
├── verify.js                 # Automated 9-stage verification test runner
└── README.md                 # Complete backend documentation
```

---

## 4. Configuration (`.env`)
The backend is configured via environment variables in `server/.env`:
```env
PORT=5000
```
- If `PORT` is not specified, it defaults to `5000`.

---

## 5. REST API Endpoints

### `GET /`
- **Description**: Root health/greeting check.
- **Response**: Text: `ProxiSpeak Backend is running!`
- **Status Code**: `200 OK`

### `GET /api/health`
- **Description**: System health check endpoint.
- **Response Headers**: `Cache-Control: no-cache`
- **Response**:
  ```json
  {
    "status": "OK",
    "project": "ProxiSpeak",
    "timestamp": "2026-10-21T08:20:00.000Z"
  }
  ```
- **Status Code**: `200 OK`

### `GET /api/status`
- **Description**: Returns live operational status, server uptime, and active user count.
- **Response Headers**: `Cache-Control: no-cache`
- **Response**:
  ```json
  {
    "status": "active",
    "message": "ProxiSpeak server is operational",
    "uptime": "145s",
    "activeUsers": 2,
    "timestamp": "2026-10-21T08:20:00.000Z"
  }
  ```
- **Status Code**: `200 OK`

### `GET /demo`
- **Description**: Serves the interactive 2D Canvas multi-user visual demo with room switching and real-time avatar movement.
- **Status Code**: `200 OK`

---

## 6. Socket.IO Real-Time Events Reference

### Connection & Disconnection Lifecycle

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `connectionAck` | Server $\rightarrow$ Client | `{ status, socketId, user, serverTime }` | Confirms client connection with session metadata. |
| `disconnecting` | Internal / Room | Reason string | Triggers room-level participant departure notices before socket leaves rooms. |
| `disconnect` | Internal / Global | Reason string | Cleans up user from memory and broadcasts `userDisconnected` globally. |
| `clientDisconnect` | Client $\rightarrow$ Server | None | Requests a clean, voluntary client disconnection. |
| `userDisconnected` | Server $\rightarrow$ Clients | `{ id, username, reason }` | Broadcasted globally when any user disconnects. |

### Rooms & Participant Management

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `joinRoom` | Client $\rightarrow$ Server | `{ roomId, username }` | Leaves current room and joins target room (e.g., `main-office`, `meeting-room-a`). |
| `leaveRoom` | Client $\rightarrow$ Server | `{ roomId }` | Leaves specified room and reverts to `main-office`. |
| `roomParticipants`| Server $\rightarrow$ Client | `{ roomId, participants: [...] }` | Sends active member list for the user's room. |
| `participantJoined`| Server $\rightarrow$ Room | `{ id, username, roomId, x, y, color }` | Broadcasted to room members when a new participant enters. |
| `participantLeft` | Server $\rightarrow$ Room | `{ id, username, roomId, reason }` | Broadcasted to room members when a participant exits the room. |
| `getParticipants` | Client $\rightarrow$ Server | `{ roomId }` (with callback) | Requests live participant list of a room. |

### Spatial Movement & Position Updates

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `updatePosition` | Client $\rightarrow$ Server | `{ x, y }` | Sends updated avatar coordinates. Validates finite numbers and clamps to `[0, 2000]`. |
| `userPositionUpdated`| Server $\rightarrow$ Clients | `{ id, username, roomId, x, y }` | Broadcasts validated avatar coordinates to peers. |
| `userMoved` | Server $\rightarrow$ Clients | `{ id, username, roomId, x, y }` | Backward-compatible alias for `userPositionUpdated`. |

### Voice Communication Readiness (WebRTC Signaling)

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `signal:offer` | Client $\leftrightarrow$ Server | `{ targetId, offer }` | Relays WebRTC SDP offer to target peer. |
| `signal:answer` | Client $\leftrightarrow$ Server | `{ targetId, answer }` | Relays WebRTC SDP answer to target peer. |
| `signal:ice-candidate`| Client $\leftrightarrow$ Server | `{ targetId, candidate }` | Relays ICE candidate for NAT traversal. |

### Validation & Diagnostics

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `ping` | Client $\rightarrow$ Server | `{ message, sentAt }` | Health check probe. |
| `pong` | Server $\rightarrow$ Client | `{ message, sentAt }` | Replies to `ping` probe. |
| `error:validation` | Server $\rightarrow$ Client | `{ message, received }` | Emitted when a client sends invalid/corrupted payloads. |

---

## 7. How to Run Locally

### Start Development Server
```bash
cd server
npm start
```
Starts Express & Socket.IO server at `http://localhost:5000`.

### Run Automated Verification Test Suite
```bash
cd server
npm test
```
Executes the comprehensive 9-module verification runner in `verify.js`:
- Route checks (`/`, `/api/health`, `/api/status`, 404 handler)
- Socket.IO connection acknowledgment (`connectionAck`)
- Real-time movement & boundary clamping
- Room transitions (`joinRoom`, `leaveRoom`, participant broadcasts)
- Input validation rejecting malformed payloads
- Clean disconnection and peer notification

### Interactive 2D Visual Demo
Open [http://localhost:5000/demo](http://localhost:5000/demo) in two separate browser windows to test multiplayer movement and live room switching!
