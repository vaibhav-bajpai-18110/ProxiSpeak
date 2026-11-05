require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mongoose = require("mongoose");
const User = require("./src/models/User");
const World = require("./src/models/World");
const WorldMember = require("./src/models/WorldMember");
const CommunicationSession = require("./src/models/CommunicationSession");
const testId = `db-persistence-${Date.now()}`;
const created = {
  userIds: [],
  worldIds: [],
  membershipIds: [],
  sessionIds: [],
};
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function run() {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is missing from environment variables");
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connection: PASS");
    // Create two uniquely identified test users.
    const user1 = await User.create({
      userId: `${testId}-user1`,
      username: "Persistence Test User 1",
    });
    created.userIds.push(user1.userId);
    const user2 = await User.create({
      userId: `${testId}-user2`,
      username: "Persistence Test User 2",
    });
    created.userIds.push(user2.userId);
    console.log("Test users created: PASS");
    // Create and retrieve a world.
    const world = await World.create({
      name: `${testId}-world`,
      ownerId: user1.userId,
      layout: { test: true },
    });
    created.worldIds.push(world._id);
    const readWorld = await World.findById(world._id);
    assert(readWorld && readWorld.name === world.name, "World read-back failed");
    console.log("World save and read: PASS");
    // Create and retrieve a membership.
    const membership = await WorldMember.create({
      userId: user2.userId,
      worldId: world._id,
      role: "member",
    });
    created.membershipIds.push(membership._id);
    const readMembership = await WorldMember.findById(membership._id);
    assert(
      readMembership &&
        readMembership.userId === user2.userId &&
        readMembership.worldId.toString() === world._id.toString(),
      "Membership read-back failed"
    );
    console.log("WorldMember save and read: PASS");
    // Confirm the unique userId + worldId index rejects duplicates.
    let duplicateRejected = false;
    try {
      await WorldMember.create({
        userId: user2.userId,
        worldId: world._id,
        role: "member",
      });
    } catch (error) {
      if (error.code === 11000) {
        duplicateRejected = true;
      } else {
        throw error;
      }
    }
    assert(
      duplicateRejected,
      "Duplicate membership was not rejected by MongoDB"
    );
    console.log("Duplicate membership constraint: PASS");
    // Create and retrieve a communication session.
    const session = await CommunicationSession.create({
      participantIds: [user1.userId, user2.userId],
      worldId: world._id,
      status: "active",
    });
    created.sessionIds.push(session._id);
    const readSession = await CommunicationSession.findById(session._id);
    assert(
      readSession &&
        readSession.participantIds.includes(user1.userId) &&
        readSession.participantIds.includes(user2.userId) &&
        readSession.status === "active",
      "CommunicationSession read-back failed"
    );
    console.log("CommunicationSession save and read: PASS");
    // End the session and verify the update persists.
    readSession.status = "ended";
    readSession.endedAt = new Date();
    await readSession.save();
    const endedSession = await CommunicationSession.findById(session._id);
    assert(
      endedSession &&
        endedSession.status === "ended" &&
        endedSession.endedAt,
      "Session end update was not persisted"
    );
    console.log("CommunicationSession update: PASS");
    console.log("MODEL PERSISTENCE VERIFICATION: PASS");
  } catch (error) {
    console.error("MODEL PERSISTENCE VERIFICATION: FAIL", error.message);
    process.exitCode = 1;
  } finally {
    // Delete only records created by this run.
    try {
      if (mongoose.connection.readyState === 1) {
        if (created.sessionIds.length) {
          await CommunicationSession.deleteMany({
            _id: { $in: created.sessionIds },
          });
        }
        if (created.membershipIds.length) {
          await WorldMember.deleteMany({
            _id: { $in: created.membershipIds },
          });
        }
        if (created.worldIds.length) {
          await World.deleteMany({ _id: { $in: created.worldIds } });
        }
        if (created.userIds.length) {
          await User.deleteMany({
            userId: { $in: created.userIds },
          });
        }
        console.log("Test-record cleanup: PASS");
      }
    } catch (cleanupError) {
      console.error("Test-record cleanup: FAIL", cleanupError.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  }
}
run();
