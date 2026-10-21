
/**
 * ProxiSpeak Socket.IO handlers.
 * Supports live users, avatar movement, and persistent communication sessions.
 */
const User = require("../models/User");
const CommunicationSession = require("../models/CommunicationSession");

const users = new Map();
const activeSessions = new Map();

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

  const user = {
    id: socket.id,
    username: `Guest-${socket.id.slice(0, 4)}`,
    x: 49,
    y: 57,
    color: getRandomColor(),
  };

  users.set(socket.id, user);

  // Save the connected user in MongoDB.
  User.findOneAndUpdate(
    { userId: socket.id },
    { $set: { username: user.username } },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
    }
  ).catch((error) => {
    console.error("Failed to save connected user:", error.message);
  });

  // Send existing users to the newly connected client.
  socket.emit(
    "currentUsers",
    Array.from(users.values()).filter(
      (item) => item.id !== socket.id
    )
  );

  // Notify other connected clients.
  socket.broadcast.emit("userJoined", user);

  // Update username when a user joins.
  socket.on("join", async (data = {}) => {
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    if (typeof data.username === "string" && data.username.trim()) {
      currentUser.username = data.username.trim();
    }

    if (typeof data.x === "number" && Number.isFinite(data.x)) {
      currentUser.x = Math.min(92, Math.max(8, data.x));
    }

    if (typeof data.y === "number" && Number.isFinite(data.y)) {
      currentUser.y = Math.min(88, Math.max(12, data.y));
    }

    if (typeof data.color === "string" && data.color.trim()) {
      currentUser.color = data.color;
    }

    users.set(socket.id, currentUser);

    try {
      await User.findOneAndUpdate(
        { userId: socket.id },
        { $set: { username: currentUser.username } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
        }
      );
    } catch (error) {
      console.error("Failed to update user:", error.message);
    }

    socket.broadcast.emit("userJoined", currentUser);
  });

  // Start a persistent communication session with another user.
  socket.on("startCommunicationSession", async (data = {}, callback) => {
    try {
      const participantId = data.participantId;

      if (
        typeof participantId !== "string" ||
        participantId === socket.id ||
        !users.has(participantId)
      ) {
        const result = {
          error: "A different connected participantId is required.",
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("communicationSessionError", result);
        return;
      }

      const participantIds = [socket.id, participantId].sort();

      const existingSession = await CommunicationSession.findOne({
        participantIds: { $all: participantIds, $size: 2 },
        status: "active",
      });

      if (existingSession) {
        const result = {
          sessionId: existingSession._id.toString(),
          status: existingSession.status,
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("communicationSessionStarted", result);
        return;
      }

      const session = await CommunicationSession.create({
        participantIds,
        status: "active",
        startedAt: new Date(),
      });

      activeSessions.set(session._id.toString(), participantIds);

      const result = {
        sessionId: session._id.toString(),
        participantIds,
        status: session.status,
        startedAt: session.startedAt,
      };

      if (typeof callback === "function") callback(result);
      else socket.emit("communicationSessionStarted", result);

      io.to(participantId).emit("communicationSessionStarted", result);
    } catch (error) {
      console.error(
        "Failed to start communication session:",
        error.message
      );

      const result = { error: "Failed to start communication session." };

      if (typeof callback === "function") callback(result);
      else socket.emit("communicationSessionError", result);
    }
  });

  // End a session only if the requesting user is a participant.
  socket.on("endCommunicationSession", async (data = {}, callback) => {
    try {
      const sessionId = data.sessionId;

      if (typeof sessionId !== "string") {
        const result = { error: "A sessionId is required." };

        if (typeof callback === "function") callback(result);
        else socket.emit("communicationSessionError", result);
        return;
      }

      const session = await CommunicationSession.findOneAndUpdate(
        {
          _id: sessionId,
          participantIds: socket.id,
          status: "active",
        },
        { $set: { status: "ended", endedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!session) {
        const result = {
          error: "Active session not found for this participant.",
        };

        if (typeof callback === "function") callback(result);
        else socket.emit("communicationSessionError", result);
        return;
      }

      activeSessions.delete(sessionId);

      const result = {
        sessionId,
        status: session.status,
        endedAt: session.endedAt,
      };

      if (typeof callback === "function") callback(result);
      else socket.emit("communicationSessionEnded", result);

      for (const participantId of session.participantIds) {
        io.to(participantId).emit("communicationSessionEnded", result);
      }
    } catch (error) {
      console.error("Failed to end communication session:", error.message);

      const result = { error: "Failed to end communication session." };

      if (typeof callback === "function") callback(result);
      else socket.emit("communicationSessionError", result);
    }
  });

  // Update avatar position and broadcast it to other clients.
  function handlePosition(position) {
    const currentUser = users.get(socket.id);
    if (!currentUser || !position) return;

    const x = Number(position.x);
    const y = Number(position.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    currentUser.x = Math.min(92, Math.max(8, x));
    currentUser.y = Math.min(88, Math.max(12, y));

    users.set(socket.id, currentUser);

    const payload = {
      id: socket.id,
      username: currentUser.username,
      x: currentUser.x,
      y: currentUser.y,
      color: currentUser.color,
    };

    socket.broadcast.emit("userPositionUpdated", payload);
    socket.broadcast.emit("userMoved", payload);
  }

  socket.on("updatePosition", handlePosition);
  socket.on("userMoved", handlePosition);

  // Ping/pong connectivity check.
  socket.on("ping", (data) => {
    socket.emit("pong", {
      message: data?.message || "Pong received",
    });
  });

  // Remove the user and end their active sessions on disconnect.
  socket.on("disconnect", async () => {
    console.log("User disconnected:", socket.id);
    users.delete(socket.id);

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

    // Preserve the string ID expected by the existing frontend.
    io.emit("userDisconnected", socket.id);
    socket.broadcast.emit("userLeft", { id: socket.id });
  });
}

module.exports = {
  registerSocketHandlers,
  users,
  activeSessions,
};
