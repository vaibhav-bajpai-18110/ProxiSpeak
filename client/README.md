
# ProxiSpeak Client

ProxiSpeak is a browser-based virtual office that helps team members connect and collaborate.

## Features

- Username-based office entry
- Backend health status
- Real-time Socket.IO connection
- Participant presence
- Office avatar movement controls
- Connection and leave controls

## Tech Stack

- React
- Vite
- Socket.IO Client

## Run Locally

From the repository root, open two terminals.

### Terminal 1 — Backend

```bash
cd server
npm install
npm start
```

### Terminal 2 — Frontend

```bash
cd client
npm install
npm run dev
```

Open the local URL printed by Vite.

The backend should be available at `http://localhost:5000` unless configured otherwise.

## Configuration

The frontend supports these environment variables:

- `VITE_API_URL` — backend health-check URL
- `VITE_SOCKET_URL` — Socket.IO server URL

Use a local `.env` file for your own configuration. Do not commit secrets.
