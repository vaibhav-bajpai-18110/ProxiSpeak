
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url) {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body };
}

async function testSocketPingPong(serverUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.IO pong response timed out"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit("ping", {
        message: "ping from test client",
        sentAt: Date.now(),
      });
    });

    socket.on("pong", (data) => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve(data);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(error);
    });
  });
}

async function testMultiClientPositionSync(serverUrl) {
  return new Promise((resolve, reject) => {
    const client1 = io(serverUrl, { timeout: 5000 });
    const client2 = io(serverUrl, { timeout: 5000 });

    let client1Connected = false;
    let client2Connected = false;
    let testStarted = false;

    const cleanup = () => {
      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Multi-client position test timed out"));
    }, 8000);

    function checkAndMove() {
      if (
        client1Connected &&
        client2Connected &&
        !testStarted
      ) {
        testStarted = true;
        client1.emit("updatePosition", { x: 30, y: 40 });
      }
    }

    client1.on("connect", () => {
      client1Connected = true;
      checkAndMove();
    });

    client2.on("connect", () => {
      client2Connected = true;
      checkAndMove();
    });

    client2.on("userPositionUpdated", (data) => {
      if (
        data.id === client1.id &&
        data.x === 30 &&
        data.y === 40
      ) {
        cleanup();
        resolve(true);
      }
    });

    client1.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });

    client2.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function runTest() {
  let hasErrors = false;

  console.log("Starting server process...");

  const server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (data) => {
    console.log(`[SERVER]: ${data.toString().trim()}`);
  });

  server.stderr.on("data", (data) => {
    console.error(`[SERVER ERROR]: ${data.toString().trim()}`);
  });

  try {
    // Wait for the server to start.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    if (server.exitCode !== null) {
      throw new Error("Server exited before tests could start.");
    }

    console.log("\n--- Test 1: Root endpoint ---");
    const root = await checkUrl("http://localhost:5000/");

    if (
      root.status === 200 &&
      root.body === "ProxiSpeak Backend is running!"
    ) {
      console.log("PASS: Root endpoint");
    } else {
      throw new Error("Root endpoint test failed.");
    }

    console.log("\n--- Test 2: Health endpoint ---");
    const health = await checkUrl(
      "http://localhost:5000/api/health"
    );
    const healthJson = JSON.parse(health.body);

    if (
      health.status === 200 &&
      healthJson.status === "OK" &&
      healthJson.project === "ProxiSpeak"
    ) {
      console.log("PASS: Health endpoint");
    } else {
      throw new Error("Health endpoint test failed.");
    }

    console.log("\n--- Test 3: Status endpoint ---");
    const status = await checkUrl(
      "http://localhost:5000/api/status"
    );
    const statusJson = JSON.parse(status.body);

    if (status.status === 200 && statusJson.status === "active") {
      console.log("PASS: Status endpoint");
    } else {
      throw new Error("Status endpoint test failed.");
    }

    console.log("\n--- Test 4: Socket.IO ping-pong ---");
    const pong = await testSocketPingPong(
      "http://localhost:5000"
    );

    if (pong) {
      console.log("PASS: Socket.IO ping-pong");
    } else {
      throw new Error("Ping-pong test failed.");
    }

    console.log("\n--- Test 5: Multi-client position sync ---");
    const synced = await testMultiClientPositionSync(
      "http://localhost:5000"
    );

    if (synced) {
      console.log("PASS: Multi-client position synchronization");
    } else {
      throw new Error("Position synchronization test failed.");
    }
  } catch (error) {
    console.error("\nTEST ERROR:", error.message);
    hasErrors = true;
  } finally {
    console.log("\nStopping test server...");

    if (server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (hasErrors) {
      console.error("\nTESTS FAILED");
      process.exitCode = 1;
    } else {
      console.log("\nALL TESTS PASSED");
    }
  }
}

runTest();
