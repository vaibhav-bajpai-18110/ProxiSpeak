import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = "http://localhost:5000";

function App() {
  const [started, setStarted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!started) {
      setConnected(false);
      return;
    }

    const socket = io(SERVER_URL);

    socket.on("connect", () => {
      setConnected(true);
      setMessage("Connected to ProxiSpeak backend!");
      socket.emit("ping", { message: "Hello from React frontend" });
    });

    socket.on("pong", (data) => {
      setMessage(
        typeof data === "object" ? data.message : String(data)
      );
    });

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
    };
  }, [started]);

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
          {connected ? "Connected" : "Not connected"}
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
            <strong className={connected ? "ready" : "disconnected"}>
              {connected ? "Connected" : "Disconnected"}
            </strong>
          </div>

          <div className="status-row">
            <span>Application Status</span>
            <strong className="ready">
              {started ? "Started" : "Ready"}
            </strong>
          </div>
        </div>

        <button className="start-button" onClick={handleStart}>
          {started ? "Stop ProxiSpeak" : "Start ProxiSpeak"}
          <span>→</span>
        </button>

        {started && (
          <p className="feedback">
            {message || "Connecting to backend..."}
          </p>
        )}

        <p className="footer-note">
          Frontend prototype • React + Vite + Socket.IO
        </p>
      </main>

      <footer className="footer">
        © 2026 ProxiSpeak. Built for better connections.
      </footer>
    </div>
  );
}

export default App;