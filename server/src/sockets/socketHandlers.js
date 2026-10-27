/**
 * Socket.IO event handlers for ProxiSpeak
 * Handles connection lifecycle, strict input validation, real-time position broadcasting,
 * room join/leave logic, participant updates, duplicate event protection, and WebRTC signaling.
 */

const {
  calculateDistance,
  calculateAudioVolume,
  calculateAudioPan,
  getNearbyParticipants,
} = require("../services/proximityService");

// In-memory store of active users: socket.id -> { id, username, roomId, x, y, color }
const users = new Map();

// Map bounds for the virtual office
const MAP_BOUNDS = {
  MIN_X: 0,
  MAX_X: 2000,
  MIN_Y: 0,
  MAX_Y: 2000,
};

// Default room for all incoming connections
const DEFAULT_ROOM = "main-office";

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

function isFiniteNumber(val) {
  return typeof val === "number" && Number.isFinite(val) && !Number.isNaN(val);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function sanitizeUsername(input, defaultName) {
  if (typeof input !== "string") return defaultName;
  const clean = input.replace(/[<>'"&]/g, "").trim();
  if (clean.length === 0) return defaultName;
  return clean.slice(0, 30);
}

function sanitizeRoomId(roomId) {
  if (typeof roomId !== "string") return DEFAULT_ROOM;
  const clean = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  return clean.length > 0 ? clean.slice(0, 50) : DEFAULT_ROOM;
}

/**
 * Returns all active users in a specific room.
 */
function getRoomParticipants(roomId) {
  const participants = [];
  for (const user of users.values()) {
    if (user.roomId === roomId) {
      participants.push(user);
    }
  }
  return participants;
}

/**
 * Internal logic for joining or switching rooms
 */
function executeRoomJoin(socket, targetRoomId, newUsername) {
  const user = users.get(socket.id);
  if (!user) return;

  const targetRoom = sanitizeRoomId(targetRoomId || DEFAULT_ROOM);
  const oldRoom = user.roomId;
  const targetUsername = newUsername ? sanitizeUsername(newUsername, user.username) : user.username;

  // Duplicate Join Guard: Idempotent if already in target room with identical username
  if (oldRoom === targetRoom && user.username === targetUsername) {
    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });
    return;
  }

  // Same room, username change only
  if (oldRoom === targetRoom) {
    user.username = targetUsername;
    users.set(socket.id, user);
    socket.to(targetRoom).emit("participantJoined", user);
    socket.broadcast.emit("userJoined", user);
    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });
    return;
  }

  // Room Switch: Leave old room and announce departure
  socket.leave(oldRoom);
  socket.to(oldRoom).emit("participantLeft", {
    id: socket.id,
    username: user.username,
    roomId: oldRoom,
  });

  // Join new room
  socket.join(targetRoom);
  user.roomId = targetRoom;
  user.username = targetUsername;
  users.set(socket.id, user);

  console.log(`[ROOM SWITCH] User ${socket.id} moved from ${oldRoom} to ${targetRoom}`);

  socket.emit("roomParticipants", {
    roomId: targetRoom,
    participants: getRoomParticipants(targetRoom),
  });

  socket.to(targetRoom).emit("participantJoined", user);
  socket.broadcast.emit("userJoined", user);
}

/**
 * Internal logic for updating avatar position
 */
function handleUpdatePosition(socket, positionData) {
  try {
    if (!positionData || typeof positionData !== "object" || Array.isArray(positionData)) {
      socket.emit("error:validation", { message: "Position payload must be an object" });
      return;
    }

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

    const boundedX = clamp(positionData.x, MAP_BOUNDS.MIN_X, MAP_BOUNDS.MAX_X);
    const boundedY = clamp(positionData.y, MAP_BOUNDS.MIN_Y, MAP_BOUNDS.MAX_Y);

    currentUser.x = boundedX;
    currentUser.y = boundedY;
    users.set(socket.id, currentUser);

    const updatePayload = {
      id: socket.id,
      username: currentUser.username,
      roomId: currentUser.roomId,
      x: boundedX,
      y: boundedY,
      color: currentUser.color,
    };

    // Broadcast position update to peers without echo back to sender
    socket.broadcast.emit("userPositionUpdated", updatePayload);
    socket.broadcast.emit("userMoved", updatePayload);
  } catch (err) {
    console.error(`[UPDATE POSITION ERROR] ${socket.id}:`, err.message);
    socket.emit("error:validation", { message: "Internal error processing position" });
  }
}

function registerSocketHandlers(io, socket) {
  const clientIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  const transportName = socket.conn.transport.name;
  console.log(`[SOCKET CONNECT] User connected: ${socket.id} (IP: ${clientIp}, Transport: ${transportName})`);

  socket.on("error", (err) => {
    console.error(`[SOCKET ERROR] Socket ${socket.id} error:`, err?.message || err);
  });

  // Default user record upon connection
  const defaultUser = {
    id: socket.id,
    username: `User-${socket.id.slice(0, 4)}`,
    roomId: DEFAULT_ROOM,
    x: Math.floor(100 + Math.random() * 400),
    y: Math.floor(100 + Math.random() * 300),
    color: getRandomColor(),
  };

  users.set(socket.id, defaultUser);

  // Automatically join default room
  socket.join(DEFAULT_ROOM);

  // 1. Connection Acknowledgment: Confirm connection to the client with session metadata
  socket.emit("connectionAck", {
    status: "connected",
    socketId: socket.id,
    user: defaultUser,
    serverTime: new Date().toISOString(),
  });

  // 2. Initial sync: Send current room participants and all users to newly connected client
  socket.emit("roomParticipants", {
    roomId: DEFAULT_ROOM,
    participants: getRoomParticipants(DEFAULT_ROOM),
  });
  socket.emit("currentUsers", Array.from(users.values()));

  // 3. Broadcast to peers that a participant/user joined
  socket.to(DEFAULT_ROOM).emit("participantJoined", defaultUser);
  socket.broadcast.emit("userJoined", defaultUser);

  // 4. Room Join / Switch Handler with Duplicate Join Protection
  socket.on("joinRoom", (data = {}) => {
    try {
      if (data && typeof data === "object") {
        executeRoomJoin(socket, data.roomId, data.username);
      } else if (typeof data === "string") {
        executeRoomJoin(socket, data, null);
      } else {
        socket.emit("error:validation", { message: "Invalid joinRoom payload" });
      }
    } catch (err) {
      console.error(`[JOIN ROOM ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Failed to join room" });
    }
  });

  // Alias join handler
  socket.on("join", (userData = {}) => {
    try {
      const parsedData = typeof userData === "string" ? { username: userData } : (userData || {});
      const user = users.get(socket.id) || defaultUser;
      const targetUsername = parsedData.username ? sanitizeUsername(parsedData.username, user.username) : user.username;

      if (parsedData.roomId) {
        executeRoomJoin(socket, parsedData.roomId, targetUsername);
        return;
      }

      if (user.username === targetUsername && users.has(socket.id)) {
        return;
      }

      user.username = targetUsername;
      users.set(socket.id, user);
      socket.broadcast.emit("userJoined", user);
      socket.to(user.roomId).emit("participantJoined", user);
    } catch (err) {
      console.error(`[JOIN ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Failed to process join" });
    }
  });

  // 5. Leave Room Handler
  socket.on("leaveRoom", (data = {}) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const roomPayload = (data && typeof data === "object") ? data : {};
      const roomToLeave = sanitizeRoomId(roomPayload.roomId || user.roomId);

      if (roomToLeave === DEFAULT_ROOM) {
        return;
      }

      socket.leave(roomToLeave);

      socket.to(roomToLeave).emit("participantLeft", {
        id: socket.id,
        username: user.username,
        roomId: roomToLeave,
      });

      // Revert to default room
      socket.join(DEFAULT_ROOM);
      user.roomId = DEFAULT_ROOM;
      users.set(socket.id, user);

      socket.emit("roomParticipants", {
        roomId: DEFAULT_ROOM,
        participants: getRoomParticipants(DEFAULT_ROOM),
      });
      socket.to(DEFAULT_ROOM).emit("participantJoined", user);
    } catch (err) {
      console.error(`[LEAVE ROOM ERROR] ${socket.id}:`, err.message);
    }
  });

  // 6. Get participants for a room
  socket.on("getParticipants", (data = {}, callback) => {
    const roomPayload = (data && typeof data === "object") ? data : {};
    const roomId = sanitizeRoomId(roomPayload.roomId || DEFAULT_ROOM);
    const participants = getRoomParticipants(roomId);
    if (typeof callback === "function") {
      callback({ roomId, participants });
    } else {
      socket.emit("roomParticipants", { roomId, participants });
    }
  });

  // 7. User Position Updates & Broadcasting
  socket.on("updatePosition", (positionData) => {
    handleUpdatePosition(socket, positionData);
  });

  // Backward-compatible alias for updatePosition
  socket.on("userMoved", (positionData) => {
    handleUpdatePosition(socket, positionData);
  });

  // 8. WebRTC Signaling Relays with Target Validation
  socket.on("signal:offer", ({ targetId, offer } = {}) => {
    if (!targetId || !users.has(targetId)) {
      socket.emit("signal:error", { message: "Target peer not found or disconnected", targetId });
      return;
    }
    if (offer) {
      io.to(targetId).emit("signal:offer", {
        senderId: socket.id,
        offer,
      });
    }
  });

  socket.on("signal:answer", ({ targetId, answer } = {}) => {
    if (!targetId || !users.has(targetId)) {
      socket.emit("signal:error", { message: "Target peer not found or disconnected", targetId });
      return;
    }
    if (answer) {
      io.to(targetId).emit("signal:answer", {
        senderId: socket.id,
        answer,
      });
    }
  });

  socket.on("signal:ice-candidate", ({ targetId, candidate } = {}) => {
    if (!targetId || !users.has(targetId)) {
      socket.emit("signal:error", { message: "Target peer not found or disconnected", targetId });
      return;
    }
    if (candidate) {
      io.to(targetId).emit("signal:ice-candidate", {
        senderId: socket.id,
        candidate,
      });
    }
  });

  // 9. Ping-Pong event (maintains backward compatibility)
  socket.on("ping", (data) => {
    socket.emit("pong", data || "pong");
  });

  // 10. Spatial Proximity & Nearby Participants Query
  socket.on("getNearbyUsers", (data = {}, callback) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;
      const radius = isFiniteNumber(data.radius) ? clamp(data.radius, 10, 2000) : 300;
      const roomParticipants = getRoomParticipants(user.roomId);
      const nearby = getNearbyParticipants(user, roomParticipants, radius);

      if (typeof callback === "function") {
        callback({ roomId: user.roomId, radius, nearby });
      } else {
        socket.emit("nearbyUsers", { roomId: user.roomId, radius, nearby });
      }
    } catch (err) {
      console.error(`[PROXIMITY ERROR] ${socket.id}:`, err.message);
    }
  });

  // 11. Voluntary Client Disconnection Request
  socket.on("clientDisconnect", () => {
    console.log(`[CLIENT DISCONNECT REQUEST] Client ${socket.id} requested disconnect`);
    socket.disconnect(true);
  });

  // 11. Disconnecting Lifecycle (Fired BEFORE leaving rooms)
  socket.on("disconnecting", (reason) => {
    const existingUser = users.get(socket.id);
    console.log(`[SOCKET DISCONNECTING] User ${socket.id} disconnecting. Reason: ${reason}. Active rooms:`, Array.from(socket.rooms));

    const notifiedRooms = new Set();
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        notifiedRooms.add(room);
        socket.to(room).emit("participantLeft", {
          id: socket.id,
          username: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
          roomId: room,
          reason,
        });
      }
    }

    if (existingUser?.roomId && !notifiedRooms.has(existingUser.roomId)) {
      socket.to(existingUser.roomId).emit("participantLeft", {
        id: socket.id,
        username: existingUser.username,
        roomId: existingUser.roomId,
        reason,
      });
    }
  });

  // 12. Disconnect Lifecycle with Dual-Format Notification (Frontend String + Backend Object)
  socket.on("disconnect", (reason) => {
    if (!users.has(socket.id)) {
      return;
    }

    const existingUser = users.get(socket.id);
    users.delete(socket.id);

    console.log(`[SOCKET DISCONNECT] User disconnected: ${socket.id} (Reason: ${reason}). Remaining users: ${users.size}`);

    // Notify remaining clients across the server with structured disconnect payload
    const disconnectPayload = {
      id: socket.id,
      username: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
      reason,
    };

    socket.broadcast.emit("userDisconnected", disconnectPayload);
    socket.broadcast.emit("userLeft", disconnectPayload);
  });
}

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
  getRoomParticipants,
  getUserCount,
  hasUser,
  clearUsers,
  isFiniteNumber,
  clamp,
  sanitizeUsername,
  sanitizeRoomId,
  calculateDistance,
  calculateAudioVolume,
  calculateAudioPan,
  getNearbyParticipants,
  DEFAULT_ROOM,
  MAP_BOUNDS,
};
