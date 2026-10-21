
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url) {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body };
}

async function waitForServer(server, serverUrl, maxWait = 20000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (server.exitCode !== null) {
      throw new Error("Server exited before tests could start.");
    }

    try {
      const res = await fetch(serverUrl);
      if (res.ok) return;
    } catch (_) {
      // Server may still be connecting to MongoDB or starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Server did not become ready within 20 seconds.");
}

// Test 1: Socket.IO Ping-Pong Handshake
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

// Test 2: Multi-Client Position Update & Broadcasting
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
      if (client1Connected && client2Connected && !testStarted) {
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

// Test 3: Backend Validation & Coordinate Clamping
async function testBackendValidation(serverUrl) {
  return new Promise((resolve, reject) => {
    const clientA = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    const clientB = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    let validationErrorsReceived = 0;
    let clampedBroadcastReceived = false;
    let validationPayloadsSent = false;

    const cleanup = () => {
      clearTimeout(timeout);
      clientA.disconnect();
      clientB.disconnect();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Backend validation test timed out"));
    }, 8000);

    let readyCount = 0;

    function onReady() {
      readyCount++;

      if (readyCount === 2 && !validationPayloadsSent) {
        validationPayloadsSent = true;
        clientA.emit("updatePosition", {
          x: "invalid_string",
          y: null,
        });
        clientA.emit("updatePosition", {
          x: NaN,
          y: 150,
        });
      }
    }

    clientA.on("connect", onReady);
    clientB.on("connect", onReady);

    clientA.on("error:validation", () => {
      validationErrorsReceived++;

      if (validationErrorsReceived >= 2 && !clampedBroadcastReceived) {
        clientA.emit("updatePosition", { x: 99999, y: -500 });
      }
    });

    clientB.on("userPositionUpdated", (data) => {
      if (
        data.id === clientA.id &&
        data.x === 2000 &&
        data.y === 0
      ) {
        clampedBroadcastReceived = true;
        cleanup();
        resolve({
          validationErrorsReceived,
          clampedBroadcastReceived,
        });
      }
    });

    clientA.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });

    clientB.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

// Test 4: User Disconnection Handling
async function testDisconnectionHandling(serverUrl) {
  return new Promise((resolve, reject) => {
    const observerClient = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    const leavingClient = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    let leavingClientId = null;
    let disconnectRequested = false;

    const cleanup = () => {
      clearTimeout(timeout);
      observerClient.disconnect();
      leavingClient.disconnect();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Disconnection handling test timed out"));
    }, 8000);

    leavingClient.on("connect", () => {
      leavingClientId = leavingClient.id;

      if (!disconnectRequested) {
        disconnectRequested = true;
        setTimeout(() => leavingClient.disconnect(), 500);
      }
    });

    observerClient.on("userDisconnected", (data) => {
      const disconnectedId =
        typeof data === "string" ? data : data?.id;

      if (disconnectedId && disconnectedId === leavingClientId) {
        const result = {
          disconnectedId,
          reason: typeof data === "object" ? data.reason : undefined,
        };

        cleanup();
        resolve(result);
      }
    });

    observerClient.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });

    leavingClient.on("connect_error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

// Test 5: Room Join/Leave & Participant Updates
async function testRoomJoinAndParticipantUpdates(serverUrl) {
  return new Promise((resolve, reject) => {
    const client1 = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    const client2 = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    let client2JoinedReceived = false;
    let client2LeftReceived = false;
    let client2NewRoomConfirmed = false;
    let roomSwitchRequested = false;

    const cleanup = () => {
      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Room join/leave test timed out"));
    }, 8000);

    client1.on("connect", () => {
      client1.emit("joinRoom", {
        roomId: "main-office",
        username: "VoiceTester-1",
      });
    });

    client2.on("connect", () => {
      client2.emit("joinRoom", {
        roomId: "main-office",
        username: "VoiceTester-2",
      });
    });

    client1.on("participantJoined", (user) => {
      if (
        user.id === client2.id &&
        user.roomId === "main-office"
      ) {
        client2JoinedReceived = true;

        if (!roomSwitchRequested) {
          roomSwitchRequested = true;
          client2.emit("joinRoom", {
            roomId: "conference-1",
            username: "VoiceTester-2",
          });
        }

        checkComplete();
      }
    });

    client1.on("participantLeft", (data) => {
      if (
        data.id === client2.id &&
        data.roomId === "main-office"
      ) {
        client2LeftReceived = true;
        checkComplete();
      }
    });

    client2.on("roomParticipants", (data) => {
      if (data.roomId === "conference-1") {
        const participants = Array.isArray(data.participants)
          ? data.participants
          : [];

        if (participants.some((p) => p.id === client2.id)) {
          client2NewRoomConfirmed = true;
          checkComplete();
        }
      }
    });

    function checkComplete() {
      if (
        client2JoinedReceived &&
        client2LeftReceived &&
        client2NewRoomConfirmed
      ) {
        cleanup();
        resolve(true);
      }
    }

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

  console.log("Starting ProxiSpeak server for verification...");

  const server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (data) => {
    const output = data.toString().trim();
    if (output) console.log(`[SERVER]: ${output}`);
  });

  server.stderr.on("data", (data) => {
    const output = data.toString().trim();
    if (output) console.error(`[SERVER ERROR]: ${output}`);
  });

  try {
    await waitForServer(server, "http://localhost:5000/");

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
    const health = await checkUrl("http://localhost:5000/api/health");
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
    const status = await checkUrl("http://localhost:5000/api/status");
    const statusJson = JSON.parse(status.body);

    if (status.status === 200 && statusJson.status === "active") {
      console.log("PASS: Status endpoint");
    } else {
      throw new Error("Status endpoint test failed.");
    }

    console.log("\n--- Test 4: Unknown route ---");
    const unknown = await checkUrl(
      "http://localhost:5000/api/non-existent-route"
    );

    if (unknown.status === 404) {
      console.log("PASS: Unknown route returns 404");
    } else {
      throw new Error("404 route test failed.");
    }

    console.log("\n--- Test 5: Socket.IO ping-pong ---");
    const pong = await testSocketPingPong("http://localhost:5000");

    if (pong) {
      console.log("PASS: Socket.IO ping-pong");
    } else {
      throw new Error("Ping-pong test failed.");
    }

    console.log("\n--- Test 6: Multi-client position sync ---");
    const synced = await testMultiClientPositionSync(
      "http://localhost:5000"
    );

    if (synced) {
      console.log("PASS: Multi-client position synchronization");
    } else {
      throw new Error("Position synchronization test failed.");
    }

    console.log("\n--- Test 7: Backend validation and clamping ---");
    const validation = await testBackendValidation(
      "http://localhost:5000"
    );

    if (
      validation.validationErrorsReceived >= 2 &&
      validation.clampedBroadcastReceived
    ) {
      console.log("PASS: Invalid position payloads rejected");
      console.log("PASS: Coordinates clamped to [0, 2000]");
    } else {
      throw new Error("Backend validation test failed.");
    }

    console.log("\n--- Test 8: Disconnection handling ---");
    const disconnect = await testDisconnectionHandling(
      "http://localhost:5000"
    );

    if (disconnect && disconnect.disconnectedId) {
      console.log("PASS: User disconnection notified to peers");
    } else {
      throw new Error("Disconnection handling test failed.");
    }

    console.log("\n--- Test 9: Room join/leave and participant updates ---");
    const roomSuccess = await testRoomJoinAndParticipantUpdates(
      "http://localhost:5000"
    );

    if (roomSuccess) {
      console.log("PASS: Room join, room switch, and participant updates");
    } else {
      throw new Error("Room join/leave test failed.");
    }
  } catch (error) {
    hasErrors = true;
    console.error("\nTEST ERROR:", error.message);
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
