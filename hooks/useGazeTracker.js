import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Dimensions } from 'react-native';

import * as GazeTracker from '../modules/gaze-tracker';
import settings from '../config/settings.json';
import { GazeFilter2D } from '../utils/oneEuroFilter';
import {
  applyCalibration,
  clampToScreen,
  rawToScreenPoints,
} from '../utils/gazeMapping';
import { loadCalibration, saveCalibration, clearCalibration } from '../utils/calibrationStore';

const OFFSCREEN = -9999;

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
  const lastReadoutRef = useRef(0);
  const rateRef = useRef({ count: 0, since: 0, hz: 0 });

  // ---------------------------------------------------------------- MARK: sample
  const handleSample = useCallback(
    (sample) => {
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
        sample.isTracked && sample.hasHit && eyesOk && distanceOk && disparityOk;

      if (!valid) {
        visibility.setValue(0);
        filterRef.current.reset();
        latestRef.current = { ...latestRef.current, valid: false, timestamp: sample.timestamp };
        maybePublishReadout(sample, null, false);
        onSampleCallback?.({ ...sample, valid: false });
        return;
      }

      // raw (uncalibrated) point, always computed so the debug ghost has something
      const raw = rawToScreenPoints(sample.sx, sample.sy, cfg.screen, window);

      const mapped = calibrationRef.current
        ? applyCalibration(calibrationRef.current, sample.sx, sample.sy)
        : raw;

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
        collectingRef.current.push({
          sx: sample.sx,
          sy: sample.sy,
          x: final.x,
          y: final.y,
          timestamp: sample.timestamp,
        });
      }

      maybePublishReadout(sample, final, true);
      onSampleCallback?.({ ...sample, valid: true, point: final });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window.width, window.height, onSampleCallback]
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
        case 'stopped': setStatus('idle'); setRunning(false); visibility.setValue(0); break;
        case 'faceFound': setStatus('tracking'); break;
        case 'faceLost': setStatus('searching'); visibility.setValue(0); break;
        case 'interrupted': setStatus('interrupted'); visibility.setValue(0); break;
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
  useEffect(() => {
    if (!settings.calibration.autoLoad) return;
    let alive = true;
    loadCalibration().then((c) => {
      if (alive && c) {
        calibrationRef.current = c;
        setCalibrationState(c);
      }
    });
    return () => { alive = false; };
  }, []);

  const setCalibration = useCallback(async (c, { persist = true } = {}) => {
    calibrationRef.current = c;
    setCalibrationState(c);
    filterRef.current.reset();
    if (persist) await saveCalibration(c);
  }, []);

  const resetCalibration = useCallback(async () => {
    calibrationRef.current = null;
    setCalibrationState(null);
    filterRef.current.reset();
    await clearCalibration();
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
    readout,
    window,

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
