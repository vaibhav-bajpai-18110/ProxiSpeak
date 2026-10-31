import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { getPeerAudioStatusLabel } from "./audioUtils.js";
import {
  BACKEND_MAP_SIZE,
  clampPosition,
  isValidPosition,
  mergeParticipant,
  normalizeParticipant,
  normalizeUsername,
} from "./presence.js";
import {
  AVAILABILITY_OPTIONS,
  DEFAULT_PROFILE,
  getAvailabilityLabel,
  normalizeProfile,
  PROFILE_AVATAR_COLORS,
} from "./profileUtils.js";
import { useOfficeAudio } from "./useOfficeAudio.js";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api/health";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin;
const API_TIMEOUT_MS = 8000;
const USERNAME_STORAGE_KEY = "proxispeak.username";
const PROFILE_STORAGE_KEY = "proxispeak.profile";
const THEME_STORAGE_KEY = "proxispeak.theme";
const INITIAL_POSITION = { x: 49, y: 57 };

function getSavedUsername() {
  try {
    return window.localStorage.getItem(USERNAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function getSavedProfile() {
  const legacyName = getSavedUsername();
  try {
    const savedProfile = JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    return normalizeProfile({
      ...DEFAULT_PROFILE,
      ...(savedProfile && typeof savedProfile === "object" ? savedProfile : {}),
      displayName: savedProfile?.displayName || legacyName,
    });
  } catch {
    return normalizeProfile({ ...DEFAULT_PROFILE, displayName: legacyName });
  }
}

function getSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
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
  const [theme, setTheme] = useState(getSavedTheme);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiError, setApiError] = useState("");
  const [profile, setProfile] = useState(getSavedProfile);
  const username = profile.displayName;
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [socketStatus, setSocketStatus] = useState("idle");
  const [socketError, setSocketError] = useState("");
  const [participants, setParticipants] = useState([]);
  const [socket, setSocket] = useState(null);
  const socketRef = useRef(null);
  const hasConnectedRef = useRef(false);
  const profileRef = useRef(profile);
  const audio = useOfficeAudio({
    socket,
    started,
    isConnected: socketStatus === "connected",
    participants,
  });
  const removeAudioParticipant = audio.removeParticipant;

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

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

      setApiStatus("connected");
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setApiStatus("disconnected");
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
    const localProfile = profileRef.current;
    setParticipants((current) => {
      const existing = current.find((participant) => participant.id === id || participant.isYou);
      const localParticipant = {
        ...existing,
        id,
        name: localProfile.displayName,
        status,
        isYou: true,
        position: existing?.position || null,
        color: localProfile.avatarColor,
        availability: localProfile.availability,
      };
      return [
        ...current.filter((participant) => participant.id !== id && !participant.isYou),
        localParticipant,
      ];
    });
  }, []);

  useEffect(() => {
    if (!started) return undefined;

    const socket = io(SOCKET_URL, {
      autoConnect: false,
      auth: { username: profileRef.current.displayName },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;
    setSocket(socket);
    hasConnectedRef.current = false;

    const handleConnect = () => {
      hasConnectedRef.current = true;
      setSocketStatus("connected");
      setSocketError("");
      setLocalParticipant("online");
      socket.emit("join", { username: profileRef.current.displayName });
    };
    const handleParticipantsSnapshot = (payload) => {
      const nextParticipants = Array.isArray(payload) ? payload : payload?.participants;
      if (!Array.isArray(nextParticipants)) return;
      const normalized = nextParticipants
        .map((participant) => normalizeParticipant(participant, socket.id))
        .filter(Boolean)
        .map((participant) => participant.isYou ? {
          ...participant,
          name: profileRef.current.displayName,
          color: profileRef.current.avatarColor,
          availability: profileRef.current.availability,
        } : participant);
      setParticipants((current) => {
        const existingById = new Map(current.map((participant) => [participant.id, participant]));
        return normalized.map((participant) => mergeParticipant(participant, existingById.get(participant.id)));
      });
    };
    const handleParticipantJoined = (participant) => {
      const normalized = normalizeParticipant(participant, socket.id);
      if (!normalized) return;
      const localProfile = profileRef.current;
      const nextParticipant = normalized.isYou
        ? { ...normalized, name: localProfile.displayName, color: localProfile.avatarColor, availability: localProfile.availability }
        : normalized;
      setParticipants((current) => {
        const existing = current.find((person) => person.id === nextParticipant.id);
        return [
          ...current.filter((person) => person.id !== nextParticipant.id),
          mergeParticipant(nextParticipant, existing),
        ];
      });
    };
    const handleParticipantLeft = (participant) => {
      if (typeof participant?.id !== "string") return;
      removeAudioParticipant(participant.id);
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
      if (socketRef.current === socket) {
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [started, setLocalParticipant, removeAudioParticipant]);

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
    const cleanUsername = normalizeUsername(profile.displayName).slice(0, 24);
    if (!cleanUsername || isJoining) return;
    const nextProfile = normalizeProfile({ ...profile, displayName: cleanUsername });
    setProfile(nextProfile);
    try {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(nextProfile));
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
    audio.leaveAudio();
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

  function saveProfile(nextProfile) {
    const normalizedProfile = normalizeProfile(nextProfile);
    if (!normalizedProfile.displayName) return;
    setProfile(normalizedProfile);
    try {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, normalizedProfile.displayName);
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalizedProfile));
    } catch {
      // Keep the updated profile for this session if browser storage is unavailable.
    }
    setParticipants((current) => current.map((participant) => participant.isYou
      ? {
        ...participant,
        name: normalizedProfile.displayName,
        color: normalizedProfile.avatarColor,
        availability: normalizedProfile.availability,
      }
      : participant));
    if (socketRef.current?.connected) {
      socketRef.current.emit("join", { username: normalizedProfile.displayName });
    }
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
    <div className="app" data-theme={theme}>
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
          <button
            className="theme-toggle"
            type="button"
            onClick={() => {
              const nextTheme = theme === "dark" ? "light" : "dark";
              setTheme(nextTheme);
              try {
                window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
              } catch {
                // Keep the selected theme for this session if storage is unavailable.
              }
            }}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-pressed={theme === "light"}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            <span className="theme-toggle-icon" aria-hidden="true">{theme === "dark" ? "☼" : "☾"}</span>
            <span className="theme-toggle-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button
            className="profile-settings-button"
            type="button"
            onClick={() => setIsProfileSettingsOpen(true)}
            title="Edit profile settings"
            aria-label={`Edit profile settings${username ? ` for ${username}` : ""}`}
          >
            <span className="profile-trigger-avatar" style={{ backgroundColor: profile.avatarColor }}>
              {username ? getInitials(username) : "⚙"}
            </span>
            <span>Edit profile</span>
          </button>
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          onPositionChange={updatePosition}
          username={username}
          avatarColor={profile.avatarColor}
          availability={profile.availability}
          connectionStatus={socketStatus}
          connectionError={socketError}
          participants={participants}
          audio={audio}
          onRetryConnection={() => socketRef.current?.connect()}
          onLeave={leaveOffice}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiError={apiError}
          isJoining={isJoining}
          username={username}
          onUsernameChange={(displayName) => setProfile((current) => ({ ...current, displayName }))}
          onJoin={enterOffice}
          onRetryBackend={retryBackend}
        />
      )}

      {isProfileSettingsOpen && (
        <ProfileSettingsDialog
          profile={profile}
          onClose={() => setIsProfileSettingsOpen(false)}
          onSave={saveProfile}
        />
      )}

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({ apiStatus, apiError, isJoining, username, onUsernameChange, onJoin, onRetryBackend }) {
  return (
    <main className="welcome-page">
      <div className="welcome-orb welcome-orb-one" aria-hidden="true" />
      <div className="welcome-orb welcome-orb-two" aria-hidden="true" />

      <section className="welcome-copy">
        <span className="welcome-badge"><i /> YOUR TEAM'S LITTLE CORNER OF THE INTERNET</span>
        <h1>Work feels better<br />when we're <span>together.</span></h1>
        <p className="welcome-description">
          Clock in, find your people, and make the workday feel a little less like a workday.
        </p>
        <div className="welcome-features">
          <div className="welcome-feature">
            <span className="welcome-feature-icon">✦</span>
            <span><strong>Show up as you</strong><small>Your avatar, your name, your spot.</small></span>
          </div>
          <div className="welcome-feature">
            <span className="welcome-feature-icon">↗</span>
            <span><strong>Find your people</strong><small>See who's around in real time.</small></span>
          </div>
          <div className="welcome-feature">
            <span className="welcome-feature-icon">⌘</span>
            <span><strong>Move at your pace</strong><small>Use your keys or click around the office.</small></span>
          </div>
        </div>
        <div className="welcome-social-proof"><span className="welcome-online-dot" /> A shared space for your team, wherever you are.</div>
      </section>

      <section className="join-card" aria-labelledby="join-title">
        <div className="join-card-topline">
          <span className="join-card-spark" aria-hidden="true">✦</span>
          <span>GOOD TO SEE YOU</span>
          <span className="join-card-wave" aria-hidden="true">✷</span>
        </div>
        <h2 id="join-title">Let's get you in.</h2>
        <p className="join-card-description">Pick a name and step into the office.</p>

        <div className="status-card" aria-label="Workspace connection status">
          <div className="status-row">
            <span><i className={`status-indicator ${apiStatus}`} />Workspace connection</span>
            <div className="backend-status-actions">
              <strong className={apiStatus} role="status" aria-live="polite">{apiStatus === "loading" ? "Checking..." : apiStatus === "connected" ? "Online" : "Offline"}</strong>
              {apiStatus === "disconnected" && <button className="api-retry" onClick={onRetryBackend} type="button">Retry</button>}
            </div>
          </div>
          {apiStatus === "connected" && <p className="status-caption">All good — your workspace is ready.</p>}
          {apiStatus === "loading" && <p className="status-caption">Waking up your workspace…</p>}
          {apiStatus === "disconnected" && <p className="api-error" role="alert">{apiError || "We couldn't reach the workspace. Try again in a moment."}</p>}
        </div>

        <form className="join-form" onSubmit={onJoin}>
          <label className="username-field">
            <span>What should we call you?</span>
            <input
              autoComplete="nickname"
              maxLength={24}
              name="username"
              onChange={(event) => onUsernameChange(event.target.value)}
              pattern=".*\S.*"
              placeholder="Your name here"
              required
              title="Enter at least one non-space character."
              value={username}
            />
          </label>
          <p className="username-hint">This is the name your teammates will see.</p>
          <button className="start-button" type="submit" disabled={isJoining || apiStatus === "loading" || !username.trim()}>
            {isJoining ? "Getting things ready…" : apiStatus === "disconnected" ? "Try again & join" : "Step into the office"} <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="join-card-footnote">No awkward meeting link. Just your team. ✨</p>
      </section>
    </main>
  );
}

export function VirtualOffice({ position, onPositionChange, username, avatarColor, availability, connectionStatus, connectionError, participants, audio, onRetryConnection, onLeave }) {
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

      <section className="dashboard-overview" aria-label="Workspace dashboard">
        <article className="dashboard-card">
          <span>Current workspace</span>
          <strong>The Commons</strong>
          <small>Open workspace</small>
        </article>
        <article className="dashboard-card">
          <span>People online</span>
          <strong>{participants.filter((participant) => participant.status === "online").length}</strong>
          <small>{participants.length} participant{participants.length === 1 ? "" : "s"} in the office</small>
        </article>
        <article className="dashboard-card">
          <span>Office connection</span>
          <strong className={`dashboard-connection ${connectionStatus}`}>{connectionStatus === "connected" ? "Live" : connectionStatus === "connecting" || connectionStatus === "reconnecting" ? "Connecting" : "Offline"}</strong>
          <small>{connectionStatus === "connected" ? "Updates are syncing" : "Check the status above"}</small>
        </article>
        <article className="dashboard-card">
          <span>Your availability</span>
          <strong className={`dashboard-availability ${availability}`}><i />{getAvailabilityLabel(availability)}</strong>
          <small>Edit from profile settings</small>
        </article>
      </section>

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
            <span className="my-avatar"><span className="avatar-hair" /><span className="avatar-face"><i /><i /></span><span className="avatar-body" style={{ background: `linear-gradient(135deg, ${avatarColor}, ${avatarColor})` }} /></span>
            <span className="avatar-position">{Math.round(position.x)}, {Math.round(position.y)}</span>
          </div>
          <span className="scene-hint">Click anywhere to move</span>
        </div>

        <div className="office-controls">
          <div className="movement-help"><span className="key-cluster"><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span><span>or arrow keys to move</span></div>
          <div className="control-actions">
            <button
              className={`control-button ${audio.isMuted ? "is-muted" : "audio-join"}`}
              onClick={audio.microphoneStatus === "ready" ? audio.toggleMute : audio.requestMicrophone}
              disabled={audio.microphoneStatus === "requesting" || connectionStatus !== "connected"}
              aria-pressed={audio.microphoneStatus === "ready" ? audio.isMuted : undefined}
              aria-label={audio.microphoneStatus === "ready" ? `${audio.isMuted ? "Unmute" : "Mute"} microphone` : "Join audio and enable microphone"}
            >
              <span>{audio.microphoneStatus === "requesting" ? "…" : audio.isMuted ? "◌" : "◖"}</span>
              {audio.microphoneStatus === "requesting" ? "Requesting mic…" : audio.microphoneStatus === "ready" ? (audio.isMuted ? "Unmute" : "Mute") : audio.microphoneStatus === "denied" || audio.microphoneStatus === "unavailable" ? "Try audio" : "Join audio"}
            </button>
            {(audio.hasFailedPeer || audio.audioError) && <button className="retry-connection" onClick={audio.retryAudio} type="button">Retry audio</button>}
            <button className="control-button leave-button" onClick={onLeave}><span>↗</span> Leave office</button>
          </div>
        </div>
      </section>
      <AudioStatusPanel audio={audio} participants={participants} />
      <ParticipantsPanel participants={participants} />
      <p className="office-footnote"><span>✦</span> You appear in the office as {username}.</p>
    </main>
  );
}

function AudioStatusPanel({ audio, participants }) {
  const remoteParticipants = participants.filter((participant) => !participant.isYou && participant.status === "online");
  const peerStates = Object.values(audio.peerStatuses);
  const indicatorStatus = audio.connectedPeerCount > 0
    ? "connected"
    : audio.hasFailedPeer
      ? "failed"
      : peerStates.includes("connecting") || audio.microphoneStatus === "requesting"
        ? "connecting"
        : peerStates.includes("disconnected")
          ? "disconnected"
          : audio.microphoneStatus;

  return (
    <section className="audio-status-panel" aria-label="Voice audio status">
      <div className="audio-status-content">
        <div className="audio-status-heading">
          <span className={`audio-status-dot ${indicatorStatus}`} aria-hidden="true" />
          <h2>Voice audio</h2>
          <span className={`audio-status-label ${indicatorStatus}`} role="status" aria-live="polite">{audio.statusLabel}</span>
        </div>
        {audio.microphoneError && <p className="audio-error" role="alert">{audio.microphoneError}</p>}
        {audio.audioError && <p className="audio-error" role="alert">{audio.audioError}</p>}
        {remoteParticipants.length > 0 && (
          <ul className="audio-peer-list" aria-label="Audio connection status by participant">
            {remoteParticipants.map((participant) => (
              <li key={participant.id}>
                <span>{participant.name}</span>
                <small>{getPeerAudioStatusLabel(audio.peerStatuses[participant.id])}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="remote-audio" aria-hidden="true">
        {Object.entries(audio.remoteStreams).map(([peerId, stream]) => (
          <RemoteAudioPlayer key={peerId} stream={stream} onPlaybackError={audio.reportPlaybackError} />
        ))}
      </div>
    </section>
  );
}

function RemoteAudioPlayer({ stream, onPlaybackError }) {
  const audioRef = useRef(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return undefined;
    element.srcObject = stream;
    void element.play().catch(onPlaybackError);
    return () => {
      element.pause();
      element.srcObject = null;
    };
  }, [stream, onPlaybackError]);

  return <audio ref={audioRef} autoPlay playsInline />;
}

function ProfileSettingsDialog({ profile, onSave, onClose }) {
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState(profile);
  const [nameError, setNameError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    const nextProfile = normalizeProfile(draft);
    if (!nextProfile.displayName) {
      setNameError("Enter a display name to save your profile.");
      return;
    }
    onSave(nextProfile);
    dialogRef.current?.close();
  }

  return (
    <dialog
      className="profile-dialog"
      ref={dialogRef}
      aria-labelledby="profile-dialog-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <form className="profile-form" onSubmit={handleSubmit}>
        <div className="profile-dialog-heading">
          <div>
            <p className="office-kicker">YOUR ACCOUNT</p>
            <h2 id="profile-dialog-title">Profile settings</h2>
          </div>
          <button className="profile-close" type="button" aria-label="Close profile settings" onClick={() => dialogRef.current?.close()}>×</button>
        </div>

        <label className="profile-field">
          <span>Display name</span>
          <input
            autoComplete="nickname"
            autoFocus
            maxLength={24}
            value={draft.displayName}
            onChange={(event) => {
              setDraft((current) => ({ ...current, displayName: event.target.value }));
              setNameError("");
            }}
            placeholder="Your name in the office"
            required
          />
          {nameError && <small className="profile-field-error" role="alert">{nameError}</small>}
        </label>

        <fieldset className="profile-field avatar-color-field">
          <legend>Avatar color</legend>
          <div className="avatar-color-options">
            {PROFILE_AVATAR_COLORS.map((color) => (
              <label className="avatar-color-choice" key={color.value}>
                <input
                  type="radio"
                  name="avatarColor"
                  value={color.value}
                  checked={draft.avatarColor === color.value}
                  onChange={() => setDraft((current) => ({ ...current, avatarColor: color.value }))}
                />
                <span className="avatar-color-swatch" style={{ backgroundColor: color.value }} aria-hidden="true" />
                <small>{color.name}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="profile-field">
          <span>Availability</span>
          <select
            value={draft.availability}
            onChange={(event) => setDraft((current) => ({ ...current, availability: event.target.value }))}
          >
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <p className="profile-storage-note">Your profile choices are saved in this browser.</p>
        <div className="profile-dialog-actions">
          <button className="profile-cancel" type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="profile-save" type="submit">Save profile</button>
        </div>
      </form>
    </dialog>
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
              <span className="participant-avatar" style={participant.color ? { background: participant.color } : undefined}>{getInitials(participant.name)}</span>
              <span className="participant-name">
                {participant.name}
                {participant.isYou && <small>You</small>}
                {participant.isYou && participant.availability && <small className={`availability-tag ${participant.availability}`}>{getAvailabilityLabel(participant.availability)}</small>}
              </span>
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
