const { io } = require("socket.io-client");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:5000";

console.log(`Connecting to ProxiSpeak Socket.IO server at ${SERVER_URL}...`);

const socket = io(SERVER_URL, {
  transports: ["websocket", "polling"],
});

const startTime = Date.now();

socket.on("connect", () => {
  console.log(`[CLIENT] Connected successfully! Socket ID: ${socket.id}`);
  console.log("[CLIENT] Emitting 'ping' event to server...");
  socket.emit("ping", { message: "ping", sentAt: startTime });
});

socket.on("pong", (data) => {
  const roundTripTime = Date.now() - startTime;
  console.log(`[CLIENT] Received 'pong' response from server in ${roundTripTime}ms!`);
  console.log("[CLIENT] Data received:", data);
  console.log("[CLIENT] Test passed successfully. Disconnecting...");
  socket.disconnect();
  process.exit(0);
});

socket.on("connect_error", (err) => {
  console.error("[CLIENT] Connection error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("[CLIENT] Timeout waiting for 'pong' event.");
  socket.disconnect();
  process.exit(1);
}, 5000);
