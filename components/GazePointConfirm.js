import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import settings from '../config/settings.json';
import { cmToPoints, pointsToCm } from '../utils/gazeMapping';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (v) => {
  const a = [...v].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// These MUST match PointSelector's sizing exactly. PointSelector sizes its box
// to the image's true aspect ratio so the image fills it edge to edge, and
// normalises taps against that box. If this view letterboxed the image instead
// (resizeMode 'contain' inside a flexible container), gaze would be normalised
// against the container including the empty bars, and every confirmed point
// would land offset from where the user actually looked.
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const BOX_WIDTH = SCREEN_WIDTH * settings.pointSelector.screenCoverage;
const MAX_BOX_HEIGHT = SCREEN_HEIGHT * 1.5;

/**
 * Confirms the freshly-tapped password points by having the user look at them.
 *
 * Why gaze-confirm instead of a second tap pass: tapping twice only proves the
 * user can repeat a tap. Looking at the points proves the points are actually
 * reachable *by gaze* at this user's accuracy — which is the thing that decides
 * whether they'll ever be able to log in. A point that sits too close to a
 * screen edge, or two points closer together than the gaze error, fails here at
 * registration instead of silently becoming an un-loginable account.
 *
 * Capture is dwell-based. Gaze samples are buffered over a sliding window; when
 * every sample in the window sits within `stabilityRadiusCm` of their centroid,
 * that centroid is committed as a fixation. The gaze then has to travel beyond
 * `releaseRadiusCm` before the next point can be captured, so one long stare
 * can't register as several points.
 */
export default function GazePointConfirm({
  imageUri,
  tracker,
  expectedCount = settings.pointSelector.maxPoints,
  onComplete,
  onCancel,
  title,
  subtitle,
  // Overrides for settings.gazeConfirm. Registration passes nothing and gets
  // the defaults; login passes settings.gazeAuth so the two passes can be
  // tuned independently. Registration's gaze pass is a feasibility check on
  // points the user has just tapped, while login's IS the credential, so it
  // wants a tighter dwell and no on-screen trace of where the user looked.
  config,
  showUndo = true,
  showReset = true,
}) {
  // `config` comes straight from a settings.json import, so its identity is
  // stable across renders and this memo effectively runs once per mount.
  const cfg = useMemo(() => ({ ...settings.gazeConfirm, ...(config ?? {}) }), [config]);

  const [captured, setCaptured] = useState([]);
  const [imageRect, setImageRect] = useState(null);
  const [boxSize, setBoxSize] = useState({ width: BOX_WIDTH, height: BOX_WIDTH });
  const [dwellProgress, setDwellProgress] = useState(0);
  const [armed, setArmed] = useState(true);

  // ---- drift check -------------------------------------------------------
  // Before any point is captured, the user looks at a few fixed, neutral dots
  // (the same for everyone, unrelated to the password). Their mean landing
  // offset - measured NOW, in the pose the points will be looked at in - is
  // subtracted from all gaze until this screen closes. It catches whatever
  // shifted the mapping since calibration: a pose change, ARKit drift, or an
  // over-eager head-pose correction (pilot: a uniform 2.2 cm shift).
  const driftCfg = cfg.driftCheck ?? {};
  const useDrift = driftCfg.enabled === true && typeof tracker.setDriftCorrection === 'function';
  const [driftPhase, setDriftPhase] = useState(useDrift ? 'pending' : 'done'); // pending | running | done
  const [driftDot, setDriftDot] = useState(null); // { nx, ny, n, total, collecting }
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  const imageRectRef = useRef(null);

  const imageRef = useRef(null);
  const bufferRef = useRef([]);
  const lastCaptureRef = useRef(null);
  const capturedRef = useRef([]);
  const stableCountRef = useRef(0);

  // Same aspect-ratio derivation as PointSelector.
  useEffect(() => {
    if (!imageUri) return;
    Image.getSize(
      imageUri,
      (naturalWidth, naturalHeight) => {
        const aspect = naturalWidth / naturalHeight;
        let width = BOX_WIDTH;
        let height = width / aspect;
        if (height > MAX_BOX_HEIGHT) {
          height = MAX_BOX_HEIGHT;
          width = height * aspect;
        }
        setBoxSize({ width, height });
      },
      (error) => {
        console.warn('GazePointConfirm: could not read image size', error);
        setBoxSize({ width: BOX_WIDTH, height: BOX_WIDTH });
      }
    );
  }, [imageUri]);

  useEffect(() => {
    imageRectRef.current = imageRect;
  }, [imageRect]);

  // Runs once per mount. Deliberately NOT keyed on driftPhase: setting it to
  // 'running' would otherwise trigger this effect's cleanup and cancel the check.
  const driftStartedRef = useRef(false);
  useEffect(() => {
    if (!useDrift || !imageRect || driftStartedRef.current) return undefined;
    driftStartedRef.current = true;
    let cancelled = false;
    const t = trackerRef.current;

    (async () => {
      // the image rect must have settled, like for normal captures
      while (!cancelled && stableCountRef.current < 2) await wait(100);
      if (cancelled) return;
      setDriftPhase('running');
      t.setDriftCorrection(null); // measure the uncorrected mapping

      const points = driftCfg.points ?? [[0.5, 0.1], [0.12, 0.9], [0.88, 0.9]];
      const rounds = driftCfg.maxRounds ?? 2;
      let applied = null;

      for (let round = 1; round <= rounds && !cancelled; round++) {
        const offsets = [];
        for (let i = 0; i < points.length && !cancelled; i++) {
          const [nx, ny] = points[i];
          setDriftDot({ nx, ny, n: i + 1, total: points.length, collecting: false });
          // The first dot appears with the screen: the eye needs longer to find it.
          await wait(i === 0 ? (driftCfg.firstWarmupMs ?? 1200) : (driftCfg.warmupMs ?? 700));
          if (cancelled) return;
          setDriftDot({ nx, ny, n: i + 1, total: points.length, collecting: true });
          t.beginCollect();
          await wait(driftCfg.dwellMs ?? 1000);
          const samples = t.endCollect();
          const rect = imageRectRef.current;
          if (!rect || samples.length < (driftCfg.minSamples ?? 8)) {
            offsets.push(null);
            continue;
          }
          const tx = rect.x + nx * rect.width;
          const ty = rect.y + ny * rect.height;
          offsets.push({ dx: median(samples.map((p) => p.x)) - tx, dy: median(samples.map((p) => p.y)) - ty });
        }
        if (cancelled) return;

        const ok = offsets.filter(Boolean);
        const lastRound = round === rounds;
        let spreadCm = Infinity;
        if (ok.length === points.length) {
          spreadCm = 0;
          for (const a of ok) for (const b of ok) spreadCm = Math.max(spreadCm, pointsToCm(Math.hypot(a.dx - b.dx, a.dy - b.dy)));
        }
        const fmt = (o) => (o ? `(${pointsToCm(o.dx).toFixed(2)}, ${pointsToCm(o.dy).toFixed(2)})` : '(no samples)');
        console.log(
          `[DriftCheck] round ${round}: offsets cm ${offsets.map(fmt).join(' ')} · spread ${Number.isFinite(spreadCm) ? spreadCm.toFixed(2) : '-'}cm`
        );
        // The dots must agree with each other: if they don't, the user probably
        // wasn't looking at one of them, and the mean would be a guess.
        if (spreadCm <= (driftCfg.maxSpreadCm ?? 2.0)) {
          let dx = ok.reduce((a, o) => a + o.dx, 0) / ok.length;
          let dy = ok.reduce((a, o) => a + o.dy, 0) / ok.length;
          // A small mean offset is just the normal per-point error of the fit
          // (~0.5-1 cm, different at each spot); "correcting" it moves some
          // points closer and others further. Only a clear common shift is fixed.
          if (pointsToCm(Math.hypot(dx, dy)) < (driftCfg.minCorrectionCm ?? 0.4)) {
            console.log(`[DriftCheck] shift ${pointsToCm(Math.hypot(dx, dy)).toFixed(2)}cm is within normal error - no correction needed`);
            applied = null;
            break;
          }
          const maxPts = cmToPoints(driftCfg.maxCorrectionCm ?? 3);
          const mag = Math.hypot(dx, dy);
          if (mag > maxPts) {
            dx *= maxPts / mag;
            dy *= maxPts / mag;
          }
          applied = { dx, dy };
          break;
        }
        if (lastRound) console.log('[DriftCheck] dots disagreed - continuing WITHOUT correction');
      }
      if (cancelled) return;

      t.setDriftCorrection(applied);
      if (applied) {
        console.log(`[DriftCheck] applied correction dx ${pointsToCm(-applied.dx).toFixed(2)}cm dy ${pointsToCm(-applied.dy).toFixed(2)}cm`);
      }
      setDriftDot(null);
      setDriftPhase('done');
    })();

    return () => {
      cancelled = true;
      t.endCollect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDrift, imageRect != null]);

  // The correction belongs to this screen only.
  useEffect(() => () => trackerRef.current.setDriftCorrection?.(null), []);

  const stabilityRadius = cmToPoints(cfg.stabilityRadiusCm);
  const releaseRadius = cmToPoints(cfg.releaseRadiusCm);

  // The gaze cursor lives in window coordinates, so the image's on-screen rect
  // has to be measured in the same space before gaze can be normalised against
  // it. measureInWindow (not onLayout's local coords) is what makes this work
  // inside a modal.
  const handleImageLayout = useCallback(() => {
    requestAnimationFrame(() => {
      imageRef.current?.measureInWindow((x, y, width, height) => {
        if (!(width > 0 && height > 0)) return;
        setImageRect((prev) => {
          // The modal slides in, so an early measurement catches the view
          // mid-animation and reports a y that is too large - which would push
          // every captured point upwards. Only trust the rect once two
          // consecutive measurements agree.
          if (prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5) {
            stableCountRef.current += 1;
            return prev;
          }
          stableCountRef.current = 0;
          return { x, y, width, height };
        });
      });
    });
  }, []);

  // Re-measure once the box has been resized to the image aspect ratio, then
  // keep re-measuring: the modal presentation animation, rotation, or a layout
  // pass can all move the box after the first measurement.
  useEffect(() => {
    handleImageLayout();
    const id = setInterval(handleImageLayout, 400);
    return () => clearInterval(id);
  }, [boxSize.width, boxSize.height, handleImageLayout]);

  const commit = useCallback(
    (point) => {
      const next = [...capturedRef.current, point];
      if (cfg.logPoints) {
        console.log(
          `[GazeConfirm] captured #${next.length}`,
          `window(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`,
          `normalized(${((point.x - imageRect.x) / imageRect.width).toFixed(4)}, ` +
            `${((point.y - imageRect.y) / imageRect.height).toFixed(4)})`
        );
      }
      capturedRef.current = next;
      setCaptured(next);
      bufferRef.current = [];
      lastCaptureRef.current = point;
      setArmed(false);
      setDwellProgress(0);

      if (next.length >= expectedCount) {
        const normalized = next.map((p) => ({
          x: (p.x - imageRect.x) / imageRect.width,
          y: (p.y - imageRect.y) / imageRect.height,
        }));
        // The box size travels with the points so the caller can convert
        // normalized distances back into real centimetres.
        onComplete?.(normalized, {
          boxSize: { width: imageRect.width, height: imageRect.height },
          windowPoints: next,
        });
      }
    },
    [cfg, expectedCount, imageRect, onComplete]
  );

  useEffect(() => {
    if (!imageRect) return undefined;
    if (driftPhase !== 'done') return undefined; // no captures during the drift check
    if (captured.length >= expectedCount) return undefined;

    const id = setInterval(() => {
      // Don't record anything until the measured image rect has settled,
      // otherwise points get normalised against a mid-animation position.
      if (stableCountRef.current < 2) return;

      const latest = tracker.latestRef.current;
      const now = Date.now();

      if (!latest?.valid) {
        bufferRef.current = [];
        setDwellProgress(0);
        return;
      }

      const g = { x: latest.x, y: latest.y };

      // Re-arm once the gaze has clearly left the last captured point.
      if (!armed) {
        if (
          !lastCaptureRef.current ||
          Math.hypot(g.x - lastCaptureRef.current.x, g.y - lastCaptureRef.current.y) > releaseRadius
        ) {
          setArmed(true);
        }
        return;
      }

      const buf = bufferRef.current;
      buf.push({ ...g, t: now });
      while (buf.length && now - buf[0].t > cfg.dwellMs) buf.shift();

      if (buf.length < 3) return;

      const cx = buf.reduce((a, p) => a + p.x, 0) / buf.length;
      const cy = buf.reduce((a, p) => a + p.y, 0) / buf.length;
      const spread = Math.max(...buf.map((p) => Math.hypot(p.x - cx, p.y - cy)));

      if (spread > stabilityRadius) {
        // Gaze moved — restart the dwell rather than averaging across a saccade.
        bufferRef.current = [{ ...g, t: now }];
        setDwellProgress(0);
        return;
      }

      const held = now - buf[0].t;
      setDwellProgress(Math.min(1, held / cfg.dwellMs));

      if (held >= cfg.dwellMs) commit({ x: cx, y: cy });
    }, cfg.pollIntervalMs);

    return () => clearInterval(id);
  }, [cfg, imageRect, captured.length, armed, expectedCount, commit, releaseRadius, stabilityRadius, tracker, driftPhase]);

  const undo = () => {
    const next = capturedRef.current.slice(0, -1);
    capturedRef.current = next;
    setCaptured(next);
    bufferRef.current = [];
    lastCaptureRef.current = next[next.length - 1] ?? null;
    setArmed(true);
    setDwellProgress(0);
  };

  const reset = () => {
    capturedRef.current = [];
    setCaptured([]);
    bufferRef.current = [];
    lastCaptureRef.current = null;
    setArmed(true);
    setDwellProgress(0);
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>
        {title ?? 'Κοίτα τα σημεία σου με τη σειρά'}
      </Text>
      <Text style={styles.subtitle}>
        {driftPhase !== 'done'
          ? `Γρήγορος έλεγχος: κοίτα την κίτρινη κουκκίδα${driftDot ? ` (${driftDot.n}/${driftDot.total})` : ''}`
          : subtitle ??
          (armed
            ? `Κράτησε το βλέμμα σου σταθερό (${captured.length + 1}/${expectedCount})`
            : 'Κοίτα αλλού για το επόμενο σημείο')}
      </Text>

      <View style={styles.imageOuter}>
        <View
          ref={imageRef}
          style={[styles.imageBox, { width: boxSize.width, height: boxSize.height }]}
          onLayout={handleImageLayout}
        >
          <Image
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="stretch"
          />

        {!imageRect && (
          <View style={styles.overlayCentre}>
            <ActivityIndicator />
          </View>
        )}

        {driftDot && imageRect && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[StyleSheet.absoluteFill, styles.driftDim]} />
            <View
              style={[
                styles.driftDot,
                {
                  left: driftDot.nx * boxSize.width - DRIFT_DOT / 2,
                  top: driftDot.ny * boxSize.height - DRIFT_DOT / 2,
                  backgroundColor: driftDot.collecting ? '#FFD60A' : 'transparent',
                },
              ]}
            >
              <View style={[styles.driftCore, { backgroundColor: driftDot.collecting ? '#000' : '#FFD60A' }]} />
            </View>
          </View>
        )}

        {cfg.showCapturedPoints &&
          imageRect &&
          captured.map((p, i) => (
            <View
              key={i}
              pointerEvents="none"
              style={[
                styles.capturedDot,
                {
                  left: p.x - imageRect.x - cmToPoints(settings.pointSelector.dotDiameterCm) / 2,
                  top: p.y - imageRect.y - cmToPoints(settings.pointSelector.dotDiameterCm) / 2,
                  width: cmToPoints(settings.pointSelector.dotDiameterCm),
                  height: cmToPoints(settings.pointSelector.dotDiameterCm),
                  borderRadius: cmToPoints(settings.pointSelector.dotDiameterCm) / 2,
                },
              ]}
            >
              <Text style={styles.capturedIndex}>{i + 1}</Text>
            </View>
          ))}
        </View>
      </View>

      {cfg.showProgress && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${dwellProgress * 100}%` }]} />
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity onPress={onCancel} style={styles.ghostButton}>
          <Text style={styles.ghostText}>Ακύρωση</Text>
        </TouchableOpacity>
        {showUndo && (
          <TouchableOpacity onPress={undo} disabled={!captured.length} style={styles.ghostButton}>
            <Text style={[styles.ghostText, !captured.length && styles.disabled]}>Αναίρεση</Text>
          </TouchableOpacity>
        )}
        {showReset && (
          <TouchableOpacity onPress={reset} disabled={!captured.length} style={styles.ghostButton}>
            <Text style={[styles.ghostText, !captured.length && styles.disabled]}>Επανεκκίνηση</Text>
          </TouchableOpacity>
        )}
      </View>

    </View>
  );
}

const DRIFT_DOT = cmToPoints(1.2);

const styles = StyleSheet.create({
  driftDim: { backgroundColor: 'rgba(0,0,0,0.55)' },
  driftDot: {
    position: 'absolute', width: DRIFT_DOT, height: DRIFT_DOT, borderRadius: DRIFT_DOT / 2,
    borderWidth: 2, borderColor: '#FFD60A', alignItems: 'center', justifyContent: 'center',
  },
  driftCore: { width: 4, height: 4, borderRadius: 2 },
  root: { flex: 1, backgroundColor: '#fff' },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginTop: 12, color: '#111827' },
  subtitle: { fontSize: 14, textAlign: 'center', marginTop: 4, marginBottom: 12, color: '#6b7280' },
  imageOuter: { flex: 1, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  imageBox: { position: 'relative', overflow: 'hidden' },
  overlayCentre: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  capturedDot: {
    position: 'absolute',
    backgroundColor: 'rgba(76,175,80,0.35)',
    borderWidth: 2,
    borderColor: '#2e7d32',
    alignItems: 'center',
    justifyContent: 'center',
  },
  capturedIndex: { color: '#fff', fontWeight: '700', fontSize: 12 },
  progressTrack: {
    height: 4,
    marginHorizontal: 24,
    marginTop: 10,
    backgroundColor: '#e5e7eb',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: '#4f46e5' },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16 },
  ghostButton: { padding: 8 },
  ghostText: { color: '#4f46e5', fontWeight: '600', fontSize: 14 },
  disabled: { color: '#9ca3af' },
});
