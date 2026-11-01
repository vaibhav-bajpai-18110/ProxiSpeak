
const User = require("../models/User");
const CommunicationSession = require("../models/CommunicationSession");

const {
  calculateDistance,
  calculateAudioVolume,
  calculateAudioPan,
  getNearbyParticipants,
} = require("../services/proximityService");

const users = new Map();
const activeSessions = new Map();

const activeAudioCalls = new Map();
const userCallMap = new Map();

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
    if (!call) continue;

    userCallMap.get(call.callerId)?.delete(callId);
    userCallMap.get(call.calleeId)?.delete(callId);
    activeAudioCalls.delete(callId);
  }

  return callsToTerminate.length > 0;
}

function getCallPeers(socketId) {
  const callIds = userCallMap.get(socketId);
  if (!callIds || callIds.size === 0) return [];

  const peers = new Set();

  for (const callId of callIds) {
    const call = activeAudioCalls.get(callId);
    if (!call) continue;

    if (call.callerId === socketId) peers.add(call.calleeId);
    else if (call.calleeId === socketId) peers.add(call.callerId);
  }

  return Array.from(peers);
}

function cleanupUserCalls(socketId, io, reason = "peer_disconnected") {
  const callIds = userCallMap.get(socketId);

  if (!callIds || callIds.size === 0) {
    userCallMap.delete(socketId);
    return [];
  }

  const terminatedPeers = [];

  for (const callId of Array.from(callIds)) {
    const call = activeAudioCalls.get(callId);
    if (!call) continue;

    const otherPeerId =
      call.callerId === socketId ? call.calleeId : call.callerId;

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

const MAP_BOUNDS = {
  MIN_X: 0,
  MAX_X: 2000,
  MIN_Y: 0,
  MAX_Y: 2000,
};

const DEFAULT_ROOM = "main-office";

const rooms = new Map();

const DEFAULT_ROOMS = [
  {
    id: "main-office",
    name: "Main Office",
    description: "Central virtual workspace",
    maxParticipants: 50,
    isDefault: true,
  },
  {
    id: "meeting-room-a",
    name: "Meeting Room A",
    description: "Focus and presentation room",
    maxParticipants: 10,
    isDefault: false,
  },
  {
    id: "meeting-room-b",
    name: "Meeting Room B",
    description: "Collaborative breakout space",
    maxParticipants: 10,
    isDefault: false,
  },
  {
    id: "lounge",
    name: "Lounge / Cafeteria",
    description: "Casual watercooler chat",
    maxParticipants: 25,
    isDefault: false,
  },
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeUsername(input, defaultName) {
  if (typeof input !== "string") return defaultName;

  const trimmed = input.trim();
  return trimmed ? trimmed.slice(0, 30) : defaultName;
}

function sanitizeRoomId(roomId) {
  if (typeof roomId !== "string") return DEFAULT_ROOM;

  const clean = roomId
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");

  return clean ? clean.slice(0, 50) : DEFAULT_ROOM;
}

function getRoomParticipants(roomId) {
  return Array.from(users.values()).filter(
    (user) => user.roomId === roomId
  );
}

function initDefaultRooms() {
  rooms.clear();

  DEFAULT_ROOMS.forEach((room) => {
    rooms.set(room.id, {
      ...room,
      isPrivate: false,
      createdBy: "system",
      createdAt: new Date().toISOString(),
    });
  });
}

initDefaultRooms();

function getRoomsList() {
  return Array.from(rooms.values()).map((room) => ({
    ...room,
    currentParticipants: getRoomParticipants(room.id).length,
  }));
}

function getRoomMeta(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  const autoRoom = {
    id: roomId,
    name: roomId
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase()),
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

function createRoom(
  {
    roomId,
    name,
    description,
    maxParticipants,
    isPrivate = false,
  } = {},
  creatorId = "system"
) {
  const sanitizedId = sanitizeRoomId(
    roomId || name || `room-${Date.now()}`
  );

  const sanitizedName =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, 50)
      : sanitizedId;

  const sanitizedDescription =
    typeof description === "string"
      ? description.trim().slice(0, 200)
      : "";

  const maxCapacity =
    typeof maxParticipants === "number" &&
    Number.isFinite(maxParticipants) &&
    maxParticipants > 0
      ? Math.min(100, Math.max(2, Math.round(maxParticipants)))
      : 25;

  if (rooms.has(sanitizedId)) {
    return {
      success: false,
      error: "Room already exists",
      roomId: sanitizedId,
    };
  }

  const room = {
    id: sanitizedId,
    name: sanitizedName,
    description: sanitizedDescription,
    maxParticipants: maxCapacity,
    isPrivate: Boolean(isPrivate),
    isDefault: sanitizedId === DEFAULT_ROOM,
    createdBy: creatorId,
    createdAt: new Date().toISOString(),
  };

  rooms.set(sanitizedId, room);

  return {
    success: true,
    room,
  };
}

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

// Availability status options
const VALID_AVAILABILITY = ["available", "away", "busy", "dnd"];

// In-memory store of user profiles: userId -> profile object
const profiles = new Map();

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
    if (sId === cleanId || u.id === cleanId) {
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
    if (sId === cleanId || u.id === cleanId) {
      u.username = cleanUsername;
      u.color = cleanColor;
      u.status = cleanStatus;
      users.set(sId, u);
    }
  }

  return { success: true, profile: updatedProfile };
}

function getRandomColor() {
  return AVATAR_COLORS[
    Math.floor(Math.random() * AVATAR_COLORS.length)
  ];
}

async function saveUser(user) {
  try {
    await User.findOneAndUpdate(
      { userId: user.id },
      { $set: { username: user.username } },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
      }
    );
  } catch (error) {
    console.error("Failed to save user:", error.message);
  }
}

function executeRoomJoin(socket, targetRoomId, newUsername, io) {
  const user = users.get(socket.id);
  if (!user) return false;

  const targetRoom = sanitizeRoomId(targetRoomId || DEFAULT_ROOM);
  const targetUsername = newUsername
    ? sanitizeUsername(newUsername, user.username)
    : user.username;

  if (user.roomId === targetRoom) {
    const usernameChanged = user.username !== targetUsername;

    user.username = targetUsername;
    users.set(socket.id, user);

    if (usernameChanged) {
      void saveUser(user);
      socket.to(targetRoom).emit("participantJoined", user);
      socket.broadcast.emit("userJoined", user);
    }

    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });

    return true;
  }

  const roomMeta = getRoomMeta(targetRoom);
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

  const oldRoom = user.roomId || DEFAULT_ROOM;

  cleanupUserCalls(socket.id, io, "room_switched");

  socket.leave(oldRoom);

  socket.to(oldRoom).emit("participantLeft", {
    id: socket.id,
    username: user.username,
    roomId: oldRoom,
    reason: "room_switched",
  });

  user.roomId = targetRoom;
  user.username = targetUsername;
  users.set(socket.id, user);

  socket.join(targetRoom);
  void saveUser(user);

  console.log(
    `[ROOM SWITCH] User ${socket.id} moved from ${oldRoom} to ${targetRoom}`
  );

  socket.emit("roomParticipants", {
    roomId: targetRoom,
    participants: getRoomParticipants(targetRoom),
  });

  socket.to(targetRoom).emit("participantJoined", user);
  socket.broadcast.emit("userJoined", user);
  io.emit("roomListUpdated", getRoomsList());

  return true;
}

function registerSocketHandlers(io, socket) {
  console.log(`[SOCKET CONNECT] User connected: ${socket.id}`);

  socket.on("error", (error) => {
    console.error(
      `[SOCKET ERROR] ${socket.id}:`,
      error?.message || error
    );
  });

  const user = {
    id: socket.id,
    username: `Guest-${socket.id.slice(0, 4)}`,
    roomId: DEFAULT_ROOM,
    x: 300,
    y: 250,
    color: getRandomColor(),
    isMuted: false,
    status: "available",
  };

  users.set(socket.id, user);
  socket.join(DEFAULT_ROOM);

  void saveUser(user);

  socket.emit(
    "currentUsers",
    Array.from(users.values()).filter(
      (existingUser) => existingUser.id !== socket.id
    )
  );

  socket.emit("roomParticipants", {
    roomId: DEFAULT_ROOM,
    participants: getRoomParticipants(DEFAULT_ROOM),
  });

  socket.emit("roomList", getRoomsList());

  socket.broadcast.emit("userJoined", user);
  socket.to(DEFAULT_ROOM).emit("participantJoined", user);

  function sendValidationError(message, received) {
    const payload = { message };
    if (received !== undefined) payload.received = received;
    socket.emit("error:validation", payload);
  }

  socket.on("createRoom", (data = {}, callback) => {
    try {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        const result = {
          success: false,
          message: "Invalid payload for createRoom",
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("error:room", result);

        return;
      }

      const result = createRoom(data, socket.id);

      if (!result.success) {
        if (typeof callback === "function") callback(result);
        else socket.emit("error:room", result);

        return;
      }

      socket.emit("roomCreated", result.room);

      if (typeof callback === "function") {
        callback({ success: true, room: result.room });
      }

      io.emit("roomListUpdated", getRoomsList());
    } catch (error) {
      console.error(`[CREATE ROOM ERROR] ${socket.id}:`, error.message);

      const result = {
        success: false,
        message: "Internal error creating room",
      };

      if (typeof callback === "function") callback(result);
      else socket.emit("error:room", result);
    }
  });

  socket.on("getRooms", (callback) => {
    const list = getRoomsList();

    if (typeof callback === "function") {
      callback({ success: true, rooms: list });
    } else {
      socket.emit("roomList", list);
    }
  });

  socket.on("joinRoom", (data = {}, callback) => {
    try {
      let targetRoomId = DEFAULT_ROOM;
      let targetUsername = null;

      if (data && typeof data === "object" && !Array.isArray(data)) {
        targetRoomId = data.roomId || DEFAULT_ROOM;
        targetUsername = data.username || null;
      } else if (typeof data === "string") {
        targetRoomId = data;
      } else {
        const result = {
          success: false,
          message: "Invalid joinRoom payload",
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("error:validation", result);

        return;
      }

      const success = executeRoomJoin(
        socket,
        targetRoomId,
        targetUsername,
        io
      );

      if (typeof callback === "function") {
        if (!success) {
          callback({
            success: false,
            message: "Room join failed",
            roomId: targetRoomId,
          });
        } else {
          const finalRoom = sanitizeRoomId(targetRoomId);

          callback({
            success: true,
            roomId: finalRoom,
            participants: getRoomParticipants(finalRoom),
          });
        }
      }
    } catch (error) {
      console.error(`[JOIN ROOM ERROR] ${socket.id}:`, error.message);

      const result = {
        success: false,
        message: "Failed to join room",
      };

      if (typeof callback === "function") callback(result);
      else socket.emit("error:validation", result);
    }
  });

  socket.on("join", (data = {}) => {
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    if (
      data &&
      typeof data === "object" &&
      data.roomId
    ) {
      executeRoomJoin(socket, data.roomId, data.username, io);
      return;
    }

    if (data.username) {
      currentUser.username = sanitizeUsername(
        data.username,
        currentUser.username
      );

      users.set(socket.id, currentUser);
      void saveUser(currentUser);
      socket.broadcast.emit("userJoined", currentUser);
    }

    if (isFiniteNumber(data.x)) {
      currentUser.x = clamp(
        data.x,
        MAP_BOUNDS.MIN_X,
        MAP_BOUNDS.MAX_X
      );
    }

    if (isFiniteNumber(data.y)) {
      currentUser.y = clamp(
        data.y,
        MAP_BOUNDS.MIN_Y,
        MAP_BOUNDS.MAX_Y
      );
    }

    if (typeof data.color === "string" && data.color.trim()) {
      currentUser.color = data.color.trim();
    }

    users.set(socket.id, currentUser);
  });

  socket.on("leaveRoom", (data = {}, callback) => {
    try {
      const currentUser = users.get(socket.id);

      if (!currentUser) {
        if (typeof callback === "function") {
          callback({ success: false, message: "User not found" });
        }
        return;
      }

      const roomPayload =
        data && typeof data === "object" ? data : {};

      const roomToLeave = sanitizeRoomId(
        roomPayload.roomId || currentUser.roomId
      );

      if (currentUser.roomId !== roomToLeave) {
        const result = {
          success: false,
          message: "User is not in the requested room",
          currentRoom: currentUser.roomId,
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("error:room", result);

        return;
      }

      if (roomToLeave === DEFAULT_ROOM) {
        const result = {
          success: false,
          message: "Cannot leave the default room",
          currentRoom: DEFAULT_ROOM,
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("error:room", result);

        return;
      }

      cleanupUserCalls(socket.id, io, "room_left");

      socket.leave(roomToLeave);

      socket.to(roomToLeave).emit("participantLeft", {
        id: socket.id,
        username: currentUser.username,
        roomId: roomToLeave,
        reason: "user_left_room",
      });

      currentUser.roomId = DEFAULT_ROOM;
      users.set(socket.id, currentUser);

      socket.join(DEFAULT_ROOM);

      socket.emit("roomParticipants", {
        roomId: DEFAULT_ROOM,
        participants: getRoomParticipants(DEFAULT_ROOM),
      });

      socket.to(DEFAULT_ROOM).emit("participantJoined", currentUser);
      io.emit("roomListUpdated", getRoomsList());

      if (typeof callback === "function") {
        callback({
          success: true,
          leftRoom: roomToLeave,
          currentRoom: DEFAULT_ROOM,
        });
      }
    } catch (error) {
      console.error(`[LEAVE ROOM ERROR] ${socket.id}:`, error.message);

      if (typeof callback === "function") {
        callback({ success: false, message: error.message });
      }
    }
  });

  socket.on("getParticipants", (data = {}, callback) => {
    const roomId = sanitizeRoomId(data.roomId || DEFAULT_ROOM);

    const result = {
      roomId,
      participants: getRoomParticipants(roomId),
    };

    if (typeof callback === "function") callback(result);
    else socket.emit("roomParticipants", result);
  });

  function handlePosition(position) {
    if (
      !position ||
      typeof position !== "object" ||
      Array.isArray(position)
    ) {
      sendValidationError("Position payload must be an object");
      return;
    }

    if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
      sendValidationError("Coordinates x and y must be finite numbers", {
        x: position.x,
        y: position.y,
      });
      return;
    }

    const currentUser = users.get(socket.id);

    if (!currentUser) {
      sendValidationError("User not found in active session");
      return;
    }

    currentUser.x = clamp(
      position.x,
      MAP_BOUNDS.MIN_X,
      MAP_BOUNDS.MAX_X
    );

    currentUser.y = clamp(
      position.y,
      MAP_BOUNDS.MIN_Y,
      MAP_BOUNDS.MAX_Y
    );

    users.set(socket.id, currentUser);

    const payload = {
      id: socket.id,
      username: currentUser.username,
      roomId: currentUser.roomId,
      x: currentUser.x,
      y: currentUser.y,
      color: currentUser.color,
      status: currentUser.status || "available",
    };

    socket.to(currentUser.roomId).emit("roomPositionUpdated", payload);
    socket.broadcast.emit("userPositionUpdated", payload);
    socket.broadcast.emit("userMoved", payload);
  }

  socket.on("updatePosition", handlePosition);
  socket.on("userMoved", handlePosition);

  // Update the connected user's profile and notify other participants.
  socket.on("updateProfile", (data = {}, callback) => {
    try {
      const result = saveProfile(socket.id, data);

      if (!result.success) {
        const errPayload = {
          status: "error",
          message: result.message,
          code: result.code,
        };
        if (typeof callback === "function") callback(errPayload);
        else socket.emit("error:validation", errPayload);
        return;
      }

      const user = users.get(socket.id);
      const broadcastPayload = {
        id: socket.id,
        userId: socket.id,
        username: result.profile.username,
        displayName: result.profile.displayName,
        color: result.profile.color,
        avatarColor: result.profile.avatarColor,
        status: result.profile.status,
        availability: result.profile.availability,
        roomId: user?.roomId || DEFAULT_ROOM,
      };

      socket.broadcast.emit("userProfileUpdated", broadcastPayload);
      socket.broadcast.emit("profileUpdated", broadcastPayload);
      if (user?.roomId) {
        socket.to(user.roomId).emit("roomProfileUpdated", broadcastPayload);
      }

      if (typeof callback === "function") {
        callback({ status: "success", profile: result.profile });
      } else {
        socket.emit("profileUpdated", {
          status: "success",
          profile: result.profile,
        });
      }
    } catch (err) {
      console.error(`[UPDATE PROFILE ERROR] ${socket.id}:`, err.message);
      const errPayload = {
        status: "error",
        message: "Failed to update profile",
        code: "INTERNAL_ERROR",
      };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
    }
  });

  // Retrieve a profile by user ID; defaults to the current socket user.
  socket.on("getProfile", (data = {}, callback) => {
    const targetUserId =
      (typeof data === "string" ? data : data?.userId) || socket.id;
    const profile = getProfile(targetUserId);

    if (!profile) {
      const errPayload = {
        status: "error",
        message: `Profile not found for userId: ${targetUserId}`,
      };
      if (typeof callback === "function") callback(errPayload);
      else socket.emit("error:validation", errPayload);
      return;
    }

    if (typeof callback === "function") {
      callback({ status: "success", profile });
    } else {
      socket.emit("profileData", { status: "success", profile });
    }
  });

  const handleCallUser = ({
    targetId,
    userToCall,
    metadata = {},
    signalData,
  } = {}) => {
    const target = targetId || userToCall;

    if (!target) {
      socket.emit("signal:error", {
        message: "Target peer ID is required",
        targetId: null,
      });
      return;
    }

    if (target === socket.id) {
      socket.emit("signal:error", {
        message: "Cannot call yourself",
        targetId: target,
      });
      return;
    }

    if (!users.has(target)) {
      socket.emit("signal:error", {
        message: "Target peer not found or offline",
        targetId: target,
      });
      return;
    }

    const caller = users.get(socket.id);
    const targetUser = users.get(target);

    if (caller.roomId !== targetUser.roomId) {
      socket.emit("signal:error", {
        message: "Cannot call a participant in another room",
        targetId: target,
      });
      return;
    }

    const callerName = caller.username;

    io.to(target).emit("signal:incoming-call", {
      callerId: socket.id,
      callerName,
      metadata,
      signalData,
    });

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
      socket.emit("signal:error", {
        message: "Caller peer not found or offline",
        targetId: target,
      });
      return;
    }

    const caller = users.get(target);
    const callee = users.get(socket.id);

    if (!caller || !callee || caller.roomId !== callee.roomId) {
      socket.emit("signal:error", {
        message: "Caller is not in the same room",
        targetId: target,
      });
      return;
    }

    const call = registerCall(target, socket.id);
    const calleeName = callee.username;

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
    if (!targetId || !users.has(targetId)) return;

    io.to(targetId).emit("signal:call-rejected", {
      peerId: socket.id,
      reason,
    });

    io.to(targetId).emit("callRejected", {
      peerId: socket.id,
      reason,
    });
  });

  socket.on("signal:offer", ({ targetId, offer } = {}) => {
    if (!targetId || !users.has(targetId) || !offer) {
      socket.emit("signal:error", {
        message: "Target peer not found or offer is missing",
        targetId,
      });
      return;
    }

    const sender = users.get(socket.id);
    const receiver = users.get(targetId);

    if (!sender || !receiver || sender.roomId !== receiver.roomId) {
      socket.emit("signal:error", {
        message: "Target is not in the same room",
        targetId,
      });
      return;
    }

    io.to(targetId).emit("signal:offer", {
      senderId: socket.id,
      offer,
    });
  });

  socket.on("signal:answer", ({ targetId, answer } = {}) => {
    if (!targetId || !users.has(targetId) || !answer) {
      socket.emit("signal:error", {
        message: "Target peer not found or answer is missing",
        targetId,
      });
      return;
    }

    const sender = users.get(socket.id);
    const receiver = users.get(targetId);

    if (!sender || !receiver || sender.roomId !== receiver.roomId) {
      socket.emit("signal:error", {
        message: "Target is not in the same room",
        targetId,
      });
      return;
    }

    io.to(targetId).emit("signal:answer", {
      senderId: socket.id,
      answer,
    });
  });

  socket.on("signal:ice-candidate", ({ targetId, candidate } = {}) => {
    if (!targetId || !users.has(targetId) || !candidate) {
      socket.emit("signal:error", {
        message: "Target peer not found or ICE candidate is missing",
        targetId,
      });
      return;
    }

    const sender = users.get(socket.id);
    const receiver = users.get(targetId);

    if (!sender || !receiver || sender.roomId !== receiver.roomId) {
      socket.emit("signal:error", {
        message: "Target is not in the same room",
        targetId,
      });
      return;
    }

    io.to(targetId).emit("signal:ice-candidate", {
      senderId: socket.id,
      candidate,
    });
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
    const currentUser = users.get(socket.id);
    const muted = Boolean(isMuted);

    if (currentUser) {
      currentUser.isMuted = muted;
      users.set(socket.id, currentUser);

      socket.to(currentUser.roomId).emit("userMuteChanged", {
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

  socket.on("ping", (data) => {
    socket.emit("pong", {
      message:
        typeof data?.message === "string"
          ? data.message
          : "Pong received",
    });
  });

  socket.on("getNearbyUsers", (data = {}, callback) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser) return;

      const radius = isFiniteNumber(data.radius)
        ? clamp(data.radius, 10, 2000)
        : 300;

      const roomParticipants = getRoomParticipants(currentUser.roomId);

      const nearby = getNearbyParticipants(
        currentUser,
        roomParticipants,
        radius
      );

      const result = {
        roomId: currentUser.roomId,
        radius,
        nearby,
      };

      if (typeof callback === "function") callback(result);
      else socket.emit("nearbyUsers", result);
    } catch (error) {
      console.error(`[PROXIMITY ERROR] ${socket.id}:`, error.message);
    }
  });

  socket.on("clientDisconnect", () => {
    console.log(
      `[CLIENT DISCONNECT REQUEST] Client ${socket.id} requested disconnect`
    );

    socket.disconnect(true);
  });

  socket.on("startCommunicationSession", async (data = {}, callback) => {
    const respond = (result) => {
      if (typeof callback === "function") {
        callback(result);
      } else if (result.error) {
        socket.emit("communicationSessionError", result);
      } else {
        socket.emit("communicationSessionStarted", result);
      }
    };

    try {
      const participantId = data.participantId;

      if (
        typeof participantId !== "string" ||
        participantId === socket.id ||
        !users.has(participantId)
      ) {
        respond({
          error: "A different connected participantId is required.",
        });
        return;
      }

      const participantIds = [socket.id, participantId].sort();

      let session = await CommunicationSession.findOne({
        participantIds: { $all: participantIds, $size: 2 },
        status: "active",
      });

      if (!session) {
        session = await CommunicationSession.create({
          participantIds,
          status: "active",
          startedAt: new Date(),
        });
      }

      const sessionId = session._id.toString();
      activeSessions.set(sessionId, participantIds);

      const result = {
        sessionId,
        participantIds,
        status: session.status,
        startedAt: session.startedAt,
      };

      respond(result);
      io.to(participantId).emit("communicationSessionStarted", result);
    } catch (error) {
      console.error(
        "Failed to start communication session:",
        error.message
      );

      respond({ error: "Failed to start communication session." });
    }
  });

  socket.on("endCommunicationSession", async (data = {}, callback) => {
    const respond = (result) => {
      if (typeof callback === "function") {
        callback(result);
      } else {
        socket.emit(
          result.error
            ? "communicationSessionError"
            : "communicationSessionEnded",
          result
        );
      }
    };

    try {
      if (typeof data.sessionId !== "string") {
        respond({ error: "A sessionId is required." });
        return;
      }

      const session = await CommunicationSession.findOneAndUpdate(
        {
          _id: data.sessionId,
          participantIds: socket.id,
          status: "active",
        },
        {
          $set: {
            status: "ended",
            endedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (!session) {
        respond({
          error: "Active session not found for this participant.",
        });
        return;
      }

      activeSessions.delete(data.sessionId);

      const result = {
        sessionId: data.sessionId,
        status: session.status,
        endedAt: session.endedAt,
      };

      respond(result);

      for (const participantId of session.participantIds) {
        io.to(participantId).emit("communicationSessionEnded", result);
      }
    } catch (error) {
      console.error(
        "Failed to end communication session:",
        error.message
      );

      respond({ error: "Failed to end communication session." });
    }
  });

  socket.on("disconnecting", (reason) => {
    cleanupUserCalls(socket.id, io, reason || "peer_disconnected");
  });

  socket.on("disconnect", async (reason) => {
    console.log(
      `[SOCKET DISCONNECT] ${socket.id} (${reason || "unknown reason"})`
    );

    cleanupUserCalls(socket.id, io, reason || "peer_disconnected");

    const disconnectedUser = users.get(socket.id);
    users.delete(socket.id);

    if (disconnectedUser) {
      socket.to(disconnectedUser.roomId).emit("participantLeft", {
        id: socket.id,
        username: disconnectedUser.username,
        roomId: disconnectedUser.roomId,
        reason,
      });
    }

    socket.broadcast.emit("userDisconnected", { id: socket.id, username: disconnectedUser?.username || `Guest-${socket.id.slice(0, 4)}`, roomId: disconnectedUser?.roomId || DEFAULT_ROOM, reason });

    socket.broadcast.emit("userLeft", {
      id: socket.id,
      username:
        disconnectedUser?.username || `Guest-${socket.id.slice(0, 4)}`,
      reason,
    });

    io.emit("roomListUpdated", getRoomsList());

    try {
      const endedAt = new Date();

      const sessions = await CommunicationSession.find({
        participantIds: socket.id,
        status: "active",
      }).select("_id participantIds");

      await CommunicationSession.updateMany(
        {
          participantIds: socket.id,
          status: "active",
        },
        {
          $set: {
            status: "ended",
            endedAt,
          },
        }
      );

      for (const session of sessions) {
        const sessionId = session._id.toString();
        activeSessions.delete(sessionId);

        const result = {
          sessionId,
          status: "ended",
          endedAt,
          reason: "participant_disconnected",
        };

        for (const participantId of session.participantIds) {
          if (participantId !== socket.id) {
            io.to(participantId).emit(
              "communicationSessionEnded",
              result
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "Failed to end sessions on disconnect:",
        error.message
      );
    }
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
  activeSessions.clear();
  profiles.clear();
  clearActiveCalls();
  initDefaultRooms();
}

module.exports = {
  registerSocketHandlers,
  users,
  activeSessions,
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
};

