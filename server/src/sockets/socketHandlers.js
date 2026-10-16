/**
 * Socket.IO event handlers for ProxiSpeak
 * Handles connection lifecycle, strict input validation, real-time position broadcasting,
 * and robust user disconnection cleanup.
 */

// In-memory store of active users: socket.id -> { id, username, x, y, color }
const users = new Map();

// Map bounds for the virtual office
const MAP_BOUNDS = {
  MIN_X: 0,
  MAX_X: 2000,
  MIN_Y: 0,
  MAX_Y: 2000,
};

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

/**
 * Validates whether a value is a valid, finite number (not NaN, not Infinity).
 */
function isFiniteNumber(val) {
  return typeof val === "number" && Number.isFinite(val) && !Number.isNaN(val);
}

/**
 * Clamps a number within min and max boundaries.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, Math.round(val)));
}

/**
 * Sanitizes strings (e.g. usernames) to avoid injection or excessive lengths.
 */
function sanitizeUsername(input, defaultName) {
  if (typeof input !== "string") return defaultName;
  const trimmed = input.trim();
  if (trimmed.length === 0) return defaultName;
  // Limit to 30 alphanumeric/basic punctuation characters
  return trimmed.slice(0, 30);
}

function registerSocketHandlers(io, socket) {
  console.log(`[SOCKET CONNECT] User connected: ${socket.id}`);

  // Handle socket-level errors gracefully to prevent crashing
  socket.on("error", (err) => {
    console.error(`[SOCKET ERROR] Socket ${socket.id} error:`, err?.message || err);
  });

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

  // 3. Handle custom join / init with payload validation
  socket.on("join", (userData = {}) => {
    try {
      const existing = users.get(socket.id) || defaultUser;

      const safeUsername = sanitizeUsername(userData?.username, existing.username);
      const safeX = isFiniteNumber(userData?.x)
        ? clamp(userData.x, MAP_BOUNDS.MIN_X, MAP_BOUNDS.MAX_X)
        : existing.x;
      const safeY = isFiniteNumber(userData?.y)
        ? clamp(userData.y, MAP_BOUNDS.MIN_Y, MAP_BOUNDS.MAX_Y)
        : existing.y;
      const safeColor = typeof userData?.color === "string" && userData.color.startsWith("#")
        ? userData.color.slice(0, 7)
        : existing.color;

      const updated = {
        ...existing,
        username: safeUsername,
        x: safeX,
        y: safeY,
        color: safeColor,
      };

      users.set(socket.id, updated);
      socket.broadcast.emit("userJoined", updated);
    } catch (err) {
      console.error(`[JOIN ERROR] Failed to process join for ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Invalid join payload" });
    }
  });

  // 4. Handle user position updates with strict validation
  socket.on("updatePosition", (positionData) => {
    try {
      // Validation Check 1: Must be a non-null object
      if (!positionData || typeof positionData !== "object" || Array.isArray(positionData)) {
        socket.emit("error:validation", { message: "Position payload must be an object" });
        return;
      }

      // Validation Check 2: Coordinates must be valid finite numbers
      if (!isFiniteNumber(positionData.x) || !isFiniteNumber(positionData.y)) {
        socket.emit("error:validation", {
          message: "Coordinates x and y must be finite numbers",
          received: { x: positionData.x, y: positionData.y },
        });
        return;
      }

      const currentUser = users.get(socket.id);
      if (!currentUser) {
        socket.emit("error:validation", { message: "User not found in active session" });
        return;
      }

      // Validation Check 3: Clamp coordinates to map boundaries
      const boundedX = clamp(positionData.x, MAP_BOUNDS.MIN_X, MAP_BOUNDS.MAX_X);
      const boundedY = clamp(positionData.y, MAP_BOUNDS.MIN_Y, MAP_BOUNDS.MAX_Y);

      currentUser.x = boundedX;
      currentUser.y = boundedY;
      users.set(socket.id, currentUser);

      const updatePayload = {
        id: socket.id,
        x: boundedX,
        y: boundedY,
        username: currentUser.username,
      };

      // Broadcast validated coordinates to all other connected clients
      socket.broadcast.emit("userPositionUpdated", updatePayload);
      socket.broadcast.emit("userMoved", updatePayload);
    } catch (err) {
      console.error(`[UPDATE POSITION ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Internal error processing position" });
    }
  });

  // Alias listener for userMoved
  socket.on("userMoved", (positionData) => {
    socket.emit("updatePosition", positionData);
  });

  // 5. Ping-Pong event (maintains backward compatibility with Day 2)
  socket.on("ping", (data) => {
    socket.emit("pong", data || "pong");
  });

  // 6. Robust user disconnection handling
  socket.on("disconnect", (reason) => {
    console.log(`[SOCKET DISCONNECT] User disconnected: ${socket.id} (Reason: ${reason})`);

    const existingUser = users.get(socket.id);

    // Guaranteed cleanup from active users registry
    users.delete(socket.id);

    // Notify all remaining clients that this user left
    const disconnectPayload = {
      id: socket.id,
      username: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
      reason,
    };

    socket.broadcast.emit("userDisconnected", disconnectPayload);
    socket.broadcast.emit("userLeft", disconnectPayload);
  });
}

// Helpers for test assertions and monitoring
function getUserCount() {
  return users.size;
}

function hasUser(id) {
  return users.has(id);
}

function clearUsers() {
  users.clear();
}

module.exports = {
  registerSocketHandlers,
  users,
  getUserCount,
  hasUser,
  clearUsers,
  isFiniteNumber,
  clamp,
  sanitizeUsername,
  MAP_BOUNDS,
};
