
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

async function checkUrl(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      return { status: res.status, body, headers: res.headers };
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
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

    if (root.status === 200 && root.body === "ProxiSpeak Backend is running!") {
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

    console.log(
      "\n--- Test 16: Simultaneous Multi-User Interaction & Spatial Proximity ---"
    );

    const simInteractionResult =
      await testSimultaneousVirtualOfficeInteraction(
        "http://localhost:5000"
      );

    if (
      simInteractionResult.proximityAccurate &&
      simInteractionResult.roomTransitionVerified
    ) {
      console.log("PASS: Four concurrent users interacted successfully.");
      console.log("PASS: Spatial proximity and volume attenuation verified.");
      console.log("PASS: Room isolation and room transitions verified.");
    } else {
      throw new Error(
        "Simultaneous interaction test failed: " +
        JSON.stringify(simInteractionResult)
      );
    }

    console.log("\n--- Test 17: WebRTC full audio handshake ---");
    const fullHandshakeResult =
      await testWebRTCAudioCallingFullHandshake(
        "http://localhost:5000"
      );

    if (
      fullHandshakeResult.incomingCallReceived &&
      fullHandshakeResult.callAcceptedReceived &&
      fullHandshakeResult.offerRelayed &&
      fullHandshakeResult.answerRelayed &&
      fullHandshakeResult.candidateRelayed &&
      fullHandshakeResult.muteStatusRelayed &&
      fullHandshakeResult.callEndedReceived
    ) {
      console.log("PASS: WebRTC call handshake and signaling");
    } else {
      throw new Error(
        "WebRTC handshake test failed: " +
        JSON.stringify(fullHandshakeResult)
      );
    }

    console.log("\n--- Test 18: Abrupt disconnection cleanup ---");
    const abruptDisconnectResult =
      await testMidCallAbruptDisconnectionCleanup(
        "http://localhost:5000"
      );

    if (
      abruptDisconnectResult.callEndedReceivedByCallee &&
      abruptDisconnectResult.participantLeftReceivedByCallee
    ) {
      console.log("PASS: Active call and participant cleanup");
    } else {
      throw new Error(
        "Abrupt disconnection test failed: " +
        JSON.stringify(abruptDisconnectResult)
      );
    }

    console.log("\n--- Test 19: WebRTC errors and reconnection ---");
    const errorHandlingResult =
      await testWebRTCErrorHandlingAndReconnection(
        "http://localhost:5000"
      );

    if (
      errorHandlingResult.offlineErrorReceived &&
      errorHandlingResult.selfCallErrorReceived &&
      errorHandlingResult.callRejectedReceived &&
      errorHandlingResult.postReconnectCallSucceeded
    ) {
      console.log("PASS: WebRTC error handling and reconnection");
    } else {
      throw new Error(
        "WebRTC reconnection test failed: " +
        JSON.stringify(errorHandlingResult)
      );
    }

  } catch (error) {
    hasErrors = true;
    console.error("\n[TEST RUNNER EXCEPTION]:", error.message || error);
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
      process.exitCode = 0;
    }
  }
}

runTest();
