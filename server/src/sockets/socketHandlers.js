
const users = new Map();

function registerSocketHandlers(io, socket) {
  const user = {
    id: socket.id,
    username: `Guest-${socket.id.slice(0, 4)}`,
    x: 49,
    y: 57,
  };

  users.set(socket.id, user);

  // Send existing users to the newly connected client
  console.log(
  "SENDING CURRENT USERS:",
  Array.from(users.values()).filter((item) => item.id !== socket.id)
  );
  socket.emit(
    "currentUsers",
    Array.from(users.values()).filter((item) => item.id !== socket.id)
  );

  // Announce this user to everyone else
  socket.broadcast.emit("userJoined", user);

  socket.on("join", (data = {}) => {
    console.log("JOIN EVENT RECEIVED:", socket.id, data);
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    if (typeof data.username === "string" && data.username.trim()) {
      currentUser.username = data.username.trim();
    }

    io.emit("userJoined", currentUser);
  });

  socket.on("updatePosition", (position) => {
    const currentUser = users.get(socket.id);
    if (!currentUser || !position) return;

    const x = Number(position.x);
    const y = Number(position.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    currentUser.x = Math.min(92, Math.max(8, x));
    currentUser.y = Math.min(88, Math.max(12, y));

    // Broadcast the same coordinates to all other clients
    socket.broadcast.emit("userPositionUpdated", currentUser);
  });

  socket.on("ping", (data) => {
    console.log(`Received ping from client: ${socket.id}`);
    socket.emit("pong", {
      message: data?.message || "Pong received",
    });
  });

  socket.on("disconnect", () => {
    users.delete(socket.id);
    io.emit("userDisconnected", socket.id);
    console.log(`User disconnected: ${socket.id}`);
  });
}

module.exports = {
  registerSocketHandlers,
};
