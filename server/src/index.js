const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();

const { registerSocketHandlers } = require("./sockets/socketHandlers");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Root API route
app.get("/", (req, res) => {
  res.send("ProxiSpeak Backend is running!");
});

// Interactive multi-browser testing demo
app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Serve static assets for demo (without overriding root)
app.use(express.static(path.join(__dirname, "../public"), { index: false }));

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    project: "ProxiSpeak"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "active",
    message: "ProxiSpeak server is operational",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString()
  });
});

// 404 Handler for unknown routes
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not Found", path: req.path });
  }
  res.status(404).send("Not Found");
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]:", err);
  res.status(500).json({ error: "Internal Server Error", message: err.message });
});

io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
