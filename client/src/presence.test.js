import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampPosition,
  mergeParticipant,
  normalizeParticipant,
  normalizeUsername,
} from "./presence.js";

test("normalizes display names by trimming and collapsing whitespace", () => {
  assert.equal(normalizeUsername("  Harshavardhan\n  Yelleti  "), "Harshavardhan Yelleti");
  assert.equal(normalizeUsername("   "), "");
  assert.equal(normalizeUsername(null), "");
});

test("normalizes a backend participant and converts map coordinates to office percentages", () => {
  const participant = normalizeParticipant({
    id: "socket-1",
    username: "Guest One",
    x: 860,
    y: 920,
    color: "#3B82F6",
  }, "socket-1");

  assert.deepEqual(participant, {
    id: "socket-1",
    name: "Guest One",
    status: "online",
    isYou: true,
    position: { x: 43, y: 46 },
    color: "#3B82F6",
  });
});

test("keeps converted avatar positions inside the visible office bounds", () => {
  assert.deepEqual(clampPosition({ x: -10, y: 110 }), { x: 8, y: 88 });
  assert.deepEqual(normalizeParticipant({ id: "socket-2", x: 0, y: 2000 }).position, {
    x: 8,
    y: 88,
  });
});

test("preserves known name and position when a later roster update omits them", () => {
  const previous = {
    id: "socket-3",
    name: "Guest Three",
    status: "online",
    isYou: false,
    position: { x: 61, y: 37 },
    color: "#10B981",
  };
  const next = normalizeParticipant({ id: "socket-3", username: "Guest" });

  assert.deepEqual(mergeParticipant(next, previous), previous);
});

test("ignores malformed participant records and rejects non-finite coordinates", () => {
  assert.equal(normalizeParticipant(null), null);
  assert.equal(normalizeParticipant({ username: "Missing ID" }), null);
  assert.equal(normalizeParticipant({ id: "socket-4", x: Number.NaN, y: 10 }).position, null);
});
