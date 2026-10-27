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

// In-memory store of active users: socket.id -> { id, username, roomId, x, y, color, isMuted }
const users = new Map();

// In-memory store of active audio calls:
// activeAudioCalls: callId -> { callId, callerId, calleeId, startedAt, status }
// userCallMap: socketId -> Set<callId>
const activeAudioCalls = new Map();
const userCallMap = new Map();

/**
 * Registers an active audio call between two peers
 */
function registerCall(callerId, calleeId) {
  const callId = `call_${callerId}_${calleeId}_${Date.now()}`;
  const callRecord = {
    callId,
    callerId,
    calleeId,
    startedAt: Date.now(),
    status: "active",
  };
  activeAudioCalls.set(callId, callRecord);

  if (!userCallMap.has(callerId)) userCallMap.set(callerId, new Set());
  if (!userCallMap.has(calleeId)) userCallMap.set(calleeId, new Set());
  userCallMap.get(callerId).add(callId);
  userCallMap.get(calleeId).add(callId);

  return callRecord;
}

/**
 * Terminates any active call between two specific users
 */
function endCallBetween(userA, userB) {
  const callsToTerminate = [];
  for (const [callId, call] of activeAudioCalls.entries()) {
    if (
      (call.callerId === userA && call.calleeId === userB) ||
      (call.callerId === userB && call.calleeId === userA)
    ) {
      callsToTerminate.push(callId);
    }
  }
  for (const callId of callsToTerminate) {
    const call = activeAudioCalls.get(callId);
    if (call) {
      userCallMap.get(call.callerId)?.delete(callId);
      userCallMap.get(call.calleeId)?.delete(callId);
      activeAudioCalls.delete(callId);
    }
  }
  return callsToTerminate.length > 0;
}

/**
 * Returns all peer socket IDs currently in an active call with socketId
 */
function getCallPeers(socketId) {
  const callIds = userCallMap.get(socketId);
  if (!callIds || callIds.size === 0) return [];
  const peers = new Set();
  for (const callId of callIds) {
    const call = activeAudioCalls.get(callId);
    if (call) {
      if (call.callerId === socketId) peers.add(call.calleeId);
      else if (call.calleeId === socketId) peers.add(call.callerId);
    }
  }
  return Array.from(peers);
}

/**
 * Cleans up all active audio call states for a disconnected user
 * Notifies each connected peer that the call has ended
 */
function cleanupUserCalls(socketId, io, reason = "peer_disconnected") {
  const callIds = userCallMap.get(socketId);
  if (!callIds || callIds.size === 0) return [];
  const terminatedPeers = [];

  for (const callId of Array.from(callIds)) {
    const call = activeAudioCalls.get(callId);
    if (call) {
      const otherPeerId = call.callerId === socketId ? call.calleeId : call.callerId;
      userCallMap.get(otherPeerId)?.delete(callId);
      activeAudioCalls.delete(callId);

      if (otherPeerId) {
        terminatedPeers.push(otherPeerId);
        if (io) {
          io.to(otherPeerId).emit("signal:call-ended", {
            peerId: socketId,
            reason,
            callId,
          });
          io.to(otherPeerId).emit("callEnded", {
            peerId: socketId,
            reason,
          });
        }
      }
    }
  }
  userCallMap.delete(socketId);
  return terminatedPeers;
}

function getActiveCallsCount() {
  return activeAudioCalls.size;
}

function clearActiveCalls() {
  activeAudioCalls.clear();
  userCallMap.clear();
}

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

  // 8. WebRTC Audio Calling Signaling & Call State Handlers
  const handleCallUser = ({ targetId, userToCall, metadata = {}, signalData } = {}) => {
    const target = targetId || userToCall;
    if (!target) {
      socket.emit("signal:error", { message: "Target peer ID is required", targetId: null });
      return;
    }
    if (target === socket.id) {
      socket.emit("signal:error", { message: "Cannot call yourself", targetId: target });
      return;
    }
    if (!users.has(target)) {
      socket.emit("signal:error", { message: "Target peer not found or offline", targetId: target });
      return;
    }

    const caller = users.get(socket.id);
    const callerName = caller ? caller.username : `User-${socket.id.slice(0, 4)}`;

    io.to(target).emit("signal:incoming-call", {
      callerId: socket.id,
      callerName,
      metadata,
      signalData,
    });

    // Also emit frontend-compatible alias
    io.to(target).emit("callUser", {
      from: socket.id,
      name: callerName,
      signal: signalData,
    });
  };

  socket.on("signal:call-user", handleCallUser);
  socket.on("callUser", handleCallUser);

  const handleAcceptCall = ({ targetId, to, signal } = {}) => {
    const target = targetId || to;
    if (!target || !users.has(target)) {
      socket.emit("signal:error", { message: "Caller peer not found or offline", targetId: target });
      return;
    }

    const call = registerCall(target, socket.id);
    const callee = users.get(socket.id);
    const calleeName = callee ? callee.username : `User-${socket.id.slice(0, 4)}`;

    io.to(target).emit("signal:call-accepted", {
      peerId: socket.id,
      peerName: calleeName,
      callId: call.callId,
      signal,
    });

    io.to(target).emit("callAccepted", {
      signal,
      from: socket.id,
    });
  };

  socket.on("signal:accept-call", handleAcceptCall);
  socket.on("answerCall", handleAcceptCall);

  socket.on("signal:reject-call", ({ targetId, reason = "declined" } = {}) => {
    if (targetId && users.has(targetId)) {
      io.to(targetId).emit("signal:call-rejected", {
        peerId: socket.id,
        reason,
      });
      io.to(targetId).emit("callRejected", {
        peerId: socket.id,
        reason,
      });
    }
  });

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

  const handleEndCall = ({ targetId, reason = "call_ended" } = {}) => {
    if (targetId) {
      endCallBetween(socket.id, targetId);
      if (users.has(targetId)) {
        io.to(targetId).emit("signal:call-ended", {
          peerId: socket.id,
          reason,
        });
        io.to(targetId).emit("callEnded", {
          peerId: socket.id,
          reason,
        });
      }
      socket.emit("signal:call-ended", {
        peerId: targetId,
        reason,
      });
    } else {
      cleanupUserCalls(socket.id, io, reason);
    }
  };

  socket.on("signal:end-call", handleEndCall);
  socket.on("signal:hangup", handleEndCall);
  socket.on("endCall", handleEndCall);

  socket.on("signal:mute-status", ({ targetId, isMuted } = {}) => {
    const user = users.get(socket.id);
    const muted = Boolean(isMuted);
    if (user) {
      user.isMuted = muted;
      socket.to(user.roomId).emit("userMuteChanged", {
        id: socket.id,
        isMuted: muted,
      });
    }
    if (targetId && users.has(targetId)) {
      io.to(targetId).emit("signal:mute-status", {
        peerId: socket.id,
        isMuted: muted,
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

    // Clean up all active WebRTC audio calls and notify peers immediately
    cleanupUserCalls(socket.id, io, reason || "peer_disconnected");

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
    // Secondary safety cleanup for audio calls in case disconnecting did not trigger
    cleanupUserCalls(socket.id, io, reason || "peer_disconnected");

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
  clearActiveCalls();
}

module.exports = {
  registerSocketHandlers,
  users,
  activeAudioCalls,
  userCallMap,
  registerCall,
  endCallBetween,
  getCallPeers,
  cleanupUserCalls,
  getActiveCallsCount,
  clearActiveCalls,
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
