# ProxiSpeak Backend Documentation

## 1. Overview
The **ProxiSpeak Backend** is an enterprise-grade Node.js and Express server powered by Socket.IO. It serves as the real-time spatial positioning, room management, WebRTC audio signaling, and client state orchestration engine for the ProxiSpeak Geospatial Proximity Audio platform.

The backend is fully integrated with and verified against both the ProxiSpeak React frontend client (`client/src/App.jsx`) and the interactive multi-tab Canvas test environment (`server/public/index.html`).

---

## 2. Tech Stack & Environment
- **Runtime**: Node.js (LTS v24.13+ / v20.x+)
- **Server Framework**: Express.js (`^5.3.0`)
- **WebSocket Engine**: Socket.IO (`^4.8.4`)
- **Cross-Origin Handling**: CORS (`^2.8.6`)
- **Environment Management**: `dotenv` (`^18.0.7`)
- **Automated Verification**: Custom 15-stage end-to-end integration test runner

---

## 3. Directory Structure
```text
server/
├── public/
│   └── index.html            # Interactive multi-tab 2D Canvas testing client
├── src/
│   ├── index.js              # Express app, process safety nets, REST APIs, & HTTP server
│   ├── sockets/
│   │   └── socketHandlers.js # Socket.IO lifecycle, validation, room, & movement handlers
│   └── services/
│       └── proximityService.js # Spatial distance & proximity calculations helper
├── .env                      # Environment configurations (PORT=5000)
├── .gitignore                # Git exclusion rules
├── package.json              # Package manifest and scripts (start, test)
├── test-client.js            # Standalone Socket.IO test client
├── verify.js                 # Automated 15-stage verification test runner
└── README.md                 # Complete backend documentation
```

---

## 4. Configuration (`.env`)
The server reads configuration from `server/.env`:
```env
PORT=5000
```
- Defaults to `PORT=5000` if not explicitly defined.
- Configured with permissive CORS policies allowing any origin in development mode, including Vite's development ports (`http://localhost:5173`, `http://localhost:3000`).

---

## 5. REST API Endpoints

### `GET /`
- **Description**: Root health/greeting check.
- **Response**: Text: `ProxiSpeak Backend is running!`
- **Status Code**: `200 OK`

### `GET /api/health`
- **Description**: Frontend integration health probe consumed directly by the React client (`client/src/App.jsx`).
- **Response Headers**: `Cache-Control: no-cache`
- **Response Format**:
  ```json
  {
    "status": "OK",
    "project": "ProxiSpeak",
    "timestamp": "2026-10-25T14:00:00.000Z"
  }
  ```
- **Status Code**: `200 OK`

### `GET /api/status`
- **Description**: Live operational status, server uptime, and dynamic active user count.
- **Response Headers**: `Cache-Control: no-cache`
- **Response Format**:
  ```json
  {
    "status": "active",
    "message": "ProxiSpeak server is operational",
    "uptime": "120s",
    "activeUsers": 3,
    "timestamp": "2026-10-25T14:00:00.000Z"
  }
  ```
- **Status Code**: `200 OK`

### `GET /demo`
- **Description**: Serves the standalone 2D Canvas interactive visual client with real-time avatar movement, live room switching, and multi-tab testing support.
- **Status Code**: `200 OK`

### 404 Route Fallback
- Any unmatched endpoint under `/api/*` returns a standardized JSON 404 response:
  ```json
  {
    "status": "error",
    "message": "API route not found"
  }
  ```
- **Status Code**: `404 Not Found`

---

## 6. Socket.IO Real-Time Events Reference

### Connection & Disconnection Lifecycle

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `connectionAck` | Server $\rightarrow$ Client | `{ status, socketId, user, serverTime }` | Confirms connection and returns initial user session metadata. |
| `join` | Client $\rightarrow$ Server | `{ username, roomId? }` | Frontend entry event. Assigns sanitized username, room, and broadcasts presence. |
| `clientDisconnect` | Client $\rightarrow$ Server | None | Requests clean voluntary client disconnection. |
| `disconnecting` | Internal / Room | Reason string | Dispatches room-level departure notices before socket leaves room sets. |
| `disconnect` | Internal / Global | Reason string | Deletes user from memory registry and broadcasts departure to all remaining clients. Handles unexpected drops (`transport close`, `ping timeout`). |
| `userDisconnected` | Server $\rightarrow$ Clients | `{ id, username, reason }` | Broadcasted globally. Compatible with `typeof data === "string" ? data : data?.id`. |
| `userLeft` | Server $\rightarrow$ Clients | `{ id, username, reason }` | Alias event for rich clients and Canvas HUD logs. |

### Rooms & Participant Management

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `joinRoom` | Client $\rightarrow$ Server | `{ roomId, username? }` | Switches room with duplicate-join idempotency guard. |
| `leaveRoom` | Client $\rightarrow$ Server | `{ roomId }` | Leaves room and resets user back to `main-office`. |
| `currentUsers` | Server $\rightarrow$ Client | `Array<User>` | Emitted on connect with global user snapshot. |
| `roomParticipants`| Server $\rightarrow$ Client | `{ roomId, participants: [...] }` | Emitted on join/switch with current room member list. |
| `participantJoined`| Server $\rightarrow$ Room | `{ id, username, roomId, x, y, color }` | Broadcasted to room members when a participant joins. |
| `userJoined` | Server $\rightarrow$ Clients | `{ id, username, roomId, x, y, color }` | Broadcasted globally when a participant joins. |
| `participantLeft` | Server $\rightarrow$ Room | `{ id, username, roomId, reason }` | Broadcasted to room members when a participant leaves. |

### Spatial Positioning & Movement

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `updatePosition` | Client $\rightarrow$ Server | `{ x, y }` | Sends updated avatar coordinates. Sanitized and clamped to map bounds `[0, 2000]`. Includes `color`. |
| `userPositionUpdated`| Server $\rightarrow$ Clients | `{ id, username, roomId, x, y, color }` | Broadcasts validated avatar position to peers without sender echo. |
| `userMoved` | Server $\rightarrow$ Clients | `{ id, username, roomId, x, y, color }` | Backward-compatible alias for `userPositionUpdated`. |

### WebRTC Audio Signaling Relays

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `signal:offer` | Client $\leftrightarrow$ Server | `{ targetId, offer }` | Relays WebRTC SDP offer to target peer. Emits `signal:error` if peer is offline. |
| `signal:answer` | Client $\leftrightarrow$ Server | `{ targetId, answer }` | Relays WebRTC SDP answer to target peer. Emits `signal:error` if peer is offline. |
| `signal:ice-candidate`| Client $\leftrightarrow$ Server | `{ targetId, candidate }`| Relays ICE candidate to target peer. Emits `signal:error` if peer is offline. |
| `signal:error` | Server $\rightarrow$ Client | `{ message, targetId }` | Emitted to sender if target peer does not exist or has disconnected. |

### Validation & Diagnostics

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `ping` | Client $\rightarrow$ Server | `{ message, sentAt }` | Latency and connection probe. |
| `pong` | Server $\rightarrow$ Client | `{ message, sentAt }` | Response to `ping` probe. |
| `error:validation` | Server $\rightarrow$ Client | `{ message, received }` | Emitted when client transmits malformed, NaN, non-numeric, or invalid payloads. |

---

## 7. Multi-Tab Avatar Movement Synchronization

The backend and Canvas client are designed for multi-tab synchronization:

1. **Independent Client Sessions**:
   - Each browser tab receives a distinct Socket.IO connection ID, unique initial position, and distinct avatar color.
   - Users can customize their display name directly via the HUD Name input.
2. **Real-Time Bidirectional Propagation**:
   - Movements triggered in Tab 1 via keyboard (<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows) or clicking the canvas emit `updatePosition`.
   - The server validates coordinates, clamps them to `[0, 2000]`, and broadcasts `userPositionUpdated` to all other tabs.
   - Tab 2 receives the update and smoothly moves Tab 1's avatar in real-time.
3. **No Ghost Avatars on Room Transitions**:
   - When a user switches rooms, their avatar is automatically purged from the previous room's canvas and member list.
   - Only peers within the active room are rendered.
4. **Unexpected Disconnection Recovery**:
   - When a browser tab is abruptly closed or refreshes, the server detects the transport teardown (`transport close`), clears the user from memory, and immediately informs all other tabs via `userDisconnected` and `participantLeft`.

---

## 8. Frontend Integration Contract (`client/src/App.jsx`)

The backend is engineered to seamlessly communicate with the React frontend:

1. **Health Verification**:
   - The React client verifies backend readiness by fetching `http://localhost:5000/api/health`.
   - Expects `data.status === "OK"` and `data.project === "ProxiSpeak"`.
2. **User Registration**:
   - On connecting, client emits `socket.emit("join", { username })`.
   - Server registers user and responds with `currentUsers` snapshot and broadcasts `userJoined`.
3. **Movement Synchronization**:
   - React client emits `socket.emit("updatePosition", { x, y })`.
   - Coordinates are mapped to map boundaries `[0, 2000]` and broadcast via `userPositionUpdated` and `userMoved`.
4. **Disconnection Handling**:
   - The React client registers:
     ```javascript
     socket.on("userDisconnected", removeUser);
     socket.on("userLeft", removeUser);
     socket.on("participantLeft", removeUser);
     ```
   - `removeUser` handles both string IDs and object payloads:
     ```javascript
     const id = typeof data === "string" ? data : data?.id;
     ```
   - Server emits `{ id: socket.id, username, reason }` ensuring 100% interoperability.
5. **Reconnection Churn Safety**:
   - Rapid sequential or burst reconnects do not cause orphaned user records or memory leaks; the server automatically prunes socket references upon socket transport teardown.

---

## 9. How to Run Locally

### Start Development Server
```bash
cd server
npm start
```
Starts Express & Socket.IO server on `http://localhost:5000`.

### Run Automated 15-Module Verification Suite
```bash
cd server
npm test
```
Executes all 15 automated integration tests:
1. `GET /` (Root route)
2. `GET /api/health` (Frontend health contract)
3. `GET /api/status` (Active users and uptime)
4. `GET /api/unknown` (404 error handler)
5. Socket.IO connection acknowledgment & ping-pong
6. Multi-client position update & real-time sync
7. Input validation & coordinate boundary clamping `[0, 2000]`
8. Disconnection lifecycle & broadcast
9. Room join/leave logic & voice participant updates
10. Multiple simultaneous connections & duplicate event guards
11. WebRTC signaling relays & offline target error handling
12. Repeated connections & disconnection churn resilience (sequential & concurrent bursts)
13. Real-time multi-tab avatar movement synchronization (Alice, Bob, Charlie)
14. Unexpected disconnections & abrupt transport teardown handling
15. Exhaustive invalid inputs battery & crash resistance

### Interactive Multi-Tab Visual Demo
1. Start server: `npm start`
2. Open [http://localhost:5000/demo](http://localhost:5000/demo) in **two or three separate browser tabs**.
3. Name Tab 1 "Alice" and Tab 2 "Bob".
4. Move either avatar using keyboard or mouse; watch real-time coordinates, avatar position, and room member lists sync instantaneously!
5. Close Tab 1; observe Tab 2 immediately logging the disconnect and clearing Alice from the screen.
