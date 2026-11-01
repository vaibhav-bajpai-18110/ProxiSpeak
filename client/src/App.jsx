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
const PALETTE_STORAGE_KEY = "proxispeak.palette";
const ROOM_STORAGE_KEY = "proxispeak.room";
const INITIAL_POSITION = { x: 49, y: 57 };
const APPEARANCE_PALETTES = [
  { id: "ocean", name: "Ocean Calm", color: "#72b7d0" },
  { id: "lavender", name: "Lavender Glow", color: "#a78bfa" },
  { id: "sage", name: "Sage Garden", color: "#74b99a" },
  { id: "warm", name: "Warm Sand", color: "#d69a67" },
];
const ROOMS = [
  { id: "main-office", name: "Main Office", icon: "✦", description: "The shared floor for daily work and team catch-ups." },
  { id: "meeting-room", name: "Meeting Room", icon: "▦", description: "A dedicated spot for focused conversations." },
  { id: "focus-room", name: "Focus Room", icon: "◌", description: "A quieter space for uninterrupted work." },
];
const AVATAR_STYLES = [
  { id: "person", name: "Classic", icon: "" },
  { id: "robot", name: "Robot", icon: "🤖" },
  { id: "fox", name: "Fox", icon: "🦊" },
  { id: "sprout", name: "Sprout", icon: "🌱" },
  { id: "star", name: "Star", icon: "✦" },
  { id: "cat", name: "Cat", icon: "🐱" },
  { id: "astronaut", name: "Astronaut", icon: "🧑‍🚀" },
  { id: "alien", name: "Alien", icon: "👽" },
  { id: "ghost", name: "Ghost", icon: "👻" },
];
const AVAILABILITY_HINTS = {
  available: "Open to quick chats",
  away: "Stepping away",
  busy: "Heads-down for now",
  dnd: "Keep things quiet",
};
const ROOM_START_POSITIONS = {
  "main-office": INITIAL_POSITION,
  "meeting-room": { x: 50, y: 76 },
  "focus-room": { x: 50, y: 72 },
};

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
    return normalizeWorkspaceProfile({
      ...DEFAULT_PROFILE,
      ...(savedProfile && typeof savedProfile === "object" ? savedProfile : {}),
      displayName: savedProfile?.displayName || legacyName,
    });
  } catch {
    return normalizeWorkspaceProfile({ ...DEFAULT_PROFILE, displayName: legacyName });
  }
}

function getSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function getSavedPalette() {
  try {
    const savedPalette = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    return APPEARANCE_PALETTES.some((palette) => palette.id === savedPalette) ? savedPalette : "ocean";
  } catch {
    return "ocean";
  }
}

function getSavedRoomId() {
  try {
    const savedRoomId = window.localStorage.getItem(ROOM_STORAGE_KEY);
    return ROOMS.some((room) => room.id === savedRoomId) ? savedRoomId : ROOMS[0].id;
  } catch {
    return ROOMS[0].id;
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

function normalizeWorkspaceProfile(profile = {}) {
  const normalized = normalizeProfile(profile);
  const avatarStyle = AVATAR_STYLES.some((style) => style.id === profile.avatarStyle)
    ? profile.avatarStyle
    : AVATAR_STYLES[0].id;
  return { ...normalized, avatarStyle };
}

function normalizeOfficeParticipant(participant, ownSocketId) {
  const normalized = normalizeParticipant(participant, ownSocketId);
  if (!normalized) return null;
  const availability = AVAILABILITY_OPTIONS.some((option) => option.value === participant.availability)
    ? participant.availability
    : undefined;
  const avatarStyle = AVATAR_STYLES.some((style) => style.id === participant.avatarStyle)
    ? participant.avatarStyle
    : undefined;
  return {
    ...normalized,
    roomId: typeof participant.roomId === "string" && participant.roomId.trim()
      ? participant.roomId
      : ROOMS[0].id,
    ...(availability ? { availability } : {}),
    ...(avatarStyle ? { avatarStyle } : {}),
  };
}

function getAvatarStyle(styleId) {
  return AVATAR_STYLES.find((style) => style.id === styleId) || AVATAR_STYLES[0];
}

function getRoomName(roomId) {
  return ROOMS.find((room) => room.id === roomId)?.name || "Room not shared";
}

function App() {
  const [started, setStarted] = useState(false);
  const [theme, setTheme] = useState(getSavedTheme);
  const [palette, setPalette] = useState(getSavedPalette);
  const [roomId, setRoomId] = useState(getSavedRoomId);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiError, setApiError] = useState("");
  const [profile, setProfile] = useState(getSavedProfile);
  const username = profile.displayName;
  const currentRoom = ROOMS.find((room) => room.id === roomId) || ROOMS[0];
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [socketStatus, setSocketStatus] = useState("idle");
  const [socketError, setSocketError] = useState("");
  const [participants, setParticipants] = useState([]);
  const [socket, setSocket] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const socketRef = useRef(null);
  const hasConnectedRef = useRef(false);
  const profileRef = useRef(profile);
  const roomIdRef = useRef(roomId);
  const positionRef = useRef(position);
  const audio = useOfficeAudio({
    socket,
    started,
    isConnected: socketStatus === "connected",
    participants,
    localPosition: position,
    roomId,
  });
  const removeAudioParticipant = audio.removeParticipant;

  useEffect(() => {
    profileRef.current = profile;
    setParticipants((current) => current.map((participant) => participant.isYou
      ? {
        ...participant,
        name: profile.displayName,
        color: profile.avatarColor,
        availability: profile.availability,
        avatarStyle: profile.avatarStyle,
      }
      : participant));
  }, [profile]);

  useEffect(() => {
    roomIdRef.current = roomId;
    setParticipants((current) => current.map((participant) => participant.isYou
      ? { ...participant, roomId }
      : participant));
  }, [roomId]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

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
        position: positionRef.current,
        roomId: roomIdRef.current,
        color: localProfile.avatarColor,
        availability: localProfile.availability,
        avatarStyle: localProfile.avatarStyle,
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
      socket.emit("joinRoom", {
        roomId: roomIdRef.current,
        username: profileRef.current.displayName,
      });
      refreshRoomRosters();
    };
    const handleFullParticipantsSnapshot = (payload) => {
      const nextParticipants = Array.isArray(payload) ? payload : payload?.participants;
      if (!Array.isArray(nextParticipants)) return;
      const normalized = nextParticipants
        .map((participant) => normalizeOfficeParticipant(participant, socket.id))
        .filter(Boolean)
        .map((participant) => participant.isYou ? {
          ...participant,
          name: profileRef.current.displayName,
          color: profileRef.current.avatarColor,
          availability: profileRef.current.availability,
          avatarStyle: profileRef.current.avatarStyle,
        } : participant);
      setParticipants((current) => {
        const existingById = new Map(current.map((participant) => [participant.id, participant]));
        return normalized.map((participant) => mergeParticipant(participant, existingById.get(participant.id)));
      });
    };
    const handleRoomParticipantsSnapshot = (payload) => {
      const nextParticipants = Array.isArray(payload) ? payload : payload?.participants;
      if (!Array.isArray(nextParticipants)) return;
      const snapshotRoomId = typeof payload?.roomId === "string" ? payload.roomId : roomIdRef.current;
      const normalized = nextParticipants
        .map((participant) => normalizeOfficeParticipant({ ...participant, roomId: participant.roomId || snapshotRoomId }, socket.id))
        .filter(Boolean)
        .map((participant) => participant.isYou ? {
          ...participant,
          name: profileRef.current.displayName,
          color: profileRef.current.avatarColor,
          availability: profileRef.current.availability,
          avatarStyle: profileRef.current.avatarStyle,
        } : participant);
      setParticipants((current) => {
        const existingById = new Map(current.map((participant) => [participant.id, participant]));
        const roomRoster = normalized.map((participant) => mergeParticipant(participant, existingById.get(participant.id)));
        const roomRosterIds = new Set(roomRoster.map((participant) => participant.id));
        const otherRooms = current.filter((participant) => participant.roomId !== snapshotRoomId && !roomRosterIds.has(participant.id));
        return [...otherRooms, ...roomRoster];
      });
    };
    function refreshRoomRosters() {
      for (const room of ROOMS) {
        socket.emit("getParticipants", { roomId: room.id }, handleRoomParticipantsSnapshot);
      }
    }
    const handleParticipantJoined = (participant) => {
      const normalized = normalizeOfficeParticipant(participant, socket.id);
      if (!normalized) return;
      const localProfile = profileRef.current;
      const nextParticipant = normalized.isYou
        ? { ...normalized, name: localProfile.displayName, color: localProfile.avatarColor, availability: localProfile.availability, avatarStyle: localProfile.avatarStyle }
        : normalized;
      setParticipants((current) => {
        const existing = current.find((person) => person.id === nextParticipant.id);
        return [
          ...current.filter((person) => person.id !== nextParticipant.id),
          mergeParticipant(nextParticipant, existing),
        ];
      });
      refreshRoomRosters();
    };
    const handleParticipantLeft = (participant) => {
      if (typeof participant?.id !== "string") return;
      removeAudioParticipant(participant.id);
      if (participant.reason) {
        setParticipants((current) => current.filter((person) => person.id !== participant.id));
        refreshRoomRosters();
        return;
      }
      setParticipants((current) => current.map((person) => person.id === participant.id
        ? { ...person, roomId: null, position: null }
        : person));
      refreshRoomRosters();
    };
    const handleParticipantDisconnected = (participant) => {
      if (typeof participant?.id !== "string") return;
      removeAudioParticipant(participant.id);
      setParticipants((current) => current.filter((person) => person.id !== participant.id));
      refreshRoomRosters();
    };
    const handlePositionUpdate = (update) => {
      const normalized = normalizeOfficeParticipant(update, socket.id);
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
    socket.on("roomParticipants", handleRoomParticipantsSnapshot);
    socket.on("currentUsers", handleFullParticipantsSnapshot);
    socket.on("participants:update", handleFullParticipantsSnapshot);
    socket.on("participantJoined", handleParticipantJoined);
    socket.on("userJoined", handleParticipantJoined);
    socket.on("participantLeft", handleParticipantLeft);
    socket.on("userDisconnected", handleParticipantDisconnected);
    socket.on("userLeft", handleParticipantDisconnected);
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
      socket.off("roomParticipants", handleRoomParticipantsSnapshot);
      socket.off("currentUsers", handleFullParticipantsSnapshot);
      socket.off("participants:update", handleFullParticipantsSnapshot);
      socket.off("participantJoined", handleParticipantJoined);
      socket.off("userJoined", handleParticipantJoined);
      socket.off("participantLeft", handleParticipantLeft);
      socket.off("userDisconnected", handleParticipantDisconnected);
      socket.off("userLeft", handleParticipantDisconnected);
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
    setParticipants((current) => current.map((participant) => participant.isYou
      ? { ...participant, position, roomId }
      : participant));
    socket.emit("updatePosition", {
      x: Math.round(position.x * (BACKEND_MAP_SIZE / 100)),
      y: Math.round(position.y * (BACKEND_MAP_SIZE / 100)),
      roomId,
    });
  }, [position, roomId, socketStatus, started]);

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

  async function enterOffice(event) {
    event.preventDefault();
    const cleanUsername = normalizeUsername(profile.displayName).slice(0, 24);
    if (!cleanUsername || isJoining) return;
    const nextProfile = normalizeWorkspaceProfile({ ...profile, displayName: cleanUsername });
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
      setPosition(ROOM_START_POSITIONS[roomId] || INITIAL_POSITION);
      setStarted(true);
    } finally {
      setIsJoining(false);
    }
  }

  function leaveOffice() {
    audio.leaveAudio();
    setIsSidebarOpen(false);
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

  function setAppearance(nextTheme) {
    if (nextTheme !== "light" && nextTheme !== "dark") return;
    setTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Keep the selected theme for this session if storage is unavailable.
    }
  }

  function selectPalette(nextPalette) {
    if (!APPEARANCE_PALETTES.some((option) => option.id === nextPalette)) return;
    setPalette(nextPalette);
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, nextPalette);
    } catch {
      // Keep the selected palette for this session if storage is unavailable.
    }
  }

  function focusDashboard() {
    const targetId = started ? "workspace-dashboard" : "workspace-lobby-status";
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setIsSidebarOpen(false);
  }

  function selectRoom(nextRoomId) {
    if (!ROOMS.some((room) => room.id === nextRoomId)) return;
    if (nextRoomId !== roomId) setPosition(ROOM_START_POSITIONS[nextRoomId] || INITIAL_POSITION);
    roomIdRef.current = nextRoomId;
    setRoomId(nextRoomId);
    try {
      window.localStorage.setItem(ROOM_STORAGE_KEY, nextRoomId);
    } catch {
      // Keep the selected room for this session if storage is unavailable.
    }
    if (started && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", {
        roomId: nextRoomId,
        username: profileRef.current.displayName,
      });
    }
    setIsSidebarOpen(false);
  }

  function saveProfile(nextProfile) {
    const normalizedProfile = normalizeWorkspaceProfile(nextProfile);
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
        avatarStyle: normalizedProfile.avatarStyle,
      }
      : participant));
    if (socketRef.current?.connected) {
      socketRef.current.emit("join", { username: normalizedProfile.displayName });
    }
  }

  function findParticipant(participant) {
    if (!participant?.roomId || participant.isYou) return;
    selectRoom(participant.roomId);
    if (participant.position) {
      setPosition(clampPosition({
        x: participant.position.x < 18 ? participant.position.x + 9 : participant.position.x - 9,
        y: participant.position.y,
      }));
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
    <div className="app" data-theme={theme} data-palette={palette}>
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
            <span className="room-label"><span className="room-label-dot" /> {currentRoom.name.toUpperCase()}</span>
          )}
          <span className={`nav-status ${connectionStatus}`} role="status" aria-live="polite">
            <span className={`status-dot ${connectionStatus}`} />
            {connectionLabel}
          </span>
          {started && (
            <button
              className="sidebar-toggle"
              type="button"
              onClick={() => setIsSidebarOpen((open) => !open)}
              aria-expanded={isSidebarOpen}
              aria-controls="workspace-sidebar"
              aria-label={isSidebarOpen ? "Close navigation menu" : "Open navigation menu"}
            >
              <span aria-hidden="true">{isSidebarOpen ? "×" : "☰"}</span>
              <span className="sidebar-toggle-label">Menu</span>
            </button>
          )}
        </div>
      </header>

      <div className={`workspace-layout ${started ? "" : "lobby-layout"}`}>
        {started && (
          <WorkspaceSidebar
            id="workspace-sidebar"
            isOpen={isSidebarOpen}
            profile={profile}
            apiStatus={apiStatus}
            connectionStatus={connectionStatus}
            theme={theme}
            palette={palette}
            onDashboard={focusDashboard}
            onOpenProfile={() => {
              setIsProfileSettingsOpen(true);
              setIsSidebarOpen(false);
            }}
            onSetAppearance={setAppearance}
            onSetPalette={selectPalette}
          />
        )}
        {started && isSidebarOpen && <button className="sidebar-backdrop" type="button" onClick={() => setIsSidebarOpen(false)} aria-label="Close navigation menu" />}
        <div className="workspace-content">
          {started ? (
            <VirtualOffice
              position={position}
              onPositionChange={updatePosition}
              username={username}
              avatarColor={profile.avatarColor}
              avatarStyle={profile.avatarStyle}
              connectionStatus={socketStatus}
              connectionError={socketError}
              backendStatus={apiStatus}
              backendError={apiError}
              currentRoom={currentRoom}
              rooms={ROOMS}
              onSelectRoom={selectRoom}
              participants={participants}
              audio={audio}
              onFindParticipant={findParticipant}
              onRetryBackend={retryBackend}
              onRetryConnection={() => socketRef.current?.connect()}
              onLeave={leaveOffice}
            />
          ) : (
            <Home
              apiStatus={apiStatus}
              apiError={apiError}
              isJoining={isJoining}
              username={username}
              currentRoom={currentRoom}
              onUsernameChange={(displayName) => setProfile((current) => ({ ...current, displayName }))}
              onJoin={enterOffice}
              onRetryBackend={retryBackend}
            />
          )}
        </div>
      </div>

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

function Home({ apiStatus, apiError, isJoining, username, currentRoom, onUsernameChange, onJoin, onRetryBackend }) {
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

        <div className="status-card" id="workspace-lobby-status" aria-label="Workspace connection status">
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
            {isJoining ? "Getting things ready…" : apiStatus === "disconnected" ? "Retry & join" : `Join ${currentRoom.name}`} <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="join-card-footnote">No awkward meeting link. Just your team. ✨</p>
      </section>
    </main>
  );
}

function WorkspaceSidebar({ id, isOpen, profile, apiStatus, connectionStatus, theme, palette, onDashboard, onOpenProfile, onSetAppearance, onSetPalette }) {
  const statusLabel = (status) => status === "connected" ? "Connected" : status === "loading" || status === "connecting" || status === "reconnecting" ? "Connecting" : "Offline";

  return (
    <aside id={id} className={`workspace-sidebar ${isOpen ? "open" : ""}`} aria-label="Workspace navigation">
      <div className="sidebar-workspace-card">
        <span className="sidebar-workspace-icon" aria-hidden="true">✦</span>
        <span><strong>Your workspace</strong><small>Dashboard and settings</small></span>
      </div>

      <nav className="sidebar-nav" aria-label="Main menu">
        <button className="sidebar-dashboard-link active" type="button" onClick={onDashboard}>
          <span className="sidebar-link-icon" aria-hidden="true">⌂</span>
          <span className="sidebar-link-copy"><strong>Dashboard</strong><small>Workspace overview</small></span>
        </button>
      </nav>

      <div className="sidebar-section-heading sidebar-status-heading"><span>Connection</span></div>
      <div className="sidebar-status-list">
        <div className="sidebar-status-row"><span>Backend API</span><strong className={apiStatus}><i />{statusLabel(apiStatus)}</strong></div>
        <div className="sidebar-status-row"><span>Live office</span><strong className={connectionStatus}><i />{statusLabel(connectionStatus)}</strong></div>
      </div>

      <div className="sidebar-utility-actions">
        <button className="sidebar-profile-link" type="button" onClick={onOpenProfile} aria-label={`Edit profile${profile.displayName ? ` for ${profile.displayName}` : ""}`}>
          <span className={`sidebar-profile-avatar avatar-style-${profile.avatarStyle}`} style={{ backgroundColor: profile.avatarColor }}>
            {getAvatarStyle(profile.avatarStyle).icon || (profile.displayName ? getInitials(profile.displayName) : "⚙")}
          </span>
          <span className="sidebar-profile-copy"><strong>Edit your profile</strong><small>Make your office avatar yours</small></span>
          <span className="sidebar-profile-action" aria-hidden="true"><small>Edit</small><span>↗</span></span>
        </button>
        <div className="sidebar-appearance">
          <div className="sidebar-appearance-heading">Appearance</div>
          <div className="sidebar-appearance-mode" role="group" aria-label="Choose light or dark mode">
            <button className={theme === "light" ? "selected" : ""} type="button" onClick={() => onSetAppearance("light")} aria-pressed={theme === "light"}>
              <span aria-hidden="true">☼</span> Light
            </button>
            <button className={theme === "dark" ? "selected" : ""} type="button" onClick={() => onSetAppearance("dark")} aria-pressed={theme === "dark"}>
              <span aria-hidden="true">☾</span> Dark
            </button>
          </div>
          <div className="sidebar-palette-heading">Color palette</div>
          <div className="sidebar-palette-options" role="group" aria-label="Choose color palette">
            {APPEARANCE_PALETTES.map((option) => (
              <button className={palette === option.id ? "selected" : ""} key={option.id} type="button" onClick={() => onSetPalette(option.id)} aria-pressed={palette === option.id}>
                <i style={{ backgroundColor: option.color }} aria-hidden="true" />
                <span>{option.name}</span>
                {palette === option.id && <b aria-hidden="true">✓</b>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function RoomSelector({ rooms, selectedRoomId, onSelectRoom, participants }) {
  return (
    <section className="room-selector room-selector-office" aria-labelledby="room-selector-title">
      <div className="room-selector-heading">
        <div>
          <h2 id="room-selector-title">Choose your room</h2>
          <p>Pick a space for this session.</p>
        </div>
        <span className="room-preview-badge">ROOMS</span>
      </div>
      <div className="room-options">
        {rooms.map((room) => {
          const selected = room.id === selectedRoomId;
          const roomOnlineCount = participants.filter((participant) => participant.status === "online" && participant.roomId === room.id).length;
          const occupancyLabel = `${roomOnlineCount} online`;
          return (
            <button
              className={`room-option ${selected ? "selected" : ""}`}
              key={room.id}
              type="button"
              onClick={() => onSelectRoom(room.id)}
              aria-pressed={selected}
            >
              <span className="room-option-icon" aria-hidden="true">{room.icon}</span>
              <span className="room-option-copy">
                <strong>{room.name}</strong>
                <small>{room.description}</small>
                <span className="room-option-occupancy">{occupancyLabel}</span>
              </span>
              {selected && <span className="room-option-check" aria-label="Selected">✓</span>}
            </button>
          );
        })}
      </div>
      <p className="room-sync-note">Choose a room to move your avatar and see its live participants.</p>
    </section>
  );
}

export function VirtualOffice({ position, onPositionChange, username, avatarColor, avatarStyle, connectionStatus, connectionError, backendStatus, backendError, currentRoom, rooms, onSelectRoom, participants, audio, onFindParticipant, onRetryBackend, onRetryConnection, onLeave }) {
  const roomRef = useRef(null);
  function startNearbyCall() {
    if (connectionStatus !== "connected") return;
    if (audio.microphoneStatus === "ready") {
      if (audio.isMuted) audio.toggleMute();
      return;
    }
    void audio.requestMicrophone();
  }

  const moveBy = useCallback((dx, dy) => {
    onPositionChange({ x: position.x + dx, y: position.y + dy });
  }, [onPositionChange, position]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target?.closest("button, input, textarea, select, summary, [contenteditable='true']")) return;
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
          <h1>{currentRoom.name}<span>.</span></h1>
          <p className="office-subtitle">{currentRoom.description}</p>
        </div>
        <div className="people-pill"><span className="people-avatars"><i>{getInitials(username)}</i></span><span><b>{participants.filter((participant) => participant.status === "online" && participant.roomId === currentRoom.id).length}</b> online in this room</span></div>
      </div>

      <RoomSelector rooms={rooms} selectedRoomId={currentRoom.id} onSelectRoom={onSelectRoom} participants={participants} />

      <section className="dashboard-overview" id="workspace-dashboard" aria-label="Workspace dashboard">
        <article className="dashboard-card">
          <span>Backend API</span>
          <div className="dashboard-value-row">
            <strong className={`dashboard-connection ${backendStatus}`}>{backendStatus === "connected" ? "Online" : backendStatus === "loading" ? "Checking" : "Offline"}</strong>
            {backendStatus !== "connected" && <button className="dashboard-retry" onClick={onRetryBackend} type="button" disabled={backendStatus === "loading"}>{backendStatus === "loading" ? "Checking…" : "Retry"}</button>}
          </div>
          <small title={backendError || undefined}>{backendError || (backendStatus === "connected" ? "Health check passed" : "API needs attention")}</small>
        </article>
        <article className="dashboard-card">
          <span>Current room</span>
          <strong>{currentRoom.name}</strong>
          <small>{currentRoom.description}</small>
        </article>
        <article className="dashboard-card">
          <span>People online</span>
          <strong>{participants.filter((participant) => participant.status === "online" && participant.roomId === currentRoom.id).length}</strong>
          <small>In {currentRoom.name}</small>
        </article>
        <article className="dashboard-card">
          <span>Live connection</span>
          <div className="dashboard-value-row">
            <strong className={`dashboard-connection ${connectionStatus}`}>{connectionStatus === "connected" ? "Connected" : connectionStatus === "connecting" || connectionStatus === "reconnecting" ? "Connecting" : connectionStatus === "offline" ? "Offline" : "Disconnected"}</strong>
            {connectionStatus !== "connected" && <button className="dashboard-retry" onClick={onRetryConnection} type="button" disabled={connectionStatus === "connecting" || connectionStatus === "reconnecting"}>{connectionStatus === "connecting" || connectionStatus === "reconnecting" ? "Connecting…" : "Retry"}</button>}
          </div>
          <small>{connectionStatus === "connected" ? "Participant updates are live" : "Reconnect to sync with the team"}</small>
        </article>
      </section>

      <section className="office-shell" aria-label="Interactive virtual office">
        <div className="room-toolbar">
          <div className="room-name"><span className="room-live" /> {currentRoom.name} <span className="room-separator">/</span> {currentRoom.description}</div>
          <div className={`room-presence ${connectionStatus}`} role="status" aria-live="polite">
            <span className={`presence-dot ${connectionStatus}`} />
            <span>{connectionStatus === "connected" ? "Live connection" : connectionStatus === "connecting" ? "Connecting to office" : connectionStatus === "reconnecting" ? "Reconnecting" : connectionStatus === "offline" ? "Device offline" : "Disconnected"}</span>
            {connectionError && connectionStatus !== "connected" && <span className="connection-detail"> · {connectionError}</span>}
            {connectionStatus === "disconnected" && <button className="retry-connection" onClick={onRetryConnection} type="button">Retry</button>}
          </div>
        </div>

        <div className={`room-scene room-scene-${currentRoom.id}`} ref={roomRef} onClick={moveToPointer} role="region" tabIndex={0} aria-label={`${currentRoom.name} virtual office`} aria-describedby="office-movement-instructions">
          <div className="window-wall"><span /><span /><span /><span /><span /></div>
          <div className="meeting-display" aria-hidden="true"><span>TEAM SYNC</span><i /></div>
          <div className="focus-bookshelf" aria-hidden="true"><i /><i /><i /><span /><span /><span /></div>
          <div className="focus-rug" aria-hidden="true" />
          <div className="focus-station focus-station-one" aria-hidden="true"><i /><span /><b /></div>
          <div className="focus-station focus-station-two" aria-hidden="true"><i /><span /><b /></div>
          <div className="focus-station focus-station-three" aria-hidden="true"><i /><span /><b /></div>
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

          {participants.filter((participant) => !participant.isYou && participant.roomId === currentRoom.id && participant.position && participant.status === "online").map((participant) => (
            <div
              className="office-mate"
              key={participant.id}
              style={{ left: `${participant.position.x}%`, top: `${participant.position.y}%` }}
              role="img"
              aria-label={`${participant.name}'s avatar`}
            >
              <span className="mate-status">Online{participant.availability ? ` · ${getAvailabilityLabel(participant.availability)}` : ""}</span>
              <span className={`mate-avatar avatar-style-${participant.avatarStyle || "person"}`} style={participant.color ? { background: participant.color } : undefined}>{getAvatarStyle(participant.avatarStyle).icon || getInitials(participant.name)}</span>
              <span className="mate-name">{participant.name}</span>
            </div>
          ))}

          <div
            className="my-avatar-wrap"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
            role="img"
            aria-label={`Your avatar, position ${Math.round(position.x)}, ${Math.round(position.y)}`}
          >
            <span className="avatar-name-tag">{username}</span>
            <span className="avatar-shadow" />
            <span className={`my-avatar ${avatarStyle === "person" ? "" : `avatar-glyph avatar-style-${avatarStyle}`}`} style={{ "--avatar-color": avatarColor }}>
              {avatarStyle === "person"
                ? <><span className="avatar-hair" /><span className="avatar-face"><i /><i /></span><span className="avatar-body" style={{ background: `linear-gradient(135deg, ${avatarColor}, ${avatarColor})` }} /></>
                : <span className="avatar-style-glyph">{getAvatarStyle(avatarStyle).icon}</span>}
            </span>
            <span className="avatar-position">{Math.round(position.x)}, {Math.round(position.y)}</span>
          </div>
          <span className="scene-hint">Click or tap to move</span>
        </div>

        <div className="office-controls">
          <span id="office-movement-instructions" className="visually-hidden">Move your avatar with W, A, S, D, the arrow keys, or the on-screen movement buttons. Click or tap a location in the office to move there.</span>
          <div className="movement-help">
            <span className="key-cluster" aria-hidden="true"><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span>
            <span className="movement-help-label">Keys or tap controls to move</span>
            <div className="movement-pad" role="group" aria-label="Avatar movement controls">
              <button type="button" aria-label="Move avatar up" onClick={() => moveBy(0, -3)}>↑</button>
              <span>
                <button type="button" aria-label="Move avatar left" onClick={() => moveBy(-3, 0)}>←</button>
                <button type="button" aria-label="Move avatar down" onClick={() => moveBy(0, 3)}>↓</button>
                <button type="button" aria-label="Move avatar right" onClick={() => moveBy(3, 0)}>→</button>
              </span>
            </div>
          </div>
          <div className="control-actions">
            <button
              className={`control-button ${audio.isMuted ? "is-muted" : "audio-join"}`}
              onClick={audio.microphoneStatus === "ready" ? audio.toggleMute : audio.requestMicrophone}
              disabled={audio.microphoneStatus === "requesting" || connectionStatus !== "connected"}
              aria-pressed={audio.microphoneStatus === "ready" ? audio.isMuted : undefined}
              aria-label={audio.microphoneStatus === "ready" ? `${audio.isMuted ? "Unmute" : "Mute"} microphone` : "Join nearby audio and enable microphone"}
            >
              <span>{audio.microphoneStatus === "requesting" ? "…" : audio.isMuted ? "◌" : "◖"}</span>
              {audio.microphoneStatus === "requesting" ? "Requesting mic…" : audio.microphoneStatus === "ready" ? (audio.isMuted ? "Unmute" : "Mute") : audio.microphoneStatus === "denied" || audio.microphoneStatus === "unavailable" ? "Try audio" : "Join nearby audio"}
            </button>
            {(audio.microphoneStatus !== "off" || Object.keys(audio.remoteStreams).length > 0) && (
              <button className="control-button audio-leave" onClick={audio.leaveAudio} type="button">Leave audio</button>
            )}
            {(audio.hasFailedPeer || audio.audioError) && <button className="retry-connection" onClick={audio.retryAudio} type="button">Retry audio</button>}
            <button className="control-button leave-button" onClick={onLeave}><span>↗</span> Leave office</button>
          </div>
        </div>
      </section>
      <AudioStatusPanel audio={audio} participants={participants} />
      <ParticipantsPanel participants={participants} onFindParticipant={onFindParticipant} />
      <p className="office-footnote"><span>✦</span> You appear in the {currentRoom.name} as {username}. Voice connects to teammates nearby when you join audio.</p>
      <OfficeChatDock
        username={username}
        participants={participants}
        audio={audio}
        connectionStatus={connectionStatus}
        onStartCall={startNearbyCall}
      />
    </main>
  );
}

function AudioStatusPanel({ audio, participants }) {
  const nearbyIds = new Set(audio.nearbyParticipantIds);
  const remoteParticipants = participants.filter((participant) => nearbyIds.has(participant.id));
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
          <h2>Proximity voice</h2>
          <span className={`audio-status-label ${indicatorStatus}`} role="status" aria-live="polite">{audio.statusLabel}</span>
        </div>
        {audio.microphoneStatus === "ready" && audio.nearbyPeerCount === 0 && (
          <p className="proximity-note">
            {audio.onlinePeerCount > 0
              ? `No teammates are within ${audio.proximityRadius}% of your position. Move closer to talk.`
              : "Your mic is ready. Nearby teammates will connect when they enter this room."}
          </p>
        )}
        {audio.microphoneError && <p className="audio-error" role="alert">{audio.microphoneError}</p>}
        {audio.audioError && <p className="audio-error" role="alert">{audio.audioError}</p>}
        <details className="audio-settings">
          <summary>Audio settings</summary>
          <label className="audio-volume-control" htmlFor="office-output-volume">
            <span>Speaker volume</span>
            <input
              id="office-output-volume"
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(audio.outputVolume * 100)}
              onChange={(event) => audio.setOutputVolume(Number(event.target.value) / 100)}
              aria-describedby="office-volume-help"
            />
            <output htmlFor="office-output-volume" aria-live="polite">{Math.round(audio.outputVolume * 100)}%</output>
          </label>
          <p id="office-volume-help">Nearby voices still get quieter as teammates move farther away. This level is saved on this device.</p>
        </details>
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
          <RemoteAudioPlayer key={peerId} stream={stream} volume={audio.remoteVolumes[peerId] ?? 1} onPlaybackError={audio.reportPlaybackError} />
        ))}
      </div>
    </section>
  );
}

function RemoteAudioPlayer({ stream, volume, onPlaybackError }) {
  const audioRef = useRef(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return undefined;
    element.srcObject = stream;
    element.volume = volume;
    void element.play().catch(onPlaybackError);
    return () => {
      element.pause();
      element.srcObject = null;
    };
  }, [stream, onPlaybackError]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  return <audio ref={audioRef} autoPlay playsInline />;
}

function ProfileSettingsDialog({ profile, onSave, onClose }) {
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState(profile);
  const [nameError, setNameError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    const nextProfile = normalizeWorkspaceProfile(draft);
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
            <p className="profile-studio-kicker"><span aria-hidden="true">✦</span> PROFILE STUDIO <small>YOUR VIBE</small></p>
            <h2 id="profile-dialog-title">Make it yours<span>.</span></h2>
            <p className="profile-dialog-subtitle">A little refresh for your corner of the office.</p>
          </div>
          <button className="profile-close" type="button" aria-label="Close profile settings" onClick={() => dialogRef.current?.close()}>×</button>
        </div>

        <div className="profile-live-preview" aria-live="polite" aria-label="Live profile preview">
          <span className={`profile-preview-avatar avatar-style-${draft.avatarStyle}`} style={{ backgroundColor: draft.avatarColor }} aria-hidden="true">
            {getAvatarStyle(draft.avatarStyle).icon || getInitials(draft.displayName || "You")}
          </span>
          <span className="profile-preview-copy">
            <small>YOUR OFFICE ID</small>
            <strong>{draft.displayName || "Your name"}</strong>
            <span className={`profile-preview-status ${draft.availability}`}><i />{getAvailabilityLabel(draft.availability)}</span>
          </span>
          <span className="profile-preview-chip">LIVE PREVIEW</span>
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

        <fieldset className="profile-field avatar-style-field">
          <legend>Avatar style</legend>
          <div className="avatar-style-options">
            {AVATAR_STYLES.map((style) => (
              <label className={`avatar-style-choice ${draft.avatarStyle === style.id ? "selected" : ""}`} key={style.id}>
                <input
                  type="radio"
                  name="avatarStyle"
                  value={style.id}
                  checked={draft.avatarStyle === style.id}
                  onChange={() => setDraft((current) => ({ ...current, avatarStyle: style.id }))}
                />
                <span className={`avatar-style-preview avatar-style-${style.id}`} style={{ "--avatar-color": draft.avatarColor }} aria-hidden="true">
                  {style.icon || getInitials(draft.displayName || "You")}
                </span>
                <small>{style.name}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="profile-field availability-field">
          <legend>Availability</legend>
          <p className="availability-hint" id="availability-hint">Let teammates know what kind of energy you’re on.</p>
          <div className="availability-options">
            {AVAILABILITY_OPTIONS.map((option) => (
              <label className={`availability-choice ${option.value}`} key={option.value}>
                <input
                  type="radio"
                  name="profileAvailability"
                  value={option.value}
                  checked={draft.availability === option.value}
                  aria-describedby="availability-hint"
                  onChange={() => setDraft((current) => ({ ...current, availability: option.value }))}
                />
                <span className={`availability-choice-dot ${option.value}`} aria-hidden="true" />
                <span className="availability-choice-copy">
                  <strong>{option.label}</strong>
                  <small>{AVAILABILITY_HINTS[option.value]}</small>
                </span>
                <span className="availability-choice-check" aria-hidden="true">✓</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="profile-storage-note">Your profile choices are saved in this browser.</p>
        <div className="profile-dialog-actions">
          <button className="profile-cancel" type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="profile-save" type="submit">Save profile</button>
        </div>
      </form>
    </dialog>
  );
}

function ParticipantsPanel({ participants, onFindParticipant }) {
  const onlineCount = participants.filter((participant) => participant.status === "online").length;
  return (
    <section className="participants-panel" aria-label="Office participants">
      <div className="participants-heading">
        <h2>Find your teammates</h2>
        <span>{onlineCount} online · {participants.length} participant{participants.length === 1 ? "" : "s"}</span>
      </div>
      <p className="participants-note">Room, position, connection, and availability are shown separately.</p>
      {participants.length ? (
        <ul className="participants-list">
          {participants.map((participant) => (
            <li className="participant-row" key={participant.id}>
              <span className={`participant-avatar avatar-style-${participant.avatarStyle || "person"}`} style={participant.color ? { background: participant.color } : undefined}>
                {getAvatarStyle(participant.avatarStyle).icon || getInitials(participant.name)}
              </span>
              <span className="participant-details">
                <span className="participant-name">
                  {participant.name}
                  {participant.isYou && <small>You</small>}
                </span>
                <span className="participant-meta">
                  <small>{getRoomName(participant.roomId)} · {participant.position ? `Position ${Math.round(participant.position.x)}%, ${Math.round(participant.position.y)}%` : "Position not shared"}</small>
                  <small className={`availability-tag ${participant.availability || "unknown"}`}>
                    {participant.availability ? getAvailabilityLabel(participant.availability) : "Availability not shared"}
                  </small>
                </span>
              </span>
              <span className={`participant-status ${participant.status}`}>
                <i />{participant.status === "online" ? "Online" : participant.status === "connecting" ? "Connecting" : "Offline"}
              </span>
              <button
                className="participant-find"
                type="button"
                onClick={() => onFindParticipant(participant)}
                disabled={participant.isYou || participant.status !== "online" || !participant.roomId}
                aria-label={`Find ${participant.name} in ${getRoomName(participant.roomId)}`}
              >
                Find
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="participants-empty">Waiting for the office connection…</p>
      )}
    </section>
  );
}

function TeamChatPanel({ username, participants, audio, connectionStatus, onStartCall, onClose, isOpen }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const onlineCount = participants.filter((participant) => participant.status === "online").length;
  const voiceActive = audio.microphoneStatus === "ready" && !audio.isMuted;
  const callLabel = voiceActive ? "Voice is on" : audio.microphoneStatus === "requesting" ? "Connecting…" : "Call nearby";

  function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => [...current, {
      id: `${Date.now()}-${Math.random()}`,
      author: username || "You",
      text,
      time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    }]);
    setDraft("");
  }

  return (
    <section id="team-chat-panel" className="team-chat-panel" aria-labelledby="team-chat-title" hidden={!isOpen}>
      <div className="team-chat-heading">
        <div>
          <p className="chat-kicker"><span aria-hidden="true">✦</span> THE TEAM SPACE</p>
          <h2 id="team-chat-title">Office chat <span className="chat-preview-badge">Preview</span></h2>
          <p className="chat-subtitle">{onlineCount} teammate{onlineCount === 1 ? "" : "s"} online · Say hi to your team</p>
        </div>
        <div className="chat-header-actions">
          <button
            className={`chat-call-button ${voiceActive ? "active" : ""}`}
            type="button"
            onClick={onStartCall}
            disabled={connectionStatus !== "connected" || audio.microphoneStatus === "requesting" || voiceActive}
            aria-label={voiceActive ? "Nearby voice is on" : "Start a proximity voice call with nearby teammates"}
            title="Voice connects with teammates nearby in this room."
          >
            <span aria-hidden="true">{voiceActive ? "◖" : "☎"}</span>{callLabel}
          </button>
          <button className="chat-close-button" type="button" onClick={onClose} aria-label="Close team chat">×</button>
        </div>
      </div>

      <p className="chat-preview-note">Messages stay in this browser session for now. Team-wide chat needs backend support.</p>

      <div className="chat-thread" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Chat messages">
        {messages.length ? messages.map((message) => (
          <article className="chat-message is-you" key={message.id}>
            <span className="chat-message-avatar" aria-hidden="true">{getInitials(message.author)}</span>
            <div className="chat-message-body">
              <div className="chat-message-meta"><strong>{message.author}</strong><time>{message.time}</time></div>
              <p>{message.text}</p>
            </div>
          </article>
        )) : (
          <div className="chat-empty-state">
            <span className="chat-empty-icon" aria-hidden="true">✦</span>
            <strong>Your team, right here.</strong>
            <span>Drop a hello or share what you’re working on.</span>
          </div>
        )}
      </div>

      <form className="chat-composer" onSubmit={sendMessage}>
        <label className="visually-hidden" htmlFor="team-chat-message">Write a message to your team</label>
        <input
          id="team-chat-message"
          type="text"
          value={draft}
          maxLength={500}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a message…"
        />
        <button type="submit" disabled={!draft.trim()}>Send <span aria-hidden="true">↗</span></button>
      </form>
      <p className="chat-voice-note">Proximity voice connects automatically when teammates are nearby.</p>
    </section>
  );
}

function OfficeChatDock({ username, participants, audio, connectionStatus, onStartCall }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="office-chat-dock">
      <button
        className={`office-chat-launcher ${isOpen ? "open" : ""}`}
        type="button"
        aria-expanded={isOpen}
        aria-controls="team-chat-panel"
        aria-label={isOpen ? "Close team chat" : "Open team chat"}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="chat-launcher-icon" aria-hidden="true">{isOpen ? "×" : "▤"}</span>
        <span>{isOpen ? "Close chat" : "Chat"}</span>
      </button>
      <TeamChatPanel
        username={username}
        participants={participants}
        audio={audio}
        connectionStatus={connectionStatus}
        onStartCall={onStartCall}
        onClose={() => setIsOpen(false)}
        isOpen={isOpen}
      />
    </div>
  );
}

export default App;
