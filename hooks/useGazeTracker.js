import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Dimensions } from 'react-native';

import * as GazeTracker from '../modules/gaze-tracker';
import settings from '../config/settings.json';
import { GazeFilter2D } from '../utils/oneEuroFilter';
import { writeToLogFile } from '../utils/sessionLog';
import {
  applyCalibration,
  clampToScreen,
  modelLabel,
  pointsToCm,
  rawToScreenPoints,
} from '../utils/gazeMapping';
import {
  evaluatePositioning,
  hasReferencePose,
  headMetrics,
  referenceConfig,
  screenGeometry,
  smoothMetrics,
} from '../utils/headPose';

const OFFSCREEN = -9999;

/**
 * Gaze stream: every native sample, valid or not, while a screen records
 * (startStream ... stopStream). Columns: STREAM_BASE, then RAW_EXTRAS.
 *   valid   1 = the sample was used for gaze, 0 = rejected (blink, no face,
 *           out of range, or blocked by the pose lock)
 *   locked  1 = the pose lock was blocking samples
 *   fx, fy  calibrated point BEFORE the drift correction (window points)
 *   x, y    final point (drift correction + smoothing), what the screen used
 * With the calibration data dump this is enough to replay a whole login
 * offline with any calibration model, drift algorithm or capture rule.
 */
const STREAM_BASE = ['timestamp', 'valid', 'locked', 'sx', 'sy', 'fx', 'fy', 'x', 'y'];
const STREAM_POINT_KEYS = new Set(['fx', 'fy', 'x', 'y']);
// Module level, not per hook: every screen has its own tracker hook, and the
// ids must stay unique for the whole app session (one log file).
let streamCounter = 0;

/** Native sample fields copied into calibration samples, for the data dump. */
export const RAW_EXTRAS = [
  'leftSx', 'leftSy', 'rightSx', 'rightSy', 'altSx', 'altSy',
  'blinkLeft', 'blinkRight',
  'lookUpL', 'lookUpR', 'lookDownL', 'lookDownR', 'lookInL', 'lookInR',
  'lookOutL', 'lookOutR', 'squintL', 'squintR', 'wideL', 'wideR',
  'distanceCm', 'headXCm', 'headYCm', 'headZCm', 'faceDirX', 'faceDirY', 'faceDirZ', 'headRollDeg',
  'deviceTiltDeg', 'interEyeCm',
];

/**
 * Owns one ARKit gaze session.
 *
 * Gaze arrives at ~30 Hz. Re-rendering React at that rate would drop frames, so
 * the cursor position is written into Animated.Values (no re-render) and only
 * coarse status - tracking / face lost / distance - goes through useState, and
 * even that is throttled.
 */
export function useGazeTracker(options = {}) {
  const { autoStart = false, onSample: onSampleCallback } = options;

  const cfg = settings.eyeTracking;
  const validity = cfg.validity;

  const window = useMemo(() => Dimensions.get('window'), []);

  // --- animated outputs (never trigger a React render) ---
  const position = useRef(new Animated.ValueXY({ x: OFFSCREEN, y: OFFSCREEN })).current;
  const rawPosition = useRef(new Animated.ValueXY({ x: OFFSCREEN, y: OFFSCREEN })).current;
  const visibility = useRef(new Animated.Value(0)).current;

  // --- coarse UI state ---
  const [supported] = useState(() => GazeTracker.isSupported());
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | searching | tracking | interrupted | error
  const [error, setError] = useState(null);
  const [calibration, setCalibrationState] = useState(null);
  const [readout, setReadout] = useState({
    x: null, y: null, sx: null, sy: null,
    distanceCm: null, eyesOpen: true, valid: false, hz: 0,
  });

  // --- refs ---
  const filterRef = useRef(new GazeFilter2D(cfg.filter));
  const calibrationRef = useRef(null);
  const collectingRef = useRef(null);
  const latestRef = useRef(null);
  // Latest head/device pose, kept apart from latestRef because it is needed even
  // when the gaze sample itself is invalid (that is when the positioning guide
  // matters most). { sample, receivedAt } or null when no face is in view.
  const headRef = useRef(null);
  // Last raw sample of any kind, plus a counter - for diagnostics only
  // (lets the positioning screen tell "no samples" from "samples without pose").
  const lastSampleRef = useRef(null);
  const sampleCountRef = useRef(0);
  const lastPoseLogRef = useRef(0);
  // Pose lock: while active, gaze samples count only if the head is still in
  // the pose the calibration was made in (calibration.pose). Off by default;
  // screens switch it on for the stretch where accuracy matters (login gaze,
  // accuracy check) via setPoseLockActive.
  // Drift correction measured by the drift check (GazePointConfirm): an
  // offset plus (optionally) a vertical scale, in screen points, removed from
  // every mapped sample. See setDriftCorrection.
  const driftRef = useRef(null);
  const poseLockActiveRef = useRef(false);
  const poseLockRef = useRef({ locked: false, okSince: null, since: 0, smoothed: null });
  const [poseLock, setPoseLockState] = useState({ locked: false, issue: null });
  const geom = useMemo(() => screenGeometry(cfg.screen, window, pointsToCm), [window, cfg.screen]);
  const lastReadoutRef = useRef(0);
  const rateRef = useRef({ count: 0, since: 0, hz: 0 });
  // Gaze stream recording (see STREAM_BASE): { id, rows, lastTimestamp } or null
  const streamRef = useRef(null);

  // ---------------------------------------------------------------- MARK: sample
  const handleSample = useCallback(
    (sample) => {
      lastSampleRef.current = sample;
      sampleCountRef.current += 1;

      // Head pose first, before any validity check can return early.
      if (sample.headZCm != null) {
        headRef.current = sample.isTracked ? { sample, receivedAt: Date.now() } : null;
        logPoseDrift(sample);
      }
      const poseBlocked = updatePoseLock(sample);

      // sampling rate, useful to confirm the native throttle is behaving
      const rate = rateRef.current;
      rate.count += 1;
      if (rate.since === 0) rate.since = sample.timestamp;
      const elapsed = sample.timestamp - rate.since;
      if (elapsed >= 1) {
        rate.hz = Math.round(rate.count / elapsed);
        rate.count = 0;
        rate.since = sample.timestamp;
      }

      const distanceOk =
        sample.distanceCm == null ||
        (sample.distanceCm >= validity.minFaceDistanceCm &&
          sample.distanceCm <= validity.maxFaceDistanceCm);

      const disparityOk =
        sample.eyeDisparityCm == null ||
        validity.maxEyeDisparityCm == null ||
        sample.eyeDisparityCm <= validity.maxEyeDisparityCm;

      const eyesOk = validity.requireBothEyes ? sample.eyesOpen : sample.hasHit;

      const valid =
        sample.isTracked && sample.hasHit && eyesOk && distanceOk && disparityOk && !poseBlocked;

      if (!valid) {
        visibility.setValue(0);
        filterRef.current.reset();
        latestRef.current = { ...latestRef.current, valid: false, timestamp: sample.timestamp };
        maybePublishReadout(sample, null, false);
        recordStream(sample, false, poseBlocked, null, null);
        onSampleCallback?.({ ...sample, valid: false });
        return;
      }

      // raw (uncalibrated) point, always computed so the debug ghost has something
      const raw = rawToScreenPoints(sample.sx, sample.sy, cfg.screen, window);

      const fitted = calibrationRef.current
        ? applyCalibration(calibrationRef.current, sample.sx, sample.sy, sample)
        : raw;
      const drift = driftRef.current;
      const mapped = drift
        ? {
            x: drift.x0 + (fitted.x - drift.x0 - drift.dx) / drift.scaleX,
            y: drift.y0 + (fitted.y - drift.y0 - drift.dy) / drift.scaleY,
          }
        : fitted;

      const smoothed = filterRef.current.filter(mapped.x, mapped.y, sample.timestamp);
      const final = validity.clampToScreen ? clampToScreen(smoothed, window) : smoothed;

      position.setValue(final);
      rawPosition.setValue(validity.clampToScreen ? clampToScreen(raw, window) : raw);
      visibility.setValue(1);

      latestRef.current = {
        x: final.x,
        y: final.y,
        rawX: raw.x,
        rawY: raw.y,
        sx: sample.sx,
        sy: sample.sy,
        distanceCm: sample.distanceCm,
        timestamp: sample.timestamp,
        valid: true,
      };

      if (collectingRef.current) {
        const kept = {
          sx: sample.sx,
          sy: sample.sy,
          x: final.x,
          y: final.y,
          timestamp: sample.timestamp,
        };
        // Raw extras for the calibration data dump (offline model comparison).
        for (const key of RAW_EXTRAS) if (sample[key] != null) kept[key] = sample[key];
        collectingRef.current.push(kept);
      }

      maybePublishReadout(sample, final, true);
      recordStream(sample, true, poseBlocked, fitted, final);
      onSampleCallback?.({ ...sample, valid: true, point: final });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window.width, window.height, onSampleCallback]
  );

  // ---------------------------------------------------------- MARK: gaze stream
  const streamCfg = settings.eyeTracking?.streamLog ?? {};
  const STREAM_CHUNK = streamCfg.chunkRows ?? 40;
  const roundStream = (key, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return STREAM_POINT_KEYS.has(key) ? Math.round(v * 10) / 10 : Math.round(v * 1e5) / 1e5;
  };
  const flushStream = () => {
    const st = streamRef.current;
    if (!st || st.rows.length === 0) return;
    writeToLogFile(`[GazeStream] rows ${st.id} ${JSON.stringify(st.rows)}`);
    st.rows = [];
  };
  const recordStream = (sample, valid, locked, fitted, final) => {
    const st = streamRef.current;
    if (!st) return;
    const row = [
      roundStream('timestamp', sample.timestamp),
      valid ? 1 : 0,
      locked ? 1 : 0,
      roundStream('sx', sample.sx),
      roundStream('sy', sample.sy),
      roundStream('fx', fitted?.x),
      roundStream('fy', fitted?.y),
      roundStream('x', final?.x),
      roundStream('y', final?.y),
    ];
    for (const key of RAW_EXTRAS) row.push(roundStream(key, sample[key]));
    st.rows.push(row);
    st.lastTimestamp = sample.timestamp;
    if (st.rows.length >= STREAM_CHUNK) flushStream();
  };
  // Once a second: how far the head has moved since the calibration was fitted.
  // A calibration only holds for the pose it was made in, so this is the first
  // thing to look at when the cursor lands off target. Pose only - no gaze.
  const logPoseDrift = (sample) => {
    const ref = calibrationRef.current?.pose;
    if (!settings.positioning?.logDiagnostics || !ref || ref.distanceCm == null) return;
    const now = Date.now();
    if (now - lastPoseLogRef.current < (settings.positioning.logIntervalMs ?? 1000)) return;
    lastPoseLogRef.current = now;
    const m = headMetrics(sample, geom);
    if (!m) return;
    const d = (a, b, digits = 1) => {
      const v = a - b;
      return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
    };
    console.log(
      `[PoseDrift] since calibration: d ${d(m.distanceCm, ref.distanceCm)}cm` +
        ` x ${d(m.eyeXFromCenterCm, ref.eyeXFromCenterCm)}cm y ${d(m.eyeYFromTopCm, ref.eyeYFromTopCm)}cm` +
        ` · yaw ${d(m.yawDeg, ref.yawDeg, 0)}° pitch ${d(m.pitchDeg, ref.pitchDeg, 0)}° roll ${d(m.rollDeg, ref.rollDeg, 0)}°` +
        (m.deviceTiltDeg != null && ref.deviceTiltDeg != null
          ? ` · tilt ${d(m.deviceTiltDeg, ref.deviceTiltDeg, 0)}°`
          : '')
    );
  };

  /**
   * Returns true while the pose lock is engaged (= this sample must not count).
   *
   * Hysteresis, deliberately asymmetric: the lock ENGAGES only when the pose
   * leaves the widened (exit) limits, and RELEASES only after the pose has been
   * back inside the strict (entry) limits for poseLock.holdStillMs. So sensor
   * noise near the edge does not toggle it.
   */
  const updatePoseLock = (sample) => {
    const lockCfg = settings.positioning?.poseLock;
    const ref = calibrationRef.current?.pose;
    if (!poseLockActiveRef.current || !hasReferencePose(calibrationRef.current)) return false;

    // The smoothed pose is measured even with the lock disabled: the drift
    // re-check on pose change (GazePointConfirm) runs on it.
    const st = poseLockRef.current;
    const m = sample.isTracked && sample.headZCm != null ? headMetrics(sample, geom) : null;
    st.smoothed = m ? smoothMetrics(st.smoothed, m, settings.positioning.smoothing ?? 1) : null;
    if (!lockCfg?.enabled) return false; // measure only: never blocks, never asks to go back
    const rcfg = referenceConfig(settings.positioning, ref);
    const now = Date.now();

    if (!st.locked) {
      const v = evaluatePositioning(st.smoothed, rcfg, true);
      if (!v.ok) {
        st.locked = true;
        st.since = now;
        st.okSince = null;
        setPoseLockState({ locked: true, issue: v.primary });
        if (settings.positioning.logDiagnostics) {
          const p = st.smoothed?.pitchDeg;
          const win = rcfg.pitchRangeDeg
            ? ` · allowed ${rcfg.pitchRangeDeg[0].toFixed(1)}…${rcfg.pitchRangeDeg[1].toFixed(1)}°`
            : '';
          console.log(`[PoseLock] locked: ${v.issues.join(',')}${p != null ? ` (pitch ${p.toFixed(1)}°${win})` : ''}`);
        }
      }
    } else {
      const v = evaluatePositioning(st.smoothed, rcfg, false);
      if (!v.ok) {
        st.okSince = null;
      } else {
        if (st.okSince == null) st.okSince = now;
        if (now - st.okSince >= rcfg.holdStillMs) {
          st.locked = false;
          setPoseLockState({ locked: false, issue: null });
          if (settings.positioning.logDiagnostics) console.log(`[PoseLock] released after ${now - st.since}ms`);
        }
      }
    }
    return st.locked;
  };

  /** Switch the pose lock on/off. Always starts unlocked. */
  const setPoseLockActive = useCallback((on) => {
    poseLockActiveRef.current = !!on;
    poseLockRef.current = { locked: false, okSince: null, since: 0, smoothed: null };
    setPoseLockState({ locked: false, issue: null });
  }, []);
  const isPoseLockActive = useCallback(() => poseLockActiveRef.current, []);
  /**
   * Smoothed head pose (headPose.headMetrics units) while the pose lock is
   * active (setPoseLockActive), else null - also when poseLock.enabled is
   * false: then the pose is only measured, nothing is blocked.
   */
  const getPoseMetrics = useCallback(
    () => (poseLockActiveRef.current ? poseLockRef.current.smoothed : null),
    []
  );

  const maybePublishReadout = useCallback((sample, point, valid) => {
    const now = Date.now();
    if (now - lastReadoutRef.current < (cfg.debugReadoutIntervalMs ?? 200)) return;
    lastReadoutRef.current = now;
    setReadout({
      x: point ? Math.round(point.x) : null,
      y: point ? Math.round(point.y) : null,
      sx: sample.sx ?? null,
      sy: sample.sy ?? null,
      distanceCm: sample.distanceCm ?? null,
      eyesOpen: sample.eyesOpen,
      blinkLeft: sample.blinkLeft,
      blinkRight: sample.blinkRight,
      eyeDisparityCm: sample.eyeDisparityCm ?? null,
      valid,
      hz: rateRef.current.hz,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- MARK: listeners
  useEffect(() => {
    const gaze = GazeTracker.addGazeListener(handleSample);
    const state = GazeTracker.addTrackingStateListener((e) => {
      switch (e.state) {
        case 'started': setStatus('searching'); setRunning(true); break;
        case 'stopped': setStatus('idle'); setRunning(false); visibility.setValue(0); headRef.current = null; break;
        case 'faceFound': setStatus('tracking'); break;
        case 'faceLost': setStatus('searching'); visibility.setValue(0); headRef.current = null; break;
        case 'interrupted': setStatus('interrupted'); visibility.setValue(0); headRef.current = null; break;
        case 'resumed': setStatus('searching'); break;
        default: break;
      }
    });
    const errors = GazeTracker.addErrorListener((e) => {
      setError(e.message);
      setStatus('error');
      setRunning(false);
    });

    return () => {
      gaze.remove();
      state.remove();
      errors.remove();
    };
  }, [handleSample]);

  // ---------------------------------------------------------------- MARK: control
  const start = useCallback(async () => {
    setError(null);

    if (!GazeTracker.isNativeModuleAvailable) {
      setError(
        'Native module not loaded. This needs a development build on a physical device - Expo Go cannot run ARKit.'
      );
      setStatus('error');
      return false;
    }
    if (!GazeTracker.isSupported()) {
      setError('This device has no TrueDepth camera, so ARKit face tracking is unavailable.');
      setStatus('error');
      return false;
    }

    if (GazeTracker.getCameraPermissionStatus() !== 'granted') {
      const granted = await GazeTracker.requestCameraPermission();
      if (!granted) {
        setError('Camera access is required for eye tracking. Enable it in Settings > Privacy > Camera.');
        setStatus('error');
        return false;
      }
    }

    filterRef.current.reset();
    rateRef.current = { count: 0, since: 0, hz: 0 };

    try {
      await GazeTracker.start({
        updateIntervalMs: cfg.updateIntervalMs,
        rayMode: cfg.rayMode,
        useLeftEye: cfg.useLeftEye,
        useRightEye: cfg.useRightEye,
        blinkThreshold: validity.blinkThreshold,
      });
      setRunning(true);
      return true;
    } catch (e) {
      setError(String(e.message ?? e));
      setStatus('error');
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async () => {
    await GazeTracker.stop();
    setRunning(false);
    setStatus('idle');
    visibility.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // stop the session when the app is backgrounded, ARKit cannot run there anyway
  useEffect(() => {
    if (!cfg.autoStopOnBackground) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && GazeTracker.isRunning()) stop();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  useEffect(() => {
    if (autoStart) start();
    return () => { GazeTracker.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- MARK: calibration
  // Calibration lives in memory only, for this screen's session. It is never
  // written to or read from the device: every registration, login and test
  // session starts with a calibration of its own.

  /**
   * Set (or clear with null) the drift correction, in screen points.
   *   { dx, dy }                       - a plain shift (as before)
   *   { dx, dy, scaleY, y0 }           - plus a vertical scale around y0
   *   { dx, dy, scaleX, x0, scaleY, y0 }
   * Meaning of the model (measured by the drift check): a gaze that truly
   * lands at y is reported at  y0 + scaleY*(y - y0) + dy.  The hook inverts it.
   */
  const setDriftCorrection = useCallback((d) => {
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    driftRef.current =
      d && Number.isFinite(d.dx) && Number.isFinite(d.dy)
        ? {
            dx: d.dx,
            dy: d.dy,
            scaleX: num(d.scaleX, 1),
            scaleY: num(d.scaleY, 1),
            x0: num(d.x0, 0),
            y0: num(d.y0, 0),
          }
        : null;
    filterRef.current.reset();
  }, []);

  const setCalibration = useCallback(async (c) => {
    driftRef.current = null; // a drift correction belongs to the calibration it was measured on
    calibrationRef.current = c;
    setCalibrationState(c);
    filterRef.current.reset();
  }, []);

  const resetCalibration = useCallback(async () => {
    calibrationRef.current = null;
    setCalibrationState(null);
    filterRef.current.reset();
  }, []);

  /**
   * Start recording the gaze stream (to the log file only). `meta` should say
   * which screen and what the image rect is; the calibration in use and the
   * drift correction are added here. Returns the stream id, or null when
   * disabled. A running stream is closed first.
   */
  const startStream = useCallback((label, meta = {}) => {
    if (streamCfg.enabled !== true) return null;
    if (streamRef.current) stopStream('replaced');
    streamCounter += 1;
    const id = `${label}-${streamCounter}`;
    const c = calibrationRef.current;
    writeToLogFile(
      `[GazeStream] start ${id} ${JSON.stringify({
        id,
        at: new Date().toISOString(),
        window: { width: window.width, height: window.height },
        keys: [...STREAM_BASE, ...RAW_EXTRAS],
        calibration: c ? { model: modelLabel(c), looCm: c.quality?.loo?.rmseCm ?? null, pose: c.pose ?? null } : null,
        drift: driftRef.current,
        poseLockActive: poseLockActiveRef.current,
        ...meta,
      })}`
    );
    streamRef.current = { id, rows: [], lastTimestamp: latestRef.current?.timestamp ?? null };
    return id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window.width, window.height]);

  /**
   * Something happened on screen (a drift dot, a capture, a correction...).
   * `t` is the timestamp of the last recorded sample (same clock as the rows),
   * so offline the event can be placed exactly in the stream.
   */
  const streamEvent = useCallback((type, data = {}) => {
    const st = streamRef.current;
    if (!st) return;
    flushStream(); // rows before the event stay before it in the file
    writeToLogFile(`[GazeStream] event ${st.id} ${JSON.stringify({ type, t: st.lastTimestamp, at: Date.now(), ...data })}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = useCallback((reason = 'stop') => {
    const st = streamRef.current;
    if (!st) return;
    flushStream();
    writeToLogFile(`[GazeStream] end ${st.id} ${JSON.stringify({ reason, t: st.lastTimestamp, at: Date.now() })}`);
    streamRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start buffering raw samples (used by the calibration overlay). */
  const beginCollect = useCallback(() => {
    collectingRef.current = [];
  }, []);

  /** Stop buffering and return everything captured since beginCollect(). */
  const endCollect = useCallback(() => {
    const samples = collectingRef.current ?? [];
    collectingRef.current = null;
    return samples;
  }, []);

  return {
    // capability
    supported,
    nativeAvailable: GazeTracker.isNativeModuleAvailable,
    nativeError: GazeTracker.nativeModuleError,

    // session
    running,
    status,
    error,
    start,
    stop,

    // rendering
    position,
    rawPosition,
    visibility,
    latestRef,
    headRef,
    lastSampleRef,
    sampleCountRef,
    readout,
    window,

    // drift check (see GazePointConfirm)
    setDriftCorrection,

    // gaze stream recording (offline replay, see STREAM_BASE)
    startStream,
    streamEvent,
    stopStream,

    // pose lock (see updatePoseLock)
    poseLock,
    setPoseLockActive,
    isPoseLockActive,
    getPoseMetrics,

    // calibration
    calibration,
    isCalibrated: calibration !== null,
    setCalibration,
    resetCalibration,
    beginCollect,
    endCollect,
  };
}

export default useGazeTracker;
