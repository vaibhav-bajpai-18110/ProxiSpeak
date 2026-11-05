import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROFILE,
  getAvailabilityLabel,
  normalizeProfile,
  PROFILE_AVATAR_COLORS,
} from "./profileUtils.js";

test("normalizes editable profile values and falls back for unknown options", () => {
  assert.deepEqual(normalizeProfile({
    displayName: "  Harsha   Vardhan ",
    avatarColor: PROFILE_AVATAR_COLORS[2].value,
    availability: "busy",
  }), {
    displayName: "Harsha Vardhan",
    avatarColor: PROFILE_AVATAR_COLORS[2].value,
    availability: "busy",
  });

  assert.deepEqual(normalizeProfile({
    displayName: "H".repeat(30),
    avatarColor: "not-a-color",
    availability: "unknown",
  }), {
    displayName: "H".repeat(24),
    avatarColor: DEFAULT_PROFILE.avatarColor,
    availability: DEFAULT_PROFILE.availability,
  });
});

test("labels profile availability choices", () => {
  assert.equal(getAvailabilityLabel("available"), "Available");
  assert.equal(getAvailabilityLabel("dnd"), "Do not disturb");
  assert.equal(getAvailabilityLabel("unknown"), "Available");
});
