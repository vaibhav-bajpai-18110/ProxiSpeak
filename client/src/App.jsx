
import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = "http://localhost:5000";
const API_URL = `${SERVER_URL}/api/health`;
const ROOM_BOUNDS = { minX: 8, maxX: 92, minY: 12, maxY: 88 };
const INITIAL_POSITION = { x: 49, y: 57 };

function clampPosition(position) {
  return {
    x: Math.min(ROOM_BOUNDS.maxX, Math.max(ROOM_BOUNDS.minX, position.x)),
    y: Math.min(ROOM_BOUNDS.maxY, Math.max(ROOM_BOUNDS.minY, position.y)),
  };
}

function isValidPosition(position) {
  return position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y);
}
console.log("PROXISPEAK APP LOADED");
function App() {
  const [started, setStarted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiResponse, setApiResponse] = useState(null);
  const [apiError, setApiError] = useState("");
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [isMuted, setIsMuted] = useState(false);

  const socketRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();

    async function checkBackend() {
      try {
        const response = await fetch(API_URL, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        const data = await response.json();
        setApiResponse(data);
        setApiStatus("connected");
      } catch (error) {
        if (error.name === "AbortError") return;
        setApiResponse(null);
        setApiStatus("disconnected");
        setApiError(error.message);
      }
    }

    checkBackend();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!started) {
      setConnected(false);
      setRemoteUsers([]);
      socketRef.current = null;
      return;
    }

    const socket = io(SERVER_URL);
    socketRef.current = socket;

    function upsertUser(user) {
      if (!user || !user.id || user.id === socket.id) return;

      setRemoteUsers((previous) => {
        const index = previous.findIndex((item) => item.id === user.id);

        if (index === -1) return [...previous, user];

        return previous.map((item) =>
          item.id === user.id ? { ...item, ...user } : item
        );
      });
    }

    function removeUser(data) {
      const id = typeof data === "string" ? data : data?.id;
      if (!id) return;

      setRemoteUsers((previous) =>
        previous.filter((user) => user.id !== id)
      );
    }

    socket.on("connect", () => {
      console.log("SOCKET CONNECTED:", socket.id);
      setConnected(true);
      setMessage("Connected to ProxiSpeak backend!");

      console.log("SENDING JOIN EVENT");
      socket.emit("join", { username: "Vaibhav" });
      socket.emit("ping", { message: "Hello from React frontend" });
    });

    socket.on("pong", (data) => {
      setMessage(
        typeof data === "object" ? data.message || "Pong received" : String(data)
      );
    });

    console.log("REGISTERING CURRENT USERS LISTENER");
    socket.on("currentUsers", (users) => {
      console.log("CURRENT USERS:", users);
  console.log("CURRENT USERS:", users);

  if (!Array.isArray(users)) return;

  setRemoteUsers(users.filter((user) => user.id !== socket.id));
});

console.log("REGISTERING USER JOINED LISTENER");
socket.on("userJoined", (user) => {
  console.log("USER JOINED:", user);
  upsertUser(user);
});

    socket.on("userJoined", upsertUser);
    socket.on("userPositionUpdated", upsertUser);
    socket.on("userMoved", upsertUser);

    socket.on("userDisconnected", removeUser);
    socket.on("userLeft", removeUser);

    socket.on("disconnect", () => {
      setConnected(false);
      setMessage("Disconnected from backend.");
    });

    socket.on("connect_error", () => {
      setConnected(false);
      setMessage("Unable to connect. Is the backend running?");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [started]);

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

  useEffect(() => {
    if (!started || !connected || !socketRef.current) return;

    socketRef.current.emit("updatePosition", position);
  }, [position, started, connected]);

  return (
    <div className="app">
      <header className="navbar">
        <button
          className="brand brand-button"
          onClick={() => setStarted(false)}
          aria-label="Go to ProxiSpeak home"
        >
          <span className="brand-icon" aria-hidden="true">P</span>
          <span>ProxiSpeak</span>
        </button>

        <div className="nav-right">
          {started && (
            <span className="room-label">
              <span className="room-label-dot" /> PRODUCTIVITY FLOOR
            </span>
          )}

          <span className={`nav-status ${connected ? "connected" : "disconnected"}`}>
            <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
            {connected ? "Connected" : "Not connected"}
          </span>
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          remoteUsers={remoteUsers}
          onPositionChange={updatePosition}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((value) => !value)}
          onLeave={() => setStarted(false)}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiResponse={apiResponse}
          apiError={apiError}
          connected={connected}
          message={message}
          onStart={() => setStarted(true)}
        />
      )}

      <footer className="footer">
        2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({ apiStatus, apiResponse, apiError, connected, message, onStart }) {
  return (
    <main className="hero">
      <div className="hero-icon" aria-hidden="true">P</div>
      <span className="eyebrow">THE FUTURE OF COMMUNICATION</span>
      <h1>Connect. Communicate.<br /><span>Anywhere.</span></h1>

      <p className="description">
        Welcome to ProxiSpeak — a modern communication platform
        designed to bring people closer.
      </p>

      <div className="status-card">
        <div className="status-row">
          <span>Backend API</span>
          <strong className={apiStatus}>
            {apiStatus === "loading" ? "Checking..." :
              apiStatus === "connected" ? "Connected" : "Disconnected"}
          </strong>
        </div>

        <div className="status-row">
          <span>Socket.IO</span>
          <strong className={connected ? "ready" : "disconnected"}>
            {connected ? "Connected" : "Disconnected"}
          </strong>
        </div>

        {apiResponse && (
          <pre className="api-details">
            {JSON.stringify(apiResponse, null, 2)}
          </pre>
        )}

        {apiStatus === "disconnected" && (
          <p className="api-error" role="alert">{apiError}</p>
        )}
      </div>

      <button className="start-button" onClick={onStart}>
        Enter virtual office →
      </button>

      {message && <p className="feedback">{message}</p>}

      <p className="footer-note">
        A little space to work together, wherever you are.
      </p>
    </main>
  );
}

function VirtualOffice({
  position,
  remoteUsers,
  onPositionChange,
  isMuted,
  onToggleMute,
  onLeave,
}) {
  const roomRef = useRef(null);

  const moveBy = useCallback((dx, dy) => {
    onPositionChange({
      x: position.x + dx,
      y: position.y + dy,
    });
  }, [position, onPositionChange]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (
        event.altKey || event.ctrlKey || event.metaKey ||
        event.target?.closest("button, input, textarea, select")
      ) return;

      const moves = {
        arrowup: [0, -3], w: [0, -3],
        arrowdown: [0, 3], s: [0, 3],
        arrowleft: [-3, 0], a: [-3, 0],
        arrowright: [3, 0], d: [3, 0],
      };

      const move = moves[event.key.toLowerCase()];
      if (!move) return;

      event.preventDefault();
      moveBy(...move);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveBy]);

  function moveToPointer(event) {
    if (event.target.closest("button")) return;

    const bounds = roomRef.current.getBoundingClientRect();

    onPositionChange({
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    });
  }

  return (
    <main className="office-page">
      <div className="office-heading">
        <div>
          <p className="office-kicker">YOUR TEAM, IN ONE PLACE</p>
          <h1>Welcome to the office<span>.</span></h1>
          <p className="office-subtitle">
            Move around and find a spot to settle in.
          </p>
        </div>

        <div className="people-pill">
          <span className="people-avatars"><i>H</i><i>M</i><i>A</i></span>
          <span><b>{remoteUsers.length + 1}</b> connected in this office</span>
        </div>
      </div>

      <section className="office-shell" aria-label="Interactive virtual office">
        <div className="room-toolbar">
          <div className="room-name">
            <span className="room-live" /> The Commons / Open workspace
          </div>
          <div className="room-presence">
            {remoteUsers.length + 1} participant(s)
          </div>
        </div>

        <div
          className="room-scene"
          ref={roomRef}
          onClick={moveToPointer}
          role="application"
          aria-label="Office floor. Click a spot to move your avatar."
        >
          <div className="window-wall"><span /><span /><span /><span /><span /></div>
          <div className="plant plant-one"><i /><b /><em /></div>
          <div className="plant plant-two"><i /><b /><em /></div>

          <div className="meeting-zone">
            <span className="zone-label">HUDDLE ROOM</span>
            <div className="meeting-table"><i /><i /><i /><i /></div>
            <div className="meeting-chair chair-a" />
            <div className="meeting-chair chair-b" />
          </div>

          <div className="desk desk-one">
            <span className="monitor" /><span className="keyboard" />
            <span className="desk-mug" />
          </div>
          <div className="desk desk-two">
            <span className="monitor" /><span className="keyboard" />
            <span className="plant-pot" />
          </div>
          <div className="sofa"><span /><span /><i /></div>
          <div className="rug" />

          {remoteUsers.map((user) => {
            const userPosition = isValidPosition(user)
              ? clampPosition(user)
              : INITIAL_POSITION;

            return (
              <div
                key={user.id}
                className="my-avatar-wrap"
                style={{
                  left: `${userPosition.x}%`,
                  top: `${userPosition.y}%`,
                  pointerEvents: "none",
                }}
                title={user.username || "Guest"}
              >
                <span className="avatar-name-tag">
                  {user.username || "Guest"}
                </span>
                <span className="avatar-shadow" />
                <span className="my-avatar">
                  <span className="avatar-hair" />
                  <span className="avatar-face"><i /><i /></span>
                  <span className="avatar-body" />
                </span>
              </div>
            );
          })}

          <div
            className="my-avatar-wrap"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
          >
            <span className="avatar-name-tag">You</span>
            <span className="avatar-shadow" />
            <span className="my-avatar">
              <span className="avatar-hair" />
              <span className="avatar-face"><i /><i /></span>
              <span className="avatar-body" />
            </span>
            <span className="avatar-position">
              {Math.round(position.x)}, {Math.round(position.y)}
            </span>
          </div>

          <span className="scene-hint">Click anywhere to move</span>
        </div>

        <div className="office-controls">
          <div className="movement-help">
            <span className="key-cluster">
              <kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
            </span>
            <span>or arrow keys to move</span>
          </div>

          <div className="control-actions">
            <button
              className={`control-button ${isMuted ? "is-muted" : ""}`}
              onClick={onToggleMute}
              aria-pressed={isMuted}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button className="control-button leave-button" onClick={onLeave}>
              Leave office
            </button>
          </div>
        </div>
      </section>

      <p className="office-footnote">
        {remoteUsers.length} other participant(s) received from the backend.
      </p>
    </main>
  );
}

export default App;
