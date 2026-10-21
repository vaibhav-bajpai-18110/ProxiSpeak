
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const mongoose = require("mongoose");

require("dotenv").config();

const connectDB = require("./config/db");
const { registerSocketHandlers } = require("./sockets/socketHandlers");
const databaseService = require("./services/databaseService");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
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
  res.json({
    status: "OK",
    project: "ProxiSpeak",
  });
});

// Server status
app.get("/api/status", (req, res) => {
  res.json({
    status: "active",
    message: "ProxiSpeak server is operational",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
  });
});

// Create a world
app.post("/api/worlds", async (req, res) => {
  try {
    const { name, ownerId, layout } = req.body;

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
      error: error.statusCode ? error.message : "Failed to create world.",
    });
  }
});

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

// Get a world and its members
app.get("/api/worlds/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid world ID." });
    }

    const result = await databaseService.getWorldWithMembers(id);

    if (!result) {
      return res.status(404).json({ error: "World not found." });
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
      return res.status(400).json({ error: "Invalid world ID." });
    }

    if (typeof userId !== "string" || !userId.trim()) {
      return res.status(400).json({ error: "A userId is required." });
    }

    const membership = await databaseService.joinWorld(id, userId.trim());

    return res.status(200).json({
      message: "Successfully joined the world.",
      membership,
    });
  } catch (error) {
    console.error("Failed to join world:", error.message);

    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to join world.",
    });
  }
});

// Register Socket.IO handlers
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  registerSocketHandlers(io, socket);
});

// 404 handler for unknown routes
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Not Found",
      path: req.path,
    });
  }

  return res.status(404).send("Not Found");
});

// Global error handler
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
