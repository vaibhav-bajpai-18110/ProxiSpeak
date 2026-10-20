
/**
 * ProxiSpeak Socket.IO handlers.
 * MongoDB stores user records.
 * In-memory state handles live users and avatar movement.
 */

const User = require("../models/User");

const users = new Map();

const AVATAR_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
];

function getRandomColor() {
  return AVATAR_COLORS[
    Math.floor(Math.random() * AVATAR_COLORS.length)
  ];
}

function registerSocketHandlers(io, socket) {
  console.log("User connected:", socket.id);

  const defaultUser = {
    id: socket.id,
    username: `User-${socket.id.slice(0, 4)}`,
    x: Math.floor(100 + Math.random() * 400),
    y: Math.floor(100 + Math.random() * 300),
    color: getRandomColor(),
  };

  users.set(socket.id, defaultUser);

  // Create or update the user's database record.
  // A database error must not stop live socket functionality.
  User.findOneAndUpdate(
    { userId: socket.id },
    { $set: { username: defaultUser.username } },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
    }
  ).catch((error) => {
    console.error("Failed to save connected user:", error.message);
  });

  socket.emit("currentUsers", Array.from(users.values()));
  socket.broadcast.emit("userJoined", defaultUser);

  // Update a user's name or initial position.
  socket.on("join", async (userData = {}) => {
    const existing = users.get(socket.id) || defaultUser;

    const updated = {
      ...existing,
      username: userData.username || existing.username,
      x: typeof userData.x === "number" ? userData.x : existing.x,
      y: typeof userData.y === "number" ? userData.y : existing.y,
      color: userData.color || existing.color,
    };

    users.set(socket.id, updated);

    try {
      await User.findOneAndUpdate(
        { userId: socket.id },
        { $set: { username: updated.username } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
        }
      );
    } catch (error) {
      console.error("Failed to update user:", error.message);
    }

    socket.broadcast.emit("userJoined", updated);
  });

  // Keep avatar movement in memory; do not write every move to MongoDB.
  socket.on("updatePosition", (positionData) => {
    const currentUser = users.get(socket.id);
    if (!currentUser || !positionData) return;

    const newX =
      typeof positionData.x === "number" ? positionData.x : currentUser.x;
    const newY =
      typeof positionData.y === "number" ? positionData.y : currentUser.y;

    currentUser.x = newX;
    currentUser.y = newY;
    users.set(socket.id, currentUser);

    const updatePayload = {
      id: socket.id,
      x: newX,
      y: newY,
      username: currentUser.username,
    };

    socket.broadcast.emit("userPositionUpdated", updatePayload);
    socket.broadcast.emit("userMoved", updatePayload);
  });

  // Preserve the existing event alias.
  socket.on("userMoved", (positionData) => {
    socket.emit("updatePosition", positionData);
  });

  socket.on("ping", (data) => {
    console.log("Received ping from client:", socket.id);
    socket.emit("pong", data || "pong");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    users.delete(socket.id);

    // Intentionally keep the MongoDB record.
    socket.broadcast.emit("userDisconnected", { id: socket.id });
    socket.broadcast.emit("userLeft", { id: socket.id });
  });
}

module.exports = {
  registerSocketHandlers,
  users,
};
