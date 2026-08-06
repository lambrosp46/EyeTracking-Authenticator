import React, { useMemo, useState } from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import settings from '../config/settings.json';
import useGazeTracker from '../hooks/useGazeTracker';
import GazeCircle from '../components/GazeCircle';
import CalibrationOverlay from '../components/CalibrationOverlay';
import { cmToPoints } from '../utils/gazeMapping';

/**
 * Standalone harness for the gaze pipeline. Nothing here touches the register or
 * login flows - the point is to confirm the tracker works before it is wired in.
 *
 * IMPORTANT: the gaze cursor is positioned in window coordinates, so this screen
 * must fill the window. If you mount it under a navigation header, either hide
 * the header (`options={{ headerShown: false }}`) or the cursor will sit lower
 * than where the user is actually looking by the height of that header.
 */
export default function GazeTestScreen() {
  const tracker = useGazeTracker();
  const [overlay, setOverlay] = useState(null); // null | 'calibrate' | 'validate'
  const [showGrid, setShowGrid] = useState(false);
  const [showGhost, setShowGhost] = useState(settings.gazeCircle.showRawGhost);

  const window = useMemo(() => Dimensions.get('window'), []);
  const { readout, status, running, error } = tracker;

  const distanceState = distanceHint(readout.distanceCm, settings.eyeTracking.validity);

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>Gaze tracking test</Text>
          <Text style={styles.subtitle}>
            ARKit face tracking, projected onto the screen plane. Debug harness only.
          </Text>

          {/* ---- capability ---- */}
          {!tracker.nativeAvailable && (
            <Banner tone="warn">
              The native module isn't loaded. Build with{' '}
              <Text style={styles.mono}>npx expo run:ios</Text> on a physical device - ARKit
              cannot run in Expo Go or the simulator.
            </Banner>
          )}
          {tracker.nativeAvailable && !tracker.supported && (
            <Banner tone="warn">
              This device has no TrueDepth camera. Face tracking needs an iPhone X or newer.
            </Banner>
          )}
          {error && <Banner tone="error">{error}</Banner>}

          {/* ---- live state ---- */}
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
              <Text style={styles.statusText}>{statusLabel(status)}</Text>
              <Text style={styles.hz}>{readout.hz ? `${readout.hz} Hz` : '—'}</Text>
            </View>

            <View style={styles.grid}>
              <Metric label="x, y (pt)" value={readout.x != null ? `${readout.x}, ${readout.y}` : '—'} />
              <Metric
                label="raw (cm from lens)"
                value={readout.sx != null ? `${(readout.sx * 100).toFixed(1)}, ${(readout.sy * 100).toFixed(1)}` : '—'}
              />
              <Metric
                label="distance"
                value={readout.distanceCm != null ? `${readout.distanceCm.toFixed(0)} cm` : '—'}
                tone={distanceState.tone}
                hint={distanceState.hint}
              />
              <Metric
                label="eye agreement"
                value={readout.eyeDisparityCm != null ? `${readout.eyeDisparityCm.toFixed(1)} cm` : '—'}
              />
              <Metric label="blink L / R" value={formatBlink(readout)} />
              <Metric
                label="calibration"
                value={tracker.isCalibrated ? tracker.calibration.model : 'none'}
                tone={tracker.isCalibrated ? 'ok' : 'warn'}
              />
            </View>
          </View>

          {/* ---- controls ---- */}
          <View style={styles.buttonRow}>
            <Button
              label={running ? 'Stop tracking' : 'Start tracking'}
              primary={!running}
              onPress={() => (running ? tracker.stop() : tracker.start())}
            />
          </View>

          <View style={styles.buttonRow}>
            <Button label="Calibrate" onPress={() => setOverlay('calibrate')} disabled={!running} />
            <Button
              label="Check accuracy"
              onPress={() => setOverlay('validate')}
              disabled={!running || !tracker.isCalibrated}
            />
          </View>

          <View style={styles.toggles}>
            <Toggle label="Reference grid" value={showGrid} onPress={() => setShowGrid((v) => !v)} />
            <Toggle label="Uncalibrated ghost" value={showGhost} onPress={() => setShowGhost((v) => !v)} />
          </View>

          {tracker.isCalibrated && (
            <Pressable onPress={tracker.resetCalibration} style={styles.reset}>
              <Text style={styles.resetText}>Delete saved calibration</Text>
            </Pressable>
          )}

          <Text style={styles.footnote}>
            The circle is {settings.gazeCircle.diameterCm} cm across - the same size as a
            selectable point. If it can sit inside the grid dots without drifting, the tracker
            is accurate enough to try in the real flow.
          </Text>
        </ScrollView>
      </SafeAreaView>

      {/* ---- overlays (absolute, window coordinates) ---- */}
      {showGrid && <ReferenceGrid window={window} />}

      {showGhost && (
        <GazeCircle
          position={tracker.rawPosition}
          visibility={tracker.visibility}
          diameterCm={settings.gazeCircle.diameterCm}
          color={settings.gazeCircle.rawGhostColor}
          borderColor={settings.gazeCircle.rawGhostBorderColor}
          borderWidth={1}
          showCrosshair={false}
        />
      )}

      {settings.gazeCircle.enabled && (
        <GazeCircle position={tracker.position} visibility={tracker.visibility} />
      )}

      <CalibrationOverlay
        visible={overlay !== null}
        mode={overlay ?? 'calibrate'}
        tracker={tracker}
        onClose={() => setOverlay(null)}
      />
    </View>
  );
}

/** Fixed dots at known positions - look at one and see how far the cursor lands. */
function ReferenceGrid({ window }) {
  const size = cmToPoints(1.5);
  const positions = [];
  for (const fy of [0.15, 0.5, 0.85]) {
    for (const fx of [0.15, 0.5, 0.85]) {
      positions.push({ x: fx * window.width, y: fy * window.height });
    }
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {positions.map((p, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: p.x - size / 2,
            top: p.y - size / 2,
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.35)',
            borderStyle: 'dashed',
          }}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- small pieces

function Metric({ label, value, tone = 'default', hint }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, tone === 'warn' && styles.warnText, tone === 'ok' && styles.okText]}>
        {value}
      </Text>
      {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
    </View>
  );
}

function Button({ label, onPress, primary, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ label, value, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, value && styles.toggleOn]}>
      <Text style={[styles.toggleText, value && styles.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

function Banner({ tone, children }) {
  return (
    <View style={[styles.banner, tone === 'error' && styles.bannerError]}>
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

function statusLabel(status) {
  return {
    idle: 'Stopped',
    searching: 'Looking for a face',
    tracking: 'Tracking',
    interrupted: 'Interrupted',
    error: 'Error',
  }[status] ?? status;
}

function statusColor(status) {
  return {
    idle: '#8E8E93',
    searching: '#FFD60A',
    tracking: '#30D158',
    interrupted: '#FF9F0A',
    error: '#FF453A',
  }[status] ?? '#8E8E93';
}

function distanceHint(distanceCm, validity) {
  if (distanceCm == null) return { tone: 'default' };
  if (distanceCm < validity.minFaceDistanceCm) return { tone: 'warn', hint: 'too close' };
  if (distanceCm > validity.maxFaceDistanceCm) return { tone: 'warn', hint: 'too far' };
  return { tone: 'ok' };
}

function formatBlink({ blinkLeft, blinkRight }) {
  if (blinkLeft == null) return '—';
  return `${blinkLeft.toFixed(2)} / ${blinkRight.toFixed(2)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0B0F' },
  safe: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 48, gap: 14 },

  title: { color: '#FFF', fontSize: 26, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.45)', fontSize: 14, lineHeight: 20, marginTop: -6 },

  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    padding: 16,
    gap: 14,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: '#FFF', fontSize: 15, fontWeight: '600', flex: 1 },
  hz: { color: 'rgba(255,255,255,0.4)', fontSize: 13, fontVariant: ['tabular-nums'] },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  metric: { width: '50%', paddingVertical: 6 },
  metricLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  metricValue: { color: '#FFF', fontSize: 16, fontVariant: ['tabular-nums'], marginTop: 2 },
  metricHint: { color: '#FF9F0A', fontSize: 11, marginTop: 1 },
  warnText: { color: '#FF9F0A' },
  okText: { color: '#30D158' },

  buttonRow: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  buttonPrimary: { backgroundColor: '#0A84FF' },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { backgroundColor: 'rgba(255,255,255,0.05)' },
  buttonText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  buttonTextDisabled: { color: 'rgba(255,255,255,0.3)' },

  toggles: { flexDirection: 'row', gap: 10 },
  toggle: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  toggleOn: { borderColor: '#0A84FF', backgroundColor: 'rgba(10,132,255,0.15)' },
  toggleText: { color: 'rgba(255,255,255,0.5)', fontSize: 13 },
  toggleTextOn: { color: '#0A84FF' },

  reset: { paddingVertical: 10, alignItems: 'center' },
  resetText: { color: '#FF453A', fontSize: 14 },

  footnote: { color: 'rgba(255,255,255,0.35)', fontSize: 12, lineHeight: 18 },

  banner: {
    backgroundColor: 'rgba(255,159,10,0.15)',
    borderRadius: 12,
    padding: 14,
  },
  bannerError: { backgroundColor: 'rgba(255,69,58,0.15)' },
  bannerText: { color: '#FFF', fontSize: 13, lineHeight: 19 },
  mono: { fontFamily: 'Menlo', fontSize: 12 },
});
