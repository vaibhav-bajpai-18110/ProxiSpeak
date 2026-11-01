const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();

const {
  registerSocketHandlers,
  getUserCount,
  getRoomsList,
  createRoom,
} = require("./sockets/socketHandlers");

// Process-level error safety nets to prevent server crashes
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]:", err?.message || err);
});

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 10000,
  pingInterval: 5000,
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

// Health Check Endpoint
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    status: "OK",
    project: "ProxiSpeak",
    timestamp: new Date().toISOString(),
  });
});

// Server Status Endpoint
app.get("/api/status", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    status: "active",
    message: "ProxiSpeak server is operational",
    uptime: `${Math.floor(process.uptime())}s`,
    activeUsers: getUserCount(),
    timestamp: new Date().toISOString(),
  });
});

// Room Directory Listing Endpoint
app.get("/api/rooms", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    status: "OK",
    rooms: getRoomsList(),
    timestamp: new Date().toISOString(),
  });
});

// Room Creation Endpoint
app.post("/api/rooms", (req, res) => {
  const { roomId, name, description, maxParticipants, isPrivate } = req.body || {};
  const result = createRoom({ roomId, name, description, maxParticipants, isPrivate }, "api");
  if (!result.success) {
    return res.status(400).json({ error: result.error, roomId: result.roomId });
  }
  io.emit("roomListUpdated", getRoomsList());
  res.status(201).json({ status: "created", room: result.room });
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
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: "Internal Server Error", message: err.message });
});

// Socket.IO Connection Handler
io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
