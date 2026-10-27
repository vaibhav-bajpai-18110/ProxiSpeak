/**
 * Proximity calculation service for ProxiSpeak
 * Handles spatial distance calculations, audio volume attenuation, and stereo panning.
 */

function calculateDistance(coord1, coord2) {
  if (!coord1 || !coord2) return Infinity;
  const dx = (coord1.x || 0) - (coord2.x || 0);
  const dy = (coord1.y || 0) - (coord2.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function isWithinRadius(coord1, coord2, radius = 300) {
  return calculateDistance(coord1, coord2) <= radius;
}

/**
 * Calculates audio volume attenuation based on distance.
 * Returns a value between 1.0 (close) and 0.0 (at or outside maxRadius).
 */
function calculateAudioVolume(distance, maxRadius = 300) {
  if (distance <= 0) return 1.0;
  if (distance >= maxRadius) return 0.0;
  return Math.max(0, Math.min(1, 1 - distance / maxRadius));
}

/**
 * Calculates stereo panning based on horizontal offset relative to the listener.
 * Returns -1.0 (hard left), 0.0 (center), or +1.0 (hard right).
 */
function calculateAudioPan(listenerCoord, sourceCoord, panMaxDistance = 300) {
  if (!listenerCoord || !sourceCoord) return 0.0;
  const dx = (sourceCoord.x || 0) - (listenerCoord.x || 0);
  const pan = dx / panMaxDistance;
  return Math.max(-1.0, Math.min(1.0, pan));
}

/**
 * Returns all participants in the same room within the specified proximity radius.
 */
function getNearbyParticipants(user, allUsers = [], radius = 300) {
  if (!user || !Array.isArray(allUsers)) return [];

  const nearby = [];
  for (const other of allUsers) {
    if (other.id === user.id) continue;
    if (other.roomId !== user.roomId) continue;

    const distance = calculateDistance(user, other);
    if (distance <= radius) {
      nearby.push({
        id: other.id,
        username: other.username,
        roomId: other.roomId,
        x: other.x,
        y: other.y,
        color: other.color,
        distance: Math.round(distance),
        volume: Number(calculateAudioVolume(distance, radius).toFixed(2)),
        pan: Number(calculateAudioPan(user, other, radius).toFixed(2)),
      });
    }
  }

  // Sort by closest first
  nearby.sort((a, b) => a.distance - b.distance);
  return nearby;
}

module.exports = {
  calculateDistance,
  isWithinRadius,
  calculateAudioVolume,
  calculateAudioPan,
  getNearbyParticipants,
};
