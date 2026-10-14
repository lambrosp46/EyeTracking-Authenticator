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
  const [phase, setPhase] = useState(usePositioning ? 'position' : 'intro'); // position | intro | warmup | collect | pose2 | return | computing | result
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  // false while the positioning step still has to run for this opening.
  const [positioned, setPositioned] = useState(!usePositioning);

  const pulse = useRef(new Animated.Value(1)).current;
  const cancelledRef = useRef(false);
  const positioningRef = useRef(null);

  // Re-arm the positioning step every time the overlay closes, so the next
  // opening starts with it again (GazeTest opens the overlay repeatedly).
  useEffect(() => {
    if (!visible) {
      setPositioned(!usePositioning);
      setPhase(usePositioning ? 'position' : 'intro'); // no flash of the first target on reopen
      positioningRef.current = null;
    }
  }, [visible, usePositioning]);

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

      // One target: warm-up (eye still travelling, discarded), then collect.
      const runTarget = async (target, targetIndex, n, into) => {
        setIndex(n);
        setCurrent(target);
        setPhase('warmup');
        await wait(cfg.warmupMs);
        if (cancelledRef.current) return false;
        setPhase('collect');
        tracker.beginCollect();
        await wait(cfg.dwellMs);
        const samples = tracker.endCollect();
        if (cancelledRef.current) return false;
        for (const s of samples) {
          into.push({ ...s, sx: s.sx, sy: s.sy, targetX: target.x, targetY: target.y, targetIndex });
        }
        return true;
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
      if (useSecondPose && poseA) {
        setPose2Target({ ...poseA, pitchDeg: poseA.pitchDeg + (secondCfg.pitchOffsetDeg ?? 3) });
        setPhase('pose2');
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

      setPhase('computing');
      await wait(250);
      if (cancelledRef.current) return;

      const perTargetCount = countPerTarget(collected);
      const thinTargets = targets.filter((_, i) => (perTargetCount[i] ?? 0) < cfg.minSamplesPerPoint);

      if (thinTargets.length > 0) {
        setFailure(
          `Μόνο ${collected.length} έγκυρα δείγματα. Κράτα το κινητό σταθερό, περίπου ` +
            `${settings.positioning?.targetDistanceCm ?? 30} cm από το πρόσωπο, με όλο το πρόσωπο ορατό, και δοκίμασε ξανά.`
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
  }, [visible, mode, positioned]);

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
  const looByKey = new Map((q?.loo?.perTarget ?? []).map((t) => [t.key, t]));

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: cfg.backgroundColor }]}>
          {/* `visible &&`: on close the phase is reset to 'position' while the
              modal is still fading out - without this the guide flashes up. */}
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

          {phase !== 'result' && phase !== 'position' && phase !== 'pose2' && phase !== 'return' && (
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
                    backgroundColor: collecting ? cfg.targetColor : 'transparent',
                    borderColor: cfg.targetColor,
                    transform: [{ scale: collecting ? 1 : pulse }],
                  },
                ]}
              >
                <View style={[styles.targetCore, { backgroundColor: collecting ? '#000' : cfg.targetColor }]} />
              </Animated.View>

              <SafeAreaView style={styles.hud} pointerEvents="box-none">
                <Text style={styles.hudTitle}>
                  {mode === 'validate' ? 'Έλεγχος ακρίβειας' : inSecondPose ? 'Βαθμονόμηση · δεύτερη στάση' : 'Βαθμονόμηση'}
                </Text>
                <Text style={styles.hudBody}>
                  {phase === 'intro'
                    ? inSecondPose || index === targets.length - 1
                      ? 'Μείνε σε αυτή τη νέα στάση και κοίτα κάθε κουκκίδα.'
                      : 'Μείνε σε αυτή τη θέση και κοίτα ίσια κάθε κουκκίδα.'
                    : tracker.poseLock?.locked
                      ? 'Η στάση σου άλλαξε — γύρνα στη θέση της βαθμονόμησης'
                      : collecting
                        ? 'Συνέχισε να κοιτάς την κουκκίδα'
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
                    {good ? 'Looking good' : 'Accuracy is low'}
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
                      : `Πάνω από τον στόχο ${cfg.maxAcceptableErrorCm} cm. Δοκίμασε ξανά μένοντας πιο ακίνητος. Τα βελάκια δείχνουν προς τα πού πέφτει κάθε σημείο: αν δείχνουν όλα προς την ίδια μεριά, κουνήθηκες ή άλλαξες στάση.`}
                  </Text>
                </>
              )}

              <View style={styles.actions}>
                <Pressable style={[styles.button, styles.buttonGhost]} onPress={onClose}>
                  <Text style={styles.buttonGhostText}>Discard</Text>
                </Pressable>
                {!failure && (
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

/** Average head pose over the collected samples, in headPose.headMetrics units. */
function meanPose(samples, window) {
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
  if (count.distanceCm < 10) return null;
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
