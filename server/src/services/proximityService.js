/**
 * Proximity calculation service for ProxiSpeak
 * Will handle spatial distance calculations and MongoDB geospatial queries.
 */

function calculateDistance(coord1, coord2) {
  const dx = coord1.x - coord2.x;
  const dy = coord1.y - coord2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

module.exports = {
  calculateDistance
};
