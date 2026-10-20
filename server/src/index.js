
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

require("dotenv").config();

const connectDB = require("./config/db");
const { registerSocketHandlers } = require("./sockets/socketHandlers");

const User = require("./models/User");
const World = require("./models/World");
const WorldMember = require("./models/WorldMember");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
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

// Serve frontend assets
app.use(express.static(path.join(__dirname, "../public"), {
  index: false,
}));

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

// Create a world and register its owner as a member
app.post("/api/worlds", async (req, res) => {
  let world;

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

    // Ensure the specified owner exists.
    const owner = await User.findOne({ userId: ownerId.trim() });

    if (!owner) {
      return res.status(404).json({
        error: "Owner not found. Use an existing userId.",
      });
    }

    world = await World.create({
      name: name.trim(),
      ownerId: ownerId.trim(),
      layout: layout ?? {},
    });

    await WorldMember.create({
      userId: ownerId.trim(),
      worldId: world._id,
      role: "owner",
    });

    return res.status(201).json({
      message: "World created successfully",
      world,
    });
  } catch (error) {
    // Remove the new world if creating its owner membership failed.
    if (world) {
      await World.deleteOne({ _id: world._id }).catch(() => {});
    }

    console.error("World creation failed:", error.message);

    return res.status(500).json({
      error: "Failed to create world.",
    });
  }
});

// List worlds
app.get("/api/worlds", async (req, res) => {
  try {
    const worlds = await World.find().sort({ createdAt: -1 });

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

// Get one world and its members
app.get("/api/worlds/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: "Invalid world ID.",
      });
    }

    const world = await World.findById(id);

    if (!world) {
      return res.status(404).json({
        error: "World not found.",
      });
    }

    const members = await WorldMember.find({
      worldId: world._id,
    });

    return res.json({
      world,
      members,
    });
  } catch (error) {
    console.error("Failed to fetch world:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve world.",
    });
  }
});

 // Join an existing world
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

    const world = await World.findById(id);

    if (!world) {
      return res.status(404).json({
        error: "World not found.",
      });
    }

    const user = await User.findOne({
      userId: userId.trim(),
    });

    if (!user) {
      return res.status(404).json({
        error: "User not found.",
      });
    }

    const membership = await WorldMember.findOneAndUpdate(
      {
        userId: user.userId,
        worldId: world._id,
      },
      {
        $setOnInsert: {
          role: "member",
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      }
    );

    return res.status(200).json({
      message: "Successfully joined the world.",
      membership,
    });
  } catch (error) {
    console.error("Failed to join world:", error.message);

    return res.status(500).json({
      error: "Failed to join world.",
    });
  }
});


// Existing real-time Socket.IO functionality
io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
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
