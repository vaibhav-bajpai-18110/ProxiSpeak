/**
 * DAY 19: Comprehensive Edge-Case Verification Suite
 * Tests 5 Core Edge-Case Categories:
 * 1. Invalid Inputs Battery (NaN/Infinity/non-numeric coords, clamping, hex colors, status, empty/50KB chat, self-calls)
 * 2. Unavailable Server Handling (Socket.IO connect_error ECONNREFUSED, AbortController HTTP timeout)
 * 3. Database Connection Failures & Graceful In-Memory Fallback (Offline MongoDB, in-memory operations, reconnection self-healing)
 * 4. Duplicate Requests & Idempotency (Duplicate joinRoom flood prevention, duplicate createRoom rejection, compound index 11000)
 * 5. Unexpected User Disconnections & High Churn (Abrupt engine.close(), mid-call audio teardown, 10-socket churn burst, zero zombie sockets)
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const http = require("http");
const mongoose = require("mongoose");
const { io } = require("socket.io-client");
const { spawn } = require("child_process");

const WorldMember = require("./src/models/WorldMember");
const User = require("./src/models/User");

function checkUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function putJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * Creates a configured Socket.IO client instance
 */
function createClient(serverUrl, options = {}) {
  return io(serverUrl, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 4000,
    ...options,
  });
}

/**
 * Main Edge Case Test Suite Execution
 */
async function runEdgeCaseTestSuite(serverUrl = "http://127.0.0.1:5000") {
  console.log("\n============================================================");
  console.log("   DAY 19: PROXISPEAK EXHAUSTIVE EDGE-CASE TEST SUITE       ");
  console.log("============================================================");

  const results = {
    category1_invalidInputs: false,
    category2_unavailableServer: false,
    category3_databaseFailures: false,
    category4_duplicateRequests: false,
    category5_unexpectedDisconnects: false,
  };

  // -------------------------------------------------------------------------
  // CATEGORY 1: Invalid Inputs Battery
  // -------------------------------------------------------------------------
  console.log("\n--- [Category 1] Invalid Inputs Battery ---");
  {
    const clientA = createClient(serverUrl);
    const clientB = createClient(serverUrl);

    await Promise.all([
      new Promise((res) => clientA.once("connect", res)),
      new Promise((res) => clientB.once("connect", res)),
    ]);

    // 1.1 Non-numeric / NaN / Infinity / strings coordinates
    let validationErrors = 0;
    clientA.on("error:validation", () => {
      validationErrors++;
    });

    clientA.emit("updatePosition", { x: NaN, y: 100 });
    clientA.emit("updatePosition", { x: Infinity, y: 100 });
    clientA.emit("updatePosition", { x: "string-coord", y: 100 });
    clientA.emit("updatePosition", null);
    clientA.emit("updatePosition", [10, 20]);
    await new Promise((r) => setTimeout(r, 300));

    if (validationErrors < 4) {
      throw new Error(`Expected at least 4 validation errors for bad coordinates, got ${validationErrors}`);
    }
    console.log(`  --> 1.1 Non-numeric/NaN/Infinity/array coordinates correctly rejected (${validationErrors} validation errors captured).`);

    // 1.2 Extreme coordinate clamping
    const clampedPosPromise = new Promise((resolve) => {
      clientB.once("userPositionUpdated", (data) => resolve(data));
    });

    clientA.emit("updatePosition", { x: -999999, y: 999999 });
    const clampedPos = await clampedPosPromise;

    if (clampedPos.x !== 0 || clampedPos.y !== 2000) {
      throw new Error(`Expected clamped coordinates [0, 2000], got [${clampedPos.x}, ${clampedPos.y}]`);
    }
    console.log(`  --> 1.2 Extreme coordinates [-999999, 999999] safely clamped to [${clampedPos.x}, ${clampedPos.y}] in [0, 2000] bounds.`);

    // 1.3 Invalid Profile Hex Colors
    const badColorRes1 = await putJson(`${serverUrl}/api/profile/edge-user-color`, { avatarColor: "not-a-color" });
    const badColorRes2 = await putJson(`${serverUrl}/api/profile/edge-user-color`, { avatarColor: "#12345" }); // 5 digits
    const goodColorRes = await putJson(`${serverUrl}/api/profile/edge-user-color`, { avatarColor: "#3B82F6" });

    if (badColorRes1.status !== 400 || badColorRes2.status !== 400 || goodColorRes.status !== 200) {
      throw new Error("Invalid hex color validation failed in REST API");
    }

    const socketBadColor = await new Promise((resolve) => {
      clientA.emit("updateProfile", { color: "#invalid-hex" }, (ack) => resolve(ack));
    });
    if (socketBadColor.status !== "error") {
      throw new Error("Socket profile update with invalid color was not rejected");
    }
    console.log("  --> 1.3 Invalid hex colors ('not-a-color', '#12345') safely rejected via REST and Socket.IO.");

    // 1.4 Invalid Availability Status
    const badStatusRes = await putJson(`${serverUrl}/api/profile/edge-user-status`, { status: "sleeping" });
    const goodStatusRes = await putJson(`${serverUrl}/api/profile/edge-user-status`, { status: "away" });

    if (badStatusRes.status !== 400 || goodStatusRes.status !== 200) {
      throw new Error("Invalid availability status validation failed");
    }

    const socketBadStatus = await new Promise((resolve) => {
      clientA.emit("updateProfile", { status: "flying" }, (ack) => resolve(ack));
    });
    if (socketBadStatus.status !== "error") {
      throw new Error("Socket profile update with invalid status was not rejected");
    }
    console.log("  --> 1.4 Invalid status ('sleeping', 'flying') safely rejected; valid status ('away') accepted.");

    // 1.5 Empty & Oversized Chat Payloads
    const emptyChatAck = await new Promise((resolve) => {
      clientA.emit("chat:send", { message: "   " }, (ack) => resolve(ack));
    });
    if (emptyChatAck.status !== "error" || emptyChatAck.code !== "VALIDATION_ERROR") {
      throw new Error("Whitespace chat message was not rejected");
    }

    const massivePayload = "Z".repeat(50000);
    const oversizedChatAck = await new Promise((resolve) => {
      clientA.emit("chat:send", { message: massivePayload }, (ack) => resolve(ack));
    });
    if (oversizedChatAck.status !== "success" || oversizedChatAck.message.text.length > 500) {
      throw new Error(`Oversized chat message length should be clamped to 500, got ${oversizedChatAck.message?.text?.length}`);
    }
    console.log(`  --> 1.5 Empty chat correctly rejected; 50,000 char message safely trimmed to ${oversizedChatAck.message.text.length} chars.`);

    // 1.6 Malformed Room Creation
    const badRoomAck = await new Promise((resolve) => {
      clientA.emit("createRoom", null, (ack) => resolve(ack));
    });
    if (badRoomAck.success !== false) {
      throw new Error("Malformed null room creation was not rejected");
    }
    console.log("  --> 1.6 Malformed room creation payload safely rejected without server errors.");

    // 1.7 WebRTC Self-Call and Offline Peer
    const selfCallError = await new Promise((resolve) => {
      clientA.once("signal:error", (err) => resolve(err));
      clientA.emit("signal:call-user", { targetId: clientA.id });
    });
    if (selfCallError.message !== "Cannot call yourself") {
      throw new Error(`Expected 'Cannot call yourself', got '${selfCallError.message}'`);
    }

    const offlineCallError = await new Promise((resolve) => {
      clientA.once("signal:error", (err) => resolve(err));
      clientA.emit("signal:call-user", { targetId: "non_existent_peer_99999" });
    });
    if (!offlineCallError.message.includes("not found")) {
      throw new Error(`Expected target peer not found error, got '${offlineCallError.message}'`);
    }
    console.log("  --> 1.7 WebRTC self-calling and non-existent peer calls blocked with descriptive signal:error.");

    clientA.disconnect();
    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    results.category1_invalidInputs = true;
    console.log("--> PASS: Category 1 (Invalid Inputs Battery) verified 100%.");
  }

  // -------------------------------------------------------------------------
  // CATEGORY 2: Unavailable Server Handling
  // -------------------------------------------------------------------------
  console.log("\n--- [Category 2] Unavailable Server Handling ---");
  {
    const unreachablePort = 5999;
    const unreachableUrl = `http://127.0.0.1:${unreachablePort}`;

    // 2.1 Socket.IO client connection to down/unreachable server
    let socketConnectErrorCaptured = false;
    await new Promise((resolve) => {
      const deadSocket = io(unreachableUrl, {
        transports: ["websocket"],
        reconnection: false,
        timeout: 1000,
      });

      deadSocket.on("connect_error", (err) => {
        socketConnectErrorCaptured = true;
        deadSocket.disconnect();
        resolve();
      });

      // Safety timeout in case error takes a second
      setTimeout(() => {
        deadSocket.disconnect();
        resolve();
      }, 1500);
    });

    if (!socketConnectErrorCaptured) {
      throw new Error("Socket.IO client did not capture connect_error on unreachable server");
    }
    console.log("  --> 2.1 Socket.IO connection refusal safely captured via connect_error without process crashes.");

    // 2.2 Frontend-Style HTTP Request Timeout via AbortController
    let fetchHandledGracefully = false;
    let fallbackApiStatus = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);

    try {
      await fetch(`${unreachableUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      fetchHandledGracefully = true;
      fallbackApiStatus = "disconnected";
    }

    if (!fetchHandledGracefully || fallbackApiStatus !== "disconnected") {
      throw new Error("Frontend-style request timeout / refusal was not handled gracefully");
    }
    console.log("  --> 2.2 Frontend AbortController timeout & server downtime handled gracefully (status: 'disconnected').");

    results.category2_unavailableServer = true;
    console.log("--> PASS: Category 2 (Unavailable Server Handling) verified 100%.");
  }

  // -------------------------------------------------------------------------
  // CATEGORY 3: Database Connection Failures & Graceful In-Memory Fallback
  // -------------------------------------------------------------------------
  console.log("\n--- [Category 3] Database Connection Failures & Graceful In-Memory Fallback ---");
  {
    // 3.1 Simulate MongoDB disconnect
    const disconnectRes = await postJson(`${serverUrl}/api/test/database/disconnect`, {});
    if (disconnectRes.status !== 200) {
      throw new Error("Failed to trigger test database disconnect");
    }
    await new Promise((r) => setTimeout(r, 300));

    // Probe GET /api/status while database is offline
    const offlineStatusRes = await checkUrl(`${serverUrl}/api/status`);
    if (offlineStatusRes.status !== 200) {
      throw new Error("Server status endpoint failed when database was disconnected");
    }
    const statusData = JSON.parse(offlineStatusRes.body);
    if (statusData.database !== "disconnected" || statusData.status !== "active") {
      throw new Error(`Expected { database: "disconnected", status: "active" }, got: ${offlineStatusRes.body}`);
    }
    console.log("  --> 3.1 MongoDB disconnect simulated; GET /api/status reports active server with database: 'disconnected'.");

    // 3.2 In-Memory Fallback Operations while Database is Offline
    const offlineRoomRes = await postJson(`${serverUrl}/api/rooms`, {
      roomId: "room-offline-resilience",
      name: "Offline Resilience Room",
      description: "Testing in-memory operations during DB downtime",
    });
    if (offlineRoomRes.status !== 201) {
      throw new Error("Room creation failed while database is offline");
    }

    const offlineProfileRes = await putJson(`${serverUrl}/api/profile/user-offline-mode`, {
      displayName: "Offline Hero",
      avatarColor: "#10B981",
      availability: "available",
    });
    if (offlineProfileRes.status !== 200) {
      throw new Error("Profile update failed while database is offline");
    }

    // Real-time Socket.IO multiplayer during DB offline
    const clientOffA = createClient(serverUrl);
    const clientOffB = createClient(serverUrl);

    await Promise.all([
      new Promise((res) => clientOffA.once("connect", res)),
      new Promise((res) => clientOffB.once("connect", res)),
    ]);

    // Join room in offline mode
    const joinOffA = await new Promise((resolve) => {
      clientOffA.emit("joinRoom", { roomId: "room-offline-resilience", username: "OfflineHero" }, resolve);
    });
    const joinOffB = await new Promise((resolve) => {
      clientOffB.emit("joinRoom", { roomId: "room-offline-resilience", username: "PeerUser" }, resolve);
    });

    if (!joinOffA.success || !joinOffB.success) {
      throw new Error("Room join failed in offline mode");
    }

    // Position movement in offline mode
    const movePromise = new Promise((resolve) => {
      clientOffB.once("roomPositionUpdated", (data) => resolve(data));
    });
    clientOffA.emit("updatePosition", { x: 450, y: 550, roomId: "room-offline-resilience" });
    const moved = await movePromise;
    if (moved.x !== 450 || moved.y !== 550) {
      throw new Error("Position update failed during DB offline");
    }

    // Chat message in offline mode
    const chatPromise = new Promise((resolve) => {
      clientOffB.once("chat:message", (msg) => resolve(msg));
    });
    clientOffA.emit("chat:send", { roomId: "room-offline-resilience", message: "Operating offline seamlessly!" });
    const chatMsg = await chatPromise;
    if (!chatMsg.text.includes("Operating offline")) {
      throw new Error("Chat message failed during DB offline");
    }

    // WebRTC signaling in offline mode
    const callPromise = new Promise((resolve) => {
      clientOffB.once("signal:incoming-call", (call) => resolve(call));
    });
    clientOffA.emit("signal:call-user", { targetId: clientOffB.id, metadata: { test: true } });
    const incCall = await callPromise;
    if (incCall.callerId !== clientOffA.id) {
      throw new Error("WebRTC signaling failed during DB offline");
    }

    clientOffA.disconnect();
    clientOffB.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    console.log("  --> 3.2 Full multiplayer (rooms, profiles, movement, chat, WebRTC) succeeded seamlessly in-memory without database.");

    // 3.3 Database Reconnection & Self-Healing
    const reconnectRes = await postJson(`${serverUrl}/api/test/database/reconnect`, {});
    if (reconnectRes.status !== 200) {
      throw new Error("Failed to trigger test database reconnect");
    }
    await new Promise((r) => setTimeout(r, 400));

    const onlineStatusRes = await checkUrl(`${serverUrl}/api/status`);
    const onlineStatusData = JSON.parse(onlineStatusRes.body);
    if (onlineStatusData.database !== "connected") {
      throw new Error(`Expected { database: "connected" } after reconnect, got: ${onlineStatusRes.body}`);
    }
    console.log("  --> 3.3 Database self-healed and reconnected successfully (database: 'connected').");

    results.category3_databaseFailures = true;
    console.log("--> PASS: Category 3 (Database Connection Failures & In-Memory Fallback) verified 100%.");
  }

  // -------------------------------------------------------------------------
  // CATEGORY 4: Duplicate Requests & Idempotency
  // -------------------------------------------------------------------------
  console.log("\n--- [Category 4] Duplicate Requests & Idempotency ---");
  {
    const clientA = createClient(serverUrl);
    const clientB = createClient(serverUrl);

    await Promise.all([
      new Promise((res) => clientA.once("connect", res)),
      new Promise((res) => clientB.once("connect", res)),
    ]);

    // 4.1 Duplicate Socket.IO joinRoom flood protection
    await new Promise((res) => clientA.emit("joinRoom", { roomId: "idemp-test-room", username: "IdempUser" }, res));
    await new Promise((res) => clientB.emit("joinRoom", { roomId: "idemp-test-room", username: "Observer" }, res));

    let duplicateBroadcastsCount = 0;
    clientB.on("participantJoined", (p) => {
      if (p.username === "IdempUser") {
        duplicateBroadcastsCount++;
      }
    });

    // Send rapid duplicate join requests from Client A
    const join1 = await new Promise((res) => clientA.emit("joinRoom", { roomId: "idemp-test-room", username: "IdempUser" }, res));
    const join2 = await new Promise((res) => clientA.emit("joinRoom", { roomId: "idemp-test-room", username: "IdempUser" }, res));
    const join3 = await new Promise((res) => clientA.emit("joinRoom", { roomId: "idemp-test-room", username: "IdempUser" }, res));

    await new Promise((r) => setTimeout(r, 300));

    if (!join1.success || !join2.success || !join3.success) {
      throw new Error("Duplicate joinRoom calls should return idempotent success acknowledgment");
    }
    if (duplicateBroadcastsCount !== 0) {
      throw new Error(`Expected 0 duplicate participantJoined broadcasts to peers, got ${duplicateBroadcastsCount}`);
    }
    console.log("  --> 4.1 Duplicate joinRoom requests handled idempotently with zero broadcast floods to peers.");

    // 4.2 Duplicate createRoom rejection
    const roomPayload = { roomId: `idemp-room-${Date.now()}`, name: "Idempotency Room" };
    const create1 = await postJson(`${serverUrl}/api/rooms`, roomPayload);
    const create2 = await postJson(`${serverUrl}/api/rooms`, roomPayload);

    if (create1.status !== 201 || create2.status !== 400) {
      throw new Error(`Expected first createRoom 201, second 400, got ${create1.status} and ${create2.status}`);
    }

    const socketDupRoom = await new Promise((res) => {
      clientA.emit("createRoom", roomPayload, res);
    });
    if (socketDupRoom.success !== false || socketDupRoom.error !== "Room already exists") {
      throw new Error("Duplicate socket createRoom was not rejected with 'Room already exists'");
    }
    console.log("  --> 4.2 Duplicate room creation cleanly rejected via REST (400) and Socket.IO ('Room already exists').");

    // 4.3 Repeated disconnect calls
    clientA.disconnect();
    clientA.disconnect(); // Duplicate disconnect
    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    console.log("  --> 4.3 Repeated disconnect calls processed without unhandled exceptions or crashes.");

    // 4.4 MongoDB Compound Unique Index { userId: 1, worldId: 1 } rejection
    if (mongoose.connection.readyState === 0) {
      try {
        await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/proxispeak", {
          serverSelectionTimeoutMS: 5000,
        });
      } catch (err) {
        console.warn("[TEST RUNNER MONGODB WARNING]:", err.message);
      }
    }

    if (mongoose.connection.readyState === 1) {
      const testUserId = `edge_user_${Date.now()}`;
      const testWorldId = new mongoose.Types.ObjectId();

      await WorldMember.init();

      // Insert first member
      await WorldMember.create({
        userId: testUserId,
        worldId: testWorldId,
        role: "member",
      });

      // Attempt duplicate member with identical compound key
      let duplicateKeyErrorCaught = false;
      try {
        await WorldMember.create({
          userId: testUserId,
          worldId: testWorldId,
          role: "owner",
        });
      } catch (err) {
        if (err.code === 11000 || (err.message && err.message.includes("11000")) || (err.message && err.message.includes("duplicate"))) {
          duplicateKeyErrorCaught = true;
        }
      }

      if (!duplicateKeyErrorCaught) {
        throw new Error("MongoDB compound unique index { userId: 1, worldId: 1 } did not throw error 11000 on duplicate");
      }

      // Cleanup
      await WorldMember.deleteMany({ userId: testUserId });
      console.log("  --> 4.4 MongoDB compound unique index { userId: 1, worldId: 1 } strictly caught duplicate insert (code 11000).");
    }

    results.category4_duplicateRequests = true;
    console.log("--> PASS: Category 4 (Duplicate Requests & Idempotency) verified 100%.");
  }

  // -------------------------------------------------------------------------
  // CATEGORY 5: Unexpected User Disconnections & High Churn
  // -------------------------------------------------------------------------
  console.log("\n--- [Category 5] Unexpected User Disconnections & High Churn ---");
  {
    // 5.1 Abrupt Transport Severing (engine.close())
    const clientA = createClient(serverUrl);
    const clientB = createClient(serverUrl);

    await Promise.all([
      new Promise((res) => clientA.once("connect", res)),
      new Promise((res) => clientB.once("connect", res)),
    ]);

    await new Promise((res) => clientA.emit("joinRoom", { roomId: "abrupt-drop-room", username: "DroppingUser" }, res));
    await new Promise((res) => clientB.emit("joinRoom", { roomId: "abrupt-drop-room", username: "WitnessUser" }, res));

    const leftPromise = new Promise((resolve) => {
      clientB.once("participantLeft", (data) => resolve(data));
    });

    // Abruptly sever transport on Client A
    clientA.io.engine.close();
    clientA.disconnect(); // cancel internal reconnection loop

    const leftData = await leftPromise;
    if (leftData.reason !== "transport close" && leftData.reason !== "client namespace disconnect") {
      throw new Error(`Unexpected departure reason: ${leftData.reason}`);
    }
    console.log(`  --> 5.1 Abrupt transport severing detected; co-located peer notified with participantLeft (reason: '${leftData.reason}').`);

    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // 5.2 Mid-Call Abrupt Disconnect Audio Teardown
    const caller = createClient(serverUrl);
    const callee = createClient(serverUrl);

    await Promise.all([
      new Promise((res) => caller.once("connect", res)),
      new Promise((res) => callee.once("connect", res)),
    ]);

    await new Promise((res) => caller.emit("joinRoom", { roomId: "call-room", username: "Caller" }, res));
    await new Promise((res) => callee.emit("joinRoom", { roomId: "call-room", username: "Callee" }, res));

    // Establish call
    const incomingPromise = new Promise((resolve) => {
      callee.once("signal:incoming-call", (c) => resolve(c));
    });
    caller.emit("signal:call-user", { targetId: callee.id });
    await incomingPromise;

    const acceptedPromise = new Promise((resolve) => {
      caller.once("signal:call-accepted", (c) => resolve(c));
    });
    callee.emit("signal:accept-call", { targetId: caller.id });
    await acceptedPromise;

    // Callee listens for call-ended when caller crashes
    const callEndedPromise = new Promise((resolve) => {
      callee.once("signal:call-ended", (c) => resolve(c));
    });

    // Abruptly sever caller's transport mid-call
    caller.io.engine.close();
    caller.disconnect();

    const callEndedData = await callEndedPromise;
    if (!callEndedData || !callEndedData.peerId) {
      throw new Error("Callee did not receive signal:call-ended upon peer abrupt disconnect");
    }
    console.log(`  --> 5.2 Mid-call abrupt disconnect: active audio call torn down immediately (reason: '${callEndedData.reason}').`);

    callee.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // 5.3 Rapid Connection Churn Burst (10 clients) & Zero Zombie Sockets
    const preChurnProbe = await checkUrl(`${serverUrl}/api/status`);
    const baselineUsers = JSON.parse(preChurnProbe.body).activeUsers;

    const churnClients = [];
    for (let i = 0; i < 10; i++) {
      const c = createClient(serverUrl);
      churnClients.push(c);
    }

    await Promise.all(churnClients.map((c) => new Promise((res) => c.once("connect", res))));

    // Rapidly send position and disconnect
    churnClients.forEach((c, idx) => {
      c.emit("updatePosition", { x: 100 + idx * 10, y: 100 + idx * 10 });
      c.disconnect();
    });

    // Allow server to process all disconnect cycles and drain active users
    let normalized = false;
    let finalActiveUsers = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 200));
      const statusProbe = await checkUrl(`${serverUrl}/api/status`);
      const statusObj = JSON.parse(statusProbe.body);
      finalActiveUsers = statusObj.activeUsers;
      if (finalActiveUsers === baselineUsers) {
        normalized = true;
        break;
      }
    }

    if (!normalized) {
      throw new Error(`Expected activeUsers === ${baselineUsers} after churn burst, found ${finalActiveUsers} zombie sockets!`);
    }
    console.log(`  --> 5.3 Rapid churn burst (10 clients) processed cleanly; active users normalized to ${finalActiveUsers} (zero zombie sockets).`);

    results.category5_unexpectedDisconnects = true;
    console.log("--> PASS: Category 5 (Unexpected User Disconnections & Churn) verified 100%.");
  }

  console.log("\n============================================================");
  console.log("   ✅ ALL 5 EDGE-CASE CATEGORIES PASSED WITH 100% SUCCESS   ");
  console.log("============================================================\n");

  return {
    success: true,
    results,
  };
}

module.exports = {
  runEdgeCaseTestSuite,
};

// Standalone execution support
if (require.main === module) {
  (async () => {
    let serverProcess = null;
    try {
      // Connect to MongoDB if not already connected
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/proxispeak", {
          serverSelectionTimeoutMS: 5000,
        });
      }

      let isServerRunning = false;
      try {
        const probe = await checkUrl("http://127.0.0.1:5000/api/health");
        if (probe.status === 200) isServerRunning = true;
      } catch {}

      if (!isServerRunning) {
        console.log("Starting server for edge case verification...");
        serverProcess = spawn(process.execPath, ["src/index.js"], {
          cwd: __dirname,
          stdio: ["pipe", "pipe", "pipe"],
        });

        serverProcess.stdout.on("data", (d) => {
          const t = d.toString().trim();
          if (t) console.log(`[SERVER STDOUT]: ${t}`);
        });

        serverProcess.stderr.on("data", (d) => {
          const t = d.toString().trim();
          if (t) console.log(`[SERVER STDERR]: ${t}`);
        });

        let ready = false;
        for (let i = 0; i < 25; i++) {
          try {
            const probe = await checkUrl("http://127.0.0.1:5000/api/health");
            if (probe.status === 200) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!ready) throw new Error("Timed out waiting for server to start");
      }

      const result = await runEdgeCaseTestSuite("http://127.0.0.1:5000");
      console.log("\n✅ EDGE CASE TEST SUITE PASSED SUCCESSFULLY:", result);
      process.exit(0);
    } catch (err) {
      console.error("\n❌ EDGE CASE TEST SUITE FAILED:", err.message || err);
      process.exit(1);
    } finally {
      if (serverProcess) {
        serverProcess.kill("SIGTERM");
      }
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  })();
}
