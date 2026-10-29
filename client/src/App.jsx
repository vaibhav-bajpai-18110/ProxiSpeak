import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  BACKEND_MAP_SIZE,
  clampPosition,
  isValidPosition,
  mergeParticipant,
  normalizeParticipant,
  normalizeUsername,
} from "./presence.js";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api/health";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin;
const API_TIMEOUT_MS = 8000;
const USERNAME_STORAGE_KEY = "proxispeak.username";
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

function App() {
  const [started, setStarted] = useState(false);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiResponse, setApiResponse] = useState(null);
  const [apiError, setApiError] = useState("");
  const [username, setUsername] = useState(getSavedUsername);
  const [isJoining, setIsJoining] = useState(false);
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [isMuted, setIsMuted] = useState(false);
  const [socketStatus, setSocketStatus] = useState("idle");
  const [socketError, setSocketError] = useState("");
  const [participants, setParticipants] = useState([]);
  const socketRef = useRef(null);
  const hasConnectedRef = useRef(false);

  const checkBackend = useCallback(async (signal) => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal?.addEventListener("abort", abortRequest, { once: true });
    const timeoutId = window.setTimeout(abortRequest, API_TIMEOUT_MS);

    try {
      if (signal?.aborted) return false;
      const response = await fetch(API_URL, { signal: requestController.signal });
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const data = await response.json();
      if (data.status !== "OK" || data.project !== "ProxiSpeak") {
        throw new Error("Unexpected backend health response");
      }

      setApiResponse(data);
      setApiStatus("connected");
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setApiStatus("disconnected");
      setApiResponse(null);
      setApiError(error.name === "AbortError" ? "The backend did not respond in time." : error.message);
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortRequest);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return checkBackend(controller.signal);
      return undefined;
    });
    return () => controller.abort();
  }, [checkBackend]);

  const setLocalParticipant = useCallback((status) => {
    const id = socketRef.current?.id || "you";
    setParticipants((current) => {
      const existing = current.find((participant) => participant.id === id || participant.isYou);
      const localParticipant = {
        ...existing,
        id,
        name: username,
        status,
        isYou: true,
        position: existing?.position || null,
        color: existing?.color || "",
      };
      return [
        ...current.filter((participant) => participant.id !== id && !participant.isYou),
        localParticipant,
      ];
    });
  }, [username]);

  useEffect(() => {
    if (!started) return undefined;

    const socket = io(SOCKET_URL, {
      autoConnect: false,
      auth: { username },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;
    hasConnectedRef.current = false;

    const handleConnect = () => {
      hasConnectedRef.current = true;
      setSocketStatus("connected");
      setSocketError("");
      setLocalParticipant("online");
      socket.emit("join", { username });
    };
    const handleParticipantsSnapshot = (payload) => {
      const nextParticipants = Array.isArray(payload) ? payload : payload?.participants;
      if (!Array.isArray(nextParticipants)) return;
      const normalized = nextParticipants
        .map((participant) => normalizeParticipant(participant, socket.id))
        .filter(Boolean)
        .map((participant) => participant.isYou ? { ...participant, name: username } : participant);
      setParticipants((current) => {
        const existingById = new Map(current.map((participant) => [participant.id, participant]));
        return normalized.map((participant) => mergeParticipant(participant, existingById.get(participant.id)));
      });
    };
    const handleParticipantJoined = (participant) => {
      const normalized = normalizeParticipant(participant, socket.id);
      if (!normalized) return;
      setParticipants((current) => {
        const existing = current.find((person) => person.id === normalized.id);
        return [
          ...current.filter((person) => person.id !== normalized.id),
          mergeParticipant(normalized, existing),
        ];
      });
    };
    const handleParticipantLeft = (participant) => {
      if (typeof participant?.id !== "string") return;
      setParticipants((current) => current.filter((person) => person.id !== participant.id));
    };
    const handlePositionUpdate = (update) => {
      const normalized = normalizeParticipant(update, socket.id);
      if (!normalized?.position) return;
      setParticipants((current) => {
        const exists = current.some((person) => person.id === normalized.id);
        if (!exists) return [...current, normalized];
        return current.map((person) => person.id === normalized.id
          ? mergeParticipant(normalized, person)
          : person);
      });
    };
    const handleSocketValidationError = (error) => {
      setSocketError(error?.message || "The backend rejected a real-time update.");
    };
    const handleDisconnect = (reason) => {
      const status = !window.navigator.onLine ? "offline" : socket.active ? (hasConnectedRef.current ? "reconnecting" : "connecting") : "disconnected";
      setSocketStatus(status);
      setSocketError(reason);
      setLocalParticipant(status === "offline" || status === "disconnected" ? status : "connecting");
    };
    const handleConnectError = (error) => {
      const status = !window.navigator.onLine ? "offline" : hasConnectedRef.current ? "reconnecting" : "connecting";
      setSocketStatus(status);
      setSocketError(error.message);
      setLocalParticipant(status === "offline" ? status : "connecting");
    };
    const handleReconnectAttempt = () => {
      const status = !window.navigator.onLine ? "offline" : hasConnectedRef.current ? "reconnecting" : "connecting";
      setSocketStatus(status);
      setLocalParticipant(status === "offline" ? status : "connecting");
    };
    const handleReconnectFailed = () => {
      setSocketStatus("disconnected");
      setSocketError("Could not connect to the office server. Retry when it is available.");
      setLocalParticipant("offline");
    };
    const handleOffline = () => {
      setSocketStatus("offline");
      setSocketError("Your device is offline.");
      setLocalParticipant("offline");
    };
    const handleOnline = () => {
      if (socket.connected) {
        setSocketStatus("connected");
        setLocalParticipant("online");
      } else {
        setSocketStatus("reconnecting");
        setLocalParticipant("connecting");
        socket.connect();
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("roomParticipants", handleParticipantsSnapshot);
    socket.on("currentUsers", handleParticipantsSnapshot);
    socket.on("participants:update", handleParticipantsSnapshot);
    socket.on("participantJoined", handleParticipantJoined);
    socket.on("userJoined", handleParticipantJoined);
    socket.on("participantLeft", handleParticipantLeft);
    socket.on("userDisconnected", handleParticipantLeft);
    socket.on("userLeft", handleParticipantLeft);
    socket.on("userPositionUpdated", handlePositionUpdate);
    socket.on("error:validation", handleSocketValidationError);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect_failed", handleReconnectFailed);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    if (window.navigator.onLine) socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("roomParticipants", handleParticipantsSnapshot);
      socket.off("currentUsers", handleParticipantsSnapshot);
      socket.off("participants:update", handleParticipantsSnapshot);
      socket.off("participantJoined", handleParticipantJoined);
      socket.off("userJoined", handleParticipantJoined);
      socket.off("participantLeft", handleParticipantLeft);
      socket.off("userDisconnected", handleParticipantLeft);
      socket.off("userLeft", handleParticipantLeft);
      socket.off("userPositionUpdated", handlePositionUpdate);
      socket.off("error:validation", handleSocketValidationError);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect_failed", handleReconnectFailed);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [started, username, setLocalParticipant]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!started || socketStatus !== "connected" || !socket?.connected) return;
    socket.emit("updatePosition", {
      x: Math.round(position.x * (BACKEND_MAP_SIZE / 100)),
      y: Math.round(position.y * (BACKEND_MAP_SIZE / 100)),
    });
  }, [position, socketStatus, started]);

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

  async function enterOffice(event) {
    event.preventDefault();
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername || isJoining) return;
    setUsername(cleanUsername);
    try {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);
    } catch {
      // The current session can still use the name when storage is unavailable.
    }
    setIsJoining(true);
    setApiStatus("loading");
    setApiError("");
    try {
      const backendIsReady = await checkBackend();
      if (!backendIsReady) return;
      const connectionStatus = window.navigator.onLine ? "connecting" : "offline";
      setSocketStatus(connectionStatus);
      setSocketError(window.navigator.onLine ? "" : "Your device is offline.");
      setLocalParticipant(connectionStatus);
      setStarted(true);
    } finally {
      setIsJoining(false);
    }
  }

  function leaveOffice() {
    setStarted(false);
    setSocketStatus("idle");
    setSocketError("");
    setParticipants([]);
  }

  function retryBackend() {
    setApiStatus("loading");
    setApiError("");
    void checkBackend();
  }

  const connectionStatus = started ? socketStatus : apiStatus;
  const connectionLabel = {
    idle: "Not connected",
    loading: "Checking backend...",
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    offline: "Offline",
  }[connectionStatus] || "Checking connection...";

  return (
    <div className="app">
      <header className="navbar">
        <button
          className="brand brand-button"
          onClick={leaveOffice}
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
          participants={participants}
          onRetryConnection={() => socketRef.current?.connect()}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((muted) => !muted)}
          onLeave={leaveOffice}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiResponse={apiResponse}
          apiError={apiError}
          isJoining={isJoining}
          username={username}
          onUsernameChange={setUsername}
          onJoin={enterOffice}
          onRetryBackend={retryBackend}
        />
      )}

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({ apiStatus, apiResponse, apiError, isJoining, username, onUsernameChange, onJoin, onRetryBackend }) {
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
          <div className="backend-status-actions">
            <strong className={apiStatus} role="status" aria-live="polite">{apiStatus === "loading" ? "Checking..." : apiStatus === "connected" ? "Connected" : "Disconnected"}</strong>
            {apiStatus === "disconnected" && <button className="api-retry" onClick={onRetryBackend} type="button">Retry</button>}
          </div>
        </div>
        <div className="status-row">
          <span>Application Status</span>
          <strong className={apiStatus === "connected" ? "ready" : apiStatus}>
            {apiStatus === "loading" ? "Checking backend" : apiStatus === "connected" ? "Ready to join" : "Waiting for backend"}
          </strong>
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
        <button className="start-button" type="submit" disabled={isJoining || apiStatus === "loading" || !username.trim()}>
          {isJoining ? "Checking backend..." : apiStatus === "disconnected" ? "Retry & enter office" : "Enter virtual office"} <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="footer-note">A little space to work together, wherever you are.</p>
    </main>
  );
}

// Controlled position props are the integration boundary for future presence updates.
// A backend adapter can pass normalized coordinates here once its contract is defined.
export function VirtualOffice({ position, onPositionChange, username, connectionStatus, connectionError, participants, onRetryConnection, isMuted, onToggleMute, onLeave }) {
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
        <div className="people-pill"><span className="people-avatars"><i>{getInitials(username)}</i></span><span><b>{participants.filter((participant) => participant.status === "online").length}</b> online</span></div>
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

          {participants.filter((participant) => !participant.isYou && participant.position && participant.status === "online").map((participant) => (
            <div
              className="office-mate"
              key={participant.id}
              style={{ left: `${participant.position.x}%`, top: `${participant.position.y}%` }}
              role="img"
              aria-label={`${participant.name}'s avatar`}
            >
              <span className="mate-status">Online</span>
              <span className="mate-avatar" style={participant.color ? { background: participant.color } : undefined}>{getInitials(participant.name)}</span>
              <span className="mate-name">{participant.name}</span>
            </div>
          ))}

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
      <ParticipantsPanel participants={participants} />
      <p className="office-footnote"><span>✦</span> You appear in the office as {username}.</p>
    </main>
  );
}

function ParticipantsPanel({ participants }) {
  return (
    <section className="participants-panel" aria-label="Office participants">
      <div className="participants-heading">
        <h2>People in the office</h2>
        <span>{participants.length} participant{participants.length === 1 ? "" : "s"}</span>
      </div>
      {participants.length ? (
        <ul className="participants-list">
          {participants.map((participant) => (
            <li className="participant-row" key={participant.id}>
              <span className="participant-avatar">{getInitials(participant.name)}</span>
              <span className="participant-name">{participant.name}{participant.isYou && <small>You</small>}</span>
              <span className={`participant-status ${participant.status}`}>
                <i />{participant.status === "online" ? "Online" : participant.status === "connecting" ? "Connecting" : "Offline"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="participants-empty">Waiting for the office connection…</p>
      )}
    </section>
  );
}

export default App;
