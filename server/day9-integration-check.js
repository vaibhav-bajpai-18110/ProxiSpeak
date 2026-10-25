const { io } = require("socket.io-client");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mongoose = require("mongoose");
const CommunicationSession = require("./src/models/CommunicationSession");
const URL = "http://localhost:5000";
const timeout = (ms = 5000) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms));
async function connectClient() {
  const socket = io(URL, { reconnection: false });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    timeout()
  ]);
  return socket;
}
function ack(socket, event, payload) {
  return Promise.race([
    new Promise(resolve => socket.emit(event, payload, resolve)),
    timeout()
  ]);
}
(async () => {
  let a, b;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    a = await connectClient();
    b = await connectClient();
    console.log("Two clients connected: PASS");
    // Start: initiator receives ack, other participant receives event.
    const startedForB = new Promise(resolve =>
      b.once("communicationSessionStarted", resolve)
    );
    const start = await ack(a, "startCommunicationSession", {
      participantId: b.id
    });
    if (!start.sessionId || start.error) throw new Error("Session start failed");
    const startNotice = await Promise.race([startedForB, timeout()]);
    if (startNotice.sessionId !== start.sessionId)
      throw new Error("Recipient did not receive matching start event");
    console.log("Recipient notified on session start: PASS");
    // End: initiator receives ack, other participant receives event.
    const endedForB = new Promise(resolve =>
      b.once("communicationSessionEnded", resolve)
    );
    const end = await ack(a, "endCommunicationSession", {
      sessionId: start.sessionId
    });
    if (end.status !== "ended" || end.error) throw new Error("Session end failed");
    const endNotice = await Promise.race([endedForB, timeout()]);
    if (endNotice.sessionId !== start.sessionId || endNotice.status !== "ended")
      throw new Error("Recipient did not receive matching end event");
    console.log("Recipient notified on session end: PASS");
    // Reject starting a session with yourself.
    const badStart = await ack(a, "startCommunicationSession", {
      participantId: a.id
    });
    if (!badStart.error) throw new Error("Self-session was not rejected");
    console.log("Invalid/self start rejected: PASS");
    // Reject ending a nonexistent session.
    const badEnd = await ack(a, "endCommunicationSession", {
      sessionId: "000000000000000000000000"
    });
    if (!badEnd.error) throw new Error("Invalid session end was not rejected");
    console.log("Invalid session end rejected: PASS");
    // Disconnect one participant during a fresh active session.
    const secondStart = await ack(a, "startCommunicationSession", {
      participantId: b.id
    });
    if (!secondStart.sessionId || secondStart.error)
      throw new Error("Second session start failed");
    const disconnectNotice = new Promise(resolve =>
      b.once("communicationSessionEnded", resolve)
    );
    a.disconnect();
    const notice = await Promise.race([disconnectNotice, timeout()]);
    if (notice.sessionId !== secondStart.sessionId ||
        notice.status !== "ended" ||
        notice.reason !== "participant_disconnected")
      throw new Error("Disconnect end notification mismatch");
    const persisted = await CommunicationSession.findById(secondStart.sessionId).lean();
    if (!persisted || persisted.status !== "ended" || !persisted.endedAt)
      throw new Error("Disconnect-ended session was not persisted");
    console.log("Disconnect ends session and persists endedAt: PASS");
    console.log("DAY 9 SOCKET INTEGRATION: PASS");
  } catch (err) {
    console.error("DAY 9 SOCKET INTEGRATION: FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    if (a && a.connected) a.disconnect();
    if (b && b.connected) b.disconnect();
    await mongoose.disconnect().catch(() => {});
  }
})();
