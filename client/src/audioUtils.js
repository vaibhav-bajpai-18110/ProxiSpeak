export function getMicrophoneErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Microphone access was denied. Allow microphone access in your browser, then try again.";
    case "NotFoundError":
      return "No microphone was found. Connect a microphone and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is unavailable or being used by another app.";
    case "OverconstrainedError":
      return "The selected microphone does not support the requested audio settings.";
    default:
      return "The microphone could not be started. Check your device and try again.";
  }
}

export function getPeerAudioStatusLabel(status) {
  switch (status) {
    case "connecting": return "Connecting audio";
    case "connected": return "Audio connected";
    case "disconnected": return "Audio disconnected";
    case "failed": return "Audio connection failed";
    default: return "Audio not started";
  }
}

export function getAudioStatusLabel({ microphoneStatus, isMuted, peerStatuses, onlinePeerCount, isConnected }) {
  if (!isConnected) {
    return microphoneStatus === "ready"
      ? "Audio paused while the office reconnects"
      : "Connect to the office before joining audio";
  }

  const statuses = Object.values(peerStatuses || {});
  const connectedCount = statuses.filter((status) => status === "connected").length;
  if (connectedCount > 0) {
    return `Audio connected with ${connectedCount} participant${connectedCount === 1 ? "" : "s"}`;
  }
  if (microphoneStatus === "requesting") return "Waiting for microphone permission";
  if (microphoneStatus === "denied") return "Microphone permission denied";
  if (microphoneStatus === "unavailable") return "Microphone is unavailable in this browser";
  if (statuses.includes("failed")) return "Audio connection failed";
  if (statuses.includes("connecting")) return "Connecting audio to participants";
  if (statuses.includes("disconnected")) return "Audio disconnected";
  if (microphoneStatus === "ready") {
    if (onlinePeerCount === 0) return isMuted ? "Microphone muted · waiting for others" : "Microphone ready · waiting for others";
    return isMuted ? "Microphone muted · audio not connected" : "Microphone on · audio not connected";
  }
  return "Microphone off";
}
