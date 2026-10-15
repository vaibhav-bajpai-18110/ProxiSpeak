
import { useEffect, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000/api/health";

function App() {
  const [started, setStarted] = useState(false);
  const [apiStatus, setApiStatus] = useState("loading");
  const [apiResponse, setApiResponse] = useState(null);
  const [apiError, setApiError] = useState("");

  async function checkBackend(signal) {
    setApiStatus("loading");
    setApiError("");

    try {
      const response = await fetch(API_URL, { signal });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== "OK" ||
          data.project !== "ProxiSpeak") {
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
  }

  useEffect(() => {
    const controller = new AbortController();

    checkBackend(controller.signal);

    return () => controller.abort();
  }, []);

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
          <span
            className={`status-dot ${apiStatus}`}
          ></span>

          {apiStatus === "loading"
            ? "Checking backend..."
            : apiStatus === "connected"
            ? "Connected"
            : "Disconnected"}
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
            <span>Backend Connection</span>

            <strong className={apiStatus}>
              {apiStatus === "loading"
                ? "Checking..."
                : apiStatus === "connected"
                ? "Connected"
                : "Disconnected"}
            </strong>
          </div>

          <div className="status-row">
            <span>Application Status</span>
            <strong className="ready">
              {started ? "Started" : "Ready"}
            </strong>
          </div>

          {apiResponse && (
            <div className="api-details">
              <p>Backend API Response</p>
              <pre>{JSON.stringify(apiResponse, null, 2)}</pre>
            </div>
          )}

          {apiStatus === "disconnected" && (
            <p className="api-error" role="alert">
              Backend unavailable: {apiError}
            </p>
          )}
        </div>

        <button
          className="start-button"
          onClick={handleStart}
        >
          {started
            ? "Stop ProxiSpeak"
            : "Start ProxiSpeak"}
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
