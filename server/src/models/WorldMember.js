
const mongoose = require("mongoose");

const worldMemberSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
    },
    worldId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "World",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "member"],
      default: "member",
    },
  },
  {
    timestamps: true,
  }
);

// A user should have only one membership record per world.
worldMemberSchema.index(
  { userId: 1, worldId: 1 },
  { unique: true }
);

module.exports = mongoose.model("WorldMember", worldMemberSchema);
