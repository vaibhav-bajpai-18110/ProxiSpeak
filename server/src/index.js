
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const mongoose = require("mongoose");

require("dotenv").config();

const connectDB = require("./config/db");
const {
  registerSocketHandlers,
  getUserCount,
  getRoomsList,
  createRoom,
  getProfile,
  saveProfile,
  getRoomMessages,
  sanitizeRoomId,
} = require("./sockets/socketHandlers");
const databaseService = require("./services/databaseService");

// Process-level error handling
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]:", err?.message || err);
});

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

const io = require("socket.io")(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 10000,
  pingInterval: 5000,
});

// Root route
app.get("/", (req, res) => {
  res.send("ProxiSpeak Backend is running!");
});

// Interactive demo
app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Serve public assets
app.use(
  express.static(path.join(__dirname, "../public"), {
    index: false,
  })
);

// Health check
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");

  res.json({
    status: "OK",
    project: "ProxiSpeak",
    timestamp: new Date().toISOString(),
  });
});

// Server status
app.get("/api/status", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");

  res.json({
    status: "active",
    message: "ProxiSpeak server is operational",
    uptime: `${Math.floor(process.uptime())}s`,
    activeUsers: getUserCount(),
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
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
  const {
    roomId,
    name,
    description,
    maxParticipants,
    isPrivate,
  } = req.body || {};

  const result = createRoom(
    { roomId, name, description, maxParticipants, isPrivate },
    "api"
  );

  if (!result.success) {
    return res.status(400).json({
      status: "error",
      error: result.error,
      message: result.error || "Room creation failed",
      roomId: result.roomId,
    });
  }

  io.emit("roomListUpdated", getRoomsList());

  return res.status(201).json({
    status: "created",
    room: result.room,
  });
});

// Create a world
app.post("/api/worlds", async (req, res) => {
  try {
    const { name, ownerId, layout } = req.body || {};

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof ownerId !== "string" ||
      !ownerId.trim()
    ) {
      return res.status(400).json({
        error: "A world name and ownerId are required.",
      });
    }

    const world = await databaseService.createWorld({
      name: name.trim(),
      ownerId: ownerId.trim(),
      layout,
    });

    return res.status(201).json({
      message: "World created successfully",
      world,
    });
  } catch (error) {
    console.error("World creation failed:", error.message);

    return res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "Failed to create world.",
    });
  }
});

// Profile query endpoints

// Room Chat History Endpoint
app.get("/api/rooms/:roomId/messages", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  const roomId = sanitizeRoomId(req.params.roomId);
  res.json({
    status: "success",
    roomId,
    messages: getRoomMessages(roomId),
  });
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

  return res.json({ status: "success", profile });
};

app.get("/api/profile", handleGetProfile);
app.get("/api/profile/:userId", handleGetProfile);

// Profile update endpoints
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

  io.emit("userProfileUpdated", { userId, ...result.profile });

  return res.json({ status: "success", profile: result.profile });
};

app.put("/api/profile", handleProfileUpdate);
app.put("/api/profile/:userId", handleProfileUpdate);
app.post("/api/profile", handleProfileUpdate);

// List worlds
app.get("/api/worlds", async (req, res) => {
  try {
    const worlds = await databaseService.listWorlds();

    return res.json({
      count: worlds.length,
      worlds,
    });
  } catch (error) {
    console.error("Failed to fetch worlds:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve worlds.",
    });
  }
});

// Test & Diagnostics endpoints for edge-case & resilience verification
if (process.env.NODE_ENV !== "production") {
  app.post("/api/test/database/disconnect", async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
      res.json({ status: "success", database: "disconnected" });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  app.post("/api/test/database/reconnect", async (req, res) => {
    try {
      if (mongoose.connection.readyState === 0) {
        await connectDB();
      }
      res.json({
        status: "success",
        database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });
}

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
  next();
});

// Get a world and its members
app.get("/api/worlds/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: "Invalid world ID.",
      });
    }

    const result = await databaseService.getWorldWithMembers(id);

    if (!result) {
      return res.status(404).json({
        error: "World not found.",
      });
    }

    return res.json(result);
  } catch (error) {
    console.error("Failed to fetch world:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve world.",
    });
  }
});

// Join a world
app.post("/api/worlds/:id/join", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: "Invalid world ID.",
      });
    }

    if (typeof userId !== "string" || !userId.trim()) {
      return res.status(400).json({
        error: "A userId is required.",
      });
    }

    const membership = await databaseService.joinWorld(
      id,
      userId.trim()
    );

    return res.status(200).json({
      message: "Successfully joined the world.",
      membership,
    });
  } catch (error) {
    console.error("Failed to join world:", error.message);

    return res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "Failed to join world.",
    });
  }
});

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  registerSocketHandlers(io, socket);
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Not Found",
      path: req.path,
    });
  }

  return res.status(404).send("Not Found");
});

// Express error handler
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]:", err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
  });
});

// Start server after MongoDB connects
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDB();

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
