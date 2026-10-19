const http = require("http");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text };
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
      reject(new Error("Socket.IO pong response timed out after 5000ms"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit("ping", { message: "ping from test client", sentAt: Date.now() });
    });

    socket.on("pong", (data) => {
      clearTimeout(timeout);
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

// Test 2: Multi-Client Position Update & Broadcasting
async function testMultiClientPositionSync(serverUrl) {
  return new Promise((resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    let client1Connected = false;
    let client2Connected = false;

    const timeout = setTimeout(() => {
      client1.disconnect();
      client2.disconnect();
      reject(new Error("Multi-client position test timed out"));
    }, 6000);

    client1.on("connect", () => {
      client1Connected = true;
      checkAndMove();
    });

    client2.on("connect", () => {
      client2Connected = true;
      checkAndMove();
    });

    function checkAndMove() {
      if (client1Connected && client2Connected) {
        client1.emit("updatePosition", { x: 300, y: 250 });
      }
    }

    client2.on("userPositionUpdated", (data) => {
      if (data.id === client1.id && data.x === 300 && data.y === 250) {
        clearTimeout(timeout);
        client1.disconnect();
        client2.disconnect();
        resolve(true);
      }
    });

    client1.on("connect_error", (e) => reject(e));
    client2.on("connect_error", (e) => reject(e));
  });
}

// Test 3: Backend Validation - Reject Malformed Payloads & Clamp Coordinates
async function testBackendValidation(serverUrl) {
  return new Promise((resolve, reject) => {
    const clientA = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const clientB = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    let validationErrorsReceived = 0;
    let clampedBroadcastReceived = false;

    const timeout = setTimeout(() => {
      clientA.disconnect();
      clientB.disconnect();
      reject(new Error("Backend validation test timed out"));
    }, 6000);

    let readyCount = 0;
    function onReady() {
      readyCount++;
      if (readyCount === 2) {
        clientA.emit("updatePosition", { x: "invalid_string", y: null });
        clientA.emit("updatePosition", { x: NaN, y: 150 });
      }
    }

    clientA.on("connect", onReady);
    clientB.on("connect", onReady);

    clientA.on("error:validation", (err) => {
      validationErrorsReceived++;
      if (validationErrorsReceived === 2) {
        clientA.emit("updatePosition", { x: 99999, y: -500 });
      }
    });

    clientB.on("userPositionUpdated", (data) => {
      if (data.id === clientA.id && data.x === 2000 && data.y === 0) {
        clampedBroadcastReceived = true;
        clearTimeout(timeout);
        clientA.disconnect();
        clientB.disconnect();
        resolve({ validationErrorsReceived, clampedBroadcastReceived });
      }
    });

    clientA.on("connect_error", (e) => reject(e));
    clientB.on("connect_error", (e) => reject(e));
  });
}

// Test 4: Proper User Disconnection Handling & Peer Notification
async function testDisconnectionHandling(serverUrl) {
  return new Promise((resolve, reject) => {
    const observerClient = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const leavingClient = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    const timeout = setTimeout(() => {
      observerClient.disconnect();
      leavingClient.disconnect();
      reject(new Error("Disconnection handling test timed out"));
    }, 6000);

    let leavingClientId = null;

    leavingClient.on("connect", () => {
      leavingClientId = leavingClient.id;
      setTimeout(() => {
        leavingClient.disconnect();
      }, 500);
    });

    observerClient.on("userDisconnected", (data) => {
      if (data && data.id === leavingClientId) {
        clearTimeout(timeout);
        observerClient.disconnect();
        resolve({ disconnectedId: data.id, reason: data.reason });
      }
    });

    observerClient.on("connect_error", (e) => reject(e));
    leavingClient.on("connect_error", (e) => reject(e));
  });
}

// Test 5: Room Join/Leave Logic & Participant Updates for Voice Communication
async function testRoomJoinAndParticipantUpdates(serverUrl) {
  return new Promise((resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    let client2JoinedReceived = false;
    let client2LeftReceived = false;
    let client2NewRoomConfirmed = false;

    const timeout = setTimeout(() => {
      client1.disconnect();
      client2.disconnect();
      reject(new Error("Room join/leave and participant update test timed out"));
    }, 6000);

    // Client 1 checks for Client 2 joining main-office
    client1.on("participantJoined", (user) => {
      if (user.id === client2.id && user.roomId === "main-office") {
        client2JoinedReceived = true;
        // Trigger Client 2 to switch room to conference-1
        client2.emit("joinRoom", { roomId: "conference-1", username: "VoiceTester-2" });
      }
    });

    // Client 1 checks for Client 2 leaving main-office
    client1.on("participantLeft", (data) => {
      if (data.id === client2.id && data.roomId === "main-office") {
        client2LeftReceived = true;
        checkComplete();
      }
    });

    // Client 2 verifies receiving roomParticipants for conference-1
    client2.on("roomParticipants", (data) => {
      if (data.roomId === "conference-1") {
        const foundSelf = data.participants.some((p) => p.id === client2.id);
        if (foundSelf) {
          client2NewRoomConfirmed = true;
          checkComplete();
        }
      }
    });

    function checkComplete() {
      if (client2JoinedReceived && client2LeftReceived && client2NewRoomConfirmed) {
        clearTimeout(timeout);
        client1.disconnect();
        client2.disconnect();
        resolve(true);
      }
    }

    client1.on("connect_error", (e) => reject(e));
    client2.on("connect_error", (e) => reject(e));
  });
}

async function runTest() {
  let hasErrors = false;
  console.log("Starting ProxiSpeak server for verification...");
  const server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stdout.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[SERVER STDOUT]: ${text}`);
  });

  server.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.error(`[SERVER STDERR]: ${text}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    console.log("\n==================================================");
    console.log("  PROXISPEAK BACKEND & SOCKET VERIFICATION SUITE  ");
    console.log("==================================================");

    // 1. Root route
    console.log("\n--- [1] Checking Root Endpoint: GET / ---");
    const rootRes = await checkUrl("http://localhost:5000/");
    if (rootRes.status === 200 && rootRes.body === "ProxiSpeak Backend is running!") {
      console.log("--> PASS: Root endpoint returns 200 OK with correct message.");
    } else {
      console.error("--> FAIL: Root endpoint failed. Status:", rootRes.status);
      hasErrors = true;
    }

    // 2. Health check
    console.log("\n--- [2] Checking Health Endpoint: GET /api/health ---");
    const healthRes = await checkUrl("http://localhost:5000/api/health");
    const healthJson = JSON.parse(healthRes.body);
    if (healthRes.status === 200 && healthJson.status === "OK" && healthJson.project === "ProxiSpeak") {
      console.log("--> PASS: /api/health returns valid status JSON.");
    } else {
      console.error("--> FAIL: /api/health invalid response.");
      hasErrors = true;
    }

    // 3. Status endpoint
    console.log("\n--- [3] Checking Status Endpoint: GET /api/status ---");
    const statusRes = await checkUrl("http://localhost:5000/api/status");
    const statusJson = JSON.parse(statusRes.body);
    if (statusRes.status === 200 && statusJson.status === "active") {
      console.log(`--> PASS: /api/status active (uptime: ${statusJson.uptime}).`);
    } else {
      console.error("--> FAIL: /api/status invalid response.");
      hasErrors = true;
    }

    // 4. Unknown route 404 handler
    console.log("\n--- [4] Checking 404 Error Handler: GET /api/unknown ---");
    const unknownRes = await checkUrl("http://localhost:5000/api/non-existent-route");
    if (unknownRes.status === 404) {
      console.log("--> PASS: Unrecognized API routes correctly return 404 Not Found.");
    } else {
      console.error("--> FAIL: 404 handler failed. Received status:", unknownRes.status);
      hasErrors = true;
    }

    // 5. Socket.IO Ping-Pong Event
    console.log("\n--- [5] Testing Socket.IO Ping-Pong Event ---");
    const pongResponse = await testSocketPingPong("http://localhost:5000");
    if (pongResponse) {
      console.log("--> PASS: Client sent 'ping', server responded with 'pong'.");
    } else {
      console.error("--> FAIL: Ping-Pong event failed.");
      hasErrors = true;
    }

    // 6. Multi-Client Position Synchronization
    console.log("\n--- [6] Testing Multi-Client Position Synchronization ---");
    const syncSuccess = await testMultiClientPositionSync("http://localhost:5000");
    if (syncSuccess) {
      console.log("--> PASS: Client 1 position update broadcasted and received by Client 2.");
    } else {
      console.error("--> FAIL: Position broadcasting failed.");
      hasErrors = true;
    }

    // 7. Backend Validation & Payload Sanitization
    console.log("\n--- [7] Testing Backend Input Validation & Clamping ---");
    const valResult = await testBackendValidation("http://localhost:5000");
    if (valResult.validationErrorsReceived >= 2 && valResult.clampedBroadcastReceived) {
      console.log(`--> PASS: Rejected ${valResult.validationErrorsReceived} malformed payloads (non-numeric, NaN) without server crash.`);
      console.log("--> PASS: Out-of-bounds coordinates safely clamped to map boundaries [0, 2000].");
    } else {
      console.error("--> FAIL: Backend validation checks failed.", valResult);
      hasErrors = true;
    }

    // 8. Proper User Disconnection Handling
    console.log("\n--- [8] Testing Proper User Disconnection Handling ---");
    const disconnectResult = await testDisconnectionHandling("http://localhost:5000");
    if (disconnectResult && disconnectResult.disconnectedId) {
      console.log(`--> PASS: Disconnection of ${disconnectResult.disconnectedId} broadcasted to peers with cleanup.`);
    } else {
      console.error("--> FAIL: Disconnection handling failed.");
      hasErrors = true;
    }

    // 9. Room Join/Leave Logic & Participant Updates for Voice
    console.log("\n--- [9] Testing Room Join/Leave Logic & Participant Updates ---");
    const roomSuccess = await testRoomJoinAndParticipantUpdates("http://localhost:5000");
    if (roomSuccess) {
      console.log("--> PASS: Room join, participantJoined, room switching, and participantLeft verified.");
    } else {
      console.error("--> FAIL: Room join/leave logic failed.");
      hasErrors = true;
    }

  } catch (err) {
    console.error("\n[TEST RUNNER EXCEPTION]:", err.message || err);
    hasErrors = true;
  } finally {
    console.log("\nShutting down test server...");
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Server stopped successfully.");

    if (hasErrors) {
      console.error("\n❌ VERIFICATION FAILED: One or more tests did not pass.\n");
      process.exit(1);
    } else {
      console.log("\n✅ ALL TESTS PASSED: All 9 backend modules, room logic, and socket events verified.\n");
      process.exit(0);
    }
  }
}

runTest();
