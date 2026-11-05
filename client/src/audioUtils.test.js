import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAudioStatusLabel,
  getMicrophoneErrorMessage,
  getPeerAudioStatusLabel,
} from "./audioUtils.js";

test("explains common microphone permission and device errors", () => {
  assert.match(getMicrophoneErrorMessage({ name: "NotAllowedError" }), /access was denied/i);
  assert.match(getMicrophoneErrorMessage({ name: "NotFoundError" }), /no microphone was found/i);
  assert.match(getMicrophoneErrorMessage({ name: "NotReadableError" }), /unavailable or being used/i);
  assert.match(getMicrophoneErrorMessage({ name: "OtherError" }), /could not be started/i);
});

test("labels participant audio connection states clearly", () => {
  assert.equal(getPeerAudioStatusLabel("connecting"), "Connecting audio");
  assert.equal(getPeerAudioStatusLabel("connected"), "Audio connected");
  assert.equal(getPeerAudioStatusLabel("disconnected"), "Audio disconnected");
  assert.equal(getPeerAudioStatusLabel("failed"), "Audio connection failed");
});

test("reports microphone and peer states for the audio panel", () => {
  const base = { peerStatuses: {}, onlinePeerCount: 0, isConnected: true, isMuted: false };
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "off" }), "Microphone off");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "requesting" }), "Waiting for microphone permission");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "denied" }), "Microphone permission denied");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "ready", isMuted: true }), "Microphone muted · waiting for others");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "off", peerStatuses: { one: "connecting" }, onlinePeerCount: 1 }), "Connecting audio to participants");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "off", peerStatuses: { one: "connected", two: "connected" } }), "Audio connected with 2 participants");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "ready", peerStatuses: { one: "failed" }, onlinePeerCount: 1 }), "Audio connection failed");
  assert.equal(getAudioStatusLabel({ ...base, microphoneStatus: "ready", isConnected: false }), "Audio paused while the office reconnects");
});
