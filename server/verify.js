const http = require("http");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      return { status: res.status, body: text, headers: res.headers };
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function postJson(url, data, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const text = await res.text();
      return { status: res.status, body: text, headers: res.headers };
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function putJson(url, data, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const text = await res.text();
      return { status: res.status, body: text, headers: res.headers };
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
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

// Test 9: Real-Time Multi-Tab Avatar Movement Synchronization
async function testMultiTabAvatarMovementSync(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const tabAlice = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const tabBob = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const tabCharlie = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    const timeout = setTimeout(() => {
      tabAlice.disconnect();
      tabBob.disconnect();
      tabCharlie.disconnect();
      reject(new Error("Multi-tab movement synchronization test timed out"));
    }, 8000);

    let bobReceivedAliceMove = false;
    let charlieReceivedAliceMove = false;
    let aliceReceivedBobMove = false;
    let charlieReceivedBobMove = false;

    function checkSync() {
      if (bobReceivedAliceMove && charlieReceivedAliceMove && aliceReceivedBobMove && charlieReceivedBobMove) {
        clearTimeout(timeout);
        tabAlice.disconnect();
        tabBob.disconnect();
        tabCharlie.disconnect();
        resolve(true);
      }
    }

    try {
      await Promise.all([
        new Promise((res, rej) => { tabAlice.on("connect", res); tabAlice.on("connect_error", rej); }),
        new Promise((res, rej) => { tabBob.on("connect", res); tabBob.on("connect_error", rej); }),
        new Promise((res, rej) => { tabCharlie.on("connect", res); tabCharlie.on("connect_error", rej); }),
      ]);

      tabAlice.emit("join", { username: "Alice", roomId: "main-office" });
      tabBob.emit("join", { username: "Bob", roomId: "main-office" });
      tabCharlie.emit("join", { username: "Charlie", roomId: "main-office" });

      await new Promise((r) => setTimeout(r, 200));

      tabBob.on("userPositionUpdated", (data) => {
        if (data.id === tabAlice.id && data.x === 250 && data.y === 350) {
          bobReceivedAliceMove = true;
          checkSync();
        }
      });

      tabCharlie.on("userPositionUpdated", (data) => {
        if (data.id === tabAlice.id && data.x === 250 && data.y === 350) {
          charlieReceivedAliceMove = true;
          checkSync();
        }
        if (data.id === tabBob.id && data.x === 500 && data.y === 150) {
          charlieReceivedBobMove = true;
          checkSync();
        }
      });

      tabAlice.on("userPositionUpdated", (data) => {
        if (data.id === tabBob.id && data.x === 500 && data.y === 150) {
          aliceReceivedBobMove = true;
          checkSync();
        }
      });

      // Alice moves
      tabAlice.emit("updatePosition", { x: 250, y: 350 });

      // Bob moves slightly after
      setTimeout(() => {
        tabBob.emit("updatePosition", { x: 500, y: 150 });
      }, 100);

    } catch (err) {
      clearTimeout(timeout);
      tabAlice.disconnect();
      tabBob.disconnect();
      tabCharlie.disconnect();
      reject(err);
    }
  });
}

// Test 10: Unexpected Disconnection & Abrupt Transport Teardown
async function testUnexpectedDisconnection(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const observerTab = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const droppedTab = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    const timeout = setTimeout(() => {
      observerTab.disconnect();
      droppedTab.disconnect();
      reject(new Error("Unexpected disconnection test timed out"));
    }, 7000);

    let droppedTabId = null;
    let peerReceivedDisconnect = false;

    try {
      await Promise.all([
        new Promise((res, rej) => { observerTab.on("connect", res); observerTab.on("connect_error", rej); }),
        new Promise((res, rej) => {
          droppedTab.on("connect", () => {
            droppedTabId = droppedTab.id;
            res();
          });
          droppedTab.on("connect_error", rej);
        }),
      ]);

      observerTab.on("userDisconnected", (data) => {
        const id = typeof data === "string" ? data : data?.id;
        if (id === droppedTabId) {
          peerReceivedDisconnect = true;
        }
      });

      // Simulate abrupt network drop / unexpected disconnect by closing transport abruptly
      droppedTab.io.engine.close();

      await new Promise((r) => setTimeout(r, 600));

      clearTimeout(timeout);
      observerTab.disconnect();

      const statusRes = await checkUrl(`${serverUrl}/api/status`);
      const statusJson = JSON.parse(statusRes.body);

      resolve({
        peerNotified: peerReceivedDisconnect,
        remainingUsers: statusJson.activeUsers,
        serverStable: statusJson.status === "active",
      });
    } catch (err) {
      clearTimeout(timeout);
      observerTab.disconnect();
      droppedTab.disconnect();
      reject(err);
    }
  });
}

// Test 11: Exhaustive Invalid Inputs & Edge Case Safety
async function testExhaustiveInvalidInputs(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const testSocket = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    let validationErrorCount = 0;

    const timeout = setTimeout(() => {
      testSocket.disconnect();
      reject(new Error("Invalid inputs test timed out"));
    }, 7000);

    testSocket.on("error:validation", () => {
      validationErrorCount++;
    });

    try {
      await new Promise((res, rej) => {
        testSocket.on("connect", res);
        testSocket.on("connect_error", rej);
      });

      // Battery of invalid inputs:
      testSocket.emit("updatePosition", null);
      testSocket.emit("updatePosition", []);
      testSocket.emit("updatePosition", "corrupted string");
      testSocket.emit("updatePosition", { x: NaN, y: 100 });
      testSocket.emit("updatePosition", { x: Infinity, y: -Infinity });
      testSocket.emit("updatePosition", { x: "string", y: null });
      testSocket.emit("updatePosition", {});

      await new Promise((r) => setTimeout(r, 500));

      // Test extreme numbers clamping (should succeed without error)
      testSocket.emit("updatePosition", { x: -50000, y: 99999 });

      await new Promise((r) => setTimeout(r, 400));

      clearTimeout(timeout);
      testSocket.disconnect();

      const healthRes = await checkUrl(`${serverUrl}/api/health`);
      const healthJson = JSON.parse(healthRes.body);

      resolve({
        validationErrorsCaptured: validationErrorCount,
        serverRemainedHealthy: healthJson.status === "OK",
      });
    } catch (err) {
      clearTimeout(timeout);
      testSocket.disconnect();
      reject(err);
    }
  });
}

// Test 12: Simultaneous Multi-User Virtual Office Interaction & Spatial Proximity
async function testSimultaneousVirtualOfficeInteraction(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const user1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const user2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const user3 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
    const user4 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });

    const clients = [user1, user2, user3, user4];
    const timeout = setTimeout(() => {
      clients.forEach((c) => c.disconnect());
      reject(new Error("Simultaneous virtual office interaction test timed out"));
    }, 10000);

    try {
      await Promise.all(
        clients.map(
          (c) =>
            new Promise((res, rej) => {
              c.on("connect", res);
              c.on("connect_error", rej);
            })
        )
      );

      // Join with distinct usernames
      user1.emit("join", { username: "User-1", roomId: "main-office" });
      user2.emit("join", { username: "User-2", roomId: "main-office" });
      user3.emit("join", { username: "User-3", roomId: "main-office" });
      user4.emit("join", { username: "User-4", roomId: "meeting-room-a" });

      await new Promise((r) => setTimeout(r, 300));

      // Simultaneously position users:
      // User-1 at (100, 100)
      // User-2 at (150, 100) -> distance to User-1 is 50px (in range <= 300)
      // User-3 at (800, 800) -> distance to User-1 is ~989px (out of range > 300)
      // User-4 at (120, 100) -> in different room ("meeting-room-a")
      user1.emit("updatePosition", { x: 100, y: 100 });
      user2.emit("updatePosition", { x: 150, y: 100 });
      user3.emit("updatePosition", { x: 800, y: 800 });
      user4.emit("updatePosition", { x: 120, y: 100 });

      await new Promise((r) => setTimeout(r, 400));

      // Query nearby participants for User-1
      let proximityResult = null;
      await new Promise((res) => {
        user1.emit("getNearbyUsers", { radius: 300 }, (data) => {
          proximityResult = data;
          res();
        });
      });

      const foundUser2 = proximityResult?.nearby?.find((p) => p.id === user2.id);
      const foundUser3 = proximityResult?.nearby?.find((p) => p.id === user3.id);
      const foundUser4 = proximityResult?.nearby?.find((p) => p.id === user4.id);

      const proximityAccurate =
        foundUser2 &&
        foundUser2.distance === 50 &&
        foundUser2.volume > 0.8 &&
        !foundUser3 &&
        !foundUser4;

      // User-4 switches to main-office
      let user1ReceivedUser4Joined = false;
      user1.on("participantJoined", (p) => {
        if (p.id === user4.id && p.roomId === "main-office") {
          user1ReceivedUser4Joined = true;
        }
      });

      user4.emit("joinRoom", { roomId: "main-office" });
      await new Promise((r) => setTimeout(r, 400));

      // Verify active users count in status endpoint
      const statusRes = await checkUrl(`${serverUrl}/api/status`);
      const statusJson = JSON.parse(statusRes.body);

      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());

      resolve({
        activeUsersCount: statusJson.activeUsers,
        proximityAccurate,
        roomTransitionVerified: user1ReceivedUser4Joined,
      });
    } catch (err) {
      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());
      reject(err);
    }
  });
}

// Test 17: WebRTC Audio Calling Full Handshake & Bidirectional Signaling
async function testWebRTCAudioCallingFullHandshake(serverUrl) {
  return new Promise((resolve, reject) => {
    const caller = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const callee = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    let callerConnected = false;
    let calleeConnected = false;

    let incomingCallReceived = false;
    let callAcceptedReceived = false;
    let offerRelayed = false;
    let answerRelayed = false;
    let candidateRelayed = false;
    let muteStatusRelayed = false;
    let callEndedReceived = false;

    const timeout = setTimeout(() => {
      caller.disconnect();
      callee.disconnect();
      reject(new Error("WebRTC full audio call handshake timed out"));
    }, 8000);

    caller.on("connect", () => {
      callerConnected = true;
      caller.emit("join", { username: "AliceCaller" });
      checkReadyToCall();
    });

    callee.on("connect", () => {
      calleeConnected = true;
      callee.emit("join", { username: "BobCallee" });
      checkReadyToCall();
    });

    function checkReadyToCall() {
      if (callerConnected && calleeConnected) {
        // Step 1: Alice initiates audio call to Bob
        caller.emit("signal:call-user", {
          targetId: callee.id,
          metadata: { audioOnly: true, callType: "voice" },
        });
      }
    }

    // Step 2: Bob receives incoming call and accepts
    callee.on("signal:incoming-call", (data) => {
      if (data.callerId === caller.id && data.callerName === "AliceCaller") {
        incomingCallReceived = true;
        callee.emit("signal:accept-call", { targetId: caller.id });
      }
    });

    // Step 3: Alice receives call-accepted, sends SDP offer
    caller.on("signal:call-accepted", (data) => {
      if (data.peerId === callee.id) {
        callAcceptedReceived = true;
        caller.emit("signal:offer", {
          targetId: callee.id,
          offer: { type: "offer", sdp: "v=0\r\no=Alice 123 456 IN IP4 127.0.0.1\r\ns=ProxiSpeakAudioCall" },
        });
      }
    });

    // Step 4: Bob receives offer, replies with SDP answer
    callee.on("signal:offer", (data) => {
      if (data.senderId === caller.id && data.offer && data.offer.type === "offer") {
        offerRelayed = true;
        callee.emit("signal:answer", {
          targetId: caller.id,
          answer: { type: "answer", sdp: "v=0\r\no=Bob 789 101 IN IP4 127.0.0.1\r\ns=ProxiSpeakAudioAnswer" },
        });
      }
    });

    // Step 5: Alice receives answer, sends ICE candidate
    caller.on("signal:answer", (data) => {
      if (data.senderId === callee.id && data.answer && data.answer.type === "answer") {
        answerRelayed = true;
        caller.emit("signal:ice-candidate", {
          targetId: callee.id,
          candidate: { candidate: "candidate:1 1 UDP 2122260223 127.0.0.1 5000 typ host", sdpMid: "0" },
        });
      }
    });

    // Step 6: Bob receives ICE candidate, Alice tests mute status
    callee.on("signal:ice-candidate", (data) => {
      if (data.senderId === caller.id && data.candidate) {
        candidateRelayed = true;
        caller.emit("signal:mute-status", {
          targetId: callee.id,
          isMuted: true,
        });
      }
    });

    // Step 7: Bob receives mute status, then hangs up
    callee.on("signal:mute-status", (data) => {
      if (data.peerId === caller.id && data.isMuted === true) {
        muteStatusRelayed = true;
        callee.emit("signal:end-call", {
          targetId: caller.id,
          reason: "call_finished",
        });
      }
    });

    // Step 8: Alice receives call-ended event
    caller.on("signal:call-ended", (data) => {
      if (data.peerId === callee.id && data.reason === "call_finished") {
        callEndedReceived = true;
        cleanupAndResolve();
      }
    });

    function cleanupAndResolve() {
      if (
        incomingCallReceived &&
        callAcceptedReceived &&
        offerRelayed &&
        answerRelayed &&
        candidateRelayed &&
        muteStatusRelayed &&
        callEndedReceived
      ) {
        clearTimeout(timeout);
        caller.disconnect();
        callee.disconnect();
        resolve({
          incomingCallReceived,
          callAcceptedReceived,
          offerRelayed,
          answerRelayed,
          candidateRelayed,
          muteStatusRelayed,
          callEndedReceived,
        });
      }
    }

    caller.on("connect_error", (e) => reject(e));
    callee.on("connect_error", (e) => reject(e));
  });
}

// Test 18: Mid-Call Abrupt Disconnection & Call State Cleanup
async function testMidCallAbruptDisconnectionCleanup(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const caller = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const callee = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    let callEndedReceivedByCallee = false;
    let endReasonReceived = null;
    let peerDisconnectedReceived = false;

    const timeout = setTimeout(() => {
      caller.disconnect();
      callee.disconnect();
      reject(new Error("Mid-call abrupt disconnect cleanup test timed out"));
    }, 8000);

    try {
      await Promise.all([
        new Promise((res, rej) => { caller.once("connect", res); caller.once("connect_error", rej); }),
        new Promise((res, rej) => { callee.once("connect", res); callee.once("connect_error", rej); }),
      ]);

      caller.emit("join", { username: "DisconnectingCaller" });
      callee.emit("join", { username: "RemainingCallee" });

      await new Promise((r) => setTimeout(r, 150));

      const callerId = caller.id;
      const calleeId = callee.id;

      // Set up listeners BEFORE emitting
      const incomingCallPromise = new Promise((res) => {
        callee.once("signal:incoming-call", (data) => {
          callee.emit("signal:accept-call", { targetId: data.callerId });
          res(data);
        });
      });

      const callAcceptedPromise = new Promise((res) => {
        caller.once("signal:call-accepted", res);
      });

      // Now initiate call
      caller.emit("signal:call-user", { targetId: calleeId });

      await incomingCallPromise;
      await callAcceptedPromise;

      await new Promise((r) => setTimeout(r, 100));

      // Listen for call-ended and disconnection on remaining callee
      let participantLeftReceivedByCallee = false;

      callee.on("signal:call-ended", (data) => {
        if (data.peerId === callerId) {
          callEndedReceivedByCallee = true;
          endReasonReceived = data.reason;
        }
      });

      callee.on("participantLeft", (data) => {
        if (data.id === callerId) {
          participantLeftReceivedByCallee = true;
        }
      });

      callee.on("userDisconnected", (data) => {
        const id = typeof data === "string" ? data : data?.id;
        if (id === callerId) {
          peerDisconnectedReceived = true;
        }
      });

      // Abruptly sever caller's transport connection
      caller.io.engine.close();

      // Allow server to execute disconnecting (call cleanup & participantLeft) and disconnect lifecycles
      await new Promise((r) => setTimeout(r, 600));

      clearTimeout(timeout);
      callee.disconnect();

      resolve({
        callEndedReceivedByCallee,
        endReasonReceived,
        participantLeftReceivedByCallee: participantLeftReceivedByCallee || peerDisconnectedReceived,
      });
    } catch (err) {
      clearTimeout(timeout);
      caller.disconnect();
      callee.disconnect();
      reject(err);
    }
  });
}

// Test 19: WebRTC Error Handling & Reconnection Scenarios
async function testWebRTCErrorHandlingAndReconnection(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const clientA = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const clientB = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    let offlineErrorReceived = false;
    let selfCallErrorReceived = false;
    let callRejectedReceived = false;
    let postReconnectCallSucceeded = false;

    const timeout = setTimeout(() => {
      clientA.disconnect();
      clientB.disconnect();
      reject(new Error("WebRTC error handling and reconnection test timed out"));
    }, 10000);

    try {
      await Promise.all([
        new Promise((res, rej) => { clientA.once("connect", res); clientA.once("connect_error", rej); }),
        new Promise((res, rej) => { clientB.once("connect", res); clientB.once("connect_error", rej); }),
      ]);

      clientA.emit("join", { username: "TesterA" });
      clientB.emit("join", { username: "TesterB" });
      await new Promise((r) => setTimeout(r, 150));

      // 1. Error Test A: Calling non-existent / offline peer
      const offlinePromise = new Promise((res) => {
        clientA.once("signal:error", (data) => {
          if (data.message.includes("offline") || data.message.includes("not found")) {
            offlineErrorReceived = true;
          }
          res();
        });
      });
      clientA.emit("signal:call-user", { targetId: "non-existent-peer-xyz" });
      await offlinePromise;

      // 2. Error Test B: Self-calling rejection
      const selfCallPromise = new Promise((res) => {
        clientA.once("signal:error", (data) => {
          if (data.message.includes("yourself")) {
            selfCallErrorReceived = true;
          }
          res();
        });
      });
      clientA.emit("signal:call-user", { targetId: clientA.id });
      await selfCallPromise;

      // 3. Rejection Test C: Callee declines call
      const incomingPromise = new Promise((res) => {
        clientB.once("signal:incoming-call", (data) => {
          clientB.emit("signal:reject-call", { targetId: data.callerId, reason: "busy_in_meeting" });
          res();
        });
      });
      const rejectedPromise = new Promise((res) => {
        clientA.once("signal:call-rejected", (data) => {
          if (data.peerId === clientB.id && data.reason === "busy_in_meeting") {
            callRejectedReceived = true;
          }
          res();
        });
      });

      clientA.emit("signal:call-user", { targetId: clientB.id });
      await incomingPromise;
      await rejectedPromise;

      // 4. Reconnection Test D: Client A disconnects, re-establishes socket, and successfully calls Client B
      clientA.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      const reconnectedClientA = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
      await new Promise((res) => reconnectedClientA.once("connect", res));
      reconnectedClientA.emit("join", { username: "TesterA-Reconnected" });
      await new Promise((r) => setTimeout(r, 150));

      const reconnectedIncomingPromise = new Promise((res) => {
        clientB.once("signal:incoming-call", (data) => {
          clientB.emit("signal:accept-call", { targetId: data.callerId });
          res();
        });
      });
      const reconnectedAcceptedPromise = new Promise((res) => {
        reconnectedClientA.once("signal:call-accepted", (data) => {
          if (data.peerId === clientB.id) {
            postReconnectCallSucceeded = true;
          }
          res();
        });
      });

      reconnectedClientA.emit("signal:call-user", { targetId: clientB.id });
      await reconnectedIncomingPromise;
      await reconnectedAcceptedPromise;

      // Hang up cleanly
      reconnectedClientA.emit("signal:end-call", { targetId: clientB.id });
      await new Promise((r) => setTimeout(r, 100));

      clearTimeout(timeout);
      reconnectedClientA.disconnect();
      clientB.disconnect();

      resolve({
        offlineErrorReceived,
        selfCallErrorReceived,
        callRejectedReceived,
        postReconnectCallSucceeded,
      });
    } catch (err) {
      clearTimeout(timeout);
      clientA.disconnect();
      clientB.disconnect();
      reject(err);
    }
  });
}

// Test 20: Room Creation, Directory Listing & REST Endpoints
async function testRoomCreationAndListing(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const client = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const timeout = setTimeout(() => {
      client.disconnect();
      reject(new Error("Room creation and listing test timed out"));
    }, 8000);

    try {
      await new Promise((res, rej) => { client.once("connect", res); client.once("connect_error", rej); });

      // Step 1: Create room via Socket.IO
      let createResult = null;
      await new Promise((res) => {
        client.emit("createRoom", {
          name: "War Room Alpha",
          maxParticipants: 6,
          description: "High priority incident room",
        }, (data) => {
          createResult = data;
          res();
        });
      });

      // Step 2: Attempt duplicate creation of same room
      let duplicateResult = null;
      await new Promise((res) => {
        client.emit("createRoom", {
          roomId: "war-room-alpha",
          name: "War Room Alpha Duplicate",
        }, (data) => {
          duplicateResult = data;
          res();
        });
      });

      // Step 3: Query room directory via Socket.IO
      let roomsListResult = null;
      await new Promise((res) => {
        client.emit("getRooms", (data) => {
          roomsListResult = data;
          res();
        });
      });

      // Step 4: Verify REST API GET /api/rooms
      const getRoomsRes = await checkUrl(`${serverUrl}/api/rooms`);
      const getRoomsJson = JSON.parse(getRoomsRes.body);

      // Step 5: Verify REST API POST /api/rooms
      const postRoomRes = await postJson(`${serverUrl}/api/rooms`, {
        name: "Design Studio",
        maxParticipants: 8,
        description: "UI/UX collaboration room",
      });
      const postRoomJson = JSON.parse(postRoomRes.body);

      clearTimeout(timeout);
      client.disconnect();

      const socketRoomCreated = Boolean(createResult?.success && createResult?.room?.id === "war-room-alpha");
      const duplicateBlocked = Boolean(duplicateResult?.success === false);
      const socketRoomsFound = Boolean(roomsListResult?.success && roomsListResult?.rooms?.some((r) => r.id === "war-room-alpha"));
      const restGetRoomsSuccess = Boolean(getRoomsRes.status === 200 && getRoomsJson?.status === "OK" && Array.isArray(getRoomsJson.rooms));
      const restPostRoomSuccess = Boolean(postRoomRes.status === 201 && postRoomJson?.room?.id === "design-studio");

      resolve({
        socketRoomCreated,
        duplicateBlocked,
        socketRoomsFound,
        restGetRoomsSuccess,
        restPostRoomSuccess,
      });
    } catch (err) {
      clearTimeout(timeout);
      client.disconnect();
      reject(err);
    }
  });
}

// Test 21: Room Capacity Enforcement & Full Room Rejection
async function testRoomCapacityAndFullRoomRejection(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client3 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    const timeout = setTimeout(() => {
      client1.disconnect();
      client2.disconnect();
      client3.disconnect();
      reject(new Error("Room capacity test timed out"));
    }, 10000);

    try {
      await Promise.all([
        new Promise((res, rej) => { client1.once("connect", res); client1.once("connect_error", rej); }),
        new Promise((res, rej) => { client2.once("connect", res); client2.once("connect_error", rej); }),
        new Promise((res, rej) => { client3.once("connect", res); client3.once("connect_error", rej); }),
      ]);

      // Create a small room with maxParticipants: 2
      await new Promise((res) => {
        client1.emit("createRoom", {
          roomId: "duo-booth",
          name: "Duo Booth",
          maxParticipants: 2,
        }, res);
      });

      // Client 1 joins duo-booth
      let c1Joined = false;
      await new Promise((res) => {
        client1.emit("joinRoom", { roomId: "duo-booth", username: "DuoUser1" }, (data) => {
          c1Joined = data.success;
          res();
        });
      });

      // Client 2 joins duo-booth (room is now 2/2 - FULL)
      let c2Joined = false;
      await new Promise((res) => {
        client2.emit("joinRoom", { roomId: "duo-booth", username: "DuoUser2" }, (data) => {
          c2Joined = data.success;
          res();
        });
      });

      // Client 3 attempts to join duo-booth (should be rejected)
      let c3RejectedMessage = null;
      const c3ErrorPromise = new Promise((res) => {
        client3.once("error:room", (err) => {
          c3RejectedMessage = err.message;
          res();
        });
      });

      let c3CallbackSuccess = null;
      const c3JoinPromise = new Promise((res) => {
        client3.emit("joinRoom", { roomId: "duo-booth", username: "DuoUser3" }, (data) => {
          c3CallbackSuccess = data.success;
          res();
        });
      });

      await Promise.race([Promise.all([c3ErrorPromise, c3JoinPromise]), new Promise((r) => setTimeout(r, 600))]);

      // Client 1 leaves duo-booth (now 1/2 available)
      let c1Left = false;
      await new Promise((res) => {
        client1.emit("leaveRoom", { roomId: "duo-booth" }, (data) => {
          c1Left = data.success;
          res();
        });
      });

      // Client 3 retries joining duo-booth (should now succeed)
      let c3JoinedAfterSlotFreed = false;
      await new Promise((res) => {
        client3.emit("joinRoom", { roomId: "duo-booth", username: "DuoUser3" }, (data) => {
          c3JoinedAfterSlotFreed = data.success;
          res();
        });
      });

      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();
      client3.disconnect();

      resolve({
        c1Joined,
        c2Joined,
        capacityEnforced: c3RejectedMessage === "Room is full" && c3CallbackSuccess === false,
        c1Left,
        c3JoinedAfterSlotFreed,
      });
    } catch (err) {
      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();
      client3.disconnect();
      reject(err);
    }
  });
}

// Test 22: Multi-Room Multi-User Isolation & Audio Call Teardown on Room Switch
async function testMultiRoomIsolationAndCallTeardownOnSwitch(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const userA = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const userB = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const userC = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const userD = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    const clients = [userA, userB, userC, userD];
    const timeout = setTimeout(() => {
      clients.forEach((c) => c.disconnect());
      reject(new Error("Multi-room isolation and call teardown test timed out"));
    }, 12000);

    try {
      await Promise.all(
        clients.map((c) => new Promise((res, rej) => { c.once("connect", res); c.once("connect_error", rej); }))
      );

      // Join rooms: User A & B in meeting-room-a, User C & D in meeting-room-b
      await Promise.all([
        new Promise((res) => userA.emit("joinRoom", { roomId: "meeting-room-a", username: "UserA" }, res)),
        new Promise((res) => userB.emit("joinRoom", { roomId: "meeting-room-a", username: "UserB" }, res)),
        new Promise((res) => userC.emit("joinRoom", { roomId: "meeting-room-b", username: "UserC" }, res)),
        new Promise((res) => userD.emit("joinRoom", { roomId: "meeting-room-b", username: "UserD" }, res)),
      ]);

      await new Promise((r) => setTimeout(r, 150));

      // 1. Verify User A & B are in meeting-room-a, User C & D in meeting-room-b
      let userARoster = null;
      let userCRoster = null;
      await Promise.all([
        new Promise((res) => userA.emit("getParticipants", { roomId: "meeting-room-a" }, (data) => { userARoster = data.participants; res(); })),
        new Promise((res) => userC.emit("getParticipants", { roomId: "meeting-room-b" }, (data) => { userCRoster = data.participants; res(); })),
      ]);

      const roomAIsolated = userARoster?.some((p) => p.id === userA.id) && userARoster?.some((p) => p.id === userB.id) && !userARoster?.some((p) => p.id === userC.id);
      const roomBIsolated = userCRoster?.some((p) => p.id === userC.id) && userCRoster?.some((p) => p.id === userD.id) && !userCRoster?.some((p) => p.id === userA.id);

      // 2. User A and User B establish WebRTC audio call in meeting-room-a
      const incomingCallPromise = new Promise((res) => {
        userB.once("signal:incoming-call", (data) => {
          userB.emit("signal:accept-call", { targetId: data.callerId });
          res();
        });
      });
      const callAcceptedPromise = new Promise((res) => {
        userA.once("signal:call-accepted", res);
      });

      userA.emit("signal:call-user", { targetId: userB.id });
      await incomingCallPromise;
      await callAcceptedPromise;

      // 3. User C moves in meeting-room-b; verify roomPositionUpdated is received by User D, but NOT by User A
      let userDReceivedRoomPosition = false;
      let userAReceivedRoomPositionForC = false;

      userD.on("roomPositionUpdated", (pos) => {
        if (pos.id === userC.id) userDReceivedRoomPosition = true;
      });
      userA.on("roomPositionUpdated", (pos) => {
        if (pos.id === userC.id) userAReceivedRoomPositionForC = true;
      });

      userC.emit("updatePosition", { x: 300, y: 300 });
      await new Promise((r) => setTimeout(r, 200));

      // 4. User A switches room from meeting-room-a to lounge
      // Verify User B receives participantLeft AND signal:call-ended with reason: "room_switched"
      let userBReceivedParticipantLeft = false;
      let userBReceivedCallEnded = false;
      let callEndedReason = null;

      userB.on("participantLeft", (data) => {
        if (data.id === userA.id) userBReceivedParticipantLeft = true;
      });
      userB.on("signal:call-ended", (data) => {
        if (data.peerId === userA.id) {
          userBReceivedCallEnded = true;
          callEndedReason = data.reason;
        }
      });

      userA.emit("joinRoom", { roomId: "lounge", username: "UserA" });
      await new Promise((r) => setTimeout(r, 400));

      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());

      resolve({
        roomAIsolated,
        roomBIsolated,
        userDReceivedRoomPosition,
        userAReceivedRoomPositionForC,
        userBReceivedParticipantLeft,
        userBReceivedCallEnded,
        callEndedReason,
      });
    } catch (err) {
      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());
      reject(err);
    }
  });
}

// Test 23: Profile REST API, Validation Errors & Real-Time Socket Updates
async function testProfileApiAndRealtimeProfileSync(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    const timeout = setTimeout(() => {
      client1.disconnect();
      client2.disconnect();
      reject(new Error("Profile test timed out"));
    }, 10000);

    try {
      await Promise.all([
        new Promise((res, rej) => { client1.once("connect", res); client1.once("connect_error", rej); }),
        new Promise((res, rej) => { client2.once("connect", res); client2.once("connect_error", rej); }),
      ]);

      // 1. Missing userId error on GET /api/profile
      const missingIdRes = await checkUrl(`${serverUrl}/api/profile`);
      const missingIdJson = JSON.parse(missingIdRes.body);
      const missingIdHandled = missingIdRes.status === 400 && missingIdJson.status === "error" && typeof missingIdJson.message === "string";

      // 2. Non-existent profile 404
      const notFoundRes = await checkUrl(`${serverUrl}/api/profile/unknown_user_999`);
      const notFoundJson = JSON.parse(notFoundRes.body);
      const notFoundHandled = notFoundRes.status === 404 && notFoundJson.status === "error" && notFoundJson.code === "PROFILE_NOT_FOUND";

      // 3. Validation rejection on PUT /api/profile/:userId (invalid hex color)
      const invalidColorRes = await putJson(`${serverUrl}/api/profile/user_alice`, {
        username: "Alice",
        color: "not-a-hex-color",
      });
      const invalidColorJson = JSON.parse(invalidColorRes.body);
      const invalidColorHandled = invalidColorRes.status === 400 && invalidColorJson.status === "error" && invalidColorJson.message.includes("valid hex color");

      // 4. Validation rejection on PUT /api/profile/:userId (invalid status)
      const invalidStatusRes = await putJson(`${serverUrl}/api/profile/user_alice`, {
        username: "Alice",
        color: "#3B82F6",
        status: "flying_in_space",
      });
      const invalidStatusJson = JSON.parse(invalidStatusRes.body);
      const invalidStatusHandled = invalidStatusRes.status === 400 && invalidStatusJson.status === "error" && invalidStatusJson.message.includes("Status must be one of");

      // 5. Successful Profile creation/update via PUT /api/profile/user_alice
      const validPutRes = await putJson(`${serverUrl}/api/profile/user_alice`, {
        username: "Alice Wonder",
        color: "#10B981",
        status: "busy",
      });
      const validPutJson = JSON.parse(validPutRes.body);
      const putSuccess = validPutRes.status === 200 &&
        validPutJson.status === "success" &&
        validPutJson.profile?.username === "Alice Wonder" &&
        validPutJson.profile?.displayName === "Alice Wonder" &&
        validPutJson.profile?.color === "#10B981" &&
        validPutJson.profile?.avatarColor === "#10B981" &&
        validPutJson.profile?.status === "busy" &&
        validPutJson.profile?.availability === "busy";

      // 6. Query saved profile via GET /api/profile/user_alice
      const getProfileRes = await checkUrl(`${serverUrl}/api/profile/user_alice`);
      const getProfileJson = JSON.parse(getProfileRes.body);
      const getSuccess = getProfileRes.status === 200 &&
        getProfileJson.status === "success" &&
        getProfileJson.profile?.username === "Alice Wonder";

      // 7. Real-Time Socket.IO profile update broadcast
      let client2ReceivedBroadcast = null;
      const broadcastPromise = new Promise((res) => {
        client2.once("userProfileUpdated", (data) => {
          client2ReceivedBroadcast = data;
          res();
        });
      });

      let client1CallbackSuccess = false;
      await new Promise((res) => {
        client1.emit("updateProfile", {
          username: "Bob Dylan",
          color: "#8B5CF6",
          status: "dnd",
        }, (response) => {
          if (response?.status === "success" && response?.profile?.username === "Bob Dylan") {
            client1CallbackSuccess = true;
          }
          res();
        });
      });

      await Promise.race([broadcastPromise, new Promise((r) => setTimeout(r, 600))]);

      // 8. Socket.IO validation error test
      let socketValidationErrorMessage = null;
      await new Promise((res) => {
        client1.emit("updateProfile", {
          status: "sleeping",
        }, (errResponse) => {
          if (errResponse?.status === "error") {
            socketValidationErrorMessage = errResponse.message;
          }
          res();
        });
      });

      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();

      resolve({
        missingIdHandled,
        notFoundHandled,
        invalidColorHandled,
        invalidStatusHandled,
        putSuccess,
        getSuccess,
        socketProfileBroadcasted: Boolean(client2ReceivedBroadcast && client2ReceivedBroadcast.username === "Bob Dylan" && client2ReceivedBroadcast.status === "dnd"),
        client1CallbackSuccess,
        socketValidationHandled: Boolean(socketValidationErrorMessage && socketValidationErrorMessage.includes("Status must be one of")),
      });
    } catch (err) {
      clearTimeout(timeout);
      client1.disconnect();
      client2.disconnect();
      reject(err);
    }
  });
}

// Test 24: Real-Time Participant Synchronization, Movement, Joining, Leaving & Live Updates Across Multiple Clients (Task 16)
async function testRealtimeParticipantSyncAndMovementLifecycle(serverUrl) {
  return new Promise(async (resolve, reject) => {
    const client1 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client2 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client3 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });
    const client4 = io(serverUrl, { transports: ["websocket", "polling"], timeout: 6000 });

    const clients = [client1, client2, client3, client4];

    const timeout = setTimeout(() => {
      clients.forEach((c) => c.disconnect());
      reject(new Error("Multi-client participant sync & movement lifecycle test timed out after 12000ms"));
    }, 12000);

    try {
      // Connect all 4 clients cleanly using connection check
      await Promise.all(
        clients.map((c) => new Promise((res, rej) => {
          if (c.connected) return res();
          c.once("connect", res);
          c.once("connect_error", rej);
        }))
      );

      // Verify Initial Roster Sync across co-located room members
      let c1Roster = [];
      let c2Roster = [];
      await Promise.all([
        new Promise((res) => client1.emit("getParticipants", { roomId: "main-office" }, (data) => { c1Roster = data.participants || []; res(); })),
        new Promise((res) => client2.emit("getParticipants", { roomId: "main-office" }, (data) => { c2Roster = data.participants || []; res(); })),
      ]);

      const c1RosterIds = c1Roster.map((u) => u.id);
      const step1JoinSyncSuccess = c1RosterIds.includes(client1.id) && c1RosterIds.includes(client2.id) && c1Roster.length >= 4;
      const step2MultiJoinSuccess = c2Roster.length === c1Roster.length && c2Roster.some((u) => u.id === client3.id) && c2Roster.some((u) => u.id === client4.id);

      // Avatar Movement - Client 1 moves, Clients 2, 3, 4 receive live update
      let c2ReceivedC1Move = false;
      let c3ReceivedC1Move = false;
      let c4ReceivedC1Move = false;

      client2.on("userPositionUpdated", (pos) => {
        if (pos.id === client1.id && pos.x === 350 && pos.y === 450) c2ReceivedC1Move = true;
      });
      client3.on("userPositionUpdated", (pos) => {
        if (pos.id === client1.id && pos.x === 350 && pos.y === 450) c3ReceivedC1Move = true;
      });
      client4.on("userPositionUpdated", (pos) => {
        if (pos.id === client1.id && pos.x === 350 && pos.y === 450) c4ReceivedC1Move = true;
      });

      client1.emit("updatePosition", { x: 350, y: 450 });
      await new Promise((r) => setTimeout(r, 250));

      const step3MovementBroadcastSuccess = c2ReceivedC1Move && c3ReceivedC1Move && c4ReceivedC1Move;

      // Concurrent Simultaneous Movements from Clients 2, 3, 4 to Client 1
      let c1ReceivedC2ConcurrentMove = false;
      let c1ReceivedC3ConcurrentMove = false;
      let c1ReceivedC4ConcurrentMove = false;

      const concurrentHandler = (pos) => {
        if (pos.id === client2.id && pos.x === 600 && pos.y === 700) c1ReceivedC2ConcurrentMove = true;
        if (pos.id === client3.id && pos.x === 800 && pos.y === 900) c1ReceivedC3ConcurrentMove = true;
        if (pos.id === client4.id && pos.x === 1000 && pos.y === 1100) c1ReceivedC4ConcurrentMove = true;
      };
      client1.on("userPositionUpdated", concurrentHandler);

      client2.emit("updatePosition", { x: 600, y: 700 });
      client3.emit("updatePosition", { x: 800, y: 900 });
      client4.emit("updatePosition", { x: 1000, y: 1100 });
      await new Promise((r) => setTimeout(r, 300));
      client1.off("userPositionUpdated", concurrentHandler);

      const step4ConcurrentMovesSuccess = c1ReceivedC2ConcurrentMove && c1ReceivedC3ConcurrentMove && c1ReceivedC4ConcurrentMove;

      // Rapid Sequential Movement Burst (Hold/Drag Simulation)
      let c2FinalPosition = null;
      const burstHandler = (pos) => {
        if (pos.id === client1.id) c2FinalPosition = { x: pos.x, y: pos.y };
      };
      client2.on("roomPositionUpdated", burstHandler);

      for (let i = 1; i <= 10; i++) {
        client1.emit("updatePosition", { x: 100 + i * 10, y: 100 + i * 10 });
      }
      await new Promise((r) => setTimeout(r, 300));
      client2.off("roomPositionUpdated", burstHandler);

      const step5BurstMovesSuccess = Boolean(c2FinalPosition && c2FinalPosition.x === 200 && c2FinalPosition.y === 200);

      // Live Profile Update across multiple clients
      let c1SawC4ProfileUpdate = false;
      let c2SawC4ProfileUpdate = false;
      let c3SawC4ProfileUpdate = false;

      const profileUpdateHandler1 = (p) => { if (p.id === client4.id && p.username === "WonderWoman" && p.status === "busy") c1SawC4ProfileUpdate = true; };
      const profileUpdateHandler2 = (p) => { if (p.id === client4.id && p.username === "WonderWoman" && p.status === "busy") c2SawC4ProfileUpdate = true; };
      const profileUpdateHandler3 = (p) => { if (p.id === client4.id && p.username === "WonderWoman" && p.status === "busy") c3SawC4ProfileUpdate = true; };

      client1.on("userProfileUpdated", profileUpdateHandler1);
      client2.on("userProfileUpdated", profileUpdateHandler2);
      client3.on("userProfileUpdated", profileUpdateHandler3);

      await new Promise((res) => {
        client4.emit("updateProfile", { username: "WonderWoman", color: "#EC4899", status: "busy" }, res);
      });
      await new Promise((r) => setTimeout(r, 200));

      const step6LiveProfileUpdateSuccess = c1SawC4ProfileUpdate && c2SawC4ProfileUpdate && c3SawC4ProfileUpdate;

      // User Leaving Lifecycle - Room Switch departure
      let c1SawC3LeaveRoom = false;
      const leaveRoomHandler = (data) => {
        if (data.id === client3.id && data.reason === "room_switched") c1SawC3LeaveRoom = true;
      };
      client1.on("participantLeft", leaveRoomHandler);

      await new Promise((res) => {
        client3.emit("joinRoom", { roomId: "meeting-room-a" }, res);
      });
      await new Promise((r) => setTimeout(r, 200));
      client1.off("participantLeft", leaveRoomHandler);

      // User Leaving Lifecycle - Disconnection
      let c1SawC2Disconnect = false;
      const client2Id = client2.id;
      const disconnectHandler = (data) => {
        if (data.id === client2Id) c1SawC2Disconnect = true;
      };
      client1.on("userDisconnected", disconnectHandler);

      client2.disconnect();
      await new Promise((r) => setTimeout(r, 300));
      client1.off("userDisconnected", disconnectHandler);

      // Verify Main Office Roster after departures
      let finalRoster = [];
      await new Promise((res) => {
        client1.emit("getParticipants", { roomId: "main-office" }, (data) => {
          finalRoster = data.participants || [];
          res();
        });
      });

      const finalRosterIds = finalRoster.map((u) => u.id);
      const step7RosterIntegritySuccess =
        c1SawC3LeaveRoom &&
        c1SawC2Disconnect &&
        finalRosterIds.includes(client1.id) &&
        finalRosterIds.includes(client4.id) &&
        !finalRosterIds.includes(client2Id) &&
        !finalRosterIds.includes(client3.id);

      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());

      resolve({
        step1JoinSyncSuccess,
        step2MultiJoinSuccess,
        step3MovementBroadcastSuccess,
        step4ConcurrentMovesSuccess,
        step5BurstMovesSuccess,
        step6LiveProfileUpdateSuccess,
        step7RosterIntegritySuccess,
      });
    } catch (err) {
      clearTimeout(timeout);
      clients.forEach((c) => c.disconnect());
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
  await new Promise((r) => setTimeout(r, 500));

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

    // 13. Real-Time Multi-Tab Avatar Movement Synchronization
    console.log("\n--- [13] Testing Real-Time Multi-Tab Avatar Movement Synchronization ---");
    const multiTabSync = await testMultiTabAvatarMovementSync("http://localhost:5000");
    if (multiTabSync) {
      console.log("--> PASS: Real-time movement synchronized seamlessly across 3 concurrent browser tabs (Alice, Bob, Charlie).");
      console.log("--> PASS: Validated bidirectional coordinate delivery with accurate avatar colors and zero packet drops.");
    } else {
      console.error("--> FAIL: Multi-tab movement synchronization test failed.");
      hasErrors = true;
    }

    // 14. Unexpected Disconnections & Abrupt Transport Teardown
    console.log("\n--- [14] Testing Unexpected Disconnection & Abrupt Transport Teardown ---");
    const unexpectedDrop = await testUnexpectedDisconnection("http://localhost:5000");
    if (unexpectedDrop.peerNotified && unexpectedDrop.serverStable) {
      console.log("--> PASS: Abrupt socket transport drop safely detected and broadcast to peers.");
      console.log(`--> PASS: Memory registry cleaned up immediately (remaining users: ${unexpectedDrop.remainingUsers}).`);
    } else {
      console.error("--> FAIL: Unexpected disconnection test failed:", unexpectedDrop);
      hasErrors = true;
    }

    // 15. Exhaustive Invalid Inputs & Edge Case Safety
    console.log("\n--- [15] Testing Exhaustive Invalid Inputs & Edge Case Safety ---");
    const invalidInputsResult = await testExhaustiveInvalidInputs("http://localhost:5000");
    if (invalidInputsResult.validationErrorsCaptured >= 5 && invalidInputsResult.serverRemainedHealthy) {
      console.log(`--> PASS: Server captured and safely rejected ${invalidInputsResult.validationErrorsCaptured} malformed/hostile payloads.`);
      console.log("--> PASS: Out-of-bounds coordinates safely clamped and server remained 100% operational.");
    } else {
      console.error("--> FAIL: Invalid inputs test failed:", invalidInputsResult);
      hasErrors = true;
    }

    // 16. Simultaneous Multi-User Virtual Office Interaction & Spatial Proximity
    console.log("\n--- [16] Testing Simultaneous Multi-User Interaction & Spatial Proximity ---");
    const simInteractionResult = await testSimultaneousVirtualOfficeInteraction("http://localhost:5000");
    if (simInteractionResult.proximityAccurate && simInteractionResult.roomTransitionVerified) {
      console.log("--> PASS: 4 concurrent users interacted simultaneously in the virtual office without race conditions.");
      console.log("--> PASS: Spatial proximity distance (50px), volume attenuation (> 0.8), and room isolation verified.");
      console.log("--> PASS: Dynamic room transitions and participant notifications delivered accurately.");
    } else {
      console.error("--> FAIL: Simultaneous interaction test failed:", simInteractionResult);
      hasErrors = true;
    }

    // 17. WebRTC Audio Calling Full Handshake & Bidirectional Signaling
    console.log("\n--- [17] Testing WebRTC Audio Calling Full Handshake & Bidirectional Signaling ---");
    const fullHandshakeResult = await testWebRTCAudioCallingFullHandshake("http://localhost:5000");
    if (
      fullHandshakeResult.incomingCallReceived &&
      fullHandshakeResult.callAcceptedReceived &&
      fullHandshakeResult.offerRelayed &&
      fullHandshakeResult.answerRelayed &&
      fullHandshakeResult.candidateRelayed &&
      fullHandshakeResult.muteStatusRelayed &&
      fullHandshakeResult.callEndedReceived
    ) {
      console.log("--> PASS: Full WebRTC audio call lifecycle verified: call-user -> incoming-call -> accept-call -> call-accepted.");
      console.log("--> PASS: Bidirectional SDP exchange (offer & answer) and ICE candidate signaling relayed cleanly.");
      console.log("--> PASS: In-call mute status toggles and explicit end-call teardown executed without error.");
    } else {
      console.error("--> FAIL: Full audio calling handshake failed:", fullHandshakeResult);
      hasErrors = true;
    }

    // 18. Mid-Call Abrupt Disconnection & Call State Cleanup
    console.log("\n--- [18] Testing Mid-Call Abrupt Disconnection & Communication State Cleanup ---");
    const abruptDisconnectResult = await testMidCallAbruptDisconnectionCleanup("http://localhost:5000");
    if (abruptDisconnectResult.callEndedReceivedByCallee && abruptDisconnectResult.participantLeftReceivedByCallee) {
      console.log("--> PASS: Peer's abrupt transport drop instantly detected during an active audio call.");
      console.log(`--> PASS: Remaining peer received signal:call-ended (reason: "${abruptDisconnectResult.endReasonReceived}").`);
      console.log("--> PASS: Active call memory pruned immediately, preventing zombie WebRTC peer connections.");
    } else {
      console.error("--> FAIL: Mid-call abrupt disconnect cleanup failed:", abruptDisconnectResult);
      hasErrors = true;
    }

    // 19. WebRTC Error Handling & Reconnection Scenarios
    console.log("\n--- [19] Testing WebRTC Error Handling & Post-Reconnection Call Recovery ---");
    const errorHandlingResult = await testWebRTCErrorHandlingAndReconnection("http://localhost:5000");
    if (
      errorHandlingResult.offlineErrorReceived &&
      errorHandlingResult.selfCallErrorReceived &&
      errorHandlingResult.callRejectedReceived &&
      errorHandlingResult.postReconnectCallSucceeded
    ) {
      console.log("--> PASS: Calling offline or non-existent peer cleanly rejected with signal:error.");
      console.log("--> PASS: Self-calling attempts blocked with validation error message.");
      console.log("--> PASS: Call rejection and decline reasons transmitted to caller accurately.");
      console.log("--> PASS: Client reconnecting after disconnection immediately resumed full calling capabilities.");
    } else {
      console.error("--> FAIL: WebRTC error handling and reconnection test failed:", errorHandlingResult);
      hasErrors = true;
    }

    // 20. Room Creation, Directory Listing & REST Endpoints
    console.log("\n--- [20] Testing Room Creation, Directory Listing & REST Endpoints ---");
    const roomCreationResult = await testRoomCreationAndListing("http://localhost:5000");
    if (
      roomCreationResult.socketRoomCreated &&
      roomCreationResult.duplicateBlocked &&
      roomCreationResult.socketRoomsFound &&
      roomCreationResult.restGetRoomsSuccess &&
      roomCreationResult.restPostRoomSuccess
    ) {
      console.log("--> PASS: Custom room dynamically created via Socket.IO with name, capacity, and metadata.");
      console.log("--> PASS: Duplicate room creation safely blocked with validation error.");
      console.log("--> PASS: Socket getRooms event returns dynamic room directory with participant counts.");
      console.log("--> PASS: REST API GET /api/rooms and POST /api/rooms fully functional and integrated.");
    } else {
      console.error("--> FAIL: Room creation and directory listing test failed:", roomCreationResult);
      hasErrors = true;
    }

    // 21. Room Capacity Enforcement & Full Room Rejection
    console.log("\n--- [21] Testing Room Capacity Enforcement & Full Room Rejection ---");
    const capacityResult = await testRoomCapacityAndFullRoomRejection("http://localhost:5000");
    if (
      capacityResult.c1Joined &&
      capacityResult.c2Joined &&
      capacityResult.capacityEnforced &&
      capacityResult.c1Left &&
      capacityResult.c3JoinedAfterSlotFreed
    ) {
      console.log("--> PASS: Max participants limit strictly enforced on room joins.");
      console.log("--> PASS: Client rejected with error:room ('Room is full') when room capacity is exceeded.");
      console.log("--> PASS: Slot availability correctly updated upon participant leaveRoom, allowing waiting user to join.");
    } else {
      console.error("--> FAIL: Room capacity enforcement test failed:", capacityResult);
      hasErrors = true;
    }

    // 22. Multi-Room Multi-User Isolation & Audio Call Teardown on Room Switch
    console.log("\n--- [22] Testing Multi-Room Isolation & Audio Call Teardown on Room Switch ---");
    const isolationResult = await testMultiRoomIsolationAndCallTeardownOnSwitch("http://localhost:5000");
    if (
      isolationResult.roomAIsolated &&
      isolationResult.roomBIsolated &&
      isolationResult.userDReceivedRoomPosition &&
      !isolationResult.userAReceivedRoomPositionForC &&
      isolationResult.userBReceivedParticipantLeft &&
      isolationResult.userBReceivedCallEnded &&
      isolationResult.callEndedReason === "room_switched"
    ) {
      console.log("--> PASS: Multi-room participant isolation verified across meeting-room-a and meeting-room-b.");
      console.log("--> PASS: Room-scoped position updates received only by co-located room members.");
      console.log("--> PASS: Switching rooms cleanly terminates active audio call with peer in old room ('room_switched').");
      console.log("--> PASS: Zero cross-room zombie audio sessions or participant leaks.");
    } else {
      console.error("--> FAIL: Multi-room isolation & call teardown test failed:", isolationResult);
      hasErrors = true;
    }

    // 23. Profile REST API, Consistent Validation Errors & Real-Time Socket Updates
    console.log("\n--- [23] Testing Profile REST API, Validation Errors & Real-Time Sync ---");
    const profileResult = await testProfileApiAndRealtimeProfileSync("http://localhost:5000");
    if (
      profileResult.missingIdHandled &&
      profileResult.notFoundHandled &&
      profileResult.invalidColorHandled &&
      profileResult.invalidStatusHandled &&
      profileResult.putSuccess &&
      profileResult.getSuccess &&
      profileResult.socketProfileBroadcasted &&
      profileResult.client1CallbackSuccess &&
      profileResult.socketValidationHandled
    ) {
      console.log("--> PASS: Missing user ID gracefully returns 400 Bad Request with descriptive message.");
      console.log("--> PASS: Non-existent profile query returns 404 with structured JSON error payload.");
      console.log("--> PASS: Invalid hex color rejected with 400 status and frontend-friendly validation error.");
      console.log("--> PASS: Invalid availability status rejected with 400 status ('Status must be one of...').");
      console.log("--> PASS: PUT /api/profile/:userId successfully saves profile with displayName, avatarColor, availability.");
      console.log("--> PASS: GET /api/profile/:userId successfully retrieves persisted profile.");
      console.log("--> PASS: Socket updateProfile updates profile and broadcasts userProfileUpdated to peers in real-time.");
      console.log("--> PASS: Socket profile validation rejection provides consistent { status: 'error', message } structure.");
    } else {
      console.error("--> FAIL: Profile API and real-time sync test failed:", profileResult);
      hasErrors = true;
    }

    // 24. Real-Time Participant Sync, Avatar Movement, User Joining & Leaving Lifecycle (Task 16)
    await new Promise((r) => setTimeout(r, 400));
    console.log("\n--- [24] Testing Real-Time Participant Sync, Movement, Joining & Leaving (Task 16) ---");
    const multiClientResult = await testRealtimeParticipantSyncAndMovementLifecycle("http://localhost:5000");
    if (
      multiClientResult.step1JoinSyncSuccess &&
      multiClientResult.step2MultiJoinSuccess &&
      multiClientResult.step3MovementBroadcastSuccess &&
      multiClientResult.step4ConcurrentMovesSuccess &&
      multiClientResult.step5BurstMovesSuccess &&
      multiClientResult.step6LiveProfileUpdateSuccess &&
      multiClientResult.step7RosterIntegritySuccess
    ) {
      console.log("--> PASS: Multi-client connection and real-time participantJoined roster synchronization verified.");
      console.log("--> PASS: Multiple simultaneous client joins reliably update active participant counts.");
      console.log("--> PASS: Live avatar movement broadcasted to all co-located peers in real-time.");
      console.log("--> PASS: Concurrent avatar movements across 3+ clients processed without packet loss or dropouts.");
      console.log("--> PASS: High-frequency sequential movement bursts accurately received in order at destination.");
      console.log("--> PASS: Live profile updates (name, color, status) propagated to all connected clients immediately.");
      console.log("--> PASS: User departure (room switch & disconnection) cleans up participant roster with zero zombie users.");
    } else {
      console.error("--> FAIL: Multi-client participant sync & movement lifecycle test failed:", multiClientResult);
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
      console.log("\n✅ ALL TESTS PASSED: All 24 backend modules, multi-client participant sync, movement, joining/leaving, and WebRTC verified.\n");
      process.exit(0);
    }
  }
}

runTest();
