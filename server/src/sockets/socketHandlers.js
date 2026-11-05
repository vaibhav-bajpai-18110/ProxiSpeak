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

// In-memory store of rooms: roomId -> { id, name, description, maxParticipants, isPrivate, isDefault, createdBy, createdAt }
const rooms = new Map();

const DEFAULT_ROOMS = [
  { id: "main-office", name: "Main Office", description: "Central virtual workspace", maxParticipants: 50, isDefault: true },
  { id: "meeting-room-a", name: "Meeting Room A", description: "Focus & presentation room", maxParticipants: 10, isDefault: false },
  { id: "meeting-room-b", name: "Meeting Room B", description: "Collaborative breakout space", maxParticipants: 10, isDefault: false },
  { id: "lounge", name: "Lounge / Cafeteria", description: "Casual watercooler chat", maxParticipants: 25, isDefault: false },
];

function initDefaultRooms() {
  rooms.clear();
  DEFAULT_ROOMS.forEach((r) => {
    rooms.set(r.id, { ...r, isPrivate: false, createdBy: "system", createdAt: new Date().toISOString() });
  });
}
initDefaultRooms();

function getRoomsList() {
  return Array.from(rooms.values()).map((r) => ({
    ...r,
    currentParticipants: getRoomParticipants(r.id).length,
  }));
}

function getRoomMeta(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }
  const autoRoom = {
    id: roomId,
    name: roomId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: "Dynamic office room",
    maxParticipants: 25,
    isPrivate: false,
    isDefault: roomId === DEFAULT_ROOM,
    createdBy: "dynamic",
    createdAt: new Date().toISOString(),
  };
  rooms.set(roomId, autoRoom);
  return autoRoom;
}

function createRoom({ roomId, name, description, maxParticipants, isPrivate = false } = {}, creatorId = "system") {
  const sanitizedId = sanitizeRoomId(roomId || name || `room-${Date.now()}`);
  const sanitizedName = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 50) : sanitizedId;
  const sanitizedDesc = typeof description === "string" ? description.trim().slice(0, 200) : "";
  const maxCap = (typeof maxParticipants === "number" && maxParticipants > 0) ? Math.min(100, Math.max(2, Math.round(maxParticipants))) : 25;

  if (rooms.has(sanitizedId)) {
    return { success: false, error: "Room already exists", roomId: sanitizedId };
  }

  const roomRecord = {
    id: sanitizedId,
    name: sanitizedName,
    description: sanitizedDesc,
    maxParticipants: maxCap,
    isPrivate: Boolean(isPrivate),
    isDefault: sanitizedId === DEFAULT_ROOM,
    createdBy: creatorId,
    createdAt: new Date().toISOString(),
  };

  rooms.set(sanitizedId, roomRecord);
  return { success: true, room: roomRecord };
}

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

// Availability status options
const VALID_AVAILABILITY = ["available", "away", "busy", "dnd"];

// In-memory store of user profiles: userId -> profile object
const profiles = new Map();

// In-memory store of room chat messages: roomId -> Array of message records
const roomChatMessages = new Map();

function saveRoomMessage(roomId, senderId, senderName, messageText) {
  const cleanRoomId = sanitizeRoomId(roomId || DEFAULT_ROOM);
  if (typeof messageText !== "string" || messageText.trim().length === 0) {
    return { success: false, message: "Chat message cannot be empty", code: "VALIDATION_ERROR" };
  }
  const cleanText = messageText.trim().slice(0, 500);
  const cleanSenderName = (typeof senderName === "string" && senderName.trim().length > 0)
    ? senderName.trim().slice(0, 30)
    : `User-${senderId ? senderId.slice(0, 4) : "anon"}`;

  const messageRecord = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    roomId: cleanRoomId,
    senderId: senderId || "system",
    senderName: cleanSenderName,
    message: cleanText,
    text: cleanText,
    timestamp: new Date().toISOString(),
  };

  if (!roomChatMessages.has(cleanRoomId)) {
    roomChatMessages.set(cleanRoomId, []);
  }
  const history = roomChatMessages.get(cleanRoomId);
  history.push(messageRecord);
  if (history.length > 100) {
    history.shift();
  }

  return { success: true, message: messageRecord };
}

function getRoomMessages(roomId) {
  const cleanRoomId = sanitizeRoomId(roomId || DEFAULT_ROOM);
  return roomChatMessages.get(cleanRoomId) || [];
}

function isValidHexColor(color) {
  if (typeof color !== "string") return false;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim());
}

function validateProfileData(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, message: "Profile payload must be a JSON object" };
  }

  const rawUsername = data.username !== undefined ? data.username : data.displayName;
  if (rawUsername !== undefined) {
    if (typeof rawUsername !== "string" || rawUsername.trim().length === 0) {
      return { valid: false, message: "Username must be a non-empty string" };
    }
    if (rawUsername.trim().length > 30) {
      return { valid: false, message: "Username must not exceed 30 characters" };
    }
  }

  const rawColor = data.color !== undefined ? data.color : data.avatarColor;
  if (rawColor !== undefined) {
    if (!isValidHexColor(rawColor)) {
      return { valid: false, message: "Color must be a valid hex color code (e.g. #3B82F6)" };
    }
  }

  const rawStatus = data.status !== undefined ? data.status : data.availability;
  if (rawStatus !== undefined) {
    if (!VALID_AVAILABILITY.includes(String(rawStatus).toLowerCase())) {
      return {
        valid: false,
        message: `Status must be one of: ${VALID_AVAILABILITY.join(", ")}`,
      };
    }
  }

  return { valid: true };
}

function getProfile(userId) {
  if (!userId || typeof userId !== "string") return null;
  const cleanId = userId.trim();
  if (profiles.has(cleanId)) {
    return profiles.get(cleanId);
  }

  // If user is currently in active socket sessions, synthesize from socket user
  for (const [sId, u] of users.entries()) {
    if (sId === cleanId || u.id === cleanId || u.userId === cleanId) {
      return {
        userId: cleanId,
        username: u.username,
        displayName: u.username,
        color: u.color,
        avatarColor: u.color,
        status: u.status || "available",
        availability: u.status || "available",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return null;
}

function saveProfile(userId, data = {}) {
  if (!userId || typeof userId !== "string") {
    return { success: false, message: "User ID is required", code: "INVALID_USER_ID" };
  }

  const validation = validateProfileData(data);
  if (!validation.valid) {
    return { success: false, message: validation.message, code: "VALIDATION_ERROR" };
  }

  const cleanId = userId.trim();
  const existing = profiles.get(cleanId) || {
    userId: cleanId,
    username: `User-${cleanId.slice(0, 4)}`,
    displayName: `User-${cleanId.slice(0, 4)}`,
    color: AVATAR_COLORS[0],
    avatarColor: AVATAR_COLORS[0],
    status: "available",
    availability: "available",
    createdAt: new Date().toISOString(),
  };

  const rawUsername = data.username !== undefined ? data.username : data.displayName;
  const cleanUsername = rawUsername ? sanitizeUsername(rawUsername, existing.username) : existing.username;

  const rawColor = data.color !== undefined ? data.color : data.avatarColor;
  const cleanColor = rawColor ? rawColor.trim() : existing.color;

  const rawStatus = data.status !== undefined ? data.status : data.availability;
  const cleanStatus = rawStatus ? String(rawStatus).toLowerCase() : existing.status;

  const updatedProfile = {
    userId: cleanId,
    username: cleanUsername,
    displayName: cleanUsername,
    color: cleanColor,
    avatarColor: cleanColor,
    status: cleanStatus,
    availability: cleanStatus,
    updatedAt: new Date().toISOString(),
  };

  profiles.set(cleanId, updatedProfile);

  // Synchronize with active socket user if connected
  for (const [sId, u] of users.entries()) {
    if (sId === cleanId || u.id === cleanId || u.userId === cleanId) {
      u.name = cleanUsername;
      u.username = cleanUsername;
      u.displayName = cleanUsername;
      u.color = cleanColor;
      u.avatarColor = cleanColor;
      u.status = cleanStatus;
      u.availability = cleanStatus;
      users.set(sId, u);
    }
  }

  return { success: true, profile: updatedProfile };
}

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
  const clean = roomId.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "");
  return clean.length > 0 ? clean.slice(0, 50) : DEFAULT_ROOM;
}

/**
 * Returns all active users in a specific room.
 */
function getRoomParticipants(roomId) {
  const participants = [];
  for (const user of users.values()) {
    if (user.roomId === roomId) {
      participants.push({ ...user });
    }
  }
  return participants;
}

/**
 * Internal logic for joining or switching rooms
 */
function executeRoomJoin(socket, targetRoomId, newUsername, io, extraData = {}) {
  const user = users.get(socket.id);
  if (!user) return false;

  const targetRoom = sanitizeRoomId(targetRoomId || DEFAULT_ROOM);
  const oldRoom = user.roomId;
  const targetUsername = newUsername ? sanitizeUsername(newUsername, user.username) : user.username;

  if (extraData && typeof extraData === "object" && extraData.userId) {
    user.userId = extraData.userId;
    const saved = getProfile(extraData.userId);
    if (saved) {
      user.color = saved.color || user.color;
      user.avatarColor = saved.avatarColor || user.color;
      user.status = saved.status || user.status;
      user.availability = saved.availability || user.status;
    }
  }

  // Duplicate Join Guard: Idempotent if already in target room with identical username
  if (oldRoom === targetRoom && user.username === targetUsername) {
    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });
    return true;
  }

  // Same room, username change only
  if (oldRoom === targetRoom) {
    user.username = targetUsername;
    user.name = targetUsername;
    user.displayName = targetUsername;
    users.set(socket.id, user);
    socket.to(targetRoom).emit("participantJoined", user);
    socket.broadcast.emit("userJoined", user);
    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });
    return true;
  }

  // Room Capacity Enforcement
  const roomMeta = getRoomMeta(targetRoom);
  if (roomMeta && typeof roomMeta.maxParticipants === "number" && oldRoom !== targetRoom) {
    const currentCount = getRoomParticipants(targetRoom).length;
    if (currentCount >= roomMeta.maxParticipants) {
      socket.emit("error:room", {
        message: "Room is full",
        roomId: targetRoom,
        maxParticipants: roomMeta.maxParticipants,
        currentCount,
      });
      return false;
    }
  }

  // Terminate any active calls from old room when switching rooms (prevents cross-room zombie audio calls)
  cleanupUserCalls(socket.id, io, "room_switched");

  // Room Switch: Leave old room and announce departure
  socket.leave(oldRoom);
  socket.to(oldRoom).emit("participantLeft", {
    id: socket.id,
    name: user.username,
    username: user.username,
    roomId: oldRoom,
    reason: "room_switched",
  });

  // Join new room
  socket.join(targetRoom);
  user.roomId = targetRoom;
  user.username = targetUsername;
  user.name = targetUsername;
  user.displayName = targetUsername;
  users.set(socket.id, user);

  console.log(`[ROOM SWITCH] User ${socket.id} moved from ${oldRoom} to ${targetRoom}`);

  socket.emit("roomParticipants", {
    roomId: targetRoom,
    participants: getRoomParticipants(targetRoom),
  });

  socket.to(targetRoom).emit("participantJoined", user);
  socket.broadcast.emit("userJoined", user);
  return true;
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

    if (positionData.roomId && typeof positionData.roomId === "string") {
      const targetRoom = sanitizeRoomId(positionData.roomId);
      if (rooms.has(targetRoom)) {
        currentUser.roomId = targetRoom;
      }
    }

    currentUser.x = boundedX;
    currentUser.y = boundedY;
    users.set(socket.id, currentUser);

    const updatePayload = {
      id: socket.id,
      name: currentUser.username,
      displayName: currentUser.username,
      username: currentUser.username,
      roomId: currentUser.roomId,
      x: boundedX,
      y: boundedY,
      color: currentUser.color,
      avatarColor: currentUser.color,
      status: currentUser.status || "available",
      availability: currentUser.status || "available",
    };

    // Broadcast position update to peers: room-scoped and backward-compatible global broadcast
    socket.to(currentUser.roomId).emit("roomPositionUpdated", updatePayload);
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

  // Handshake recovery parameters for seamless reconnection
  const auth = socket.handshake.auth || {};
  const query = socket.handshake.query || {};
  const initialUserId = auth.userId || query.userId || null;
  const initialUsername = auth.username || query.username || null;
  const initialRoomId = sanitizeRoomId(auth.roomId || query.roomId || DEFAULT_ROOM);

  let assignedColor = getRandomColor();
  let assignedStatus = "available";
  let username = initialUsername ? sanitizeUsername(initialUsername) : `User-${socket.id.slice(0, 4)}`;

  if (initialUserId) {
    const saved = getProfile(initialUserId);
    if (saved) {
      assignedColor = saved.color || saved.avatarColor || assignedColor;
      assignedStatus = saved.status || saved.availability || assignedStatus;
      if (!initialUsername && saved.username) {
        username = saved.username;
      }
    }
  }

  // Default user record upon connection
  const defaultUser = {
    id: socket.id,
    userId: initialUserId || socket.id,
    name: username,
    username: username,
    displayName: username,
    roomId: initialRoomId,
    x: Math.floor(100 + Math.random() * 400),
    y: Math.floor(100 + Math.random() * 300),
    color: assignedColor,
    avatarColor: assignedColor,
    status: assignedStatus,
    availability: assignedStatus,
  };

  users.set(socket.id, defaultUser);

  // Automatically join default room (or configured initialRoomId)
  socket.join(initialRoomId);

  // 1. Connection Acknowledgment: Confirm connection to the client with session metadata
  socket.emit("connectionAck", {
    status: "connected",
    socketId: socket.id,
    user: defaultUser,
    serverTime: new Date().toISOString(),
  });

  // 2. Initial sync: Send current room participants and all users to newly connected client
  socket.emit("roomParticipants", {
    roomId: initialRoomId,
    participants: getRoomParticipants(initialRoomId),
  });
  socket.emit("currentUsers", Array.from(users.values()));
  socket.emit("roomList", getRoomsList());

  // 3. Broadcast to peers that a participant/user joined
  socket.to(initialRoomId).emit("participantJoined", defaultUser);
  socket.broadcast.emit("userJoined", defaultUser);

  // 4. Room Creation Handler
  socket.on("createRoom", (data = {}, callback) => {
    try {
      if (!data || typeof data !== "object") {
        const errPayload = { success: false, message: "Invalid payload for createRoom" };
        if (typeof callback === "function") callback(errPayload);
        else socket.emit("error:room", errPayload);
        return;
      }

      const result = createRoom(data, socket.id);
      if (!result.success) {
        if (typeof callback === "function") callback(result);
        else socket.emit("error:room", { message: result.error, roomId: result.roomId });
        return;
      }

      socket.emit("roomCreated", result.room);
      if (typeof callback === "function") callback({ success: true, room: result.room });
      io.emit("roomListUpdated", getRoomsList());
    } catch (err) {
      console.error(`[CREATE ROOM ERROR] ${socket.id}:`, err.message);
      const errPayload = { success: false, message: "Internal error creating room" };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:room", errPayload);
    }
  });

  // Room Directory Query
  socket.on("getRooms", (callback) => {
    const list = getRoomsList();
    if (typeof callback === "function") {
      callback({ success: true, rooms: list });
    } else {
      socket.emit("roomList", list);
    }
  });

  // 5. Room Join / Switch Handler with Duplicate Join Protection & Capacity Enforcement
  socket.on("joinRoom", (data = {}, callback) => {
    try {
      let targetRoomId = DEFAULT_ROOM;
      let targetUsername = null;

      if (data && typeof data === "object") {
        targetRoomId = data.roomId;
        targetUsername = data.username;
      } else if (typeof data === "string") {
        targetRoomId = data;
      } else {
        const errPayload = { success: false, message: "Invalid joinRoom payload" };
        if (typeof callback === "function") callback(errPayload);
        else socket.emit("error:validation", errPayload);
        return;
      }

      const success = executeRoomJoin(socket, targetRoomId, targetUsername, io, data);
      if (typeof callback === "function") {
        if (success === false) {
          callback({ success: false, message: "Room join failed (full or invalid)", roomId: targetRoomId });
        } else {
          const finalRoom = sanitizeRoomId(targetRoomId);
          callback({
            success: true,
            roomId: finalRoom,
            participants: getRoomParticipants(finalRoom),
          });
        }
      }
    } catch (err) {
      console.error(`[JOIN ROOM ERROR] ${socket.id}:`, err.message);
      const errPayload = { success: false, message: "Failed to join room" };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
    }
  });

  // Alias join handler
  socket.on("join", (userData = {}) => {
    try {
      const parsedData = typeof userData === "string" ? { username: userData } : (userData || {});
      const user = users.get(socket.id) || defaultUser;
      const targetUsername = parsedData.username ? sanitizeUsername(parsedData.username, user.username) : user.username;

      if (parsedData.roomId) {
        executeRoomJoin(socket, parsedData.roomId, targetUsername, io, parsedData);
        return;
      }

      if (parsedData.userId) {
        user.userId = parsedData.userId;
        const saved = getProfile(parsedData.userId);
        if (saved) {
          user.color = saved.color || user.color;
          user.avatarColor = saved.avatarColor || user.color;
          user.status = saved.status || user.status;
          user.availability = saved.availability || user.status;
        }
      }

      if (user.username === targetUsername && users.has(socket.id)) {
        return;
      }

      user.username = targetUsername;
      user.name = targetUsername;
      user.displayName = targetUsername;
      users.set(socket.id, user);
      socket.broadcast.emit("userJoined", user);
      socket.to(user.roomId).emit("participantJoined", user);
    } catch (err) {
      console.error(`[JOIN ERROR] ${socket.id}:`, err.message);
      socket.emit("error:validation", { message: "Failed to process join" });
    }
  });

  // Reconnection state recovery & synchronization handler
  socket.on("syncState", (data = {}, callback) => {
    try {
      const user = users.get(socket.id);
      const targetRoom = sanitizeRoomId((data && data.roomId) || user?.roomId || DEFAULT_ROOM);
      const syncPayload = {
        status: "synced",
        socketId: socket.id,
        user: user || defaultUser,
        roomId: targetRoom,
        participants: getRoomParticipants(targetRoom),
        messages: getRoomMessages(targetRoom),
        rooms: getRoomsList(),
        serverTime: new Date().toISOString(),
      };
      if (typeof callback === "function") {
        callback(syncPayload);
      } else {
        socket.emit("syncStateResponse", syncPayload);
      }
    } catch (err) {
      console.error(`[SYNC STATE ERROR] ${socket.id}:`, err.message);
      if (typeof callback === "function") callback({ status: "error", message: err.message });
      else socket.emit("error:validation", { message: "Failed to sync state" });
    }
  });

  socket.on("sync", (data, callback) => {
    const user = users.get(socket.id);
    const targetRoom = sanitizeRoomId((data && data.roomId) || user?.roomId || DEFAULT_ROOM);
    const payload = {
      status: "synced",
      socketId: socket.id,
      participants: getRoomParticipants(targetRoom),
      rooms: getRoomsList(),
    };
    if (typeof callback === "function") callback(payload);
    else socket.emit("syncStateResponse", payload);
  });

  // 6. Leave Room Handler
  socket.on("leaveRoom", (data = {}, callback) => {
    try {
      const user = users.get(socket.id);
      if (!user) {
        if (typeof callback === "function") callback({ success: false, message: "User not found" });
        return;
      }

      const roomPayload = (data && typeof data === "object") ? data : {};
      const roomToLeave = sanitizeRoomId(roomPayload.roomId || user.roomId);

      if (roomToLeave === DEFAULT_ROOM) {
        if (typeof callback === "function") {
          callback({ success: true, roomId: DEFAULT_ROOM, message: "Already in default room" });
        }
        return;
      }

      // Terminate any active calls with peers in the room being left
      cleanupUserCalls(socket.id, io, "room_left");

      socket.leave(roomToLeave);

      socket.to(roomToLeave).emit("participantLeft", {
        id: socket.id,
        username: user.username,
        roomId: roomToLeave,
        reason: "user_left_room",
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

      if (typeof callback === "function") {
        callback({ success: true, leftRoom: roomToLeave, currentRoom: DEFAULT_ROOM });
      }
    } catch (err) {
      console.error(`[LEAVE ROOM ERROR] ${socket.id}:`, err.message);
      if (typeof callback === "function") callback({ success: false, message: err.message });
    }
  });

  // 7. Get participants for a room
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

  // Profile update event via Socket.IO
  socket.on("updateProfile", (data = {}, callback) => {
    try {
      const user = users.get(socket.id);
      const targetUserId = (data && data.userId) || user?.userId || socket.id;
      const result = saveProfile(targetUserId, data);
      if (!result.success) {
        const errPayload = { status: "error", message: result.message, code: result.code };
        if (typeof callback === "function") callback(errPayload);
        else socket.emit("error:validation", errPayload);
        return;
      }
      if (targetUserId !== socket.id) {
        profiles.set(socket.id, result.profile);
      }

      const broadcastPayload = {
        id: socket.id,
        userId: targetUserId,
        name: result.profile.username,
        username: result.profile.username,
        displayName: result.profile.displayName,
        color: result.profile.color,
        avatarColor: result.profile.avatarColor,
        status: result.profile.status,
        availability: result.profile.availability,
        roomId: user?.roomId || DEFAULT_ROOM,
        x: user?.x || 0,
        y: user?.y || 0,
      };

      // Broadcast profile updates in real-time across standard, room, and roster events
      socket.broadcast.emit("userProfileUpdated", broadcastPayload);
      socket.broadcast.emit("profileUpdated", broadcastPayload);
      socket.broadcast.emit("userJoined", broadcastPayload);
      if (user?.roomId) {
        socket.to(user.roomId).emit("roomProfileUpdated", broadcastPayload);
        socket.to(user.roomId).emit("participantJoined", broadcastPayload);
      }

      if (typeof callback === "function") {
        callback({ status: "success", profile: result.profile });
      } else {
        socket.emit("profileUpdated", { status: "success", profile: result.profile });
      }
    } catch (err) {
      console.error(`[UPDATE PROFILE ERROR] ${socket.id}:`, err.message);
      const errPayload = { status: "error", message: "Failed to update profile", code: "INTERNAL_ERROR" };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
    }
  });

  // Query profile via Socket.IO
  socket.on("getProfile", (data = {}, callback) => {
    const user = users.get(socket.id);
    const targetUserId = (typeof data === "string" ? data : data?.userId) || user?.userId || socket.id;
    const profile = getProfile(targetUserId);
    if (!profile) {
      const errPayload = { status: "error", message: `Profile not found for userId: ${targetUserId}` };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
    } else {
      if (typeof callback === "function") callback({ status: "success", profile });
      else socket.emit("profileData", { status: "success", profile });
    }
  });

  // 8. Room Chat Delivery
  const handleSendMessage = (data = {}, callback) => {
    try {
      const user = users.get(socket.id);
      const targetRoomId = (data && data.roomId) ? sanitizeRoomId(data.roomId) : (user?.roomId || DEFAULT_ROOM);
      const text = typeof data === "string" ? data : (data?.message || data?.text || "");

      const result = saveRoomMessage(
        targetRoomId,
        socket.id,
        user?.username || `User-${socket.id.slice(0, 4)}`,
        text
      );

      if (!result.success) {
        const errPayload = { status: "error", message: result.message, code: result.code };
        if (typeof callback === "function") callback(errPayload);
        else socket.emit("error:validation", errPayload);
        return;
      }

      // Broadcast to co-located room members
      io.to(targetRoomId).emit("chat:message", result.message);
      io.to(targetRoomId).emit("chatMessage", result.message);

      if (typeof callback === "function") {
        callback({ status: "success", message: result.message });
      }
    } catch (err) {
      console.error(`[CHAT SEND ERROR] ${socket.id}:`, err.message);
      const errPayload = { status: "error", message: "Failed to send chat message", code: "INTERNAL_ERROR" };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
    }
  };

  socket.on("chat:send", handleSendMessage);
  socket.on("sendMessage", handleSendMessage);
  socket.on("sendChatMessage", handleSendMessage);

  const handleGetChatHistory = (data = {}, callback) => {
    const user = users.get(socket.id);
    const targetRoomId = (data && data.roomId) ? sanitizeRoomId(data.roomId) : (user?.roomId || DEFAULT_ROOM);
    const messages = getRoomMessages(targetRoomId);

    if (typeof callback === "function") {
      callback({ status: "success", roomId: targetRoomId, messages });
    } else {
      socket.emit("chat:history", { status: "success", roomId: targetRoomId, messages });
    }
  };

  socket.on("chat:history", handleGetChatHistory);
  socket.on("getChatHistory", handleGetChatHistory);

  // 9. WebRTC Audio Calling Signaling & Call State Handlers
  const handleCallUser = ({ targetId, userToCall, metadata = {}, signalData } = {}) => {
    const target = targetId || userToCall;
    if (!target) {
      socket.emit("signal:error", { status: "error", message: "Target peer ID is required", targetId: null });
      return;
    }
    if (target === socket.id) {
      socket.emit("signal:error", { status: "error", message: "Cannot call yourself", targetId: target });
      return;
    }
    const caller = users.get(socket.id);
    const targetUser = users.get(target);
    if (!targetUser || (caller && caller.roomId !== targetUser.roomId)) {
      socket.emit("signal:error", {
        status: "error",
        message: "Target peer not found, offline, or not in the same room",
        targetId: target,
      });
      return;
    }

    const callerName = caller ? caller.username : `User-${socket.id.slice(0, 4)}`;

    io.to(target).emit("signal:incoming-call", {
      senderId: socket.id,
      callerId: socket.id,
      callerName,
      metadata,
      signalData,
    });

    // Also emit frontend-compatible alias
    io.to(target).emit("callUser", {
      senderId: socket.id,
      from: socket.id,
      name: callerName,
      signal: signalData,
    });
  };

  socket.on("signal:call-user", handleCallUser);
  socket.on("callUser", handleCallUser);

  const handleAcceptCall = ({ targetId, to, signal } = {}) => {
    const target = targetId || to;
    const callee = users.get(socket.id);
    const targetUser = users.get(target);
    if (!target || !targetUser || (callee && callee.roomId !== targetUser.roomId)) {
      socket.emit("signal:error", {
        status: "error",
        message: "Caller peer not found, offline, or not in the same room",
        targetId: target,
      });
      return;
    }

    const call = registerCall(target, socket.id);
    const calleeName = callee ? callee.username : `User-${socket.id.slice(0, 4)}`;

    io.to(target).emit("signal:call-accepted", {
      senderId: socket.id,
      peerId: socket.id,
      peerName: calleeName,
      callId: call.callId,
      signal,
    });

    io.to(target).emit("callAccepted", {
      senderId: socket.id,
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
    const sender = users.get(socket.id);
    const target = users.get(targetId);
    if (!targetId || !target || (sender && sender.roomId !== target.roomId)) {
      socket.emit("signal:error", {
        status: "error",
        message: "Target peer not found, disconnected, or not in the same room",
        targetId,
      });
      return;
    }
    if (offer) {
      io.to(targetId).emit("signal:offer", {
        senderId: socket.id,
        from: socket.id,
        offer,
      });
    }
  });

  socket.on("signal:answer", ({ targetId, answer } = {}) => {
    const sender = users.get(socket.id);
    const target = users.get(targetId);
    if (!targetId || !target || (sender && sender.roomId !== target.roomId)) {
      socket.emit("signal:error", {
        status: "error",
        message: "Target peer not found, disconnected, or not in the same room",
        targetId,
      });
      return;
    }
    if (answer) {
      io.to(targetId).emit("signal:answer", {
        senderId: socket.id,
        from: socket.id,
        answer,
      });
    }
  });

  socket.on("signal:ice-candidate", ({ targetId, candidate } = {}) => {
    const sender = users.get(socket.id);
    const target = users.get(targetId);
    if (!targetId || !target || (sender && sender.roomId !== target.roomId)) {
      socket.emit("signal:error", {
        status: "error",
        message: "Target peer not found, disconnected, or not in the same room",
        targetId,
      });
      return;
    }
    if (candidate) {
      io.to(targetId).emit("signal:ice-candidate", {
        senderId: socket.id,
        from: socket.id,
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
          name: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
          username: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
          roomId: room,
          reason,
        });
      }
    }

    if (existingUser?.roomId && !notifiedRooms.has(existingUser.roomId)) {
      socket.to(existingUser.roomId).emit("participantLeft", {
        id: socket.id,
        name: existingUser.username,
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
      name: existingUser?.username || `User-${socket.id.slice(0, 4)}`,
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
  profiles.clear();
  roomChatMessages.clear();
  clearActiveCalls();
  initDefaultRooms();
}

module.exports = {
  registerSocketHandlers,
  users,
  rooms,
  DEFAULT_ROOMS,
  createRoom,
  getRoomsList,
  getRoomMeta,
  initDefaultRooms,
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
  // Profile system exports
  getProfile,
  saveProfile,
  validateProfileData,
  profiles,
  // Room Chat system exports
  saveRoomMessage,
  getRoomMessages,
  roomChatMessages,
};
