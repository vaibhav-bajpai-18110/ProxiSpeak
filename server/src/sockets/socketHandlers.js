
const User = require("../models/User");
const CommunicationSession = require("../models/CommunicationSession");

const users = new Map();
const activeSessions = new Map();

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
    previousUsername !== currentUser.username) {
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
      currentUser.x = clamp(data.x, MAP_BOUNDS.MIN_X, MAP_BOUNDS.MAX_X);
    }

    if (isFiniteNumber(data.y)) {
      currentUser.y = clamp(data.y, MAP_BOUNDS.MIN_Y, MAP_BOUNDS.MAX_Y);
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

    if (typeof callback === "function") {
      callback(result);
    } else {
      socket.emit("roomParticipants", result);
    }
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
    };

    socket.broadcast.emit("userPositionUpdated", payload);
    socket.broadcast.emit("userMoved", payload);
  }

  socket.on("updatePosition", handlePosition);
  socket.on("userMoved", handlePosition);

  socket.on("ping", (data) => {
    socket.emit("pong", {
      message:
        typeof data?.message === "string"
          ? data.message
          : "Pong received",
    });
  });

  socket.on("signal:offer", (data = {}) => {
    if (typeof data.targetId === "string" && data.offer) {
      io.to(data.targetId).emit("signal:offer", {
        senderId: socket.id,
        offer: data.offer,
      });
    }
  });

  socket.on("signal:answer", (data = {}) => {
    if (typeof data.targetId === "string" && data.answer) {
      io.to(data.targetId).emit("signal:answer", {
        senderId: socket.id,
        answer: data.answer,
      });
    }
  });

  socket.on("signal:ice-candidate", (data = {}) => {
    if (typeof data.targetId === "string" && data.candidate) {
      io.to(data.targetId).emit("signal:ice-candidate", {
        senderId: socket.id,
        candidate: data.candidate,
      });
    }
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
      console.error("Failed to start communication session:", error.message);
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
        { $set: { status: "ended", endedAt: new Date() } },
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
      console.error("Failed to end communication session:", error.message);
      respond({ error: "Failed to end communication session." });
    }
  });

  socket.on("disconnect", async (reason) => {
    console.log(
      `[SOCKET DISCONNECT] ${socket.id} (${reason || "unknown reason"})`
    );

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

    // Keep the string ID for compatibility with the existing frontend.
    socket.broadcast.emit("userDisconnected", socket.id);

    socket.broadcast.emit("userLeft", {
      id: socket.id,
      username: disconnectedUser?.username || `Guest-${socket.id.slice(0, 4)}`,
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
        { $set: { status: "ended", endedAt } }
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
}

module.exports = {
  registerSocketHandlers,
  users,
  activeSessions,
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
