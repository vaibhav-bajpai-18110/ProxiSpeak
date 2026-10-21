import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:5000/api/health";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin;
const USERNAME_STORAGE_KEY = "proxispeak.username";
const ROOM_BOUNDS = { minX: 8, maxX: 92, minY: 12, maxY: 88 };
const INITIAL_POSITION = { x: 49, y: 57 };

function getSavedUsername() {
  try {
    return window.localStorage.getItem(USERNAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function clampPosition(position) {
  return {
    x: Math.min(ROOM_BOUNDS.maxX, Math.max(ROOM_BOUNDS.minX, position.x)),
    y: Math.min(ROOM_BOUNDS.maxY, Math.max(ROOM_BOUNDS.minY, position.y)),
  };
}

function isValidPosition(position) {
  return (
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y)
  );
}

function App() {
  const [started, setStarted] = useState(false);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiResponse, setApiResponse] = useState(null);
  const [apiError, setApiError] = useState("");
  const [username, setUsername] = useState(getSavedUsername);
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [isMuted, setIsMuted] = useState(false);
  const [socketStatus, setSocketStatus] = useState("idle");
  const [socketError, setSocketError] = useState("");
  const socketRef = useRef(null);
  const hasConnectedRef = useRef(false);

  const checkBackend = useCallback(async (signal) => {
    setApiStatus("loading");
    setApiError("");

    try {
      const response = await fetch(API_URL, { signal });
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const data = await response.json();
      if (data.status !== "OK" || data.project !== "ProxiSpeak") {
        throw new Error("Unexpected backend health response");
      }

      setApiResponse(data);
      setApiStatus("connected");
    } catch (error) {
      if (error.name === "AbortError") return;
      setApiStatus("disconnected");
      setApiResponse(null);
      setApiError(error.message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    checkBackend(controller.signal);
    return () => controller.abort();
  }, [checkBackend]);

  useEffect(() => {
    if (!started) {
      setSocketStatus("idle");
      setSocketError("");
      return undefined;
    }

    const socket = io(SOCKET_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;
    hasConnectedRef.current = false;
    setSocketStatus(window.navigator.onLine ? "connecting" : "offline");
    setSocketError("");

    const handleConnect = () => {
      hasConnectedRef.current = true;
      setSocketStatus("connected");
      setSocketError("");
    };
    const handleDisconnect = (reason) => {
      setSocketStatus(!window.navigator.onLine ? "offline" : socket.active ? (hasConnectedRef.current ? "reconnecting" : "connecting") : "disconnected");
      setSocketError(reason);
    };
    const handleConnectError = (error) => {
      setSocketStatus(!window.navigator.onLine ? "offline" : hasConnectedRef.current ? "reconnecting" : "connecting");
      setSocketError(error.message);
    };
    const handleReconnectAttempt = () => {
      setSocketStatus(!window.navigator.onLine ? "offline" : hasConnectedRef.current ? "reconnecting" : "connecting");
    };
    const handleOffline = () => {
      setSocketStatus("offline");
      setSocketError("Your device is offline.");
    };
    const handleOnline = () => {
      if (socket.connected) {
        setSocketStatus("connected");
      } else {
        setSocketStatus("reconnecting");
        socket.connect();
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    if (window.navigator.onLine) socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [started]);

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

  function enterOffice(event) {
    event.preventDefault();
    const cleanUsername = username.trim().replace(/\s+/g, " ");
    if (!cleanUsername) return;
    setUsername(cleanUsername);
    try {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);
    } catch {
      // The current session can still use the name when storage is unavailable.
    }
    setStarted(true);
  }

  const connectionStatus = started ? socketStatus : apiStatus;
  const connectionLabel = {
    idle: "Not connected",
    loading: "Checking backend...",
    connecting: "Connecting...",
    connected: "Connected",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    offline: "Offline",
  }[connectionStatus] || "Checking connection...";

  return (
    <div className="app">
      <header className="navbar">
        <button
          className="brand brand-button"
          onClick={() => setStarted(false)}
          aria-label="Go to ProxiSpeak home"
        >
          <span className="brand-icon" aria-hidden="true">◉</span>
          <span>ProxiSpeak</span>
        </button>

        <div className="nav-right">
          {started && (
            <span className="room-label"><span className="room-label-dot" /> PRODUCTIVITY FLOOR</span>
          )}
          <span className={`nav-status ${connectionStatus}`} role="status" aria-live="polite">
            <span className={`status-dot ${connectionStatus}`} />
            {connectionLabel}
          </span>
          {started && (
            <span className="avatar-small" title={username} aria-label={`${username} profile`}>{getInitials(username)}</span>
          )}
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          onPositionChange={updatePosition}
          username={username}
          connectionStatus={socketStatus}
          connectionError={socketError}
          onRetryConnection={() => socketRef.current?.connect()}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((muted) => !muted)}
          onLeave={() => setStarted(false)}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiResponse={apiResponse}
          apiError={apiError}
          username={username}
          onUsernameChange={setUsername}
          onJoin={enterOffice}
        />
      )}

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({ apiStatus, apiResponse, apiError, username, onUsernameChange, onJoin }) {
  return (
    <main className="hero">
      <div className="hero-icon"><span aria-hidden="true">◉</span></div>
      <span className="eyebrow">THE FUTURE OF COMMUNICATION</span>
      <h1>Connect. Communicate.<br /><span>Anywhere.</span></h1>
      <p className="description">
        Welcome to ProxiSpeak — a simple and modern communication platform designed to bring people closer.
      </p>

      <div className="status-card">
        <div className="status-row">
          <span>Backend Connection</span>
          <strong className={apiStatus}>{apiStatus === "loading" ? "Checking..." : apiStatus === "connected" ? "Connected" : "Disconnected"}</strong>
        </div>
        <div className="status-row">
          <span>Application Status</span><strong className="ready">Ready to join</strong>
        </div>
        {apiResponse && <div className="api-details"><p>Backend API Response</p><pre>{JSON.stringify(apiResponse, null, 2)}</pre></div>}
        {apiStatus === "disconnected" && <p className="api-error" role="alert">Backend unavailable: {apiError}</p>}
      </div>

      <form className="join-form" onSubmit={onJoin}>
        <label className="username-field">
          <span>Your display name</span>
          <input
            autoComplete="nickname"
            maxLength={24}
            name="username"
            onChange={(event) => onUsernameChange(event.target.value)}
            pattern=".*\S.*"
            placeholder="e.g. Harshavardhan"
            required
            title="Enter at least one non-space character."
            value={username}
          />
        </label>
        <p className="username-hint">This name appears above your avatar.</p>
        <button className="start-button" type="submit">
          Enter virtual office <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="footer-note">A little space to work together, wherever you are.</p>
    </main>
  );
}

// Controlled position props are the integration boundary for future presence updates.
// A backend adapter can pass normalized coordinates here once its contract is defined.
export function VirtualOffice({ position, onPositionChange, username, connectionStatus, connectionError, onRetryConnection, isMuted, onToggleMute, onLeave }) {
  const roomRef = useRef(null);
  const moveBy = useCallback((dx, dy) => {
    onPositionChange({ x: position.x + dx, y: position.y + dy });
  }, [onPositionChange, position]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target?.closest("button, input, textarea, select")) return;
      const key = event.key.toLowerCase();
      const moves = {
        arrowup: [0, -3], w: [0, -3],
        arrowdown: [0, 3], s: [0, 3],
        arrowleft: [-3, 0], a: [-3, 0],
        arrowright: [3, 0], d: [3, 0],
      };
      if (!moves[key]) return;
      event.preventDefault();
      moveBy(...moves[key]);
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
          <p className="office-subtitle">Move around and find a spot to settle in.</p>
        </div>
        <div className="people-pill"><span className="people-avatars"><i>{getInitials(username)}</i><i>M</i><i>A</i></span><span><b>4</b> in the office</span></div>
      </div>

      <section className="office-shell" aria-label="Interactive virtual office">
        <div className="room-toolbar">
          <div className="room-name"><span className="room-live" /> The Commons <span className="room-separator">/</span> Open workspace</div>
          <div className={`room-presence ${connectionStatus}`} role="status" aria-live="polite">
            <span className={`presence-dot ${connectionStatus}`} />
            <span>{connectionStatus === "connected" ? "Live connection" : connectionStatus === "connecting" ? "Connecting to office" : connectionStatus === "reconnecting" ? "Reconnecting" : connectionStatus === "offline" ? "Device offline" : "Disconnected"}</span>
            {connectionError && connectionStatus !== "connected" && <span className="connection-detail"> · {connectionError}</span>}
            {connectionStatus === "disconnected" && <button className="retry-connection" onClick={onRetryConnection} type="button">Retry</button>}
          </div>
        </div>

        <div className="room-scene" ref={roomRef} onClick={moveToPointer} role="application" aria-label="Office floor. Click a spot to move your avatar there.">
          <div className="window-wall"><span /><span /><span /><span /><span /></div>
          <div className="plant plant-one"><i /><b /><em /></div>
          <div className="plant plant-two"><i /><b /><em /></div>
          <div className="meeting-zone">
            <span className="zone-label">HUDDLE ROOM</span>
            <div className="meeting-table"><i /><i /><i /><i /></div>
            <div className="meeting-chair chair-a" /><div className="meeting-chair chair-b" />
          </div>
          <div className="desk desk-one"><span className="monitor" /><span className="keyboard" /><span className="desk-mug" /></div>
          <div className="desk desk-two"><span className="monitor" /><span className="keyboard" /><span className="plant-pot" /></div>
          <div className="sofa"><span /><span /><i /></div>
          <div className="rug" />

          <OfficeMate className="mate-one" initials="M" name="Maya" mood="Focused" />
          <OfficeMate className="mate-two" initials="A" name="Alex" mood="Available" />
          <OfficeMate className="mate-three" initials="J" name="Jordan" mood="In a call" />

          <div
            className="my-avatar-wrap"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
            aria-label={`Your avatar, position ${Math.round(position.x)}, ${Math.round(position.y)}`}
          >
            <span className="avatar-name-tag">{username}</span>
            <span className="avatar-shadow" />
            <span className="my-avatar"><span className="avatar-hair" /><span className="avatar-face"><i /><i /></span><span className="avatar-body" /></span>
            <span className="avatar-position">{Math.round(position.x)}, {Math.round(position.y)}</span>
          </div>
          <span className="scene-hint">Click anywhere to move</span>
        </div>

        <div className="office-controls">
          <div className="movement-help"><span className="key-cluster"><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span><span>or arrow keys to move</span></div>
          <div className="control-actions">
            <button className={`control-button ${isMuted ? "is-muted" : ""}`} onClick={onToggleMute} aria-pressed={isMuted}><span>{isMuted ? "◌" : "◖"}</span>{isMuted ? "Unmute" : "Mute"}</button>
            <button className="control-button leave-button" onClick={onLeave}><span>↗</span> Leave office</button>
          </div>
        </div>
      </section>
      <p className="office-footnote"><span>✦</span> You appear in the office as {username}.</p>
    </main>
  );
}

function OfficeMate({ className, initials, name, mood }) {
  return (
    <div className={`office-mate ${className}`} title={`${name} · ${mood}`}>
      <span className={`mate-avatar mate-${initials.toLowerCase()}`}>{initials}</span>
      <span className="mate-status">{mood}</span>
      <span className="mate-name">{name}</span>
    </div>
  );
}

export default App;
