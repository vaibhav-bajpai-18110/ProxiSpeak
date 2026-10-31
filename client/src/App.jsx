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

const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000/api/health";
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin;

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
    const saved = JSON.parse(
      window.localStorage.getItem(PROFILE_STORAGE_KEY) || "null"
    );

    return normalizeProfile({
      ...DEFAULT_PROFILE,
      ...(saved && typeof saved === "object" ? saved : {}),
      displayName: saved?.displayName || legacyName,
    });
  } catch {
    return normalizeProfile({
      ...DEFAULT_PROFILE,
      displayName: legacyName,
    });
  }
}

function getSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

function getInitials(name = "") {
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function App() {
  const [started, setStarted] = useState(false);
  const [theme, setTheme] = useState(getSavedTheme);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiError, setApiError] = useState("");
  const [profile, setProfile] = useState(getSavedProfile);
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
  const positionRef = useRef(position);

  const username = profile.displayName;

  const audio = useOfficeAudio({
    socket,
    started,
    isConnected: socketStatus === "connected",
    participants,
  });

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const checkBackend = useCallback(async (signal) => {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();

    signal?.addEventListener("abort", abortRequest, { once: true });

    const timeoutId = window.setTimeout(
      abortRequest,
      API_TIMEOUT_MS
    );

    try {
      if (signal?.aborted) return false;

      const response = await fetch(API_URL, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== "OK" || data.project !== "ProxiSpeak") {
        throw new Error("Unexpected backend health response");
      }

      setApiStatus("connected");
      setApiError("");
      return true;
    } catch (error) {
      if (signal?.aborted) return false;

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

  const setLocalParticipant = useCallback((status) => {
    const id = socketRef.current?.id || "you";
    const currentProfile = profileRef.current;

    setParticipants((current) => {
      const existing = current.find(
        (person) => person.isYou || person.id === id
      );

      const local = {
        ...existing,
        id,
        name: currentProfile.displayName,
        status,
        isYou: true,
        position: positionRef.current,
        color: currentProfile.avatarColor,
        availability: currentProfile.availability,
      };

      return [
        ...current.filter(
          (person) => !person.isYou && person.id !== id
        ),
        local,
      ];
    });
  }, []);

  const removeAudioParticipant = audio.removeParticipant;

  useEffect(() => {
    if (!started) return undefined;

    const activeSocket = io(SOCKET_URL, {
      autoConnect: false,
      auth: { username: profileRef.current.displayName },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    socketRef.current = activeSocket;
    setSocket(activeSocket);
    hasConnectedRef.current = false;

    const upsertParticipant = (raw) => {
      const participant = normalizeParticipant(raw, activeSocket.id);

      if (!participant || participant.isYou) return;

      setParticipants((current) => {
        const existing = current.find(
          (person) => person.id === participant.id
        );

        if (existing) {
          return current.map((person) =>
            person.id === participant.id
              ? mergeParticipant(participant, person)
              : person
          );
        }

        return [...current, participant];
      });
    };

    const removeParticipant = (payload) => {
      const id = typeof payload === "string" ? payload : payload?.id;

      if (typeof id !== "string") return;

      removeAudioParticipant(id);

      setParticipants((current) =>
        current.filter((person) => person.id !== id)
      );
    };

    const handleParticipantsSnapshot = (payload) => {
      const list = Array.isArray(payload)
        ? payload
        : payload?.participants;

      if (!Array.isArray(list)) return;

      const normalized = list
        .map((person) => normalizeParticipant(person, activeSocket.id))
        .filter(Boolean);

      setParticipants((current) => {
        const existingById = new Map(
          current.map((person) => [person.id, person])
        );

        const next = normalized.map((person) => {
          const merged = mergeParticipant(
            person,
            existingById.get(person.id)
          );

          if (merged.isYou) {
            return {
              ...merged,
              name: profileRef.current.displayName,
              color: profileRef.current.avatarColor,
              availability: profileRef.current.availability,
              position: positionRef.current,
            };
          }

          return merged;
        });

        if (!next.some((person) => person.isYou)) {
          next.push({
            id: activeSocket.id || "you",
            name: profileRef.current.displayName,
            status: "online",
            isYou: true,
            position: positionRef.current,
            color: profileRef.current.avatarColor,
            availability: profileRef.current.availability,
          });
        }

        return next;
      });
    };

    const handleParticipantJoined = (payload) => {
      const participant = normalizeParticipant(payload, activeSocket.id);

      if (!participant) return;

      if (participant.isYou) {
        setLocalParticipant("online");
        return;
      }

      upsertParticipant(payload);
    };

    const handlePositionUpdate = (payload) => {
      const participant = normalizeParticipant(payload, activeSocket.id);

      if (!participant?.position || participant.isYou) return;

      upsertParticipant(payload);
    };

    const handleConnect = () => {
      hasConnectedRef.current = true;
      setSocketStatus("connected");
      setSocketError("");
      setLocalParticipant("online");

      activeSocket.emit("join", {
        username: profileRef.current.displayName,
      });
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

      setSocketError(error.message || "Unable to connect.");
    };

    const handleOffline = () => {
      setSocketStatus("offline");
      setSocketError("Your device is offline.");
    };

    const handleOnline = () => {
      if (activeSocket.connected) {
        setSocketStatus("connected");
      } else {
        setSocketStatus("reconnecting");
        activeSocket.connect();
      }
    };

    const handleValidationError = (error) => {
      setSocketError(
        error?.message || "The backend rejected an update."
      );
    };

    activeSocket.on("connect", handleConnect);
    activeSocket.on("disconnect", handleDisconnect);
    activeSocket.on("connect_error", handleConnectError);

    activeSocket.on("currentUsers", handleParticipantsSnapshot);
    activeSocket.on("roomParticipants", handleParticipantsSnapshot);
    activeSocket.on("participantsSnapshot", handleParticipantsSnapshot);

    activeSocket.on("userJoined", handleParticipantJoined);
    activeSocket.on("participantJoined", handleParticipantJoined);

    activeSocket.on("userPositionUpdated", handlePositionUpdate);
    activeSocket.on("userMoved", handlePositionUpdate);
    activeSocket.on("positionUpdated", handlePositionUpdate);

    activeSocket.on("userDisconnected", removeParticipant);
    activeSocket.on("userLeft", removeParticipant);
    activeSocket.on("participantLeft", removeParticipant);

    activeSocket.on("error:validation", handleValidationError);

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    if (window.navigator.onLine) {
      activeSocket.connect();
    } else {
      handleOffline();
    }

    return () => {
      activeSocket.off("connect", handleConnect);
      activeSocket.off("disconnect", handleDisconnect);
      activeSocket.off("connect_error", handleConnectError);

      activeSocket.off("currentUsers", handleParticipantsSnapshot);
      activeSocket.off("roomParticipants", handleParticipantsSnapshot);
      activeSocket.off("participantsSnapshot", handleParticipantsSnapshot);

      activeSocket.off("userJoined", handleParticipantJoined);
      activeSocket.off("participantJoined", handleParticipantJoined);

      activeSocket.off("userPositionUpdated", handlePositionUpdate);
      activeSocket.off("userMoved", handlePositionUpdate);
      activeSocket.off("positionUpdated", handlePositionUpdate);

      activeSocket.off("userDisconnected", removeParticipant);
      activeSocket.off("userLeft", removeParticipant);
      activeSocket.off("participantLeft", removeParticipant);

      activeSocket.off("error:validation", handleValidationError);

      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);

      activeSocket.disconnect();

      if (socketRef.current === activeSocket) {
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [started, setLocalParticipant, removeAudioParticipant]);



    useEffect(() => {
    if (!started || socketStatus !== "connected") return;

    setParticipants((current) =>
      current.map((person) =>
        person.isYou ? { ...person, position } : person
      )
    );

    if (!socketRef.current?.connected) return;

    socketRef.current.emit("updatePosition", {
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

    const nextProfile = normalizeProfile({
      ...profile,
      displayName: cleanUsername,
    });

    setProfile(nextProfile);

    try {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);
      window.localStorage.setItem(
        PROFILE_STORAGE_KEY,
        JSON.stringify(nextProfile)
      );
    } catch {
      // Session can continue without local storage.
    }

    setIsJoining(true);
    setApiStatus("loading");
    setApiError("");

    try {
      const ready = await checkBackend();
      if (!ready) return;

      const status = window.navigator.onLine ? "connecting" : "offline";

      setSocketStatus(status);
      setSocketError(
        window.navigator.onLine ? "" : "Your device is offline."
      );

      setLocalParticipant(status);
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
    const normalized = normalizeProfile(nextProfile);

    if (!normalized.displayName) return;

    setProfile(normalized);

    try {
      window.localStorage.setItem(
        USERNAME_STORAGE_KEY,
        normalized.displayName
      );

      window.localStorage.setItem(
        PROFILE_STORAGE_KEY,
        JSON.stringify(normalized)
      );
    } catch {
      // Keep updated profile in current session.
    }

    setParticipants((current) =>
      current.map((person) =>
        person.isYou
          ? {
              ...person,
              name: normalized.displayName,
              color: normalized.avatarColor,
              availability: normalized.availability,
            }
          : person
      )
    );

    if (socketRef.current?.connected) {
      socketRef.current.emit("join", {
        username: normalized.displayName,
      });
    }
  }

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
    <div className="app" data-theme={theme}>
      <header className="navbar">
        <button
          className="brand brand-button"
          onClick={leaveOffice}
          type="button"
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

          <button
            className="theme-toggle"
            type="button"
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);

              try {
                window.localStorage.setItem(THEME_STORAGE_KEY, next);
              } catch {
                // Keep theme for this session.
              }
            }}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-pressed={theme === "light"}
          >
            <span className="theme-toggle-icon">
              {theme === "dark" ? "☼" : "☾"}
            </span>
            <span className="theme-toggle-label">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
          </button>

          <button
            className="profile-settings-button"
            type="button"
            onClick={() => setIsProfileSettingsOpen(true)}
            title="Edit profile settings"
          >
            <span
              className="profile-trigger-avatar"
              style={{ backgroundColor: profile.avatarColor }}
            >
              {username ? getInitials(username) : "⚙"}
            </span>
            <span>Edit profile</span>
          </button>
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          participants={participants}
          username={username}
          avatarColor={profile.avatarColor}
          availability={profile.availability}
          connectionStatus={socketStatus}
          connectionError={socketError}
          audio={audio}
          onPositionChange={updatePosition}
          onRetryConnection={() => socketRef.current?.connect()}
          onLeave={leaveOffice}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiError={apiError}
          isJoining={isJoining}
          username={username}
          onUsernameChange={(displayName) =>
            setProfile((current) => ({ ...current, displayName }))
          }
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
        2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({
  apiStatus,
  apiError,
  isJoining,
  username,
  onUsernameChange,
  onJoin,
  onRetryBackend,
}) {
  return (
    <main className="welcome-page">
      <div className="welcome-orb welcome-orb-one" aria-hidden="true" />
      <div className="welcome-orb welcome-orb-two" aria-hidden="true" />

      <section className="welcome-copy">
        <span className="welcome-badge">
          <i /> YOUR TEAM'S LITTLE CORNER OF THE INTERNET
        </span>

        <h1>
          Work feels better
          <br />
          when we're <span>together.</span>
        </h1>

        <p className="welcome-description">
          Clock in, find your people, and make the workday feel a little less
          like a workday.
        </p>

        <div className="welcome-features">
          <div className="welcome-feature">
            <span className="welcome-feature-icon">✦</span>
            <span>
              <strong>Show up as you</strong>
              <small>Your avatar, your name, your spot.</small>
            </span>
          </div>

          <div className="welcome-feature">
            <span className="welcome-feature-icon">↗</span>
            <span>
              <strong>Find your people</strong>
              <small>See who's around in real time.</small>
            </span>
          </div>

          <div className="welcome-feature">
            <span className="welcome-feature-icon">⌘</span>
            <span>
              <strong>Move at your pace</strong>
              <small>Use your keys or click around the office.</small>
            </span>
          </div>
        </div>

        <div className="welcome-social-proof">
          <span className="welcome-online-dot" />
          A shared space for your team, wherever you are.
        </div>
      </section>

      <section className="join-card" aria-labelledby="join-title">
        <div className="join-card-topline">
          <span className="join-card-spark">✦</span>
          <span>GOOD TO SEE YOU</span>
          <span className="join-card-wave">✷</span>
        </div>

        <h2 id="join-title">Let's get you in.</h2>

        <p className="join-card-description">
          Pick a name and step into the office.
        </p>

        <div className="status-card" aria-label="Workspace connection status">
          <div className="status-row">
            <span>
              <i className={`status-indicator ${apiStatus}`} />
              Workspace connection
            </span>

            <div className="backend-status-actions">
              <strong className={apiStatus} role="status">
                {apiStatus === "loading"
                  ? "Checking..."
                  : apiStatus === "connected"
                    ? "Online"
                    : "Offline"}
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

          {apiStatus === "connected" && (
            <p className="status-caption">
              All good — your workspace is ready.
            </p>
          )}

          {apiStatus === "loading" && (
            <p className="status-caption">
              Waking up your workspace…
            </p>
          )}

          {apiStatus === "disconnected" && (
            <p className="api-error" role="alert">
              {apiError || "We couldn't reach the workspace. Try again."}
            </p>
          )}
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

          <p className="username-hint">
            This is the name your teammates will see.
          </p>

          <button
            className="start-button"
            type="submit"
            disabled={
              isJoining ||
              apiStatus === "loading" ||
              !username.trim()
            }
          >
            {isJoining
              ? "Getting things ready…"
              : apiStatus === "disconnected"
                ? "Try again & join"
                : "Step into the office"}{" "}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        <p className="join-card-footnote">
          No awkward meeting link. Just your team. ✨
        </p>
      </section>
    </main>
  );
}

function VirtualOffice({
  position,
  participants,
  username,
  avatarColor,
  availability,
  connectionStatus,
  connectionError,
  audio,
  onPositionChange,
  onRetryConnection,
  onLeave,
}) {
  const roomRef = useRef(null);

  const moveBy = useCallback(
    (dx, dy) => {
      onPositionChange({
        x: position.x + dx,
        y: position.y + dy,
      });
    },
    [position, onPositionChange]
  );

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

  const remoteParticipants = participants.filter(
    (person) => !person.isYou && person.position
  );

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

      <section className="dashboard-overview" aria-label="Workspace dashboard">
        <article className="dashboard-card">
          <span>Current workspace</span>
          <strong>The Commons</strong>
          <small>Open workspace</small>
        </article>

        <article className="dashboard-card">
          <span>People online</span>
          <strong>
            {participants.filter((person) => person.status === "online").length}
          </strong>
          <small>{participants.length} participant(s) in the office</small>
        </article>

        <article className="dashboard-card">
          <span>Office connection</span>
          <strong className={`dashboard-connection ${connectionStatus}`}>
            {connectionStatus === "connected"
              ? "Live"
              : ["connecting", "reconnecting"].includes(connectionStatus)
                ? "Connecting"
                : "Offline"}
          </strong>
          <small>
            {connectionStatus === "connected"
              ? "Updates are syncing"
              : "Check the status above"}
          </small>
        </article>

        <article className="dashboard-card">
          <span>Your availability</span>
          <strong className={`dashboard-availability ${availability}`}>
            <i />
            {getAvailabilityLabel(availability)}
          </strong>
          <small>Edit from profile settings</small>
        </article>
      </section>

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
            <span className="monitor" />
            <span className="keyboard" />
            <span className="desk-mug" />
          </div>

          <div className="desk desk-two">
            <span className="monitor" />
            <span className="keyboard" />
            <span className="plant-pot" />
          </div>

          <div className="sofa"><span /><span /><i /></div>
          <div className="rug" />

          {remoteParticipants.map((person) => (
            <div
              key={person.id}
              className="my-avatar-wrap"
              style={{
                left: `${person.position.x}%`,
                top: `${person.position.y}%`,
                pointerEvents: "none",
              }}
              title={person.name}
            >
              <span className="avatar-name-tag">{person.name}</span>
              <span className="avatar-shadow" />
              <span
                className="my-avatar"
                style={
                  person.color
                    ? { backgroundColor: person.color }
                    : undefined
                }
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
              <span
                className="avatar-body"
                style={{ backgroundColor: avatarColor }}
              />
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
              <kbd>W</kbd>
              <span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
            </span>
            <span>or arrow keys to move</span>
          </div>

          <div className="control-actions">
            <button
              className={`control-button ${audio.isMuted ? "is-muted" : "audio-join"}`}
              onClick={
                audio.microphoneStatus === "ready"
                  ? audio.toggleMute
                  : audio.requestMicrophone
              }
              disabled={
                audio.microphoneStatus === "requesting" ||
                connectionStatus !== "connected"
              }
              aria-pressed={
                audio.microphoneStatus === "ready"
                  ? audio.isMuted
                  : undefined
              }
              type="button"
            >
              {audio.microphoneStatus === "requesting"
                ? "Requesting mic…"
                : audio.microphoneStatus === "ready"
                  ? audio.isMuted
                    ? "Unmute"
                    : "Mute"
                  : "Join audio"}
            </button>

            {(audio.hasFailedPeer || audio.audioError) && (
              <button
                className="retry-connection"
                onClick={audio.retryAudio}
                type="button"
              >
                Retry audio
              </button>
            )}

            <button
              className="control-button leave-button"
              onClick={onLeave}
              type="button"
            >
              Leave office
            </button>
          </div>
        </div>
      </section>

      <AudioStatusPanel audio={audio} participants={participants} />
      <ParticipantsPanel participants={participants} />

      <p className="office-footnote">
        ✦ You appear in the office as {username}.
      </p>
    </main>
  );
}

function AudioStatusPanel({ audio, participants }) {
  const remoteParticipants = participants.filter(
    (person) => !person.isYou && person.status === "online"
  );

  const peerStates = Object.values(audio.peerStatuses);

  const indicatorStatus =
    audio.connectedPeerCount > 0
      ? "connected"
      : audio.hasFailedPeer
        ? "failed"
        : peerStates.includes("connecting") ||
            audio.microphoneStatus === "requesting"
          ? "connecting"
          : peerStates.includes("disconnected")
            ? "disconnected"
            : audio.microphoneStatus;

  return (
    <section className="audio-status-panel" aria-label="Voice audio status">
      <div className="audio-status-content">
        <div className="audio-status-heading">
          <span className={`audio-status-dot ${indicatorStatus}`} />
          <h2>Voice audio</h2>
          <span className={`audio-status-label ${indicatorStatus}`}>
            {audio.statusLabel}
          </span>
        </div>

        {audio.microphoneError && (
          <p className="audio-error" role="alert">{audio.microphoneError}</p>
        )}

        {audio.audioError && (
          <p className="audio-error" role="alert">{audio.audioError}</p>
        )}

        {remoteParticipants.length > 0 && (
          <ul className="audio-peer-list">
            {remoteParticipants.map((person) => (
              <li key={person.id}>
                <span>{person.name}</span>
                <small>
                  {getPeerAudioStatusLabel(audio.peerStatuses[person.id])}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="remote-audio" aria-hidden="true">
        {Object.entries(audio.remoteStreams).map(([peerId, stream]) => (
          <RemoteAudioPlayer
            key={peerId}
            stream={stream}
            onPlaybackError={audio.reportPlaybackError}
          />
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
        if (event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
      }}
    >
      <form className="profile-form" onSubmit={handleSubmit}>
        <div className="profile-dialog-heading">
          <div>
            <p className="office-kicker">YOUR ACCOUNT</p>
            <h2 id="profile-dialog-title">Profile settings</h2>
          </div>

          <button
            className="profile-close"
            type="button"
            aria-label="Close profile settings"
            onClick={() => dialogRef.current?.close()}
          >
            ×
          </button>
        </div>

        <label className="profile-field">
          <span>Display name</span>
          <input
            autoComplete="nickname"
            autoFocus
            maxLength={24}
            value={draft.displayName}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                displayName: event.target.value,
              }));
              setNameError("");
            }}
            placeholder="Your name in the office"
            required
          />
          {nameError && (
            <small className="profile-field-error" role="alert">
              {nameError}
            </small>
          )}
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
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      avatarColor: color.value,
                    }))
                  }
                />
                <span
                  className="avatar-color-swatch"
                  style={{ backgroundColor: color.value }}
                />
                <small>{color.name}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="profile-field">
          <span>Availability</span>
          <select
            value={draft.availability}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                availability: event.target.value,
              }))
            }
          >
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <p className="profile-storage-note">
          Your profile choices are saved in this browser.
        </p>

        <div className="profile-dialog-actions">
          <button
            className="profile-cancel"
            type="button"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>

          <button className="profile-save" type="submit">
            Save profile
          </button>
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
        <span>{participants.length} participant(s)</span>
      </div>

      {participants.length ? (
        <ul className="participants-list">
          {participants.map((person) => (
            <li className="participant-row" key={person.id}>
              <span
                className="participant-avatar"
                style={
                  person.color
                    ? { background: person.color }
                    : undefined
                }
              >
                {getInitials(person.name)}
              </span>

              <span className="participant-name">
                {person.name}
                {person.isYou && <small>You</small>}
                {person.isYou && person.availability && (
                  <small className={`availability-tag ${person.availability}`}>
                    {getAvailabilityLabel(person.availability)}
                  </small>
                )}
              </span>

              <span className={`participant-status ${person.status}`}>
                <i />
                {person.status === "online"
                  ? "Online"
                  : person.status === "connecting"
                    ? "Connecting"
                    : "Offline"}
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
