/**
 * Compares two ordered lists of normalized { x, y } points and returns
 * whether every point in `attempt` lands within `tolerance` (in the same
 * [0, 1] normalized units) of the corresponding point in `reference`, at
 * the same index. Order matters — this is a sequence match, not a set
 * match, since the selection order is part of what's being verified.
 *
 * Used both to check a login attempt against the stored points, and to
 * check a registration's confirmation pass against its first pass.
 */
export function pointsMatch(attempt, reference, tolerance) {
  if (!attempt || !reference || attempt.length !== reference.length) {
    return false;
  }

  return attempt.every((point, index) => {
    const expected = reference[index];
    const dx = point.x - expected.x;
    const dy = point.y - expected.y;
    return Math.sqrt(dx * dx + dy * dy) <= tolerance;
  });
}
