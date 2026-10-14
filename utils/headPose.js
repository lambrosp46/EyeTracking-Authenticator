/**
 * Positioning check: is the head where gaze calibration works best?
 *
 * The native module sends the raw geometry (eye midpoint, which way the face
 * points, head roll, phone tilt and rotation speed). This file turns it into
 * numbers that mean something relative to the SCREEN and checks them against
 * settings.positioning. Pure functions, no React - so the thresholds can be
 * unit-tested and the same logic can later run during calibration and login.
 *
 * Why these checks (see the calibration research doc):
 *  - distance: gaze error on the screen = distance x tan(angular error), and
 *    head-screen distance, device orientation and head motion explain most of
 *    the error on handheld phones. Calibration only holds at the distance it
 *    was fitted at.
 *  - eye height: looking far down narrows the eyelids over the iris; error is
 *    largest at the bottom of the screen.
 *  - head angle is measured against the line from the eyes to the SCREEN
 *    CENTRE, not against the screen normal: "aimed at the screen" is the pose
 *    in which every target needs the smallest eye rotation.
 *  - phone tilt vs gravity is reported, but by default only as a hint: what
 *    the tracker cares about is the head relative to the phone, which the
 *    checks above already cover.
 */

const DEG = 180 / Math.PI;

/**
 * Physical screen geometry in cm, using the same conventions as
 * gazeMapping.rawToScreenPoints (lens offset from the top-left corner).
 *
 * @param {object} screenCfg settings.eyeTracking.screen
 * @param {{width: number, height: number}} window
 * @param {(points: number) => number} pointsToCm
 */
export function screenGeometry(screenCfg, window, pointsToCm) {
  const widthCm = screenCfg.widthCm ?? pointsToCm(window.width);
  const heightCm = screenCfg.heightCm ?? pointsToCm(window.height);
  return {
    widthCm,
    heightCm,
    offsetXCm: screenCfg.cameraOffsetXCm ?? widthCm / 2,
    offsetYCm: screenCfg.cameraOffsetYCm ?? 0.6,
    // Same flags that fix the uncalibrated cursor; if the preview moves the
    // wrong way, it is the same physical axis that is wrong here.
    signX: screenCfg.invertX ? -1 : 1,
    signY: screenCfg.invertY ? -1 : 1,
  };
}

/**
 * @param {object} sample a GazeSample carrying the head* / faceDir* fields
 * @param {ReturnType<typeof screenGeometry>} geom
 * @returns {null | {
 *   distanceCm: number, eyeXFromCenterCm: number, eyeYFromTopCm: number,
 *   yawDeg: number, pitchDeg: number, rollDeg: number,
 *   deviceTiltDeg: number|null, deviceRotationDps: number|null, interEyeCm: number|null
 * }}
 */
export function headMetrics(sample, geom) {
  if (!sample || sample.headZCm == null || sample.faceDirZ == null) return null;

  const hx = sample.headXCm * geom.signX; // cm right of the lens
  const hy = sample.headYCm * geom.signY; // cm below the lens
  const hz = sample.headZCm; //              cm in front of the screen

  // Screen centre, relative to the lens.
  const cx = geom.widthCm / 2 - geom.offsetXCm;
  const cy = geom.heightCm / 2 - geom.offsetYCm;

  // Direction the face points vs. direction from the eyes to the screen centre.
  const fx = sample.faceDirX * geom.signX;
  const fy = sample.faceDirY * geom.signY;
  const fz = sample.faceDirZ;
  const vx = cx - hx;
  const vy = cy - hy;
  const vz = hz;

  return {
    distanceCm: hz,
    // Where the eyes project onto the screen plane.
    eyeXFromCenterCm: hx + geom.offsetXCm - geom.widthCm / 2,
    eyeYFromTopCm: hy + geom.offsetYCm,
    // + = face turned towards the right of the screen / nose below the centre.
    yawDeg: (Math.atan2(fx, fz) - Math.atan2(vx, vz)) * DEG,
    pitchDeg: (Math.atan2(fy, fz) - Math.atan2(vy, vz)) * DEG,
    // Flipping one axis mirrors the roll as well.
    rollDeg: (sample.headRollDeg ?? 0) * geom.signX * geom.signY,
    deviceTiltDeg: sample.deviceTiltDeg ?? null,
    deviceRotationDps: sample.deviceRotationDps ?? null,
    interEyeCm: sample.interEyeCm ?? null,
  };
}

const SMOOTHED_KEYS = [
  'distanceCm', 'eyeXFromCenterCm', 'eyeYFromTopCm',
  'yawDeg', 'pitchDeg', 'rollDeg', 'deviceTiltDeg', 'deviceRotationDps',
];

/** Exponential smoothing of the metrics, so hints and the drawing don't flicker. */
export function smoothMetrics(previous, next, alpha) {
  if (!next) return null;
  if (!previous || alpha >= 1) return next;
  const out = { ...next };
  for (const key of SMOOTHED_KEYS) {
    if (next[key] == null || previous[key] == null) continue;
    out[key] = previous[key] + alpha * (next[key] - previous[key]);
  }
  return out;
}

/**
 * Checks the metrics against settings.positioning.
 *
 * Hysteresis: once everything is inside (`wasOk`), every limit widens by
 * `exitToleranceFactor`, so a user sitting right on the edge doesn't flip
 * between "ok" and "adjust" on sensor noise.
 *
 * @returns {{ ok: boolean, issues: string[], primary: string|null, soft: string[] }}
 *   issues are in priority order; the first one is the hint to show.
 *   soft = advisory problems that don't block (phone tilt in 'hint' mode).
 */
export function evaluatePositioning(m, cfg, wasOk = false) {
  if (!m) return { ok: false, issues: ['noFace'], primary: 'noFace', soft: [] };

  const f = wasOk ? (cfg.exitToleranceFactor ?? 1.5) : 1;
  const issues = [];
  const soft = [];

  const dDist = m.distanceCm - cfg.targetDistanceCm;
  if (dDist < -cfg.distanceToleranceCm * f) issues.push('tooClose');
  else if (dDist > cfg.distanceToleranceCm * f) issues.push('tooFar');

  const dY = m.eyeYFromTopCm - cfg.targetEyeYFromTopCm;
  if (dY > cfg.eyeYToleranceCm * f) issues.push('faceTooLow');
  else if (dY < -cfg.eyeYToleranceCm * f) issues.push('faceTooHigh');

  // Targets default to 0 (centred, aimed at the screen centre, upright); in
  // reference mode they are the pose the calibration was made in.
  const dX = m.eyeXFromCenterCm - (cfg.targetEyeXFromCenterCm ?? 0);
  if (dX > cfg.eyeXToleranceCm * f) issues.push('faceTooRight');
  else if (dX < -cfg.eyeXToleranceCm * f) issues.push('faceTooLeft');

  if (Math.abs(m.yawDeg - (cfg.targetYawDeg ?? 0)) > cfg.maxHeadYawDeg * f) issues.push('turnedSideways');

  const dPitch = m.pitchDeg - (cfg.targetPitchDeg ?? 0);
  if (cfg.pitchRangeDeg) {
    // Pose lock after a two-pose calibration: while tracking (wasOk), any head
    // pitch between the first and the second calibration pose (+ a margin) is
    // fine - the head-pose terms were fitted on exactly that range. Outside it
    // the fit would extrapolate, so the user is sent back - to the FIRST pose,
    // where the fit has the most data (12 targets).
    const [lo, hi] = cfg.pitchRangeDeg;
    if (wasOk) {
      const e = cfg.pitchExitMarginDeg ?? 0.5;
      if (m.pitchDeg > hi + e) issues.push('chinDown');
      else if (m.pitchDeg < lo - e) issues.push('chinUp');
    } else {
      const t = cfg.returnPitchToleranceDeg ?? 1;
      if (dPitch > t) issues.push('chinDown');
      else if (dPitch < -t) issues.push('chinUp');
    }
  } else if (dPitch > cfg.maxHeadPitchDeg * f) issues.push('chinDown');
  else if (dPitch < -cfg.maxHeadPitchDeg * f) issues.push('chinUp');

  if (Math.abs(m.rollDeg - (cfg.targetRollDeg ?? 0)) > cfg.maxHeadRollDeg * f) issues.push('headTilted');

  if (m.deviceRotationDps != null && m.deviceRotationDps > cfg.maxDeviceRotationDps * f) {
    issues.push('moving');
  }

  const tilt = cfg.deviceTilt ?? {};
  const mode = tilt.mode ?? 'hint';
  if (mode !== 'off' && m.deviceTiltDeg != null) {
    const widen = (f - 1) * ((tilt.maxDeg - tilt.minDeg) / 2);
    const target = mode === 'gate' ? issues : soft;
    if (m.deviceTiltDeg > tilt.maxDeg + widen) target.push('phoneLeanedBack');
    else if (m.deviceTiltDeg < tilt.minDeg - widen) target.push('phoneLeanedForward');
  }

  return { ok: issues.length === 0, issues, primary: issues[0] ?? null, soft };
}

/**
 * settings.positioning turned into "match THIS pose": the targets become the
 * pose the calibration was fitted in (calibration.pose) and the tolerances come
 * from positioning.poseLock, which are much tighter than the general ones.
 *
 * Why tight: ARKit reports only ~30% of the true eye rotation, so the
 * calibration multiplies the signal by ~3 - and with it every small change of
 * head pose. In the pilot, 3° of head pitch moved every point ~2.4 cm.
 * Phone tilt vs gravity is ignored here: only the head relative to the phone matters.
 */
export function referenceConfig(cfg, ref) {
  // A head-compensated calibration (fitted on two poses) stays accurate over a
  // wider range of poses, so it gets the looser poseLock.compensated limits.
  const lock = ref.compensated ? { ...(cfg.poseLock ?? {}), ...(cfg.poseLock?.compensated ?? {}) } : (cfg.poseLock ?? {});
  // Pitch window = from the first to the second calibration pose, plus a
  // margin for sensor noise (only when the fit learnt the head-pose effect).
  const pr = cfg.poseLock?.pitchRange ?? {};
  const span = ref.compensated && pr.enabled !== false && Array.isArray(ref.pitchSpanDeg) ? ref.pitchSpanDeg : null;
  const margin = pr.marginDeg ?? 1;
  const pitchWindow = span
    ? {
        pitchRangeDeg: [Math.min(...span) - margin, Math.max(...span) + margin],
        pitchExitMarginDeg: pr.exitMarginDeg ?? 0.5,
        returnPitchToleranceDeg: pr.returnToleranceDeg ?? 1,
      }
    : { pitchRangeDeg: null };
  return {
    ...cfg,
    targetDistanceCm: ref.distanceCm,
    distanceToleranceCm: lock.distanceToleranceCm ?? 1.5,
    targetEyeXFromCenterCm: ref.eyeXFromCenterCm ?? 0,
    eyeXToleranceCm: lock.eyeXToleranceCm ?? 0.7,
    targetEyeYFromTopCm: ref.eyeYFromTopCm,
    eyeYToleranceCm: lock.eyeYToleranceCm ?? 0.7,
    targetYawDeg: ref.yawDeg ?? 0,
    maxHeadYawDeg: lock.maxHeadYawDeg ?? 2,
    targetPitchDeg: ref.pitchDeg ?? 0,
    maxHeadPitchDeg: lock.maxHeadPitchDeg ?? 2,
    targetRollDeg: ref.rollDeg ?? 0,
    maxHeadRollDeg: lock.maxHeadRollDeg ?? 3,
    maxDeviceRotationDps: lock.maxDeviceRotationDps ?? cfg.maxDeviceRotationDps,
    deviceTilt: { mode: 'off' },
    holdStillMs: lock.holdStillMs ?? cfg.holdStillMs,
    exitToleranceFactor: lock.exitToleranceFactor ?? cfg.exitToleranceFactor,
    ...pitchWindow,
    isReference: true,
  };
}

/** True when a calibration carries a usable reference pose. */
export const hasReferencePose = (calibration) => calibration?.pose?.distanceCm != null;

/** User-facing hint per issue key. */
export const POSITION_HINTS = {
  noFace: 'Δεν φαίνεται το πρόσωπό σου. Κράτα το κινητό μπροστά στο πρόσωπο.',
  tooClose: 'Πολύ κοντά — απομάκρυνε λίγο το κινητό.',
  tooFar: 'Πολύ μακριά — φέρε το κινητό πιο κοντά.',
  faceTooLow: 'Φέρε το πρόσωπο πιο ψηλά στο πλαίσιο (χαμήλωσε λίγο το κινητό).',
  faceTooHigh: 'Φέρε το πρόσωπο πιο χαμηλά στο πλαίσιο (σήκωσε λίγο το κινητό).',
  faceTooRight: 'Φέρε το πρόσωπο πιο αριστερά στο πλαίσιο.',
  faceTooLeft: 'Φέρε το πρόσωπο πιο δεξιά στο πλαίσιο.',
  turnedSideways: 'Γύρισε το πρόσωπο ίσια προς την οθόνη.',
  chinDown: 'Σήκωσε λίγο το πηγούνι.',
  chinUp: 'Χαμήλωσε λίγο το πηγούνι.',
  headTilted: 'Κράτα το κεφάλι ίσιο, όχι γερμένο στο πλάι.',
  moving: 'Κράτα το κινητό σταθερό.',
  phoneLeanedBack: 'Κράτα το κινητό πιο όρθιο.',
  phoneLeanedForward: 'Γείρε λίγο το πάνω μέρος του κινητού προς τα πίσω.',
  ok: 'Τέλεια — μείνε έτσι.',
};
