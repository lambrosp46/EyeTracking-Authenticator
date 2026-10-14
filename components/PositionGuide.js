import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import settings from '../config/settings.json';
import { pointsToCm } from '../utils/gazeMapping';
import {
  POSITION_HINTS,
  evaluatePositioning,
  headMetrics,
  referenceConfig,
  screenGeometry,
  smoothMetrics,
} from '../utils/headPose';

const COLOR_OK = '#30D158';
const COLOR_ADJUST = '#FF9F0A';
const COLOR_IDLE = 'rgba(255,255,255,0.35)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Positioning step shown before calibration.
 *
 * Deliberately not a camera preview (the way Tobii's "track status" box works):
 * a square frame is the zone the head has to be in, an oval stands for the
 * face and moves like a mirror image, grows when the user is too close and
 * shrinks when too far, and rotates with the head. The small dot inside the
 * oval shows where the nose points. A side bar shows the distance against
 * the target band.
 *
 * Calibration starts by itself once every check has held for holdStillMs.
 * Nothing about gaze is shown here, so it leaks nothing about the password.
 *
 * Props:
 *   tracker       the useGazeTracker() object (session must already be running)
 *   onReady       (snapshot) => void, called once; snapshot = the pose at the
 *                 moment positioning was accepted, for the session log
 *   onCancel      () => void; no Cancel button when omitted
 *   reference     a pose (calibration.pose): instead of the general ranges,
 *                 guide the user back to THIS pose with the tight
 *                 positioning.poseLock tolerances ("return" mode)
 *   autoComplete  false = never call onReady, just keep guiding (used while the
 *                 tracker's own pose lock decides when to release)
 *   overrides     extra config on top of the reference config (second-pose step)
 *   title / subtitle  replace the default texts
 */
export default function PositionGuide({
  tracker, onReady, onCancel, reference = null, autoComplete = true, overrides = null, title = null, subtitle = null,
}) {
  const baseCfg = settings.positioning;
  const cfg = useMemo(
    () => (reference ? { ...referenceConfig(baseCfg, reference), ...(overrides ?? {}) } : baseCfg),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reference, overrides]
  );
  const isReturn = reference != null;
  const staleMs = settings.eyeTracking.validity.staleSampleMs ?? 400;
  const window = tracker.window;

  const geom = useMemo(
    () => screenGeometry(settings.eyeTracking.screen, window, pointsToCm),
    [window.width, window.height]
  );

  // The tracker object and the callbacks change identity on every parent
  // render (~5x/s); the polling loop must not restart because of that.
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const doneRef = useRef(false);
  const startedAtRef = useRef(Date.now());
  const metricsRef = useRef(null);

  const [view, setView] = useState(() => ({
    metrics: null,
    verdict: evaluatePositioning(null, cfg),
    progress: 0,
  }));

  useEffect(() => {
    let smoothed = null;
    let wasOk = false;
    let holdSince = null;
    let lastLoggedKey = null;
    let lastLogAt = 0;

    if (cfg.logDiagnostics) {
      const g = geom;
      console.log(
        `[Positioning] start · screen ${fmt(g.widthCm)}x${fmt(g.heightCm)}cm · lens offset ` +
          `${fmt(g.offsetXCm)},${fmt(g.offsetYCm)}cm · invertX ${g.signX < 0} invertY ${g.signY < 0}`
      );
    }

    const id = setInterval(() => {
      if (doneRef.current) return;
      const now = Date.now();

      const head = trackerRef.current.headRef?.current;
      const fresh = head && now - head.receivedAt <= staleMs ? head.sample : null;
      smoothed = fresh ? smoothMetrics(smoothed, headMetrics(fresh, geom), cfg.smoothing ?? 1) : null;
      metricsRef.current = smoothed;

      const verdict = evaluatePositioning(smoothed, cfg, wasOk);
      wasOk = verdict.ok;

      if (!verdict.ok) holdSince = null;
      else if (holdSince == null) holdSince = now;
      const progress = holdSince == null ? 0 : Math.min(1, (now - holdSince) / cfg.holdStillMs);

      setView({ metrics: smoothed, verdict, progress });

      if (cfg.logDiagnostics) {
        const key = verdict.ok ? 'ok' : verdict.primary;
        if (key !== lastLoggedKey || now - lastLogAt >= (cfg.logIntervalMs ?? 1000)) {
          console.log(logLine(trackerRef.current, smoothed, verdict, progress));
          lastLoggedKey = key;
          lastLogAt = now;
        }
      }

      if (progress >= 1 && autoComplete) {
        doneRef.current = true;
        onReadyRef.current?.({
          ...smoothed,
          softIssues: verdict.soft,
          timeToPositionMs: now - startedAtRef.current,
          skipped: false,
        });
      }
    }, cfg.pollIntervalMs ?? 66);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, cfg]);

  const skip = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onReadyRef.current?.({
      ...(metricsRef.current ?? {}),
      timeToPositionMs: Date.now() - startedAtRef.current,
      skipped: true,
    });
  };

  const { metrics: m, verdict, progress } = view;
  const hasFace = m !== null;
  const color = !hasFace ? COLOR_IDLE : verdict.ok ? COLOR_OK : COLOR_ADJUST;

  // ---------------------------------------------------------------- drawing
  const S = Math.min(window.width * 0.62, 260);
  const R = S / 2;
  const W0 = S * 0.42;
  const H0 = W0 * 1.3;

  let oval = null;
  if (hasFace) {
    // Squared so the size change is visible within the ±tolerance band.
    const k = clamp((cfg.targetDistanceCm / m.distanceCm) ** 2, 0.6, 1.6);
    const W = W0 * k;
    const H = H0 * k;
    // At exactly ±tolerance the oval edge reaches the frame.
    const ox =
      clamp((m.eyeXFromCenterCm - (cfg.targetEyeXFromCenterCm ?? 0)) / cfg.eyeXToleranceCm, -1.8, 1.8) *
      (R - W0 / 2);
    const oy =
      clamp((m.eyeYFromTopCm - cfg.targetEyeYFromTopCm) / cfg.eyeYToleranceCm, -1.8, 1.8) *
      (R - H0 / 2);
    const nx = clamp((m.yawDeg - (cfg.targetYawDeg ?? 0)) / cfg.maxHeadYawDeg, -1.5, 1.5) * W * 0.22;
    const ny = clamp((m.pitchDeg - (cfg.targetPitchDeg ?? 0)) / cfg.maxHeadPitchDeg, -1.5, 1.5) * H * 0.22;
    oval = {
      W, H, left: R + ox - W / 2, top: R + oy - H / 2, nx, ny,
      roll: m.rollDeg - (cfg.targetRollDeg ?? 0),
    };
  }

  // Distance bar: top = close, bottom = far (as on Tobii's track box).
  const span = cfg.distanceToleranceCm * 3;
  const lo = cfg.targetDistanceCm - span;
  const hi = cfg.targetDistanceCm + span;
  const toBar = (d) => clamp((d - lo) / (hi - lo), 0, 1) * S;
  const bandTop = toBar(cfg.targetDistanceCm - cfg.distanceToleranceCm);
  const bandBottom = toBar(cfg.targetDistanceCm + cfg.distanceToleranceCm);

  // ---------------------------------------------------------------- text
  const hintKey = verdict.ok ? 'ok' : verdict.primary;
  let hint = POSITION_HINTS[hintKey] ?? '';
  if (hasFace && (hintKey === 'tooClose' || hintKey === 'tooFar')) {
    hint += ` (${Math.round(m.distanceCm)} cm, στόχος ${Math.round(cfg.targetDistanceCm)})`;
  }
  const softHint = verdict.soft.map((k) => POSITION_HINTS[k]).filter(Boolean).join(' ');

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{title ?? (isReturn ? 'Επιστροφή στη θέση' : 'Τοποθέτηση')}</Text>
        <Text style={styles.subtitle}>
          {subtitle ?? (isReturn
            ? 'Η στάση σου άλλαξε από τη βαθμονόμηση. Γύρνα στην ίδια θέση — συνεχίζουμε μόλις το πλαίσιο γίνει πράσινο.'
            : `Βάλε το πρόσωπό σου μέσα στο πλαίσιο, περίπου ${cfg.targetDistanceCm} cm από την οθόνη. Η βαθμονόμηση ξεκινά μόνη της.`)}
        </Text>
      </View>

      <View style={styles.stage}>
        <View
          style={[
            styles.frame,
            { width: S, height: S, borderColor: color, borderStyle: hasFace ? 'solid' : 'dashed' },
          ]}
        >
          {oval && (
            <View
              style={[
                styles.oval,
                {
                  width: oval.W,
                  height: oval.H,
                  left: oval.left,
                  top: oval.top,
                  borderRadius: oval.W / 2,
                  borderColor: color,
                  transform: [{ rotate: `${oval.roll}deg` }],
                },
              ]}
            >
              <View style={[styles.eye, { left: oval.W * 0.3 - 3, top: oval.H * 0.38 - 3, backgroundColor: color }]} />
              <View style={[styles.eye, { left: oval.W * 0.7 - 3, top: oval.H * 0.38 - 3, backgroundColor: color }]} />
              <View
                style={[
                  styles.nose,
                  {
                    left: oval.W / 2 + oval.nx - 5,
                    top: oval.H * 0.55 + oval.ny - 5,
                    backgroundColor: color,
                  },
                ]}
              />
            </View>
          )}
        </View>

        <View style={[styles.bar, { height: S }]}>
          <Text style={[styles.barLabel, styles.barLabelTop]}>κοντά</Text>
          <View style={[styles.barBand, { top: bandTop, height: bandBottom - bandTop }]} />
          {hasFace && (
            <View style={[styles.barMarker, { top: toBar(m.distanceCm) - 7, backgroundColor: color }]}>
              <Text style={styles.barValue}>{Math.round(m.distanceCm)}</Text>
            </View>
          )}
          <Text style={[styles.barLabel, styles.barLabelBottom]}>μακριά</Text>
        </View>
      </View>

      <View style={styles.hints}>
        <Text style={[styles.hint, { color: hasFace ? '#FFF' : 'rgba(255,255,255,0.7)' }]}>{hint}</Text>
        {!!softHint && <Text style={styles.softHint}>{softHint}</Text>}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>

      {cfg.showDebug && <DebugReadout m={m} issues={verdict.issues} tracker={tracker} />}

      <View style={styles.actions}>
        {onCancel && (
          <Pressable onPress={onCancel} hitSlop={12} style={styles.action}>
            <Text style={styles.actionText}>Ακύρωση</Text>
          </Pressable>
        )}
        {cfg.allowSkip && autoComplete && (
          <Pressable onPress={skip} hitSlop={12} style={styles.action}>
            <Text style={styles.actionText}>Παράλειψη</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));

/** Why there is no face, in the order of what to check first. */
function noFaceReason(tracker) {
  const last = tracker.lastSampleRef?.current;
  if (!tracker.running) return 'ARKit δεν τρέχει';
  if (!last) return `καθόλου δείγματα (status: ${tracker.status})`;
  if (last.headZCm === undefined) return 'δείγματα ΧΩΡΙΣ πόζα κεφαλιού -> τρέχει παλιό native build';
  if (!last.isTracked) return 'πρόσωπο εντοπίστηκε αλλά δεν παρακολουθείται';
  return 'πόζα OK αλλά μπαγιάτικη';
}

/** One console line with everything needed to debug positioning remotely. */
function logLine(tracker, m, verdict, progress) {
  const count = tracker.sampleCountRef?.current ?? 0;
  const base = `[Positioning] samples ${count} · hz ${tracker.readout?.hz ?? '–'} · status ${tracker.status}`;
  if (!m) {
    const last = tracker.lastSampleRef?.current;
    // The keys of the last raw sample show at a glance which native build is running.
    const keys = last ? ` · last sample keys: ${Object.keys(last).sort().join(',')}` : '';
    return `${base} · NO FACE: ${noFaceReason(tracker)}${keys}`;
  }
  return (
    `${base} · d ${fmt(m.distanceCm)}cm x ${fmt(m.eyeXFromCenterCm)} y ${fmt(m.eyeYFromTopCm)}` +
    ` · yaw ${fmt(m.yawDeg, 0)}° pitch ${fmt(m.pitchDeg, 0)}° roll ${fmt(m.rollDeg, 0)}°` +
    ` · tilt ${fmt(m.deviceTiltDeg, 0)}° rot ${fmt(m.deviceRotationDps, 0)}°/s IPD ${fmt(m.interEyeCm)}cm` +
    ` · ${verdict.issues.length ? verdict.issues.join(',') : 'ok'}` +
    (verdict.soft.length ? ` (soft: ${verdict.soft.join(',')})` : '') +
    (progress > 0 ? ` · hold ${Math.round(progress * 100)}%` : '')
  );
}

function DebugReadout({ m, issues, tracker }) {
  const f = fmt;
  const why = noFaceReason(tracker);
  return (
    <View style={styles.debug}>
      {m ? (
        <>
          <Text style={styles.debugText}>
            d {f(m.distanceCm)}cm  x {f(m.eyeXFromCenterCm)}  y {f(m.eyeYFromTopCm)}
          </Text>
          <Text style={styles.debugText}>
            yaw {f(m.yawDeg, 0)}°  pitch {f(m.pitchDeg, 0)}°  roll {f(m.rollDeg, 0)}°
          </Text>
          <Text style={styles.debugText}>
            tilt {f(m.deviceTiltDeg, 0)}°  rot {f(m.deviceRotationDps, 0)}°/s  IPD {f(m.interEyeCm)}cm
          </Text>
        </>
      ) : (
        <Text style={styles.debugText}>χωρίς πρόσωπο: {why}</Text>
      )}
      <Text style={styles.debugText}>
        {issues.length ? issues.join(', ') : 'ok'} · δείγματα {tracker.sampleCountRef?.current ?? 0}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between' },
  header: { paddingHorizontal: 28, paddingTop: 24, alignItems: 'center' },
  title: { color: '#FFF', fontSize: 20, fontWeight: '700' },
  subtitle: {
    color: 'rgba(255,255,255,0.65)', fontSize: 14, lineHeight: 20,
    textAlign: 'center', marginTop: 8,
  },

  stage: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  frame: { borderWidth: 3, borderRadius: 24 },
  oval: { position: 'absolute', borderWidth: 3 },
  eye: { position: 'absolute', width: 6, height: 6, borderRadius: 3 },
  nose: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },

  bar: {
    width: 8, marginLeft: 22, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  barBand: {
    position: 'absolute', left: 0, right: 0, borderRadius: 4,
    backgroundColor: 'rgba(48,209,88,0.45)',
  },
  barMarker: {
    position: 'absolute', left: -5, width: 18, height: 14, borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
  },
  barValue: { position: 'absolute', left: 22, width: 40, color: '#FFF', fontSize: 12, fontVariant: ['tabular-nums'] },
  barLabel: {
    position: 'absolute', left: -21, width: 50, textAlign: 'center',
    color: 'rgba(255,255,255,0.45)', fontSize: 11,
  },
  barLabelTop: { top: -20 },
  barLabelBottom: { bottom: -20 },

  hints: { paddingHorizontal: 28, alignItems: 'center', minHeight: 96 },
  hint: { fontSize: 17, fontWeight: '600', textAlign: 'center', lineHeight: 23 },
  softHint: { color: COLOR_ADJUST, fontSize: 13, textAlign: 'center', marginTop: 8 },
  progressTrack: {
    height: 3, width: '60%', backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2, marginTop: 16, overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: COLOR_OK },

  debug: { alignItems: 'center', paddingHorizontal: 16 },
  debugText: { color: 'rgba(255,255,255,0.45)', fontSize: 11, fontFamily: 'Menlo' },

  actions: { flexDirection: 'row', justifyContent: 'center', gap: 32, paddingBottom: 16 },
  action: { padding: 8 },
  actionText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
});
