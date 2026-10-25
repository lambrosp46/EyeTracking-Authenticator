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
  for (let a = 0; a < k; a++) AtA[a][a] += Array.isArray(ridge) ? ridge[a] : ridge;

  return solve(AtA, Atb);
}

// Raw sx/sy are metres (~0.01-0.1), so sx^2 terms are ~1e-4 and the normal
// equations mix magnitudes 4 orders apart: the ridge then shrinks the quadratic
// terms far more than the linear ones and the fit is badly conditioned.
// Centring and scaling the inputs first is the standard fix. Calibrations
// stored before this change have no `norm` and keep working unchanged.
function inputNorm(samples) {
  const n = samples.length;
  const mx = samples.reduce((a, s) => a + s.sx, 0) / n;
  const my = samples.reduce((a, s) => a + s.sy, 0) / n;
  const vx = samples.reduce((a, s) => a + (s.sx - mx) ** 2, 0) / n;
  const vy = samples.reduce((a, s) => a + (s.sy - my) ** 2, 0) / n;
  return { mx, my, kx: Math.max(Math.sqrt(vx), 1e-6), ky: Math.max(Math.sqrt(vy), 1e-6) };
}

// ---------------------------------------------------------------------------
// Head-pose compensation
// ---------------------------------------------------------------------------
// ARKit reports only ~30% of the real eye rotation, so the fit multiplies the
// raw signal by ~3 - and every small change of head pose with it (pilot: 3° of
// head pitch moved every point ~2.4 cm, almost all of it vertically). Adding
// the head pose as extra regressors lets the fit learn how much each degree /
// centimetre of head movement shifts the gaze, and subtract it at run time.
// That is only learnable if the calibration SAW the head in more than one pose,
// hence the second-pose pass in CalibrationOverlay; with one pose these terms
// are never offered (fitCalibration `allowHead`).
const RAD_TO_DEG = 180 / Math.PI;

/** [face yaw°, face pitch°, eye-midpoint x, y, z cm] from a raw sample, or null. */
export function headFeatures(s) {
  if (!s || s.headZCm == null || s.faceDirZ == null || s.faceDirX == null) return null;
  return [
    Math.atan2(s.faceDirX, s.faceDirZ) * RAD_TO_DEG,
    Math.atan2(s.faceDirY, s.faceDirZ) * RAD_TO_DEG,
    s.headXCm,
    s.headYCm,
    s.headZCm,
  ];
}

function normalizedBasis(calibration, sx, sy, sample = null) {
  const n = calibration.norm;
  const b = n
    ? basis(calibration.model, (sx - n.mx) / n.kx, (sy - n.my) / n.ky)
    : basis(calibration.model, sx, sy);
  if (!calibration.head) return b;
  // Missing pose (rare: a sample without a face anchor) -> the calibration's
  // mean pose, i.e. no correction rather than a wild one.
  const h = headFeatures(sample) ?? calibration.head.mean;
  for (let i = 0; i < h.length; i++) b.push(h[i] - calibration.head.mean[i]);
  return b;
}

/**
 * One least-squares fit of `model`, or null if singular.
 * headLambda != null adds the head terms, ridge-regularised by headLambda per
 * sample (in units of deg / cm) so they stay small unless the data needs them.
 */
function fitModel(samples, model, ridge, headLambda = null) {
  let rows = samples;
  let head = null;
  if (headLambda != null) {
    rows = samples.filter((s) => headFeatures(s) != null);
    if (rows.length < samples.length * 0.9) return null;
    const hs = rows.map(headFeatures);
    const mean = hs[0].map((_, i) => hs.reduce((a, h) => a + h[i], 0) / hs.length);
    head = { mean, lambda: headLambda };
  }
  const norm = inputNorm(rows);
  const probe = { model, norm, head };
  const A = rows.map((s) => normalizedBasis(probe, s.sx, s.sy, s));
  const ridgeVec = A[0].map((_, i) => (head && i >= basisSize(model) ? headLambda * rows.length : ridge));
  const coefX = leastSquares(A, rows.map((s) => s.targetX), ridgeVec);
  const coefY = leastSquares(A, rows.map((s) => s.targetY), ridgeVec);
  if (!coefX || !coefY) return null;
  return head ? { model, norm, head, coefX, coefY } : { model, norm, coefX, coefY };
}

/** 'quadratic+head' etc., for logs and the result screen. */
export const modelLabel = (calibration) =>
  `${calibration.model}${calibration.head ? '+head' : ''}${calibration.prior ? ' (+shared pose model)' : ''}`;

const targetKey = (s) => s.targetIndex ?? `${s.targetX}|${s.targetY}`;

function groupByTarget(samples) {
  const groups = new Map();
  for (const s of samples) {
    const key = targetKey(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return groups;
}

/** Where a group of samples lands on average, and how far that is from its target. */
function meanOffset(calibration, group) {
  let x = 0;
  let y = 0;
  for (const s of group) {
    const p = applyCalibration(calibration, s.sx, s.sy, s);
    x += p.x;
    y += p.y;
  }
  x /= group.length;
  y /= group.length;
  const dxCm = pointsToCm(x - group[0].targetX);
  const dyCm = pointsToCm(y - group[0].targetY);
  return { dxCm, dyCm, errCm: Math.hypot(dxCm, dyCm) };
}

/**
 * Leave-one-target-out cross-validation: fit on all targets but one, measure
 * where the left-out target lands. This is the honest estimate of the error at
 * a point the fit has never seen - which is exactly what a password point is.
 * The in-sample rmseCm is always optimistic, and more so the more terms the
 * model has (a quadratic on 9 targets can look good and still be off by
 * centimetres between them).
 *
 * The error is of the MEAN landing point per target (what a dwell capture
 * produces), not per sample, so sample noise does not inflate it.
 */
export function crossValidateTargets(samples, model, ridge = 1e-6, headLambda = null) {
  const groups = groupByTarget(samples);
  if (groups.size < basisSize(model) + 1) return null;

  const perTarget = [];
  for (const [key, group] of groups) {
    const train = samples.filter((s) => targetKey(s) !== key);
    const fit = fitModel(train, model, ridge, headLambda);
    if (!fit) return null;
    perTarget.push({ key, targetX: group[0].targetX, targetY: group[0].targetY, ...meanOffset(fit, group) });
  }
  const sq = perTarget.reduce((a, t) => a + t.errCm ** 2, 0) / perTarget.length;
  return {
    rmseCm: Math.sqrt(sq),
    maxCm: Math.max(...perTarget.map((t) => t.errCm)),
    perTarget,
  };
}

/**
 * @param {Array<{sx: number, sy: number, targetX: number, targetY: number, targetIndex?: number}>} samples
 * @param {object} config settings.calibration
 *   config.model: 'affine' | 'quadratic' | 'auto' (= whichever has the lower
 *   leave-one-target-out error)
 * @returns {{ok: boolean, reason?: string, calibration?: object, quality?: object}}
 */
export function fitCalibration(rawSamples, config = {}) {
  const ridge = config.ridge ?? 1e-6;
  // Shared head-pose model (config.headPrior): its correction is taken out of
  // the targets before fitting and added back in applyCalibration, so the fit
  // (and the per-user head terms, if any) only learn what is left - this
  // user's deviation from the shared model.
  const prior = makeHeadPrior(config.headPrior, rawSamples);
  const samples = prior
    ? rawSamples.map((s) => {
        const d = priorShift(prior, s);
        return { ...s, targetX: s.targetX - d.x, targetY: s.targetY - d.y };
      })
    : rawSamples;
  const requested = config.model ?? 'affine';

  const distinctTargets = groupByTarget(samples).size;
  let candidates = requested === 'auto' ? ['affine', 'quadratic'] : [requested];
  // not enough targets to constrain the quadratic terms
  candidates = candidates.filter((m) => m !== 'quadratic' || distinctTargets >= 6);
  if (candidates.length === 0) candidates = ['affine'];

  if (samples.length < basisSize(candidates[0]) || distinctTargets < 3) {
    return { ok: false, reason: 'Δεν συλλέχθηκαν αρκετά έγκυρα δείγματα. Δοκίμασε ξανά και μείνε ακίνητος.' };
  }

  // Head-compensated variants only when the samples contain a second head
  // pose (allowHead); with one pose those terms cannot be learnt and only overfit.
  const headLambda = config.headCompensation?.lambda ?? 0.01;
  const variants = [];
  for (const model of candidates) {
    variants.push({ model, headLambda: null });
    if (config.allowHead && config.headCompensation?.enabled !== false) variants.push({ model, headLambda });
  }

  const tried = [];
  for (const v of variants) {
    const fit = fitModel(samples, v.model, ridge, v.headLambda);
    if (!fit) continue;
    tried.push({ model: modelLabel(fit), fit, loo: crossValidateTargets(samples, v.model, ridge, v.headLambda) });
  }
  if (tried.length === 0) {
    return { ok: false, reason: 'Το fit ήταν singular — οι στόχοι ήταν πολύ κοντά μεταξύ τους.' };
  }

  // Lowest cross-validated error wins; a model that could not be validated
  // only wins if nothing else could be either.
  tried.sort((a, b) => (a.loo?.rmseCm ?? Infinity) - (b.loo?.rmseCm ?? Infinity));
  const best = tried[0];

  const calibration = {
    ...best.fit,
    ...(prior ? { prior } : {}),
    sampleCount: samples.length,
    targetCount: distinctTargets,
    createdAt: new Date().toISOString(),
    version: 2,
  };

  // against the REAL targets (applyCalibration adds the prior back); the LOO
  // offsets above are the same in both spaces, the prior shift cancels out
  const quality = evaluateCalibration(calibration, rawSamples);
  quality.loo = best.loo;
  quality.modelSelection = tried.map((t) => ({ model: t.model, looRmseCm: t.loo?.rmseCm ?? null }));

  return { ok: true, calibration, quality };
}

/** `sample` carries the head pose; used by head-compensated calibrations and the shared head prior. */
export function applyCalibration(calibration, sx, sy, sample = null) {
  const b = normalizedBasis(calibration, sx, sy, sample);
  let x = 0;
  let y = 0;
  for (let i = 0; i < b.length; i++) {
    x += b[i] * calibration.coefX[i];
    y += b[i] * calibration.coefY[i];
  }
  if (calibration.prior) {
    const d = priorShift(calibration.prior, sample);
    x += d.x;
    y += d.y;
  }
  return { x, y };
}

/**
 * Shared head-pose model (settings.calibration.headPrior): how far the mapped
 * point moves, in cm, per unit change of [face yaw °, face pitch °, eye-midpoint
 * x, y, z cm] (headFeatures), learnt across many calibrations. It corrects for
 * pose changes even for a user whose own calibration cannot (one pose, or a
 * second pose too close to the first). Centred on this calibration's mean pose.
 */
function makeHeadPrior(cfg, samples) {
  if (!cfg || cfg.enabled !== true) return null;
  const cx = cfg.coefXCmPerUnit;
  const cy = cfg.coefYCmPerUnit;
  if (!Array.isArray(cx) || !Array.isArray(cy) || cx.length !== 5 || cy.length !== 5) return null;
  const hs = samples.map(headFeatures).filter(Boolean);
  if (hs.length < samples.length * 0.9) return null;
  const mean = hs[0].map((_, i) => hs.reduce((a, h) => a + h[i], 0) / hs.length);
  return { mean, coefX: cx.map(cmToPoints), coefY: cy.map(cmToPoints) };
}

function priorShift(prior, sample) {
  // no pose for this sample -> the mean pose, i.e. no correction
  const h = headFeatures(sample) ?? prior.mean;
  let x = 0;
  let y = 0;
  for (let i = 0; i < h.length; i++) {
    x += (h[i] - prior.mean[i]) * prior.coefX[i];
    y += (h[i] - prior.mean[i]) * prior.coefY[i];
  }
  return { x, y };
}

/**
 * Error of a calibration against a set of labelled samples, in centimetres
 * because that is the unit the thesis tolerance is in.
 *
 *   rmseCm       per-sample error (includes sample noise)
 *   pointRmseCm  error of the MEAN landing point per target - what a dwell
 *                capture sees, so this is the one to compare with
 *                matchToleranceCm
 *   perTarget[i].dxCm / dyCm  signed offset of that target (+ = right / down):
 *                the same direction everywhere = a shift (posture/drift),
 *                different directions = a mapping (model) problem
 */
export function evaluateCalibration(calibration, samples) {
  let sumSq = 0;
  let max = 0;

  for (const s of samples) {
    const p = applyCalibration(calibration, s.sx, s.sy, s);
    const errCm = pointsToCm(Math.hypot(p.x - s.targetX, p.y - s.targetY));
    sumSq += errCm * errCm;
    if (errCm > max) max = errCm;
  }

  const perTarget = [];
  for (const [key, group] of groupByTarget(samples)) {
    const errors = group.map((s) => {
      const p = applyCalibration(calibration, s.sx, s.sy, s);
      return pointsToCm(Math.hypot(p.x - s.targetX, p.y - s.targetY));
    });
    perTarget.push({
      key,
      targetX: group[0].targetX,
      targetY: group[0].targetY,
      meanCm: errors.reduce((a, b) => a + b, 0) / errors.length,
      maxCm: Math.max(...errors),
      samples: group.length,
      ...meanOffset(calibration, group),
    });
  }

  return {
    rmseCm: Math.sqrt(sumSq / samples.length),
    maxCm: max,
    pointRmseCm: Math.sqrt(perTarget.reduce((a, t) => a + t.errCm ** 2, 0) / perTarget.length),
    sampleCount: samples.length,
    perTarget,
  };
}

/** Console table of a calibration result - per target, signed offsets. */
export function logCalibrationQuality(tag, quality, model) {
  const f = (v) => (v == null ? '  –  ' : (v >= 0 ? ' ' : '') + v.toFixed(2));
  console.log(
    `[${tag}] model ${model} · samples ${quality.sampleCount} · per-sample RMSE ${quality.rmseCm.toFixed(2)}cm` +
      ` · per-point RMSE ${quality.pointRmseCm.toFixed(2)}cm` +
      (quality.loo ? ` · LOO (new points) RMSE ${quality.loo.rmseCm.toFixed(2)}cm max ${quality.loo.maxCm.toFixed(2)}cm` : '') +
      (quality.modelSelection?.length > 1
        ? ` · tried ${quality.modelSelection.map((m) => `${m.model}=${m.looRmseCm?.toFixed(2) ?? '–'}`).join(' ')}`
        : '')
  );
  const loo = new Map((quality.loo?.perTarget ?? []).map((t) => [t.key, t]));
  quality.perTarget.forEach((t, i) => {
    const l = loo.get(t.key);
    console.log(
      `[${tag}]   point ${i + 1} @(${Math.round(t.targetX)},${Math.round(t.targetY)})pt` +
        `  fit dx ${f(t.dxCm)} dy ${f(t.dyCm)} = ${t.errCm.toFixed(2)}cm` +
        (l ? `   LOO dx ${f(l.dxCm)} dy ${f(l.dyCm)} = ${l.errCm.toFixed(2)}cm` : '')
    );
  });
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
      case '12':
        // 3 columns x 4 rows: vertical is where ARKit is worst and where the
        // error bends, and 3 rows cannot tell a bend from noise.
        normalized = [];
        for (const y of [lo, lo + (hi - lo) / 3, lo + (2 * (hi - lo)) / 3, hi]) {
          for (const x of [lo, mid, hi]) normalized.push({ x, y });
        }
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
