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
  getProfile,
  saveProfile,
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
    return res.status(400).json({
      status: "error",
      error: result.error,
      message: result.error || "Room creation failed",
      roomId: result.roomId,
    });
  }
  io.emit("roomListUpdated", getRoomsList());
  res.status(201).json({ status: "created", room: result.room });
});

// Single Unified Profile Query Handler (Supports :userId path param or query string ?userId=...)
const handleGetProfile = (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  const userId = req.params.userId || req.query.userId || req.query.id;
  if (!userId) {
    return res.status(400).json({
      status: "error",
      error: "Bad Request",
      message: "User ID parameter or query (?userId=...) is required",
      code: "MISSING_USER_ID",
    });
  }

  const profile = getProfile(userId);
  if (!profile) {
    return res.status(404).json({
      status: "error",
      error: "Not Found",
      message: `Profile not found for userId: ${userId}`,
      code: "PROFILE_NOT_FOUND",
    });
  }

  res.json({
    status: "success",
    profile,
  });
};

app.get("/api/profile", handleGetProfile);
app.get("/api/profile/:userId", handleGetProfile);

// Single Unified Profile Update Handler (PUT /api/profile/:userId, PUT /api/profile, POST /api/profile)
const handleProfileUpdate = (req, res) => {
  const userId = req.params.userId || req.body?.userId || req.query?.userId;
  if (!userId) {
    return res.status(400).json({
      status: "error",
      error: "Bad Request",
      message: "User ID is required to update profile",
      code: "MISSING_USER_ID",
    });
  }

  const result = saveProfile(userId, req.body || {});
  if (!result.success) {
    return res.status(400).json({
      status: "error",
      error: result.message,
      message: result.message,
      code: result.code || "VALIDATION_ERROR",
    });
  }

  // Broadcast real-time profile update via Socket.IO
  io.emit("userProfileUpdated", {
    userId,
    ...result.profile,
  });

  res.json({
    status: "success",
    profile: result.profile,
  });
};

app.put("/api/profile", handleProfileUpdate);
app.put("/api/profile/:userId", handleProfileUpdate);
app.post("/api/profile", handleProfileUpdate);

// 404 Handler for unknown routes
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      status: "error",
      error: "Not Found",
      message: `Cannot ${req.method} ${req.path}`,
      path: req.path,
    });
  }
  res.status(404).send("Not Found");
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    status: "error",
    error: "Internal Server Error",
    message: err.message || "An unexpected error occurred",
  });
});

// Socket.IO Connection Handler
io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
