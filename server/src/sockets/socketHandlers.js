/**
 * ProxiSpeak Socket.IO handlers.
 * MongoDB stores users and communication sessions.
 * In-memory state handles live users and avatar movement.
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
  const defaultUser = {
    id: socket.id,
    username: `User-${socket.id.slice(0, 4)}`,
    x: Math.floor(100 + Math.random() * 400),
    y: Math.floor(100 + Math.random() * 300),
    color: getRandomColor(),
  };
  users.set(socket.id, defaultUser);
  User.findOneAndUpdate(
    { userId: socket.id },
    { $set: { username: defaultUser.username } },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
    }
  ).catch((error) => {
    console.error("Failed to save connected user:", error.message);
  });
  socket.emit("currentUsers", Array.from(users.values()));
  socket.broadcast.emit("userJoined", defaultUser);
  socket.on("join", async (userData = {}) => {
    const existing = users.get(socket.id) || defaultUser;
    const updated = {
      ...existing,
      username: userData.username || existing.username,
      x: typeof userData.x === "number" ? userData.x : existing.x,
      y: typeof userData.y === "number" ? userData.y : existing.y,
      color: userData.color || existing.color,
    };
    users.set(socket.id, updated);
    try {
      await User.findOneAndUpdate(
        { userId: socket.id },
        { $set: { username: updated.username } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
        }
      );
    } catch (error) {
      console.error("Failed to update user:", error.message);
    }
    socket.broadcast.emit("userJoined", updated);
  });
  // Start a persistent communication session with another connected user.
  socket.on("startCommunicationSession", async (data = {}, callback) => {
    try {
      const participantId = data.participantId;
      if (
        typeof participantId !== "string" ||
        participantId === socket.id ||
        !users.has(participantId)
      ) {
        const result = { error: "A different connected participantId is required." };
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
      console.error("Failed to start communication session:", error.message);
      const result = { error: "Failed to start communication session." };
      if (typeof callback === "function") callback(result);
      else socket.emit("communicationSessionError", result);
    }
  });
  // End a session only when the requesting user is a participant.
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
        const result = { error: "Active session not found for this participant." };
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
  // Keep avatar movement in memory; do not write every move to MongoDB.
  socket.on("updatePosition", (positionData) => {
    const currentUser = users.get(socket.id);
    if (!currentUser || !positionData) return;
    const newX =
      typeof positionData.x === "number" ? positionData.x : currentUser.x;
    const newY =
      typeof positionData.y === "number" ? positionData.y : currentUser.y;
    currentUser.x = newX;
    currentUser.y = newY;
    users.set(socket.id, currentUser);
    const updatePayload = {
      id: socket.id,
      x: newX,
      y: newY,
      username: currentUser.username,
    };
    socket.broadcast.emit("userPositionUpdated", updatePayload);
    socket.broadcast.emit("userMoved", updatePayload);
  });
  socket.on("userMoved", (positionData) => {
    socket.emit("updatePosition", positionData);
  });
  socket.on("ping", (data) => {
    console.log("Received ping from client:", socket.id);
    socket.emit("pong", data || "pong");
  });
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
        { participantIds: socket.id, status: "active" },
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
            io.to(participantId).emit("communicationSessionEnded", result);
          }
        }
      }
    } catch (error) {
      console.error("Failed to end sessions on disconnect:", error.message);
    }
    socket.broadcast.emit("userDisconnected", { id: socket.id });
    socket.broadcast.emit("userLeft", { id: socket.id });
  });
}
module.exports = {
  registerSocketHandlers,
  users,
  activeSessions,
};
