import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000/api/health";
const ROOM_BOUNDS = { minX: 8, maxX: 92, minY: 12, maxY: 88 };
const INITIAL_POSITION = { x: 49, y: 57 };

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
  const [position, setPosition] = useState(INITIAL_POSITION);
  const [isMuted, setIsMuted] = useState(false);

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

  const updatePosition = useCallback((nextPosition) => {
    if (!isValidPosition(nextPosition)) return;
    setPosition(clampPosition(nextPosition));
  }, []);

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
          <span className={`nav-status ${apiStatus}`}>
            <span className={`status-dot ${apiStatus}`} />
            {apiStatus === "loading" ? "Checking backend..." : apiStatus === "connected" ? "Connected" : "Disconnected"}
          </span>
          {started && (
            <button className="avatar-small" title="Harshavardhan" aria-label="Harshavardhan profile">H</button>
          )}
        </div>
      </header>

      {started ? (
        <VirtualOffice
          position={position}
          onPositionChange={updatePosition}
          apiStatus={apiStatus}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((muted) => !muted)}
          onLeave={() => setStarted(false)}
        />
      ) : (
        <Home
          apiStatus={apiStatus}
          apiResponse={apiResponse}
          apiError={apiError}
          onStart={() => setStarted(true)}
        />
      )}

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

function Home({ apiStatus, apiResponse, apiError, onStart }) {
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

      <button className="start-button" onClick={onStart}>
        Enter virtual office <span aria-hidden="true">→</span>
      </button>
      <p className="footer-note">A little space to work together, wherever you are.</p>
    </main>
  );
}

// Controlled position props are the integration boundary for future presence updates.
// A backend adapter can pass normalized coordinates here once its contract is defined.
export function VirtualOffice({ position, onPositionChange, apiStatus, isMuted, onToggleMute, onLeave }) {
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
        <div className="people-pill"><span className="people-avatars"><i>H</i><i>M</i><i>A</i></span><span><b>4</b> in the office</span></div>
      </div>

      <section className="office-shell" aria-label="Interactive virtual office">
        <div className="room-toolbar">
          <div className="room-name"><span className="room-live" /> The Commons <span className="room-separator">/</span> Open workspace</div>
          <div className="room-presence"><span className={`presence-dot ${apiStatus}`} /> {apiStatus === "connected" ? "Backend online" : "Local preview"}</div>
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
            <span className="avatar-name-tag">You</span>
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
      <p className="office-footnote"><span>✦</span> Your position is ready to sync when live presence is connected.</p>
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
