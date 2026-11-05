const ROOM_BOUNDS = { minX: 8, maxX: 92, minY: 12, maxY: 88 };
export const BACKEND_MAP_SIZE = 2000;

export function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function clampPosition(position) {
  return {
    x: Math.min(ROOM_BOUNDS.maxX, Math.max(ROOM_BOUNDS.minX, position.x)),
    y: Math.min(ROOM_BOUNDS.maxY, Math.max(ROOM_BOUNDS.minY, position.y)),
  };
}

export function isValidPosition(position) {
  return Boolean(
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y)
  );
}

function toOfficePosition(position) {
  if (!isValidPosition(position)) return null;
  return clampPosition({
    x: (position.x / BACKEND_MAP_SIZE) * 100,
    y: (position.y / BACKEND_MAP_SIZE) * 100,
  });
}

export function normalizeParticipant(participant, ownSocketId) {
  if (!participant || typeof participant.id !== "string") return null;

  const name = typeof participant.name === "string"
    ? participant.name
    : typeof participant.username === "string"
      ? participant.username
      : "Guest";
  const backendPosition = Number.isFinite(participant.x) && Number.isFinite(participant.y)
    ? toOfficePosition({ x: participant.x, y: participant.y })
    : isValidPosition(participant.position)
      ? clampPosition(participant.position)
      : null;

  return {
    id: participant.id,
    name,
    status: participant.status === "offline" ? "offline" : "online",
    isYou: participant.id === ownSocketId,
    position: backendPosition,
    color: typeof participant.color === "string" ? participant.color : "",
  };
}

export function mergeParticipant(participant, previous) {
  if (!previous) return participant;
  return {
    ...previous,
    ...participant,
    name: participant.name && participant.name !== "Guest" ? participant.name : previous.name,
    position: participant.position || previous.position || null,
    color: participant.color || previous.color || "",
  };
}
