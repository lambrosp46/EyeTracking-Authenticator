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
import {
  buildTargets,
  cmToPoints,
  evaluateCalibration,
  fitCalibration,
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
 */
export default function CalibrationOverlay({ visible, mode = 'calibrate', tracker, onClose, onComplete }) {
  const cfg = settings.calibration;
  const window = tracker.window;

  const targets = useMemo(() => buildTargets(cfg, window), [cfg, window.width, window.height]);
  const targetSize = cmToPoints(cfg.targetDiameterCm);

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState('intro'); // intro | warmup | collect | computing | result
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);

  const pulse = useRef(new Animated.Value(1)).current;
  const cancelledRef = useRef(false);

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
    setResult(null);
    setFailure(null);
    setPhase('intro');

    (async () => {
      await wait(1200); // let the user read the instruction
      const collected = [];

      for (let i = 0; i < targets.length; i++) {
        if (cancelledRef.current) return;

        setIndex(i);
        setPhase('warmup');
        await wait(cfg.warmupMs);
        if (cancelledRef.current) return;

        setPhase('collect');
        tracker.beginCollect();
        await wait(cfg.dwellMs);
        const samples = tracker.endCollect();
        if (cancelledRef.current) return;

        for (const s of samples) {
          collected.push({
            sx: s.sx,
            sy: s.sy,
            targetX: targets[i].x,
            targetY: targets[i].y,
            targetIndex: i,
          });
        }
      }

      setPhase('computing');
      await wait(250);
      if (cancelledRef.current) return;

      const perTargetCount = countPerTarget(collected);
      const thinTargets = targets.filter((_, i) => (perTargetCount[i] ?? 0) < cfg.minSamplesPerPoint);

      if (thinTargets.length > 0) {
        setFailure(
          `Only ${collected.length} usable samples came through. Hold the phone steady at arm's length, keep your whole face in view, and try again.`
        );
        setPhase('result');
        return;
      }

      const trimmed = trimOutliers(collected, cfg.outlierTrimPercent);

      if (mode === 'validate') {
        if (!tracker.calibration) {
          setFailure('There is no calibration to validate yet.');
          setPhase('result');
          return;
        }
        const quality = evaluateCalibration(tracker.calibration, trimmed);
        setResult({ quality, calibration: tracker.calibration });
        setPhase('result');
        return;
      }

      const fit = fitCalibration(trimmed, cfg);
      if (!fit.ok) {
        setFailure(fit.reason);
        setPhase('result');
        return;
      }
      setResult({ quality: fit.quality, calibration: fit.calibration });
      setPhase('result');
    })();

    return () => {
      cancelledRef.current = true;
      tracker.endCollect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode]);

  const accept = async () => {
    if (mode === 'calibrate' && result?.calibration) {
      await tracker.setCalibration(result.calibration);
    }
    onComplete?.(result);
    onClose?.();
  };

  const current = targets[index] ?? targets[0];
  const collecting = phase === 'collect';
  const good = result && result.quality.rmseCm <= cfg.maxAcceptableErrorCm;

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: cfg.backgroundColor }]}>
          {phase !== 'result' && (
            <>
              <Animated.View
                style={[
                  styles.target,
                  {
                    left: current.x - targetSize / 2,
                    top: current.y - targetSize / 2,
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
                  {mode === 'validate' ? 'Accuracy check' : 'Calibration'}
                </Text>
                <Text style={styles.hudBody}>
                  {phase === 'intro'
                    ? 'Hold the phone still at your normal reading distance and look straight at each dot.'
                    : collecting
                      ? 'Keep looking at the dot'
                      : 'Move your eyes to the dot'}
                </Text>
                <Text style={styles.hudCount}>
                  {index + 1} / {targets.length}
                </Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${((index + (collecting ? 1 : 0)) / targets.length) * 100}%` }]} />
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
                  <Text style={styles.metric}>{result.quality.rmseCm.toFixed(2)} cm</Text>
                  <Text style={styles.metricLabel}>mean error (RMSE)</Text>

                  <View style={styles.statsRow}>
                    <Stat label="worst" value={`${result.quality.maxCm.toFixed(2)} cm`} />
                    <Stat label="samples" value={String(result.quality.sampleCount)} />
                    <Stat label="model" value={result.calibration.model} />
                  </View>

                  <View style={styles.perTarget}>
                    {result.quality.perTarget.map((t, i) => (
                      <View key={i} style={styles.perTargetRow}>
                        <Text style={styles.perTargetKey}>Point {i + 1}</Text>
                        <Text style={styles.perTargetValue}>{t.meanCm.toFixed(2)} cm</Text>
                      </View>
                    ))}
                  </View>

                  <Text style={styles.hint}>
                    {good
                      ? `Within the ${cfg.maxAcceptableErrorCm} cm target.`
                      : `Above the ${cfg.maxAcceptableErrorCm} cm target. Try again with steadier posture, better lighting, or switch the model to "quadratic" with a 9-point pattern in settings.json.`}
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
