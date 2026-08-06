import * as physicalSize from './physicalSize';

/**
 * Maps the raw ARKit gaze intersection (metres from the front camera lens, on the
 * plane of the screen) to screen coordinates in React Native points.
 *
 * Two paths:
 *  1. `rawToScreenPoints`  - geometric fallback used before calibration. Assumes
 *     the lens sits horizontally centred, `cameraOffsetYCm` above the top of the
 *     display. Good enough to see the cursor move, not accurate enough to use.
 *  2. `fitCalibration` / `applyCalibration` - per-user least squares fit that
 *     absorbs the lens->corner offset, the angle between the optical and visual
 *     axis of the eye (kappa, 4-6 deg and different for everyone) and any
 *     systematic bias of ARKit's eye pose estimate.
 */

// Tolerate either a named or default export in physicalSize.js.
const cmToPoints =
  physicalSize.cmToPoints ??
  physicalSize.default?.cmToPoints ??
  ((cm) => cm * (163 / 2.54));

const POINTS_PER_CM = cmToPoints(1);

export const pointsToCm = (points) => points / POINTS_PER_CM;
export { cmToPoints };

// ---------------------------------------------------------------------------
// Uncalibrated geometric mapping
// ---------------------------------------------------------------------------

/**
 * @param {number} sxMeters metres right of the lens
 * @param {number} syMeters metres below the lens
 * @param {object} screenCfg settings.eyeTracking.screen
 * @param {{width: number, height: number}} window Dimensions.get('window')
 */
export function rawToScreenPoints(sxMeters, syMeters, screenCfg, window) {
  const widthCm = screenCfg.widthCm ?? pointsToCm(window.width);
  const offsetX = screenCfg.cameraOffsetXCm ?? widthCm / 2;
  const offsetY = screenCfg.cameraOffsetYCm ?? 0.6;

  const xCm = sxMeters * 100 * (screenCfg.invertX ? -1 : 1) + offsetX;
  const yCm = syMeters * 100 * (screenCfg.invertY ? -1 : 1) + offsetY;

  return { x: cmToPoints(xCm), y: cmToPoints(yCm) };
}

export function clampToScreen(point, window, margin = 0) {
  return {
    x: Math.min(Math.max(point.x, margin), window.width - margin),
    y: Math.min(Math.max(point.y, margin), window.height - margin),
  };
}

// ---------------------------------------------------------------------------
// Calibration model
// ---------------------------------------------------------------------------

/** Design matrix row for a raw sample. */
export function basis(model, sx, sy) {
  if (model === 'quadratic') {
    return [1, sx, sy, sx * sy, sx * sx, sy * sy];
  }
  return [1, sx, sy]; // affine
}

export function basisSize(model) {
  return model === 'quadratic' ? 6 : 3;
}

/** Solves A x = b for a small dense system with partial pivoting. */
function solve(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null; // singular
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/** Ordinary least squares with Tikhonov (ridge) regularisation. */
function leastSquares(rows, targets, ridge) {
  const k = rows[0].length;
  const AtA = Array.from({ length: k }, () => new Array(k).fill(0));
  const Atb = new Array(k).fill(0);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let a = 0; a < k; a++) {
      Atb[a] += row[a] * targets[i];
      for (let b = 0; b < k; b++) AtA[a][b] += row[a] * row[b];
    }
  }
  for (let a = 0; a < k; a++) AtA[a][a] += ridge;

  return solve(AtA, Atb);
}

/**
 * @param {Array<{sx: number, sy: number, targetX: number, targetY: number, targetIndex?: number}>} samples
 * @param {object} config settings.calibration
 * @returns {{ok: boolean, reason?: string, calibration?: object, quality?: object}}
 */
export function fitCalibration(samples, config = {}) {
  const ridge = config.ridge ?? 1e-6;
  let model = config.model ?? 'affine';

  const distinctTargets = new Set(samples.map((s) => `${s.targetX}|${s.targetY}`)).size;
  if (model === 'quadratic' && distinctTargets < 6) {
    model = 'affine'; // not enough targets to constrain the quadratic terms
  }
  if (samples.length < basisSize(model) || distinctTargets < 3) {
    return { ok: false, reason: 'Not enough valid samples were collected. Try again and hold still.' };
  }

  const rows = samples.map((s) => basis(model, s.sx, s.sy));
  const coefX = leastSquares(rows, samples.map((s) => s.targetX), ridge);
  const coefY = leastSquares(rows, samples.map((s) => s.targetY), ridge);

  if (!coefX || !coefY) {
    return { ok: false, reason: 'The calibration fit was singular - the targets were too close together.' };
  }

  const calibration = {
    model,
    coefX,
    coefY,
    sampleCount: samples.length,
    targetCount: distinctTargets,
    createdAt: new Date().toISOString(),
    version: 1,
  };

  return { ok: true, calibration, quality: evaluateCalibration(calibration, samples) };
}

export function applyCalibration(calibration, sx, sy) {
  const b = basis(calibration.model, sx, sy);
  let x = 0;
  let y = 0;
  for (let i = 0; i < b.length; i++) {
    x += b[i] * calibration.coefX[i];
    y += b[i] * calibration.coefY[i];
  }
  return { x, y };
}

/**
 * Residual error of a calibration against a set of labelled samples.
 * Returned in centimetres because that is the unit the thesis tolerance is in.
 */
export function evaluateCalibration(calibration, samples) {
  const perTarget = new Map();
  let sumSq = 0;
  let max = 0;

  for (const s of samples) {
    const p = applyCalibration(calibration, s.sx, s.sy);
    const errPoints = Math.hypot(p.x - s.targetX, p.y - s.targetY);
    const errCm = pointsToCm(errPoints);
    sumSq += errCm * errCm;
    if (errCm > max) max = errCm;

    const key = s.targetIndex ?? `${s.targetX}|${s.targetY}`;
    if (!perTarget.has(key)) perTarget.set(key, { errors: [], targetX: s.targetX, targetY: s.targetY });
    perTarget.get(key).errors.push(errCm);
  }

  return {
    rmseCm: Math.sqrt(sumSq / samples.length),
    maxCm: max,
    sampleCount: samples.length,
    perTarget: [...perTarget.entries()].map(([key, v]) => ({
      key,
      targetX: v.targetX,
      targetY: v.targetY,
      meanCm: v.errors.reduce((a, b) => a + b, 0) / v.errors.length,
      maxCm: Math.max(...v.errors),
      samples: v.errors.length,
    })),
  };
}

/**
 * Drops the worst samples of every target group. Blinks, micro-saccades and the
 * moment the eye is still travelling towards the target all produce outliers
 * that would otherwise drag the fit.
 */
export function trimOutliers(samples, trimPercent = 0.25) {
  if (trimPercent <= 0) return samples;

  const groups = new Map();
  for (const s of samples) {
    const key = s.targetIndex ?? `${s.targetX}|${s.targetY}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const kept = [];
  for (const group of groups.values()) {
    const cx = median(group.map((s) => s.sx));
    const cy = median(group.map((s) => s.sy));
    const sorted = [...group].sort(
      (a, b) => Math.hypot(a.sx - cx, a.sy - cy) - Math.hypot(b.sx - cx, b.sy - cy)
    );
    const keepCount = Math.max(1, Math.round(sorted.length * (1 - trimPercent)));
    kept.push(...sorted.slice(0, keepCount));
  }
  return kept;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Calibration target layouts
// ---------------------------------------------------------------------------

/**
 * @param {object} config settings.calibration
 * @param {{width: number, height: number}} window
 * @returns {Array<{x: number, y: number}>} target centres in screen points
 */
export function buildTargets(config, window) {
  const margin = config.marginPercent ?? 0.12;
  const lo = margin;
  const hi = 1 - margin;
  const mid = 0.5;

  let normalized;
  if (Array.isArray(config.customPoints) && config.customPoints.length >= 3) {
    normalized = config.customPoints.map(([x, y]) => ({ x, y }));
  } else {
    switch (String(config.pattern)) {
      case '9':
        normalized = [];
        for (const y of [lo, mid, hi]) for (const x of [lo, mid, hi]) normalized.push({ x, y });
        break;
      case '13':
        normalized = [
          { x: mid, y: mid },
          { x: lo, y: lo }, { x: hi, y: lo }, { x: lo, y: hi }, { x: hi, y: hi },
          { x: mid, y: lo }, { x: mid, y: hi }, { x: lo, y: mid }, { x: hi, y: mid },
          { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.3, y: 0.7 }, { x: 0.7, y: 0.7 },
        ];
        break;
      case '5':
      default:
        normalized = [
          { x: mid, y: mid },
          { x: lo, y: lo },
          { x: hi, y: lo },
          { x: hi, y: hi },
          { x: lo, y: hi },
        ];
    }
  }

  return normalized.map((p) => ({ x: p.x * window.width, y: p.y * window.height }));
}
