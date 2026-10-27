
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

// WebRTC call state
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

  const clean = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  return clean ? clean.slice(0, 50) : DEFAULT_ROOM;
}

function getRoomParticipants(roomId) {
  return Array.from(users.values()).filter(
    (user) => user.roomId === roomId
  );
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

  socket.broadcast.emit("userJoined", user);
  socket.to(DEFAULT_ROOM).emit("participantJoined", user);

  function sendValidationError(message, received) {
    const payload = { message };
    if (received !== undefined) payload.received = received;
    socket.emit("error:validation", payload);
  }

  function joinRoom(data = {}) {
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    const targetRoom = sanitizeRoomId(data.roomId || DEFAULT_ROOM);
    const oldRoom = currentUser.roomId;
    const previousUsername = currentUser.username;

    if (data.username) {
      currentUser.username = sanitizeUsername(
        data.username,
        currentUser.username
      );
    }

    if (oldRoom !== targetRoom) {
      socket.leave(oldRoom);

      socket.to(oldRoom).emit("participantLeft", {
        id: socket.id,
        username: currentUser.username,
        roomId: oldRoom,
      });

      socket.join(targetRoom);
      currentUser.roomId = targetRoom;
    }

    users.set(socket.id, currentUser);
    void saveUser(currentUser);

    socket.emit("roomParticipants", {
      roomId: targetRoom,
      participants: getRoomParticipants(targetRoom),
    });

    if (
      oldRoom !== targetRoom ||
      previousUsername !== currentUser.username
    ) {
      socket.to(targetRoom).emit("participantJoined", currentUser);
    }

    socket.broadcast.emit("userJoined", currentUser);
  }

  socket.on("joinRoom", (data = {}) => {
    try {
      joinRoom(data);
    } catch (error) {
      console.error("Join room failed:", error.message);
      sendValidationError("Failed to join room");
    }
  });

  socket.on("join", (data = {}) => {
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    if (data.roomId) {
      joinRoom(data);
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
  });

  socket.on("leaveRoom", (data = {}) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser) return;

      const roomToLeave = sanitizeRoomId(
        data.roomId || currentUser.roomId
      );

      socket.leave(roomToLeave);

      socket.to(roomToLeave).emit("participantLeft", {
        id: socket.id,
        username: currentUser.username,
        roomId: roomToLeave,
      });

      if (currentUser.roomId === roomToLeave) {
        currentUser.roomId = DEFAULT_ROOM;
        socket.join(DEFAULT_ROOM);
        users.set(socket.id, currentUser);

        socket.emit("roomParticipants", {
          roomId: DEFAULT_ROOM,
          participants: getRoomParticipants(DEFAULT_ROOM),
        });

        socket.to(DEFAULT_ROOM).emit("participantJoined", currentUser);
      }
    } catch (error) {
      console.error("Leave room failed:", error.message);
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

  // Position updates and broadcasting
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
    };

    socket.broadcast.emit("userPositionUpdated", payload);
    socket.broadcast.emit("userMoved", payload);
  }

  socket.on("updatePosition", handlePosition);
  socket.on("userMoved", handlePosition);

  // WebRTC call request
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
    const callerName = caller
      ? caller.username
      : `User-${socket.id.slice(0, 4)}`;

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

  // Accept an incoming call
  const handleAcceptCall = ({ targetId, to, signal } = {}) => {
    const target = targetId || to;

    if (!target || !users.has(target)) {
      socket.emit("signal:error", {
        message: "Caller peer not found or offline",
        targetId: target,
      });
      return;
    }

    const call = registerCall(target, socket.id);
    const callee = users.get(socket.id);
    const calleeName = callee
      ? callee.username
      : `User-${socket.id.slice(0, 4)}`;

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

  // WebRTC offer, answer and ICE signaling
  socket.on("signal:offer", ({ targetId, offer } = {}) => {
    if (!targetId || !users.has(targetId) || !offer) {
      socket.emit("signal:error", {
        message: "Target peer not found or offer is missing",
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

  // Spatial proximity
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
      console.error(
        `[PROXIMITY ERROR] ${socket.id}:`,
        error.message
      );
    }
  });

  socket.on("clientDisconnect", () => {
    console.log(
      `[CLIENT DISCONNECT REQUEST] Client ${socket.id} requested disconnect`
    );
    socket.disconnect(true);
  });

  // Persist communication sessions
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

  // Disconnect cleanup
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

    socket.broadcast.emit("userDisconnected", socket.id);

    socket.broadcast.emit("userLeft", {
      id: socket.id,
      username:
        disconnectedUser?.username || `Guest-${socket.id.slice(0, 4)}`,
      reason,
    });

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
  clearActiveCalls();
}

module.exports = {
  registerSocketHandlers,
  users,
  activeSessions,
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
