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

/**
 * Physical-distance variant of `pointsMatch`, used for gaze verification.
 *
 * Two reasons this exists rather than reusing the normalized comparison:
 *
 * 1. Normalized units are not isotropic. A distance of 0.05 along x and 0.05
 *    along y are different physical distances unless the image box is square,
 *    so a single normalized tolerance is a wider allowance on the long axis.
 *    Converting through the box size first makes the tolerance a real circle.
 *
 * 2. The tolerance is expressed the way the thesis defines it - in centimetres -
 *    so it stays independent of screen density and image display size.
 *
 * Matching rule: the attempt counts as verified when the two dots *touch*, i.e.
 * the centre-to-centre distance is no greater than the sum of their radii. With
 * both dots drawn at `dotDiameterCm`, that sum is exactly one diameter.
 *
 * Returns per-point detail as well as the verdict, so callers can log which
 * point failed and by how much.
 */
export function pointsMatchPhysical(attempt, reference, boxSize, toleranceCm, pointsToCm) {
  if (!attempt || !reference || attempt.length !== reference.length) {
    return { ok: false, reason: 'count-mismatch', details: [] };
  }

  const details = attempt.map((point, index) => {
    const expected = reference[index];
    const dxPoints = (point.x - expected.x) * boxSize.width;
    const dyPoints = (point.y - expected.y) * boxSize.height;
    const distanceCm = pointsToCm(Math.hypot(dxPoints, dyPoints));
    return {
      index,
      distanceCm,
      toleranceCm,
      ok: distanceCm <= toleranceCm,
      gaze: { x: point.x, y: point.y },
      expected: { x: expected.x, y: expected.y },
    };
  });

  return { ok: details.every((d) => d.ok), details };
}
