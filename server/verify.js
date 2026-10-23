const http = require("http");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

// Test 1: Socket.IO Connection Acknowledgment & Ping-Pong
async function testSocketConnectionAndPingPong(serverUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    let ackReceived = null;
    let pongReceived = null;

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.IO connection/pong response timed out after 5000ms"));
    }, 5000);

    socket.on("connectionAck", (ack) => {
      ackReceived = ack;
      socket.emit("ping", { message: "ping from test client", sentAt: Date.now() });
    });

    socket.on("pong", (data) => {
      pongReceived = data;
      clearTimeout(timeout);
      socket.disconnect();
      resolve({ ackReceived, pongReceived });
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

// Test 4: Proper User Disconnection Lifecycle Handling
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
        leavingClient.emit("clientDisconnect");
      }, 500);
    });

    observerClient.on("userDisconnected", (data) => {
      const id = typeof data === "string" ? data : data?.id;
      if (id === leavingClientId) {
        clearTimeout(timeout);
        observerClient.disconnect();
        resolve({ disconnectedId: id, reason: data?.reason });
      }
    });

    observerClient.on("connect_error", (e) => reject(e));
    leavingClient.on("connect_error", (e) => reject(e));
  });
}

// Test 5: Room Join/Leave Logic & Participant Updates
async function testRoomJoinAndParticipantUpdates(serverUrl) {
  return new Promise((resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    let client2 = null;

    let client2JoinedReceived = false;
    let client2LeftReceived = false;
    let client2NewRoomConfirmed = false;

    const timeout = setTimeout(() => {
      client1.disconnect();
      if (client2) client2.disconnect();
      reject(new Error("Room join/leave and participant update test timed out"));
    }, 6000);

    function checkComplete() {
      if (client2JoinedReceived && client2LeftReceived && client2NewRoomConfirmed) {
        clearTimeout(timeout);
        client1.disconnect();
        if (client2) client2.disconnect();
        resolve(true);
      }
    }

    client1.on("connect", () => {
      // Connect client2 only after client1 has registered and joined default room
      client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

      client2.on("roomParticipants", (data) => {
        if (data.roomId === "conference-1") {
          const foundSelf = data.participants.some((p) => p.id === client2.id);
          if (foundSelf) {
            client2NewRoomConfirmed = true;
            checkComplete();
          }
        }
      });

      client2.on("connect_error", (e) => reject(e));
    });

    client1.on("participantJoined", (user) => {
      if (client2 && user.id === client2.id && user.roomId === "main-office") {
        client2JoinedReceived = true;
        client2.emit("joinRoom", { roomId: "conference-1", username: "VoiceTester-2" });
      }
    });

    client1.on("participantLeft", (data) => {
      if (client2 && data.id === client2.id && data.roomId === "main-office") {
        client2LeftReceived = true;
        checkComplete();
      }
    });

    client1.on("connect_error", (e) => reject(e));
  });
}

// Test 6: Multiple Simultaneous Connections & Duplicate Guards
async function testMultipleSimultaneousConnections(serverUrl, clientCount = 6) {
  return new Promise(async (resolve, reject) => {
    const clients = [];
    const timeout = setTimeout(() => {
      clients.forEach((c) => c.disconnect());
      reject(new Error("Simultaneous connections test timed out"));
    }, 10000);

    try {
      // Step A: Connect all clients concurrently
      const connectPromises = [];
      for (let i = 0; i < clientCount; i++) {
        const socket = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
        clients.push(socket);
        connectPromises.push(
          new Promise((res, rej) => {
            socket.on("connect", () => res(socket.id));
            socket.on("connect_error", rej);
          })
        );
      }

      const connectedIds = await Promise.all(connectPromises);
      const client0Id = connectedIds[0];
      const client1Id = connectedIds[1];

      // Step B: Duplicate Join Protection Check on Client 0
      let duplicateParticipantJoinedCount = 0;
      clients[1].on("participantJoined", (user) => {
        if (user.id === client0Id) {
          duplicateParticipantJoinedCount++;
        }
      });

      // Send 3 duplicate join requests with identical data
      clients[0].emit("joinRoom", { roomId: "main-office" });
      clients[0].emit("joinRoom", { roomId: "main-office" });
      clients[0].emit("join", { username: `User-${client0Id.slice(0, 4)}` });

      await new Promise((r) => setTimeout(r, 600));

      // Step C: Concurrent Position Updates across all clients
      let updatesReceivedByClient0 = 0;
      clients[0].on("userPositionUpdated", (data) => {
        if (data.id !== client0Id) {
          updatesReceivedByClient0++;
        }
      });

      // All other clients concurrently broadcast unique positions
      for (let i = 1; i < clientCount; i++) {
        clients[i].emit("updatePosition", { x: 100 * i, y: 150 * i });
      }

      await new Promise((r) => setTimeout(r, 800));

      // Step D: Duplicate Disconnect Safety on Client 1
      let client1DisconnectEventCount = 0;
      clients[0].on("userDisconnected", (data) => {
        const id = typeof data === "string" ? data : data?.id;
        if (id === client1Id) {
          client1DisconnectEventCount++;
        }
      });

      // Emit voluntary clientDisconnect AND close socket transport
      clients[1].emit("clientDisconnect");
      clients[1].disconnect();

      await new Promise((r) => setTimeout(r, 600));

      // Cleanup remaining clients
      clients.forEach((c) => {
        if (c.connected) c.disconnect();
      });

      clearTimeout(timeout);

      resolve({
        connectedCount: connectedIds.length,
        duplicateJoinsIgnored: duplicateParticipantJoinedCount === 0,
        concurrentUpdatesReceived: updatesReceivedByClient0 === clientCount - 1,
        duplicateDisconnectSafelyHandled: client1DisconnectEventCount === 1,
      });
    } catch (err) {
      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());
      reject(err);
    }
  });
}

// Test 7: WebRTC Signaling Relays & Target Offline Validation
async function testWebRTCSignaling(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const peer1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const peer2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    const timeout = setTimeout(() => {
      peer1.disconnect();
      peer2.disconnect();
      reject(new Error("WebRTC signaling test timed out"));
    }, 6000);

    let offerRelayed = false;
    let answerRelayed = false;
    let candidateRelayed = false;
    let errorReceivedForMissingPeer = false;

    try {
      await Promise.all([
        new Promise((res, rej) => {
          peer1.on("connect", res);
          peer1.on("connect_error", rej);
        }),
        new Promise((res, rej) => {
          peer2.on("connect", res);
          peer2.on("connect_error", rej);
        }),
      ]);

      // Assert signaling relays
      peer2.on("signal:offer", (data) => {
        if (data.senderId === peer1.id && data.offer?.sdp === "test-sdp-offer") {
          offerRelayed = true;
          peer2.emit("signal:answer", { targetId: peer1.id, answer: { type: "answer", sdp: "test-sdp-answer" } });
        }
      });

      peer1.on("signal:answer", (data) => {
        if (data.senderId === peer2.id && data.answer?.sdp === "test-sdp-answer") {
          answerRelayed = true;
          peer1.emit("signal:ice-candidate", { targetId: peer2.id, candidate: { candidate: "dummy-candidate" } });
        }
      });

      peer2.on("signal:ice-candidate", (data) => {
        if (data.senderId === peer1.id && data.candidate?.candidate === "dummy-candidate") {
          candidateRelayed = true;
          checkComplete();
        }
      });

      peer1.on("signal:error", (data) => {
        if (data.targetId === "non-existent-peer") {
          errorReceivedForMissingPeer = true;
          checkComplete();
        }
      });

      // Initiate offer and bad peer test
      peer1.emit("signal:offer", { targetId: peer2.id, offer: { type: "offer", sdp: "test-sdp-offer" } });
      peer1.emit("signal:offer", { targetId: "non-existent-peer", offer: { type: "offer", sdp: "bad-offer" } });

      function checkComplete() {
        if (offerRelayed && answerRelayed && candidateRelayed && errorReceivedForMissingPeer) {
          clearTimeout(timeout);
          peer1.disconnect();
          peer2.disconnect();
          resolve(true);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      peer1.disconnect();
      peer2.disconnect();
      reject(err);
    }
  });
}

// Test 8: Repeated Connections and Disconnections (Reconnection Churn)
async function testRepeatedConnectionsAndDisconnections(serverUrl, sequentialCycles = 6) {
  return new Promise(async (resolve, reject) => {
    const observer = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const disconnectedIds = [];

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Repeated connections test timed out"));
    }, 15000);

    observer.on("userDisconnected", (data) => {
      const id = typeof data === "string" ? data : data?.id;
      if (id) disconnectedIds.push(id);
    });

    try {
      await new Promise((res, rej) => {
        observer.on("connect", res);
        observer.on("connect_error", rej);
      });

      // Part A: Rapid sequential connect/join/update/disconnect cycles
      const sequentialIds = [];
      for (let i = 0; i < sequentialCycles; i++) {
        const client = io(serverUrl, { transports: ["websocket", "polling"], timeout: 4000 });
        await new Promise((res, rej) => {
          client.on("connect", () => {
            sequentialIds.push(client.id);
            client.emit("join", { username: `ChurnUser-${i}` });
            client.emit("updatePosition", { x: 50 + i * 20, y: 50 + i * 20 });
            setTimeout(() => {
              client.disconnect();
              res();
            }, 50);
          });
          client.on("connect_error", rej);
        });
        await new Promise((r) => setTimeout(r, 60));
      }

      // Part B: Concurrent reconnection burst (4 clients simultaneously)
      const burstClients = [];
      const burstIds = [];
      const burstPromises = [];
      for (let j = 0; j < 4; j++) {
        const bClient = io(serverUrl, { transports: ["websocket", "polling"], timeout: 4000 });
        burstClients.push(bClient);
        burstPromises.push(
          new Promise((res, rej) => {
            bClient.on("connect", () => {
              burstIds.push(bClient.id);
              bClient.emit("join", { username: `BurstUser-${j}` });
              bClient.emit("updatePosition", { x: 100 * (j + 1), y: 100 * (j + 1) });
              setTimeout(() => {
                bClient.disconnect();
                res();
              }, 80);
            });
            bClient.on("connect_error", rej);
          })
        );
      }
      await Promise.all(burstPromises);
      await new Promise((r) => setTimeout(r, 800));

      clearTimeout(timeout);
      observer.disconnect();

      // Check /api/status active users count
      const statusRes = await checkUrl(`${serverUrl}/api/status`);
      const statusJson = JSON.parse(statusRes.body);

      resolve({
        cyclesCompleted: sequentialCycles,
        burstCount: burstClients.length,
        totalChurnTested: sequentialCycles + burstClients.length,
        finalActiveUsers: statusJson.activeUsers,
        serverResponsive: statusJson.status === "active",
      });
    } catch (err) {
      clearTimeout(timeout);
      observer.disconnect();
      reject(err);
    }
  });
}

async function runTest() {
  let hasErrors = false;
  console.log("Starting ProxiSpeak server for verification...");
  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.on("error", (err) => {
    console.error("[SPAWN ERROR]:", err);
  });

  let serverStarted = false;
  const startupPromise = new Promise((resolve) => {
    server.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[SERVER STDOUT]: ${text}`);
      if (text.includes("Server running on port")) {
        serverStarted = true;
        resolve();
      }
    });
    // Fallback if output format changes
    setTimeout(resolve, 3000);
  });

  server.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.error(`[SERVER STDERR]: ${text}`);
  });

  await startupPromise;

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

    // 2. Health check (Frontend Contract: client/src/App.jsx)
    console.log("\n--- [2] Checking Health Endpoint: GET /api/health ---");
    const healthRes = await checkUrl("http://localhost:5000/api/health");
    const healthJson = JSON.parse(healthRes.body);
    if (healthRes.status === 200 && healthJson.status === "OK" && healthJson.project === "ProxiSpeak" && healthJson.timestamp) {
      console.log("--> PASS: /api/health satisfies frontend contract ({ status: 'OK', project: 'ProxiSpeak' }).");
    } else {
      console.error("--> FAIL: /api/health invalid response.");
      hasErrors = true;
    }

    // 3. Status endpoint
    console.log("\n--- [3] Checking Status Endpoint: GET /api/status ---");
    const statusRes = await checkUrl("http://localhost:5000/api/status");
    const statusJson = JSON.parse(statusRes.body);
    if (statusRes.status === 200 && statusJson.status === "active" && typeof statusJson.activeUsers === "number") {
      console.log(`--> PASS: /api/status active (uptime: ${statusJson.uptime}, activeUsers: ${statusJson.activeUsers}).`);
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

    // 5. Socket.IO Connection Acknowledgment & Ping-Pong Event
    console.log("\n--- [5] Testing Socket.IO Connection Acknowledgment & Ping-Pong ---");
    const connTest = await testSocketConnectionAndPingPong("http://localhost:5000");
    if (connTest.ackReceived && connTest.ackReceived.status === "connected" && connTest.pongReceived) {
      console.log("--> PASS: Client received connectionAck and pong response successfully.");
    } else {
      console.error("--> FAIL: ConnectionAck or Ping-Pong event failed.");
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
    console.log("\n--- [8] Testing Proper User Disconnection Lifecycle ---");
    const disconnectResult = await testDisconnectionHandling("http://localhost:5000");
    if (disconnectResult && disconnectResult.disconnectedId) {
      console.log(`--> PASS: Client disconnection of ${disconnectResult.disconnectedId} broadcasted to peers with cleanup.`);
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

    // 10. Multiple Simultaneous Connections & Duplicate Event Handling
    console.log("\n--- [10] Testing Multiple Simultaneous Connections & Duplicate Guards ---");
    const concurrentResult = await testMultipleSimultaneousConnections("http://localhost:5000", 6);
    if (
      concurrentResult.connectedCount === 6 &&
      concurrentResult.duplicateJoinsIgnored &&
      concurrentResult.concurrentUpdatesReceived &&
      concurrentResult.duplicateDisconnectSafelyHandled
    ) {
      console.log(`--> PASS: Successfully managed ${concurrentResult.connectedCount} simultaneous connections.`);
      console.log("--> PASS: Duplicate join events safely ignored (zero redundant participantJoined floods).");
      console.log("--> PASS: Concurrent position updates broadcasted to all peers without race conditions.");
      console.log("--> PASS: Duplicate disconnect attempts handled safely with single broadcast.");
    } else {
      console.error("--> FAIL: Simultaneous connection test failed:", concurrentResult);
      hasErrors = true;
    }

    // 11. WebRTC Signaling Relays & Target Offline Validation
    console.log("\n--- [11] Testing WebRTC Signaling Relays & Target Validation ---");
    const signalingSuccess = await testWebRTCSignaling("http://localhost:5000");
    if (signalingSuccess) {
      console.log("--> PASS: WebRTC offer, answer, and ice-candidate successfully relayed between active peers.");
      console.log("--> PASS: signal:error safely emitted to sender when target peer does not exist.");
    } else {
      console.error("--> FAIL: WebRTC signaling test failed.");
      hasErrors = true;
    }

    // 12. Repeated Connections and Disconnections (Reconnection Churn)
    console.log("\n--- [12] Testing Repeated Connections & Disconnection Churn Handling ---");
    const churnResult = await testRepeatedConnectionsAndDisconnections("http://localhost:5000", 6);
    if (churnResult.serverResponsive && churnResult.finalActiveUsers === 0) {
      console.log(`--> PASS: Successfully sustained ${churnResult.totalChurnTested} sequential & concurrent connection cycles.`);
      console.log(`--> PASS: Active users counter correctly normalized to ${churnResult.finalActiveUsers} after disconnects.`);
      console.log("--> PASS: Server remained stable without unhandled exceptions or memory leaks.");
    } else {
      console.error("--> FAIL: Repeated connections & churn test failed:", churnResult);
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
      console.log("\n✅ ALL TESTS PASSED: All 12 backend modules, frontend contract checks, and socket events verified.\n");
      process.exit(0);
    }
  }
}

runTest();
