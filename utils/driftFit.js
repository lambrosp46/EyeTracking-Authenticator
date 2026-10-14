/**
 * Drift-check fit: turns the landing offsets of the neutral drift dots into a
 * correction for the rest of the screen.
 *
 * Why not a single shift: pilot logs showed the leftover error grows with
 * height - the top dot landed 0.8-1.9 cm too low in every round while the
 * bottom dots landed ~0. A mean shift fixes only part of that at the top and
 * over-corrects the bottom, and the old "dots disagree" check threw the
 * measurement away exactly when the error was largest. So the vertical offset
 * is modelled as a line over height:
 *
 *     offsetY(y) = dy + b * (y - y0)        (y0 = mean height of the dots)
 *
 * i.e. a reported gaze  y' = y0 + (1 + b)(y - y0) + dy , which the tracker
 * inverts (useGazeTracker.setDriftCorrection). Horizontally the error was
 * small and flat, so x stays a plain shift unless fitXScale is on.
 *
 * All inputs/outputs are in screen points; `toCm` converts points to cm.
 *
 * @param {Array<null|{tx:number,ty:number,ox:number,oy:number}>} dots
 *        target position and measured offset (median gaze - target) per dot
 * @param {{top:number,bottom:number}} span  image top/bottom (points), where
 *        the correction size is evaluated
 * @param {object} cfg  settings.gazeConfirm.driftCheck
 * @param {(pts:number)=>number} toCm
 */
export function fitDriftCorrection(dots, span, cfg, toCm) {
  const ok = dots.filter(Boolean);
  const mode = cfg.mode ?? 'linearY';
  const minDots = cfg.minDots ?? 3;
  if (ok.length < Math.min(minDots, dots.length) || ok.length < 2) {
    return { ok: false, reason: `only ${ok.length}/${dots.length} dots measured` };
  }

  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const line = (ts, os) => {
    // least-squares slope of offset over position, around the mean position
    const t0 = mean(ts);
    const o0 = mean(os);
    let sxx = 0;
    let sxy = 0;
    ts.forEach((t, i) => {
      sxx += (t - t0) * (t - t0);
      sxy += (t - t0) * (os[i] - o0);
    });
    return { t0, o0, slope: sxx > 0 ? sxy / sxx : 0, range: Math.max(...ts) - Math.min(...ts) };
  };
  const maxScale = cfg.maxScaleChange ?? 0.3;
  const clampSlope = (s) => Math.max(-maxScale, Math.min(maxScale, s));
  // A slope needs dots at clearly different heights (or widths)
  const minRangePts = (cfg.minSpanCm ?? 3) / toCm(1);

  const ly = line(ok.map((d) => d.ty), ok.map((d) => d.oy));
  const lx = line(ok.map((d) => d.tx), ok.map((d) => d.ox));
  const useY = mode === 'linearY' && ok.length >= 3 && ly.range >= minRangePts;
  const useX = useY && cfg.fitXScale === true && lx.range >= minRangePts;
  const by = useY ? clampSlope(ly.slope) : 0;
  const bx = useX ? clampSlope(lx.slope) : 0;

  let dx = lx.o0;
  let dy = ly.o0;
  const predict = (d) => ({ x: dx + bx * (d.tx - lx.t0), y: dy + by * (d.ty - ly.t0) });

  // How well the model explains the dots. Large = the user was not looking at
  // one of them (or moved), and the correction would be a guess.
  const residualCm = toCm(
    Math.sqrt(mean(ok.map((d) => {
      const p = predict(d);
      return (d.ox - p.x) ** 2 + (d.oy - p.y) ** 2;
    })))
  );

  // Size of the correction where it is largest (top or bottom of the image)
  const at = (y) => Math.hypot(dx, dy + by * (y - ly.t0));
  let maxCm = toCm(Math.max(at(span.top), at(span.bottom)));

  // Cap the shift part; the slope is already capped.
  const maxPts = (cfg.maxCorrectionCm ?? 3) / toCm(1);
  const mag = Math.hypot(dx, dy);
  if (mag > maxPts) {
    dx *= maxPts / mag;
    dy *= maxPts / mag;
    maxCm = toCm(Math.max(at(span.top), at(span.bottom)));
  }

  return {
    ok: residualCm <= (cfg.maxResidualCm ?? 1.0),
    reason: residualCm <= (cfg.maxResidualCm ?? 1.0) ? null : `residual ${residualCm.toFixed(2)}cm`,
    residualCm,
    maxCm,
    slopeClamped: useY && by !== ly.slope,
    correction: {
      dx,
      dy,
      x0: lx.t0,
      y0: ly.t0,
      scaleX: 1 + bx,
      scaleY: 1 + by,
    },
  };
}

/** Human-readable summary for the session log. */
export function describeDrift(fit, toCm) {
  const c = fit.correction;
  const pct = (s) => `${s >= 1 ? '+' : ''}${((s - 1) * 100).toFixed(0)}%`;
  return (
    `shift dx ${toCm(-c.dx).toFixed(2)}cm dy ${toCm(-c.dy).toFixed(2)}cm` +
    ` · vertical scale ${pct(c.scaleY)}${c.scaleX !== 1 ? ` · horizontal scale ${pct(c.scaleX)}` : ''}` +
    ` · largest correction ${fit.maxCm.toFixed(2)}cm · residual ${fit.residualCm.toFixed(2)}cm`
  );
}
