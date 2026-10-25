import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import settings from '../config/settings.json';
import PositionGuide from './PositionGuide';
import CalibrationHowto from './CalibrationHowto';
import RegripStep from './RegripStep';
import { writeToLogFile } from '../utils/sessionLog';
import { hasReferencePose, headMetrics, screenGeometry } from '../utils/headPose';
import { pointsToCm } from '../utils/gazeMapping';
import {
  buildTargets,
  cmToPoints,
  evaluateCalibration,
  fitCalibration,
  logCalibrationQuality,
  modelLabel,
  trimOutliers,
} from '../utils/gazeMapping';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sequential-target calibration.
 *
 * ARKit ships no gaze calibration of its own, so this is where the mapping from
 * the raw eye ray to screen coordinates is actually learned. Each target runs
 * in two phases: a warm-up (the eye is still travelling, samples are discarded)
 * and a dwell (samples are kept). The worst samples of each group are trimmed
 * before the least-squares fit.
 *
 * mode = 'calibrate' -> fits a new mapping
 * mode = 'validate'  -> reuses the current mapping and only reports the error,
 *                       which is the number you want in the thesis evaluation.
 *
 * When settings.positioning.enabled, a positioning step (PositionGuide) runs
 * first: the targets only start once the head is at the right distance,
 * height and angle. The accepted pose is returned as result.positioning.
 */
export default function CalibrationOverlay({ visible, mode = 'calibrate', tracker, onClose, onComplete }) {
  const cfg = settings.calibration;
  const usePositioning = settings.positioning?.enabled === true;
  // In the accuracy check the head must be back in the pose the calibration was
  // made in; otherwise the check measures the pose change, not the calibration.
  const poseLockOn = settings.positioning?.poseLock?.enabled === true;
  const reference =
    mode === 'validate' && poseLockOn && hasReferencePose(tracker.calibration) ? tracker.calibration.pose : null;
  const window = tracker.window;

  // The accuracy check uses DIFFERENT points from the calibration when
  // calibration.validationPoints is set: an error measured on the very points
  // the fit was made on says little about the points in between.
  const targets = useMemo(
    () =>
      buildTargets(
        mode === 'validate' && Array.isArray(cfg.validationPoints) && cfg.validationPoints.length >= 3
          ? { ...cfg, customPoints: cfg.validationPoints }
          : cfg,
        window
      ),
    [cfg, mode, window.width, window.height]
  );
  const targetSize = cmToPoints(cfg.targetDiameterCm);

  // Second pose (calibrate only): after the main pass, the user changes head
  // pitch a little and a subset of the targets is repeated. Seeing two poses is
  // what lets the fit learn - and later subtract - the effect of head pose.
  const secondCfg = cfg.secondPose ?? {};
  const useSecondPose = mode === 'calibrate' && secondCfg.enabled === true && usePositioning;
  const secondTargets = useMemo(
    () =>
      (secondCfg.targetIndices ?? []).filter((i) => i >= 0 && i < targets.length).map((i) => ({ ...targets[i], from: i })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets]
  );
  const totalTargets = targets.length + (useSecondPose ? secondTargets.length : 0);
  const pose2Overrides = useMemo(
    () => ({
      maxHeadPitchDeg: secondCfg.pitchToleranceDeg ?? 1.5,
      eyeYToleranceCm: secondCfg.eyeYToleranceCm ?? 1.5,
      eyeXToleranceCm: secondCfg.eyeXToleranceCm ?? 1.0,
      distanceToleranceCm: secondCfg.distanceToleranceCm ?? 2.0,
      exitToleranceFactor: 1.2,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [pose2Target, setPose2Target] = useState(null);
  const pose2ResolveRef = useRef(null);
  // After the second pose the user must go BACK to the first one: the pose
  // lock and the fit's centre are the first pose, and users otherwise simply
  // stay in the second pose for the rest of the session (seen in the pilot:
  // +1.2 cm / +4° carried into the gaze confirmation).
  const [returnTarget, setReturnTarget] = useState(null);
  const returnResolveRef = useRef(null);

  const [index, setIndex] = useState(0);
  const [current, setCurrent] = useState(null);
  // "Before you start" instructions (calibrate only), once per opening.
  const useHowto = mode === 'calibrate' && cfg.instructions?.enabled === true;
  const firstPhase = useHowto ? 'howto' : usePositioning ? 'position' : 'intro';
  const [phase, setPhase] = useState(firstPhase); // howto | position | intro | warmup | collect | retry | pose2 | return | computing | result
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  // false while the positioning step still has to run for this opening.
  const [positioned, setPositioned] = useState(!usePositioning);
  // Bumped by "Ξαναδοκίμασε" after a rejected calibration (re-runs the effect
  // when there is no positioning step to re-arm); tries counts them for the log.
  const [run, setRun] = useState(0);
  const triesRef = useRef(0);
  const [howtoDone, setHowtoDone] = useState(!useHowto);
  // Message shown when a target is redone (head turned / gaze not steady).
  const [retryMsg, setRetryMsg] = useState(null);
  // Filling target: 0..1 of the steady gaze needed, and why it is paused.
  const fillAnim = useRef(new Animated.Value(0)).current;
  const [fillState, setFillState] = useState('ok'); // ok | pause | head
  const setFill = (v, immediate = false) => {
    if (immediate) fillAnim.setValue(v);
    else Animated.timing(fillAnim, { toValue: v, duration: 180, easing: Easing.linear, useNativeDriver: true }).start();
  };

  const pulse = useRef(new Animated.Value(1)).current;
  const cancelledRef = useRef(false);
  const positioningRef = useRef(null);

  // Re-arm the positioning step every time the overlay closes, so the next
  // opening starts with it again (GazeTest opens the overlay repeatedly).
  useEffect(() => {
    if (!visible) {
      triesRef.current = 0;
      setHowtoDone(!useHowto);
      setPositioned(!usePositioning);
      setPhase(firstPhase); // no flash of the positioning guide / first target on reopen
      positioningRef.current = null;
    }
  }, [visible, usePositioning, firstPhase]);

  const handlePositioned = (snapshot) => {
    positioningRef.current = snapshot;
    console.log(
      `[Positioning] ${snapshot.skipped ? 'skipped' : 'ok'} after ${snapshot.timeToPositionMs}ms` +
        (snapshot.distanceCm != null
          ? ` - d ${snapshot.distanceCm.toFixed(1)}cm, eyes y ${snapshot.eyeYFromTopCm.toFixed(1)}cm,` +
            ` yaw ${snapshot.yawDeg.toFixed(0)}°, pitch ${snapshot.pitchDeg.toFixed(0)}°,` +
            ` roll ${snapshot.rollDeg.toFixed(0)}°, tilt ${snapshot.deviceTiltDeg?.toFixed(0) ?? '-'}°`
          : '')
    );
    setPositioned(true);
  };

  // pulsing target so the eye has something to lock onto
  useEffect(() => {
    if (!visible) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.35, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1.0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  useEffect(() => {
    if (!visible) return undefined;

    cancelledRef.current = false;
    setIndex(0);
    setCurrent(targets[0]);
    setResult(null);
    setFailure(null);
    setPose2Target(null);
    setReturnTarget(null);

    if (!howtoDone) {
      setPhase('howto'); // CalibrationHowto sets howtoDone -> this effect runs again
      return undefined;
    }
    if (!positioned) {
      setPhase('position'); // PositionGuide calls handlePositioned -> this effect runs again
      return undefined;
    }
    setPhase('intro');

    // Accuracy check: samples count only while the pose matches the
    // calibration's. New calibration: no lock (there is no pose to match yet).
    const lockWasActive = tracker.isPoseLockActive();
    tracker.setPoseLockActive(mode === 'validate' && reference != null);

    (async () => {
      // Let the user read the instruction. Shorter after the positioning step,
      // which already told them what to do and got them still.
      await wait(usePositioning ? 600 : 1200);
      const collected = [];

      // ---- per-target checks ----------------------------------------------
      // New users made two errors that ruined calibrations: turning the HEAD
      // towards each dot instead of moving the eyes (head range up to 13°, vs
      // < 2° for a trained user), and not holding the gaze on the dot (~2x the
      // jitter). Each target is checked right after collection; a failed one
      // is not used, the user is told what went wrong, and the target is shown
      // again (at most maxRetries times, then it is kept as it is).
      // Head reference = median head angle over the targets kept so far in this
      // pose (the first target sets it). Not the positioning snapshot: users
      // settle after it (replay: a trained user moved from 42 to 31 cm, and
      // every target would have been flagged). A target kept after maxRetries
      // also joins the reference, so a wrong first reference corrects itself.
      // Replay on all logged calibrations: trained user 0 head / 0-2 gaze
      // retries per calibration; new users 11 head (2 of 6) or 3-5 gaze.
      const checks = cfg.targetChecks ?? {};
      const useChecks = checks.enabled === true;
      const headRefs = { yaw: [], pitch: [] };
      const resetHeadRef = () => {
        headRefs.yaw = [];
        headRefs.pitch = [];
      };
      const addHeadRef = (head) => {
        if (!head) return;
        headRefs.yaw.push(head.yawDeg);
        headRefs.pitch.push(head.pitchDeg);
      };
      const checkTarget = (samples) => {
        if (!useChecks || samples.length < cfg.minSamplesPerPoint) return { head: null, problem: null };
        // gaze steadiness: robust spread of the RAW gaze (screen plane, cm)
        const jitterCm = 100 * Math.hypot(mad(samples.map((s) => s.sx)), mad(samples.map((s) => s.sy)));
        const head = meanPose(samples, window);
        if (head && headRefs.yaw.length) {
          const dYaw = head.yawDeg - median(headRefs.yaw);
          const dPitch = head.pitchDeg - median(headRefs.pitch);
          if (Math.abs(dYaw) > (checks.maxHeadYawDeg ?? 2.5) || Math.abs(dPitch) > (checks.maxHeadPitchDeg ?? 3.5)) {
            return { head, problem: { reason: 'head', detail: `head moved yaw ${dYaw.toFixed(1)}° pitch ${dPitch.toFixed(1)}°` } };
          }
        }
        if (jitterCm > (checks.maxRawJitterCm ?? 0.2)) {
          return { head, problem: { reason: 'gaze', detail: `gaze not steady (raw jitter ${jitterCm.toFixed(2)})` } };
        }
        return { head, problem: null };
      };
      const RETRY_TEXT = {
        head: 'Μόνο τα μάτια — κράτα το κεφάλι ακίνητο',
        gaze: 'Κράτα το βλέμμα σταθερά στο κέντρο της κουκκίδας',
      };

      // ---- filling target ---------------------------------------------------
      // The dot fills while the gaze is steady and the head still, and pauses
      // otherwise (suggested by a test user: you see how long to look, and
      // whether you are doing it right). Samples are collected in short chunks;
      // only steady chunks count and are kept. "Steady" can only mean steady,
      // not "on the dot": before the calibration exists, where the user looks
      // on the screen is unknown. Thresholds from the logged calibrations:
      // a trained user's chunks pass ~97% of the time, a new user's ~85%.
      const lastPauseRef = { current: 'ok' };
      const collectSteady = async () => {
        const chunkMs = checks.chunkMs ?? 200;
        const need = cfg.dwellMs;
        const maxMs = cfg.maxCollectMs ?? 4000;
        const maxSpread = checks.chunkMaxSpreadCm ?? 0.2;
        const maxAway = checks.chunkMaxAwayCm ?? 0.3;
        const t0 = Date.now();
        let kept = [];
        let steadyMs = 0;
        let anchor = null;
        let awayRun = 0;
        setFill(0, true);
        setFillState('ok');
        lastPauseRef.current = 'ok';
        while (steadyMs < need && Date.now() - t0 < maxMs) {
          tracker.beginCollect();
          await wait(chunkMs);
          const chunk = tracker.endCollect();
          if (cancelledRef.current) return { samples: [], done: false };
          if (chunk.length < 3) {
            // blink or face lost: pause
            setFillState('pause');
            lastPauseRef.current = 'pause';
            continue;
          }
          const cx = median(chunk.map((q) => q.sx));
          const cy = median(chunk.map((q) => q.sy));
          const spread = 100 * Math.hypot(mad(chunk.map((q) => q.sx)), mad(chunk.map((q) => q.sy)));
          if (useChecks && headRefs.yaw.length) {
            const h = meanPose(chunk, window, 3);
            if (
              h &&
              (Math.abs(h.yawDeg - median(headRefs.yaw)) > (checks.maxHeadYawDeg ?? 2.5) ||
                Math.abs(h.pitchDeg - median(headRefs.pitch)) > (checks.maxHeadPitchDeg ?? 3.5))
            ) {
              setFillState('head');
              lastPauseRef.current = 'head';
              continue;
            }
          }
          if (spread > maxSpread) {
            setFillState('pause');
            lastPauseRef.current = 'pause';
            continue;
          }
          const away = anchor ? 100 * Math.hypot(cx - anchor.x, cy - anchor.y) : 0;
          if (away > maxAway) {
            // the eye settled somewhere else: if it stays there, start over
            // from the new place (the first chunks were probably the eye
            // still arriving at the dot)
            awayRun += 1;
            setFillState('pause');
            lastPauseRef.current = 'pause';
            if (awayRun >= 2) {
              kept = [];
              steadyMs = 0;
              anchor = null;
              awayRun = 0;
              setFill(0);
            }
            continue;
          }
          awayRun = 0;
          kept = kept.concat(chunk);
          steadyMs += chunkMs;
          anchor = { x: median(kept.map((q) => q.sx)), y: median(kept.map((q) => q.sy)) };
          setFillState('ok');
          setFill(Math.min(1, steadyMs / need));
        }
        return { samples: kept, done: steadyMs >= need };
      };

      // One target: warm-up (eye still travelling, discarded), then collect.
      const runTarget = async (target, targetIndex, n, into) => {
        setIndex(n);
        setCurrent(target);
        for (let attempt = 0; ; attempt++) {
          setPhase('warmup');
          await wait(cfg.warmupMs);
          if (cancelledRef.current) return false;
          setPhase('collect');
          const { samples, done } = await collectSteady();
          if (cancelledRef.current) return false;

          let { head, problem } = checkTarget(samples);
          if (!done && !problem) {
            problem = {
              reason: lastPauseRef.current === 'head' ? 'head' : 'gaze',
              detail: `the dot did not fill in ${cfg.maxCollectMs ?? 4000}ms (${lastPauseRef.current})`,
            };
          }
          if (problem && attempt < (checks.maxRetries ?? 2)) {
            console.log(`[Calibration] target ${targetIndex + 1} redone (${attempt + 1}): ${problem.detail}`);
            setRetryMsg(RETRY_TEXT[problem.reason]);
            setPhase('retry');
            await wait(checks.messageMs ?? 1600);
            setRetryMsg(null);
            if (cancelledRef.current) return false;
            continue;
          }
          if (problem) console.log(`[Calibration] target ${targetIndex + 1} kept after ${attempt} retries: ${problem.detail}`);
          if (useChecks) addHeadRef(head);
          for (const s of samples) {
            into.push({ ...s, sx: s.sx, sy: s.sy, targetX: target.x, targetY: target.y, targetIndex });
          }
          return true;
        }
      };

      for (let i = 0; i < targets.length; i++) {
        if (cancelledRef.current) return;
        if (!(await runTarget(targets[i], i, i, collected))) return;
      }

      // ---- second pose -------------------------------------------------
      // Pass-B targets keep their screen position but get their own key
      // (100 + n) so cross-validation treats them as separate points.
      let secondPass = [];
      const poseA = useSecondPose ? meanPose(collected, window) : null;
      const regrip = (secondCfg.mode ?? 'regrip') === 'regrip';
      if (useSecondPose && poseA) {
        if (regrip) {
          setPhase('regrip');
        } else {
          setPose2Target({ ...poseA, pitchDeg: poseA.pitchDeg + (secondCfg.pitchOffsetDeg ?? 3) });
          setPhase('pose2');
        }
        const snapshot = await new Promise((resolve) => {
          pose2ResolveRef.current = resolve;
        });
        pose2ResolveRef.current = null;
        if (cancelledRef.current) return;
        if (snapshot && !snapshot.skipped) {
          console.log(
            `[Calibration] second pose ok after ${snapshot.timeToPositionMs}ms: pitch ${snapshot.pitchDeg.toFixed(1)}° ` +
              `(first pose ${poseA.pitchDeg.toFixed(1)}°), eyes y ${snapshot.eyeYFromTopCm.toFixed(1)}cm`
          );
          setPhase('intro');
          resetHeadRef(); // the head is meant to be in the new pose now
          await wait(600);
          for (let n = 0; n < secondTargets.length; n++) {
            if (cancelledRef.current) return;
            if (!(await runTarget(secondTargets[n], 100 + n, targets.length + n, secondPass))) return;
          }
          const counts = countPerTarget(secondPass);
          if (secondTargets.some((_, n) => (counts[100 + n] ?? 0) < cfg.minSamplesPerPoint)) {
            console.log('[Calibration] second pose: too few samples, fitting on the first pose only');
            secondPass = [];
          }
        } else {
          console.log('[Calibration] second pose skipped, fitting on the first pose only');
        }

        // ---- back to the first pose ----------------------------------
        // Only for the old head-tilt second pose. After a re-grip the user is
        // simply in their usual pose; the pose lock's pitch range covers both.
        if (!regrip) {
        // Strict pose-lock limits (no `compensated` flag on this reference).
        setReturnTarget(poseA);
        setPhase('return');
        const back = await new Promise((resolve) => {
          returnResolveRef.current = resolve;
        });
        returnResolveRef.current = null;
        if (cancelledRef.current) return;
        console.log(
          `[Calibration] back to first pose ${back?.skipped ? 'SKIPPED' : 'ok'} after ${back?.timeToPositionMs ?? '-'}ms` +
            (back?.pitchDeg != null ? `: pitch ${back.pitchDeg.toFixed(1)}° (first pose ${poseA.pitchDeg.toFixed(1)}°)` : '')
        );
        }
      }

      setPhase('computing');
      await wait(250);
      if (cancelledRef.current) return;

      const perTargetCount = countPerTarget(collected);
      const thinTargets = targets.filter((_, i) => (perTargetCount[i] ?? 0) < cfg.minSamplesPerPoint);

      if (thinTargets.length > 0) {
        setFailure(
          `Μόνο ${collected.length} έγκυρα δείγματα. Κράτα το κινητό σταθερό, ` +
            'με όλο το πρόσωπο ορατό και καλό φωτισμό, και δοκίμασε ξανά.'
        );
        setPhase('result');
        return;
      }

      const all = [...collected, ...secondPass];
      if (cfg.dumpSamples) dumpCalibrationData(mode, window, targets, all, positioningRef.current);

      const trimmed = trimOutliers(all, cfg.outlierTrimPercent);

      if (mode === 'validate') {
        if (!tracker.calibration) {
          setFailure('There is no calibration to validate yet.');
          setPhase('result');
          return;
        }
        const quality = evaluateCalibration(tracker.calibration, trimmed);
        logCalibrationQuality('Validation', quality, modelLabel(tracker.calibration));
        setResult({ quality, calibration: tracker.calibration, positioning: positioningRef.current });
        setPhase('result');
        return;
      }

      // Head terms only when there really is a second pose in the data.
      const fit = fitCalibration(trimmed, { ...cfg, allowHead: secondPass.length > 0 });
      if (!fit.ok) {
        setFailure(fit.reason);
        setPhase('result');
        return;
      }
      logCalibrationQuality('Calibration', fit.quality, modelLabel(fit.calibration));
      triesRef.current += 1;
      const looCm = fit.quality.loo?.rmseCm;
      const limitCm = cfg.maxAcceptableErrorCm;
      if (looCm != null && looCm > limitCm) {
        console.log(
          `[Calibration] REJECTED (try ${triesRef.current}): error at new points ${looCm.toFixed(2)}cm > limit ${limitCm}cm - the user has to calibrate again`
        );
      }
      // The pose the fit was made in travels with it: the pose lock and
      // [PoseDrift] compare against it. It is the MEAN pose over all the
      // calibration samples (the head moves a little with the gaze, e.g. drops
      // slightly towards the bottom row), falling back to the positioning snapshot.
      // Reference = the FIRST (main) pose; `compensated` widens the pose-lock
      // limits when the fit learnt to correct for head pose.
      const basePose =
        meanPose(collected, window) ?? (positioningRef.current?.distanceCm != null ? positioningRef.current : null);
      const pose = basePose ? { ...basePose, compensated: !!fit.calibration.head } : null;
      // The MEASURED second pose (mean over its targets, not the nominal
      // offset): the pose lock lets the head pitch move between the two poses,
      // the range the head-pose terms were fitted on (utils/headPose.referenceConfig).
      const poseB = secondPass.length > 0 ? meanPose(secondPass, window) : null;
      if (pose && poseB && pose.compensated) pose.pitchSpanDeg = [pose.pitchDeg, poseB.pitchDeg];
      const calibration = pose ? { ...fit.calibration, pose } : fit.calibration;
      if (pose) {
        console.log(
          `[Calibration] reference pose: d ${pose.distanceCm.toFixed(1)}cm x ${pose.eyeXFromCenterCm.toFixed(1)} y ${pose.eyeYFromTopCm.toFixed(1)}` +
            ` · yaw ${pose.yawDeg.toFixed(1)}° pitch ${pose.pitchDeg.toFixed(1)}° roll ${pose.rollDeg.toFixed(1)}°` +
            (poseB ? ` · second pose pitch ${poseB.pitchDeg.toFixed(1)}° eyes y ${poseB.eyeYFromTopCm.toFixed(1)}` : '')
        );
        if (pose.pitchSpanDeg) {
          const m = settings.positioning?.poseLock?.pitchRange?.marginDeg ?? 1;
          const [lo, hi] = [Math.min(...pose.pitchSpanDeg) - m, Math.max(...pose.pitchSpanDeg) + m];
          console.log(`[Calibration] allowed head pitch while tracking: ${lo.toFixed(1)}° … ${hi.toFixed(1)}° (between the two poses ± ${m}°)`);
        }
      }
      setResult({ quality: fit.quality, calibration, positioning: positioningRef.current });
      setPhase('result');
    })();

    return () => {
      cancelledRef.current = true;
      pose2ResolveRef.current?.(null);
      returnResolveRef.current?.(null);
      tracker.endCollect();
      tracker.setPoseLockActive(lockWasActive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, positioned, run, howtoDone]);

  // Start over from the positioning step (rejected calibration).
  const retry = () => {
    positioningRef.current = null;
    if (usePositioning) setPositioned(false);
    else setRun((r) => r + 1);
  };

  const accept = async () => {
    if (mode === 'calibrate' && result?.calibration) {
      await tracker.setCalibration(result.calibration);
    }
    onComplete?.(result);
    onClose?.();
  };

  const shownTarget = current ?? targets[0];
  const inSecondPose = index >= targets.length;
  const collecting = phase === 'collect';
  // Headline number = the error expected at points the fit has NOT seen:
  // leave-one-target-out after a calibration, the new points themselves in an
  // accuracy check. The per-sample in-sample RMSE is shown too, but it is
  // always optimistic and is not what a password point experiences.
  const q = result?.quality;
  const headlineCm = q ? (q.loo?.rmseCm ?? q.pointRmseCm ?? q.rmseCm) : null;
  const headlineLabel = q?.loo
    ? 'εκτιμώμενο σφάλμα σε νέα σημεία'
    : mode === 'validate'
      ? 'σφάλμα στα σημεία ελέγχου'
      : 'σφάλμα (RMSE)';
  const good = headlineCm != null && headlineCm <= cfg.maxAcceptableErrorCm;
  // A new calibration whose error at points it has NOT seen (leave-one-out) is
  // above the limit is refused: it cannot be saved, only redone. Pilot with new
  // users: calibrations of 5.1 / 2.5 / 2.0 cm were accepted and every later
  // step failed. (The old check looked at the in-sample fit error, which is
  // always optimistic.) The accuracy check (validate) only reports.
  const rejected = mode === 'calibrate' && !failure && q?.loo != null && !good;
  const looByKey = new Map((q?.loo?.perTarget ?? []).map((t) => [t.key, t]));

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: cfg.backgroundColor }]}>
          {/* `visible &&`: on close the phase is reset to 'position' while the
              modal is still fading out - without this the guide flashes up. */}
          {visible && phase === 'howto' && (
            <CalibrationHowto onStart={() => setHowtoDone(true)} onCancel={onClose} />
          )}

          {visible && phase === 'position' && (
            <PositionGuide tracker={tracker} onReady={handlePositioned} onCancel={onClose} reference={reference} />
          )}

          {visible && phase === 'return' && returnTarget && (
            <PositionGuide
              tracker={tracker}
              reference={returnTarget}
              onReady={(snap) => returnResolveRef.current?.(snap)}
              onCancel={onClose}
              title="Επιστροφή στην αρχική στάση"
              subtitle="Σήκωσε ξανά το κεφάλι όπως ήταν στην αρχή της βαθμονόμησης. Συνεχίζουμε μόλις το πλαίσιο γίνει πράσινο."
            />
          )}

          {visible && phase === 'regrip' && (
            <RegripStep tracker={tracker} onReady={(snap) => pose2ResolveRef.current?.(snap)} onCancel={onClose} />
          )}

          {visible && phase === 'pose2' && pose2Target && (
            <PositionGuide
              tracker={tracker}
              reference={pose2Target}
              overrides={pose2Overrides}
              onReady={(snap) => pose2ResolveRef.current?.(snap)}
              onCancel={onClose}
              title="Δεύτερη στάση"
              subtitle={`Σκύψε λίγο το κεφάλι (περίπου ${secondCfg.pitchOffsetDeg ?? 3}°), σαν να γέρνεις το πηγούνι προς το στήθος, με τα μάτια στην οθόνη. Ακολουθούν ${secondTargets.length} κουκκίδες ακόμα.`}
            />
          )}

          {phase !== 'result' && phase !== 'position' && phase !== 'pose2' && phase !== 'return' && phase !== 'howto' && phase !== 'regrip' && (
            <>
              <Animated.View
                style={[
                  styles.target,
                  {
                    left: shownTarget.x - targetSize / 2,
                    top: shownTarget.y - targetSize / 2,
                    width: targetSize,
                    height: targetSize,
                    borderRadius: targetSize / 2,
                    backgroundColor: 'transparent',
                    borderColor: !collecting
                      ? cfg.targetColor
                      : fillState === 'head'
                        ? '#FF9F0A'
                        : fillState === 'pause'
                          ? '#8E8E93'
                          : cfg.targetColor,
                    borderWidth: collecting ? 3 : 2,
                    transform: [{ scale: collecting ? 1 : pulse }],
                  },
                ]}
              >
                {/* fills from the centre while the gaze is steady (collectSteady) */}
                {collecting && (
                  <Animated.View
                    style={[
                      StyleSheet.absoluteFill,
                      {
                        borderRadius: targetSize / 2,
                        backgroundColor: fillState === 'head' ? '#FF9F0A' : cfg.targetColor,
                        transform: [{ scale: fillAnim }],
                      },
                    ]}
                  />
                )}
                <View style={[styles.targetCore, { backgroundColor: collecting ? '#000' : cfg.targetColor }]} />
              </Animated.View>

              <SafeAreaView style={styles.hud} pointerEvents="box-none">
                <Text style={styles.hudTitle}>
                  {mode === 'validate' ? 'Έλεγχος ακρίβειας' : inSecondPose ? 'Βαθμονόμηση · δεύτερη στάση' : 'Βαθμονόμηση'}
                </Text>
                <Text style={[styles.hudBody, phase === 'retry' && styles.hudWarn]}>
                  {phase === 'retry'
                    ? retryMsg
                    : phase === 'intro'
                    ? inSecondPose || index === targets.length - 1
                      ? 'Μείνε σε αυτή τη νέα στάση. Κράτα το κεφάλι ακίνητο και κοίτα κάθε κουκκίδα μόνο με τα μάτια.'
                      : 'Κράτα το κεφάλι ακίνητο και κοίτα κάθε κουκκίδα μόνο με τα μάτια.'
                    : tracker.poseLock?.locked
                      ? 'Η στάση σου άλλαξε — γύρνα στη θέση της βαθμονόμησης'
                      : collecting
                        ? fillState === 'head'
                          ? 'Μόνο τα μάτια — κράτα το κεφάλι ακίνητο'
                          : fillState === 'pause'
                            ? 'Κράτα το βλέμμα στο κέντρο της κουκκίδας'
                            : 'Κοίτα την κουκκίδα μέχρι να γεμίσει'
                        : 'Κοίτα την κουκκίδα'}
                </Text>
                <Text style={styles.hudCount}>
                  {index + 1} / {totalTargets}
                </Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${((index + (collecting ? 1 : 0)) / totalTargets) * 100}%` }]} />
                </View>
                <Pressable onPress={onClose} hitSlop={12} style={styles.cancel}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </SafeAreaView>
            </>
          )}

          {phase === 'computing' && (
            <View style={styles.centre}>
              <ActivityIndicator color="#FFF" />
              <Text style={styles.hudBody}>Fitting the mapping…</Text>
            </View>
          )}

          {phase === 'result' && (
            <SafeAreaView style={styles.resultWrap}>
              {failure ? (
                <>
                  <Text style={styles.resultTitle}>Didn't work</Text>
                  <Text style={styles.hudBody}>{failure}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.resultTitle}>
                    {good ? 'Looking good' : rejected ? 'Η βαθμονόμηση δεν πέτυχε' : 'Accuracy is low'}
                  </Text>
                  <Text style={styles.metric}>{headlineCm.toFixed(2)} cm</Text>
                  <Text style={styles.metricLabel}>{headlineLabel}</Text>

                  <View style={styles.statsRow}>
                    <Stat label="fit (per sample)" value={`${q.rmseCm.toFixed(2)} cm`} />
                    <Stat label="χειρότερο" value={`${(q.loo?.maxCm ?? Math.max(...q.perTarget.map((t) => t.errCm))).toFixed(2)} cm`} />
                    <Stat label="model" value={modelLabel(result.calibration)} />
                  </View>

                  <View style={styles.perTarget}>
                    {q.perTarget.map((t, i) => {
                      const l = looByKey.get(t.key);
                      const shown = l ?? t;
                      return (
                        <View key={i} style={styles.perTargetRow}>
                          <Text style={styles.perTargetKey}>Σημείο {i + 1}</Text>
                          <Text style={styles.perTargetValue}>
                            {offsetArrow(shown.dxCm, shown.dyCm)} {shown.errCm.toFixed(2)} cm
                          </Text>
                        </View>
                      );
                    })}
                  </View>

                  <Text style={styles.hint}>
                    {good
                      ? `Εντός του στόχου ${cfg.maxAcceptableErrorCm} cm.`
                      : rejected
                        ? `Το σφάλμα είναι πάνω από ${cfg.maxAcceptableErrorCm} cm, οπότε η βαθμονόμηση πρέπει να γίνει ξανά. ` +
                          'Κράτα το κινητό σταθερό, κοίτα το κέντρο κάθε κουκκίδας μέχρι να εξαφανιστεί, και μην κουνάς το κεφάλι. Βοηθάει και καλός φωτισμός στο πρόσωπο.'
                        : `Πάνω από τον στόχο ${cfg.maxAcceptableErrorCm} cm. Δοκίμασε ξανά μένοντας πιο ακίνητος. Τα βελάκια δείχνουν προς τα πού πέφτει κάθε σημείο: αν δείχνουν όλα προς την ίδια μεριά, κουνήθηκες ή άλλαξες στάση.`}
                  </Text>
                </>
              )}

              <View style={styles.actions}>
                <Pressable style={[styles.button, styles.buttonGhost]} onPress={onClose}>
                  <Text style={styles.buttonGhostText}>Discard</Text>
                </Pressable>
                {rejected && (
                  <Pressable style={styles.button} onPress={retry}>
                    <Text style={styles.buttonText}>Ξαναδοκίμασε</Text>
                  </Pressable>
                )}
                {!failure && !rejected && (
                  <Pressable style={styles.button} onPress={accept}>
                    <Text style={styles.buttonText}>
                      {mode === 'validate' ? 'Done' : 'Save calibration'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </SafeAreaView>
          )}
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Robust spread (scaled median absolute deviation): a single saccade doesn't inflate it. */
function mad(values) {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

/** Average head pose over the collected samples, in headPose.headMetrics units. */
function meanPose(samples, window, minCount = 10) {
  const geom = screenGeometry(settings.eyeTracking.screen, window, pointsToCm);
  const keys = ['distanceCm', 'eyeXFromCenterCm', 'eyeYFromTopCm', 'yawDeg', 'pitchDeg', 'rollDeg', 'deviceTiltDeg'];
  const sum = Object.fromEntries(keys.map((k) => [k, 0]));
  const count = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const s of samples) {
    const m = headMetrics(s, geom);
    if (!m) continue;
    for (const k of keys) {
      if (m[k] == null || !Number.isFinite(m[k])) continue;
      sum[k] += m[k];
      count[k] += 1;
    }
  }
  if (count.distanceCm < minCount) return null;
  return Object.fromEntries(keys.map((k) => [k, count[k] ? sum[k] / count[k] : null]));
}

/**
 * Prints every collected (untrimmed) sample to the console, so different
 * models / features / ray modes can be compared offline on the same session.
 * Compact: a header with the column names, then rows of numbers, in chunks so
 * no single console line gets too long for Metro.
 */
function dumpCalibrationData(mode, window, targets, samples, positioning) {
  if (samples.length === 0) return;
  const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))].filter(
    (k) => typeof samples[0][k] === 'number' || samples.some((s) => typeof s[k] === 'number')
  );
  const meta = {
    mode,
    at: new Date().toISOString(),
    window: { width: window.width, height: window.height },
    targets: targets.map((t) => [Math.round(t.x * 10) / 10, Math.round(t.y * 10) / 10]),
    positioning,
    keys,
  };
  const round = (v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : null);
  const rows = samples.map((s) => keys.map((k) => round(s[k])));
  const CHUNK = 40;
  const parts = Math.ceil(rows.length / CHUNK);
  // To the log FILE only: these lines are large and were flooding Metro.
  writeToLogFile(`[CalibrationData] meta ${JSON.stringify(meta)}`);
  for (let i = 0; i < parts; i++) {
    writeToLogFile(`[CalibrationData] rows ${i + 1}/${parts} ${JSON.stringify(rows.slice(i * CHUNK, (i + 1) * CHUNK))}`);
  }
  writeToLogFile('[CalibrationData] end');
  console.log(`[CalibrationData] ${samples.length} samples written to the session log file`);
}

/** Arrow for the direction a point lands relative to its target (screen: +x right, +y down). */
function offsetArrow(dx, dy) {
  if (dx == null || dy == null || Math.hypot(dx, dy) < 0.2) return '·';
  const angle = Math.atan2(dy, dx) * (180 / Math.PI); // 0 = right, 90 = down
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  return arrows[Math.round(((angle + 360) % 360) / 45) % 8];
}

function countPerTarget(samples) {
  const counts = {};
  for (const s of samples) counts[s.targetIndex] = (counts[s.targetIndex] ?? 0) + 1;
  return counts;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  target: {
    position: 'absolute',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetCore: { width: 4, height: 4, borderRadius: 2 },
  hud: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    padding: 24,
    alignItems: 'center',
  },
  centre: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12 },
  hudTitle: { color: '#FFF', fontSize: 15, fontWeight: '600', letterSpacing: 0.4 },
  hudBody: { color: 'rgba(255,255,255,0.65)', fontSize: 14, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  hudWarn: { color: '#FFD60A', fontSize: 17, fontWeight: '700' },
  hudCount: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 12 },
  progressTrack: {
    height: 2, width: '60%', backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 1, marginTop: 8, overflow: 'hidden',
  },
  progressFill: { height: 2, backgroundColor: '#FFD60A' },
  cancel: { marginTop: 18, padding: 8 },
  cancelText: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },

  resultWrap: { flex: 1, padding: 28, justifyContent: 'center' },
  resultTitle: { color: '#FFF', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  metric: { color: '#FFD60A', fontSize: 52, fontWeight: '200', textAlign: 'center', marginTop: 16 },
  metricLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center' },
  statsRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 24 },
  stat: { alignItems: 'center' },
  statValue: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  statLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 2 },
  perTarget: { marginTop: 24, gap: 6 },
  perTargetRow: { flexDirection: 'row', justifyContent: 'space-between' },
  perTargetKey: { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
  perTargetValue: { color: '#FFF', fontSize: 13, fontVariant: ['tabular-nums'] },
  hint: { color: 'rgba(255,255,255,0.5)', fontSize: 13, lineHeight: 19, marginTop: 24, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 32 },
  button: { flex: 1, backgroundColor: '#0A84FF', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  buttonGhost: { backgroundColor: 'rgba(255,255,255,0.10)' },
  buttonGhostText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
});
