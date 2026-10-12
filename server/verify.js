const http = require("http");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text };
}

async function testSocketPingPong(serverUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.IO pong response timed out after 5000ms"));
    }, 5000);

    socket.on("connect", () => {
      console.log(`[TEST CLIENT]: Connected with socket id: ${socket.id}`);
      console.log("[TEST CLIENT]: Emitting 'ping' event to server...");
      socket.emit("ping", { message: "ping from test client", sentAt: Date.now() });
    });

    socket.on("pong", (data) => {
      clearTimeout(timeout);
      console.log("[TEST CLIENT]: Received 'pong' event response from server:", JSON.stringify(data));
      socket.disconnect();
      resolve(data);
    });

    socket.on("connect_error", (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });
  });
}

async function runTest() {
  let hasErrors = false;
  console.log("Starting server process...");
  const server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stdout.on("data", (data) => {
    console.log(`[SERVER STDOUT]: ${data.toString().trim()}`);
  });

  server.stderr.on("data", (data) => {
    console.error(`[SERVER STDERR]: ${data.toString().trim()}`);
  });

  // Allow server to spin up
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    console.log("\n--- Testing Route 1: GET http://localhost:5000/ ---");
    const rootRes = await checkUrl("http://localhost:5000/");
    console.log(`Status: ${rootRes.status}`);
    console.log(`Body: ${rootRes.body}`);

    if (rootRes.status === 200 && rootRes.body === "ProxiSpeak Backend is running!") {
      console.log("--> PASS: Root endpoint verified.");
    } else {
      console.error("--> FAIL: Root endpoint unexpected response.");
      hasErrors = true;
    }

    console.log("\n--- Testing Route 2: GET http://localhost:5000/api/health ---");
    const healthRes = await checkUrl("http://localhost:5000/api/health");
    console.log(`Status: ${healthRes.status}`);
    console.log(`Body: ${healthRes.body}`);

    const healthJson = JSON.parse(healthRes.body);
    if (healthRes.status === 200 && healthJson.status === "OK" && healthJson.project === "ProxiSpeak") {
      console.log("--> PASS: Health check endpoint verified.");
    } else {
      console.error("--> FAIL: Health check endpoint unexpected response.");
      hasErrors = true;
    }

    console.log("\n--- Testing Route 3: GET http://localhost:5000/api/status ---");
    const statusRes = await checkUrl("http://localhost:5000/api/status");
    console.log(`Status: ${statusRes.status}`);
    console.log(`Body: ${statusRes.body}`);

    const statusJson = JSON.parse(statusRes.body);
    if (statusRes.status === 200 && statusJson.status === "active") {
      console.log("--> PASS: Status endpoint verified.");
    } else {
      console.error("--> FAIL: Status endpoint unexpected response.");
      hasErrors = true;
    }

    console.log("\n--- Testing Route 4: Socket.IO Ping-Pong Event ---");
    const pongResponse = await testSocketPingPong("http://localhost:5000");
    if (pongResponse) {
      console.log("--> PASS: Socket.IO ping/pong event exchange verified successfully.");
    } else {
      console.error("--> FAIL: Socket.IO ping/pong did not return expected response.");
      hasErrors = true;
    }

  } catch (err) {
    console.error("Verification encountered an error:", err);
    hasErrors = true;
  } finally {
    console.log("\nShutting down test server...");
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Server stopped successfully.");

    if (hasErrors) {
      console.error("\n❌ TESTS FAILED");
      process.exit(1);
    } else {
      console.log("\n✅ ALL TESTS PASSED");
      process.exit(0);
    }
  }
}

runTest();
