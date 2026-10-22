/**
 * Socket.IO event handlers for ProxiSpeak
 * Handles connection lifecycle, strict input validation, real-time position broadcasting,
 * room join/leave logic, participant updates, duplicate event protection, and concurrency safety.
 */

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
  const trimmed = input.trim();
  if (trimmed.length === 0) return defaultName;
  return trimmed.slice(0, 30);
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
      const user = users.get(socket.id);
      if (!user) return;

      const targetRoom = sanitizeRoomId(data.roomId || DEFAULT_ROOM);
      const oldRoom = user.roomId;
      const targetUsername = data.username ? sanitizeUsername(data.username, user.username) : user.username;

      // Duplicate Join Guard: If user is already in the room and username is unchanged, ignore redundant join
      if (oldRoom === targetRoom && user.username === targetUsername) {
        socket.emit("roomParticipants", {
          roomId: targetRoom,
          participants: getRoomParticipants(targetRoom),
        });
        return;
      }

      // If room is unchanged but username changed, update and notify room
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

      // Room Switch: Leave old room
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
    } catch (err) {
      console.error(`[JOIN ROOM ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Failed to join room" });
    }
  });

  // Alias join handler with duplicate join check
  socket.on("join", (userData = {}) => {
    const user = users.get(socket.id) || defaultUser;
    const targetUsername = userData.username ? sanitizeUsername(userData.username, user.username) : user.username;

    if (userData.roomId) {
      socket.emit("joinRoom", { roomId: userData.roomId, username: targetUsername });
      return;
    }

    // If username didn't change, avoid redundant broadcast
    if (user.username === targetUsername && users.has(socket.id)) {
      return;
    }

    user.username = targetUsername;
    users.set(socket.id, user);
    socket.broadcast.emit("userJoined", user);
  });

  // 5. Leave Room Handler
  socket.on("leaveRoom", (data = {}) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      const roomToLeave = sanitizeRoomId(data.roomId || user.roomId);

      // Guard: already in default room
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
    const roomId = sanitizeRoomId(data.roomId || DEFAULT_ROOM);
    const participants = getRoomParticipants(roomId);
    if (typeof callback === "function") {
      callback({ roomId, participants });
    } else {
      socket.emit("roomParticipants", { roomId, participants });
    }
  });

  // 7. User Position Updates & Broadcasting
  socket.on("updatePosition", (positionData) => {
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
      };

      // Broadcast position updates to all other connected clients
      socket.broadcast.emit("userPositionUpdated", updatePayload);
      socket.broadcast.emit("userMoved", updatePayload);
    } catch (err) {
      console.error(`[UPDATE POSITION ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Internal error processing position" });
    }
  });

  socket.on("userMoved", (positionData) => {
    socket.emit("updatePosition", positionData);
  });

  // 8. WebRTC Signaling Relays for Voice Communication
  socket.on("signal:offer", ({ targetId, offer }) => {
    if (targetId && offer) {
      io.to(targetId).emit("signal:offer", {
        senderId: socket.id,
        offer,
      });
    }
  });

  socket.on("signal:answer", ({ targetId, answer }) => {
    if (targetId && answer) {
      io.to(targetId).emit("signal:answer", {
        senderId: socket.id,
        answer,
      });
    }
  });

  socket.on("signal:ice-candidate", ({ targetId, candidate }) => {
    if (targetId && candidate) {
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

  // 10. Voluntary Client Disconnection Request
  socket.on("clientDisconnect", () => {
    console.log(`[CLIENT DISCONNECT REQUEST] Client ${socket.id} requested disconnect`);
    socket.disconnect(true);
  });

  // 11. Disconnecting Lifecycle (Fired BEFORE leaving rooms)
  socket.on("disconnecting", (reason) => {
    const existingUser = users.get(socket.id);
    console.log(`[SOCKET DISCONNECTING] User ${socket.id} disconnecting. Reason: ${reason}. Active rooms:`, Array.from(socket.rooms));

    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("participantLeft", {
          id: socket.id,
          username: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
          roomId: room,
          reason,
        });
      }
    }
  });

  // 12. Disconnect Lifecycle with Duplicate Disconnect Protection
  socket.on("disconnect", (reason) => {
    // Duplicate Disconnect Guard: Ensure cleanup only happens once per socket
    if (!users.has(socket.id)) {
      return;
    }

    const existingUser = users.get(socket.id);
    users.delete(socket.id);

    console.log(`[SOCKET DISCONNECT] User disconnected: ${socket.id} (Reason: ${reason}). Remaining users: ${users.size}`);

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
  DEFAULT_ROOM,
  MAP_BOUNDS,
};
