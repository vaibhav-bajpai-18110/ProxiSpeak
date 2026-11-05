const mongoose = require("mongoose");
const communicationSessionSchema = new mongoose.Schema(
  {
    participantIds: {
      type: [String],
      required: true,
      validate: {
        validator: (ids) =>
          ids.length >= 2 &&
          ids.every((id) => typeof id === "string" && id.trim().length > 0) &&
          new Set(ids).size === ids.length,
        message: "A session requires at least two unique participants.",
      },
    },
    worldId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "World",
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "ended"],
      default: "active",
      required: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    endedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);
communicationSessionSchema.index({ participantIds: 1, status: 1 });
communicationSessionSchema.index({ worldId: 1, status: 1 });
module.exports =
  mongoose.models.CommunicationSession ||
  mongoose.model("CommunicationSession", communicationSessionSchema);
