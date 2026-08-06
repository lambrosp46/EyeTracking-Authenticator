/**
 * 1 Euro filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * Chosen over a fixed low-pass / EMA because gaze has two conflicting needs:
 * a still gaze must not jitter, but a saccade must not lag. The 1 Euro filter
 * adapts its cutoff frequency to the signal speed, so it smooths hard when the
 * eye is fixating and barely smooths at all when the eye jumps.
 *
 *   minCutoff  lower  -> steadier when still, more lag
 *   beta       higher -> reacts faster to saccades, more jitter
 */

const TWO_PI = 2 * Math.PI;

function alpha(cutoff, dt) {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  constructor() {
    this.value = null;
  }
  filter(x, a) {
    this.value = this.value === null ? x : a * x + (1 - a) * this.value;
    return this.value;
  }
  reset() {
    this.value = null;
  }
}

class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.007, derivativeCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = derivativeCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
    this.lastRaw = null;
  }

  /** @param {number} value @param {number} timestampSeconds */
  filter(value, timestampSeconds) {
    let dt = 1 / 30;
    if (this.lastTime !== null) {
      const d = timestampSeconds - this.lastTime;
      if (d > 0 && d < 1) dt = d;
    }
    this.lastTime = timestampSeconds;

    const rate = this.lastRaw === null ? 0 : (value - this.lastRaw) / dt;
    this.lastRaw = value;

    const edx = this.dx.filter(rate, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
    this.lastRaw = null;
  }
}

/** Exponential moving average, kept as a simpler baseline for the thesis comparison. */
class Ema {
  constructor(alphaValue = 0.35) {
    this.alpha = alphaValue;
    this.value = null;
  }
  filter(x) {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
  reset() {
    this.value = null;
  }
}

/** 2D wrapper used by the gaze hook. */
export class GazeFilter2D {
  /** @param {{type?: 'oneEuro'|'ema'|'none', minCutoff?: number, beta?: number, derivativeCutoff?: number, emaAlpha?: number}} config */
  constructor(config = {}) {
    this.type = config.type ?? 'oneEuro';
    if (this.type === 'oneEuro') {
      this.fx = new OneEuro(config);
      this.fy = new OneEuro(config);
    } else if (this.type === 'ema') {
      this.fx = new Ema(config.emaAlpha);
      this.fy = new Ema(config.emaAlpha);
    }
  }

  filter(x, y, timestampSeconds) {
    if (this.type === 'none') return { x, y };
    if (this.type === 'ema') {
      return { x: this.fx.filter(x), y: this.fy.filter(y) };
    }
    return {
      x: this.fx.filter(x, timestampSeconds),
      y: this.fy.filter(y, timestampSeconds),
    };
  }

  reset() {
    this.fx?.reset();
    this.fy?.reset();
  }
}

export { OneEuro, Ema };
