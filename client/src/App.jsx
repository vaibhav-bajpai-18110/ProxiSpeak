
import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000/api/health";
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin;
const MAP_SIZE = 2000;
const USERNAME_KEY = "proxispeak.username";

const ROOM_BOUNDS = { minX: 8, maxX: 92, minY: 12, maxY: 88 };
const INITIAL_POSITION = { x: 49, y: 57 };

function getSavedUsername() {
  try {
    return window.localStorage.getItem(USERNAME_KEY) || "";
  } catch {
    return "";
  }
}

function getInitials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
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

function normalizeUser(user, ownSocketId) {
  if (!user || typeof user.id !== "string") return null;

  const x = Number(user.x);
  const y = Number(user.y);

  return {
    id: user.id,
    username:
      typeof user.username === "string" && user.username.trim()
        ? user.username
        : "Guest",
    x: Number.isFinite(x)
      ? Math.min(92, Math.max(8, (x / MAP_SIZE) * 100))
      : INITIAL_POSITION.x,
    y: Number.isFinite(y)
      ? Math.min(88, Math.max(12, (y / MAP_SIZE) * 100))
      : INITIAL_POSITION.y,
    color: typeof user.color === "string" ? user.color : "",
    isYou: user.id === ownSocketId,
  };
}

function App() {
  const [started, setStarted] = useState(false);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiResponse, setApiResponse] = useState(null);
  const [apiError, setApiError] = useState("");
  const [username, setUsername] = useState(getSavedUsername);
  const [isJoining, setIsJoining] = useState(false);
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [socketStatus, setSocketStatus] = useState("idle");
  const [socketError, setSocketError] = useState("");
  const [message, setMessage] = useState("");

  const socketRef = useRef(null);
  const hasConnectedRef = useRef(false);

  const checkBackend = useCallback(async (signal) => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();

    signal?.addEventListener("abort", abortRequest, { once: true });
    const timeoutId = window.setTimeout(abortRequest, 8000);

    try {
      if (signal?.aborted) return false;

      const response = await fetch(API_URL, {
        signal: requestController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== "OK" || data.project !== "ProxiSpeak") {
        throw new Error("Unexpected backend health response");
      }

      setApiResponse(data);
      setApiStatus("connected");
      setApiError("");
      return true;
    } catch (error) {
      if (signal?.aborted) return false;

      setApiResponse(null);
      setApiStatus("disconnected");
      setApiError(
        error.name === "AbortError"
          ? "The backend did not respond in time."
          : error.message
      );
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortRequest);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkBackend(controller.signal);

    return () => controller.abort();
  }, [checkBackend]);

  const participants = [
    {
      id: socketRef.current?.id || "you",
      username,
      x: position.x,
      y: position.y,
      isYou: true,
      color: "",
    },
    ...remoteUsers.filter((user) => user.id !== socketRef.current?.id),
  ];

  const enterOffice = async (event) => {
    event.preventDefault();

    const cleanUsername = username.trim().replace(/\s+/g, " ");
    if (!cleanUsername || isJoining) return;

    setUsername(cleanUsername);

    try {
      window.localStorage.setItem(USERNAME_KEY, cleanUsername);
    } catch {
      // The current session can continue without local storage.
    }

    setIsJoining(true);
    setApiError("");

    try {
      const ready = await checkBackend();
      if (!ready) return;

      setSocketStatus("connecting");
      setSocketError("");
      setStarted(true);
    } finally {
      setIsJoining(false);
    }
  };

  const leaveOffice = () => {
    setStarted(false);
    setSocketStatus("idle");
    setSocketError("");
    setRemoteUsers([]);
    setMessage("");
  };

  const retryBackend = () => {
    setApiStatus("loading");
    setApiError("");
    void checkBackend();
  };

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

    const upsertUser = (rawUser) => {
      const user = normalizeUser(rawUser, socket.id);
      if (!user || user.isYou) return;

      setRemoteUsers((current) => {
        const exists = current.some((item) => item.id === user.id);

        return exists
          ? current.map((item) =>
              item.id === user.id ? { ...item, ...user } : item
            )
          : [...current, user];
      });
    };

    const removeUser = (data) => {
      const id = typeof data === "string" ? data : data?.id;
      if (typeof id !== "string") return;

      setRemoteUsers((current) =>
        current.filter((user) => user.id !== id)
      );
    };

    const handleParticipantsSnapshot = (payload) => {
      const list = Array.isArray(payload)
        ? payload
        : payload?.participants;

      if (!Array.isArray(list)) return;

      setRemoteUsers(
        list
          .map((user) => normalizeUser(user, socket.id))
          .filter((user) => user && !user.isYou)
      );
    };

    const handleParticipantJoined = (participant) => {
      upsertUser(participant);
    };

    const handleParticipantLeft = (participant) => {
      removeUser(participant);
    };

    const handlePositionUpdate = (rawUser) => {
      upsertUser(rawUser);
    };

    const handleConnect = () => {
      hasConnectedRef.current = true;
      setSocketStatus("connected");
      setSocketError("");
      setMessage("Connected to ProxiSpeak backend!");

      socket.emit("join", { username });
    };

    const handleDisconnect = (reason) => {
      setSocketStatus(
        !window.navigator.onLine
          ? "offline"
          : hasConnectedRef.current
            ? "reconnecting"
            : "disconnected"
      );
      setSocketError(reason || "Disconnected from backend.");
    };

    const handleConnectError = (error) => {
      setSocketStatus(
        !window.navigator.onLine
          ? "offline"
          : hasConnectedRef.current
            ? "reconnecting"
            : "disconnected"
      );
      setSocketError(error.message);
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

    const handleValidationError = (error) => {
      setSocketError(
        error?.message || "The backend rejected an update."
      );
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);

    socket.on("currentUsers", handleParticipantsSnapshot);
    socket.on("roomParticipants", handleParticipantsSnapshot);
    socket.on("participantsSnapshot", handleParticipantsSnapshot);

    socket.on("userJoined", handleParticipantJoined);
    socket.on("participantJoined", handleParticipantJoined);

    socket.on("userPositionUpdated", handlePositionUpdate);
    socket.on("userMoved", handlePositionUpdate);
    socket.on("positionUpdated", handlePositionUpdate);

    socket.on("userDisconnected", handleParticipantLeft);
    socket.on("userLeft", handleParticipantLeft);
    socket.on("participantLeft", handleParticipantLeft);

    socket.on("error:validation", handleValidationError);

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    if (window.navigator.onLine) {
      socket.connect();
    } else {
      handleOffline();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);

      socket.off("currentUsers", handleParticipantsSnapshot);
      socket.off("roomParticipants", handleParticipantsSnapshot);
      socket.off("participantsSnapshot", handleParticipantsSnapshot);

      socket.off("userJoined", handleParticipantJoined);
      socket.off("participantJoined", handleParticipantJoined);

      socket.off("userPositionUpdated", handlePositionUpdate);
      socket.off("userMoved", handlePositionUpdate);
      socket.off("positionUpdated", handlePositionUpdate);

      socket.off("userDisconnected", handleParticipantLeft);
      socket.off("userLeft", handleParticipantLeft);
      socket.off("participantLeft", handleParticipantLeft);

      socket.off("error:validation", handleValidationError);

      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);

      socket.disconnect();

      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [started, username]);

  useEffect(() => {
    const socket = socketRef.current;

    if (!started || socketStatus !== "connected" || !socket?.connected) {
      return;
    }

    socket.emit("updatePosition", {
      x: Math.round(position.x * (MAP_SIZE / 100)),
      y: Math.round(position.y * (MAP_SIZE / 100)),
    });
  }, [position, socketStatus, started]);

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

  const connectionStatus = started ? socketStatus : apiStatus;

  const connectionLabel = {
    idle: "Not connected",
    loading: "Checking backend...",
    connected: "Connected",
    connecting: "Connecting",
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
          <span className="brand-icon" aria-hidden="true">P</span>
          <span>ProxiSpeak</span>
        </button>

        <div className="nav-right">
          {started && (
            <span className="room-label">
              <span className="room-label-dot" /> PRODUCTIVITY FLOOR
            </span>
          )}

          <span
            className={`nav-status ${connectionStatus}`}
            role="status"
            aria-live="polite"
          >
            <span className={`status-dot ${connectionStatus}`} />
            {connectionLabel}
          </span>

          {started && (
            <span className="avatar-small" title={username}>
              {getInitials(username)}
            </span>
          )}
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          remoteUsers={remoteUsers}
          participants={participants}
          username={username}
          connectionStatus={socketStatus}
          connectionError={socketError}
          onPositionChange={updatePosition}
          onRetryConnection={() => socketRef.current?.connect()}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((value) => !value)}
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
        2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({
  apiStatus,
  apiResponse,
  apiError,
  isJoining,
  username,
  onUsernameChange,
  onJoin,
  onRetryBackend,
}) {
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
          <span>Backend Connection</span>
          <div className="backend-status-actions">
            <strong className={apiStatus} role="status" aria-live="polite">
              {apiStatus === "loading"
                ? "Checking..."
                : apiStatus === "connected"
                  ? "Connected"
                  : "Disconnected"}
            </strong>

            {apiStatus === "disconnected" && (
              <button
                className="api-retry"
                onClick={onRetryBackend}
                type="button"
              >
                Retry
              </button>
            )}
          </div>
        </div>

        <div className="status-row">
          <span>Application Status</span>
          <strong className={apiStatus === "connected" ? "ready" : apiStatus}>
            {apiStatus === "loading"
              ? "Checking backend"
              : apiStatus === "connected"
                ? "Ready to join"
                : "Waiting for backend"}
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

      <form className="join-form" onSubmit={onJoin}>
        <label className="username-field">
          <span>Your display name</span>
          <input
            autoComplete="nickname"
            maxLength={24}
            name="username"
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="Enter your display name"
            required
            value={username}
          />
        </label>

        <p className="username-hint">
          This name appears above your avatar.
        </p>

        <button
          className="start-button"
          type="submit"
          disabled={isJoining || apiStatus === "loading" || !username.trim()}
        >
          {isJoining ? "Checking backend..." : "Enter virtual office"}
          <span aria-hidden="true"> →</span>
        </button>
      </form>

      <p className="footer-note">
        A little space to work together, wherever you are.
      </p>
    </main>
  );
}

function VirtualOffice({
  position,
  remoteUsers,
  participants,
  username,
  connectionStatus,
  connectionError,
  onPositionChange,
  onRetryConnection,
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
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.target?.closest("button, input, textarea, select")
      ) {
        return;
      }

      const moves = {
        arrowup: [0, -3],
        w: [0, -3],
        arrowdown: [0, 3],
        s: [0, 3],
        arrowleft: [-3, 0],
        a: [-3, 0],
        arrowright: [3, 0],
        d: [3, 0],
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

    const bounds = roomRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds?.height) return;

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
          <span className="people-avatars">
            <i>{getInitials(username)}</i>
          </span>
          <span>
            <b>{participants.length}</b> participant(s)
          </span>
        </div>
      </div>

      <section className="office-shell" aria-label="Interactive virtual office">
        <div className="room-toolbar">
          <div className="room-name">
            <span className="room-live" /> The Commons
            <span className="room-separator">/</span> Open workspace
          </div>

          <div
            className={`room-presence ${connectionStatus}`}
            role="status"
            aria-live="polite"
          >
            <span className={`presence-dot ${connectionStatus}`} />
            <span>
              {connectionStatus === "connected"
                ? "Live connection"
                : connectionStatus === "connecting"
                  ? "Connecting to office"
                  : connectionStatus === "reconnecting"
                    ? "Reconnecting"
                    : connectionStatus === "offline"
                      ? "Device offline"
                      : "Disconnected"}
            </span>

            {connectionError && connectionStatus !== "connected" && (
              <span className="connection-detail"> · {connectionError}</span>
            )}

            {["disconnected", "offline"].includes(connectionStatus) && (
              <button
                className="retry-connection"
                onClick={onRetryConnection}
                type="button"
              >
                Retry
              </button>
            )}
          </div>
        </div>

        <div
          className="room-scene"
          ref={roomRef}
          onClick={moveToPointer}
          role="application"
          aria-label="Office floor. Click a spot to move your avatar."
        >
          <div className="window-wall">
            <span /><span /><span /><span /><span />
          </div>
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

          {remoteUsers.map((user) => (
            <div
              key={user.id}
              className="my-avatar-wrap"
              style={{
                left: `${user.x}%`,
                top: `${user.y}%`,
                pointerEvents: "none",
              }}
              title={user.username}
            >
              <span className="avatar-name-tag">{user.username}</span>
              <span className="avatar-shadow" />
              <span
                className="my-avatar"
                style={user.color ? { backgroundColor: user.color } : undefined}
              >
                <span className="avatar-hair" />
                <span className="avatar-face"><i /><i /></span>
                <span className="avatar-body" />
              </span>
            </div>
          ))}

          <div
            className="my-avatar-wrap"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
          >
            <span className="avatar-name-tag">{username}</span>
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
            <button
              className="control-button leave-button"
              onClick={onLeave}
            >
              Leave office
            </button>
          </div>
        </div>
      </section>

      <ParticipantsPanel participants={participants} />

      <p className="office-footnote">
        ✦ You appear in the office as {username}.
      </p>
    </main>
  );
}

function ParticipantsPanel({ participants }) {
  return (
    <section className="participants-panel" aria-label="Office participants">
      <div className="participants-heading">
        <h2>People in the office</h2>
        <span>{participants.length} participant(s)</span>
      </div>

      {participants.length ? (
        <ul className="participants-list">
          {participants.map((participant) => (
            <li className="participant-row" key={participant.id}>
              <span className="participant-avatar">
                {getInitials(participant.username)}
              </span>
              <span className="participant-name">
                {participant.username}
                {participant.isYou && <small>You</small>}
              </span>
              <span className="participant-status online">
                <i /> Online
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="participants-empty">
          Waiting for the office connection…
        </p>
      )}
    </section>
  );
}

export default App;
