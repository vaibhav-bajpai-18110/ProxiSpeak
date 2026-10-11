
import { useState } from "react";
import "./App.css";

function App() {
  const [started, setStarted] = useState(false);

  function handleStart() {
    setStarted((previous) => !previous);
  }

  return (
    <div className="app">
      <header className="navbar">
        <div className="brand">
          <span className="brand-icon">◉</span>
          <span>ProxiSpeak</span>
        </div>

        <span className="nav-status">
          <span className="status-dot"></span>
          Not connected
        </span>
      </header>

      <main className="hero">
        <div className="hero-icon">◉</div>

        <span className="eyebrow">
          THE FUTURE OF COMMUNICATION
        </span>

        <h1>
          Connect. Communicate.
          <br />
          <span>Anywhere.</span>
        </h1>

        <p className="description">
          Welcome to ProxiSpeak — a simple and modern
          communication platform designed to bring
          people closer.
        </p>

        <div className="status-card">
          <div className="status-row">
            <span>Connection Status</span>
            <strong className="disconnected">
              Disconnected
            </strong>
          </div>

          <div className="status-row">
            <span>Application Status</span>
            <strong className="ready">
              {started ? "Started" : "Ready"}
            </strong>
          </div>
        </div>

        <button
          className="start-button"
          onClick={handleStart}
        >
          {started ? "Stop ProxiSpeak" : "Start ProxiSpeak"}
          <span>→</span>
        </button>

        {started && (
          <p className="feedback">
            ProxiSpeak frontend started successfully!
          </p>
        )}

        <p className="footer-note">
          Frontend prototype • React + Vite
        </p>
      </main>

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

export default App;
