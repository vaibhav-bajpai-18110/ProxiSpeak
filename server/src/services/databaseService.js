
const User = require("../models/User");
const World = require("../models/World");
const WorldMember = require("../models/WorldMember");

const databaseService = {
  // Find an existing user by their unique ID.
  findUserById(userId) {
    return User.findOne({ userId: userId.trim() });
  },

  // Create a world and register its owner as a member.
  async createWorld({ name, ownerId, layout = {} }) {
    const normalizedOwnerId = ownerId.trim();

    const owner = await User.findOne({ userId: normalizedOwnerId });

    if (!owner) {
      const error = new Error("Owner not found.");
      error.statusCode = 404;
      throw error;
    }

    let world;

    try {
      world = await World.create({
        name: name.trim(),
        ownerId: normalizedOwnerId,
        layout,
      });

      await WorldMember.create({
        userId: normalizedOwnerId,
        worldId: world._id,
        role: "owner",
      });

      return world;
    } catch (error) {
      // Avoid leaving a world behind if owner membership creation fails.
      if (world) {
        await World.deleteOne({ _id: world._id }).catch(() => {});
      }

      throw error;
    }
  },

  // Retrieve worlds, newest first.
  listWorlds() {
    return World.find().sort({ createdAt: -1 });
  },

  // Retrieve one world and its membership records.
  async getWorldWithMembers(worldId) {
    const world = await World.findById(worldId);

    if (!world) {
      return null;
    }

    const members = await WorldMember.find({ worldId: world._id });

    return { world, members };
  },

  // Add a user to a world without creating duplicate memberships.
  async joinWorld(worldId, userId) {
    const user = await User.findOne({ userId: userId.trim() });

    if (!user) {
      const error = new Error("User not found.");
      error.statusCode = 404;
      throw error;
    }

    const world = await World.findById(worldId);

    if (!world) {
      const error = new Error("World not found.");
      error.statusCode = 404;
      throw error;
    }

    return WorldMember.findOneAndUpdate(
      {
        userId: user.userId,
        worldId: world._id,
      },
      {
        $setOnInsert: {
          role: "member",
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      }
    );
  },
};

module.exports = databaseService;
