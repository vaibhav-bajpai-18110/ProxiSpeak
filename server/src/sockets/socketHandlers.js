/**
 * Socket.IO event handlers for ProxiSpeak
 * Handles connection lifecycle, user tracking, and real-time position broadcasting.
 */

// In-memory store of active users: socket.id -> { id, username, x, y, color }
const users = new Map();

// Color palette for distinguishing users in the 2D space
const AVATAR_COLORS = [
  "#3B82F6", // Blue
  "#10B981", // Emerald
  "#F59E0B", // Amber
  "#EF4444", // Red
  "#8B5CF6", // Purple
  "#EC4899", // Pink
  "#06B6D4", // Cyan
  "#F97316", // Orange
];

function getRandomColor() {
  const index = Math.floor(Math.random() * AVATAR_COLORS.length);
  return AVATAR_COLORS[index];
}

function registerSocketHandlers(io, socket) {
  console.log("User connected:", socket.id);

  // Initialize new user with random spawn position and color
  const defaultUser = {
    id: socket.id,
    username: `User-${socket.id.slice(0, 4)}`,
    x: Math.floor(100 + Math.random() * 400),
    y: Math.floor(100 + Math.random() * 300),
    color: getRandomColor(),
  };

  users.set(socket.id, defaultUser);

  // 1. Send currently connected users to the newly connected user
  socket.emit("currentUsers", Array.from(users.values()));

  // 2. Broadcast to all other users that a new user has joined
  socket.broadcast.emit("userJoined", defaultUser);

  // 3. Handle custom join / init (if client wants to specify username or spawn point)
  socket.on("join", (userData = {}) => {
    const existing = users.get(socket.id) || defaultUser;
    const updated = {
      ...existing,
      username: userData.username || existing.username,
      x: typeof userData.x === "number" ? userData.x : existing.x,
      y: typeof userData.y === "number" ? userData.y : existing.y,
      color: userData.color || existing.color,
    };
    users.set(socket.id, updated);
    socket.broadcast.emit("userJoined", updated);
  });

  // 4. Handle user position updates and broadcast to peers
  socket.on("updatePosition", (positionData) => {
    const currentUser = users.get(socket.id);
    if (!currentUser || !positionData) return;

    const newX = typeof positionData.x === "number" ? positionData.x : currentUser.x;
    const newY = typeof positionData.y === "number" ? positionData.y : currentUser.y;

    currentUser.x = newX;
    currentUser.y = newY;
    users.set(socket.id, currentUser);

    const updatePayload = {
      id: socket.id,
      x: newX,
      y: newY,
      username: currentUser.username,
    };

    // Broadcast updated coordinates to all other connected clients
    socket.broadcast.emit("userPositionUpdated", updatePayload);
    // Also emit alias for frontend flexibility
    socket.broadcast.emit("userMoved", updatePayload);
  });

  // Alias event listener for userMoved
  socket.on("userMoved", (positionData) => {
    socket.emit("updatePosition", positionData);
  });

  // 5. Ping-Pong event (maintains backward compatibility with Day 2)
  socket.on("ping", (data) => {
    console.log("Received ping from client:", socket.id);
    socket.emit("pong", data || "pong");
  });

  // 6. Handle user disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    users.delete(socket.id);

    // Notify all remaining clients that this user left
    socket.broadcast.emit("userDisconnected", { id: socket.id });
    socket.broadcast.emit("userLeft", { id: socket.id });
  });
}

module.exports = {
  registerSocketHandlers,
  users,
};
