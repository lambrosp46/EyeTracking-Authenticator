import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';

import settings from '../config/settings.json';
import CalibrationOverlay from '../components/CalibrationOverlay';
import GazeCircle from '../components/GazeCircle';
import GazePointConfirm from '../components/GazePointConfirm';
import PositionGuide from '../components/PositionGuide';
import useGazeTracker from '../hooks/useGazeTracker';
import { cropToStandardAspectRatio } from '../utils/imageAspect';
import { pointsToCm } from '../utils/gazeMapping';
import { pointsMatchPhysical } from '../utils/points';

const cfg = settings.gazeAuth;

// iOS will not present a new modal while another is still dismissing, and a
// view sitting behind a full-screen modal cannot be measured reliably. Wait for
// the calibration overlay to finish going away before mounting the gaze pass,
// otherwise measureInWindow reports a mid-animation rect and every captured
// point lands offset from where the user actually looked.
const MODAL_SWAP_MS = 450;

/**
 * Login by gaze.
 *
 * The user looks at their five password points in order; each one is captured
 * by dwell (see GazePointConfirm) and nothing is compared until all five are
 * in. Evaluating the whole sequence at the end rather than point by point is
 * deliberate: per-point feedback would turn one 5-point secret into five
 * independent 1-point guesses, and would also tell an attacker which point
 * they got right.
 *
 * Calibration runs at the start of every login, not once per install. Viewing
 * distance, posture and lighting all change between sessions, and a stale fit
 * shows up as a false rejection that has nothing to do with the password.
 *
 * Flow:
 *   'prepare'   -> crop the stored image, start the ARKit session
 *   'calibrate' -> fit this session's gaze mapping
 *   'gaze'      -> look at the five points; verdict on the fifth
 */
export default function AuthPointsScreen({ route, navigation }) {
  const { username, userId, imageUri, storedPoints } = route.params;

  const tracker = useGazeTracker();

  const [displayUri, setDisplayUri] = useState(null);
  const [stage, setStage] = useState('prepare');
  const [statusText, setStatusText] = useState('Προετοιμασία εικόνας…');
  const [attempts, setAttempts] = useState(0);
  // Bumped after every failed attempt to remount GazePointConfirm, which clears
  // its captured points and re-arms the dwell detector.
  const [attemptKey, setAttemptKey] = useState(0);

  // useGazeTracker returns a fresh object every render and re-renders this
  // screen ~5x/sec (its throttled debug readout). Nothing here may close over
  // `tracker` directly, or every callback below gets a new identity 5 times a
  // second - which would silently re-arm the attempt timeout forever and never
  // let it fire. Refs keep the identities stable.
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;

  const attemptsRef = useRef(0);
  // One attempt can be ended either by the fifth capture or by the timeout.
  // Whichever gets there first sets this, so the other becomes a no-op.
  const settledRef = useRef(false);
  // CalibrationOverlay fires onComplete then onClose synchronously, so onClose
  // cannot read state that onComplete just set. A ref sees the write at once.
  const calibrationDoneRef = useRef(false);
  const startedRef = useRef(false);
  const finishingRef = useRef(false);

  const toleranceCm = cfg.matchToleranceCm ?? settings.pointSelector.dotDiameterCm;

  // Lifecycle logs: if a login ever stops early, these show where.
  useEffect(() => {
    console.log(`[GazeLogin] screen opened for "${username}" (user ${userId}, ${storedPoints?.length ?? 0} stored points)`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    console.log(`[GazeLogin] stage -> ${stage}`);
  }, [stage]);
  const maxAttempts = cfg.maxAttempts ?? settings.authentication.maxAttempts;

  // Re-crop the stored image to the standard aspect ratio before showing it.
  // ImageCapture already crops at registration, so for current accounts this is
  // a no-op that returns the same URI; it matters only for images stored before
  // that crop existed, whose points were normalised against a different box.
  useEffect(() => {
    let cancelled = false;
    cropToStandardAspectRatio(imageUri)
      .then((uri) => {
        console.log('[GazeLogin] image ready');
        if (!cancelled) setDisplayUri(uri);
      })
      .catch((e) => {
        console.warn('[GazeLogin] image crop failed, using the original', e);
        if (!cancelled) setDisplayUri(imageUri);
      });
    return () => {
      cancelled = true;
    };
  }, [imageUri]);

  const leave = useCallback(
    (toHome) => {
      finishingRef.current = true;
      trackerRef.current.stop();
      if (toHome) navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
      else navigation.goBack();
    },
    [navigation]
  );

  // Stop the ARKit session on unmount however the screen is left (back gesture,
  // header back button, reset) - not just through our own buttons.
  useEffect(() => {
    return () => {
      trackerRef.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start the session once the image is ready. The session has to be live
  // before the calibration overlay opens, otherwise it has no samples to fit.
  useEffect(() => {
    if (!displayUri || startedRef.current) return;
    startedRef.current = true;

    (async () => {
      setStatusText('Εκκίνηση eye tracking…');
      const ok = await trackerRef.current.start();
      console.log('[GazeLogin] tracker.start ->', ok, 'error:', trackerRef.current.error);
      if (finishingRef.current) return;

      if (!ok) {
        Alert.alert(
          'Το eye tracking δεν είναι διαθέσιμο',
          trackerRef.current.error ??
            'Χρειάζεται συσκευή με TrueDepth κάμερα και development build. Δες την οθόνη Gaze Test.',
          [{ text: 'OK', onPress: () => leave(false) }]
        );
        return;
      }

      if (!cfg.requireCalibration) {
        setStage('gaze');
        return;
      }
      setStatusText('Βαθμονόμηση…');
      setStage('calibrate');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayUri]);

  const handleCalibrationComplete = useCallback(
    (result) => {
      if (!result?.calibration) {
        leave(false);
        return;
      }
      calibrationDoneRef.current = true;

      const errCm = result.quality?.loo?.rmseCm ?? result.quality?.rmseCm;
      if (errCm != null) {
        const limit = settings.calibration.maxAcceptableErrorCm;
        console.log(
          `[GazeLogin] calibration error at new points ${errCm.toFixed(2)}cm ` +
            `(limit ${limit}cm)${errCm > limit ? ' -- ABOVE LIMIT' : ''}`
        );
      }

      setTimeout(() => {
        if (finishingRef.current) return;
        settledRef.current = false;
        setStage('gaze');
      }, MODAL_SWAP_MS);
    },
    [leave]
  );

  const failAttempt = useCallback(
    (reason) => {
      const next = attemptsRef.current + 1;
      attemptsRef.current = next;
      setAttempts(next);

      if (next >= maxAttempts) {
        Alert.alert(
          'Η σύνδεση απέτυχε',
          'Πάρα πολλές αποτυχημένες προσπάθειες. Ξεκίνα από την αρχή.',
          [{ text: 'OK', onPress: () => leave(true) }]
        );
        return;
      }

      // Deliberately generic: the user is told only that the attempt failed,
      // never which point missed or by how much. The per-point distances go to
      // the console for the evaluation, not to the screen.
      const message =
        reason === 'timeout'
          ? `Έληξε ο χρόνος για αυτή την προσπάθεια. Προσπάθεια ${next + 1}/${maxAttempts}.`
          : `Τα σημεία δεν ταιριάζουν. Προσπάθεια ${next + 1}/${maxAttempts}.`;

      Alert.alert('Η σύνδεση απέτυχε', message, [
        {
          text: 'Δοκίμασε ξανά',
          onPress: () => {
            settledRef.current = false;
            setAttemptKey((k) => k + 1);
          },
        },
      ]);
    },
    [leave, maxAttempts]
  );

  // Read through a ref inside the timeout effect below, so that effect can
  // depend only on the attempt actually changing.
  const failAttemptRef = useRef(failAttempt);
  failAttemptRef.current = failAttempt;

  const handleAttempt = useCallback(
    (gazePoints, meta) => {
      if (settledRef.current) return;
      settledRef.current = true;
      // The attempt is over: no pose lock while the result is on screen (the
      // user lowers the phone to read it). The next attempt switches it on again.
      trackerRef.current.setPoseLockActive(false);

      const stored = [...storedPoints].sort((a, b) => a.point_index - b.point_index);

      // Matching rule: the gaze dot and the stored dot count as the same point
      // when their circles touch, i.e. centre-to-centre distance <= the sum of
      // the radii. Comparing in centimetres rather than normalized units keeps
      // the tolerance a true circle whatever the image's aspect ratio, and
      // keeps it independent of screen size and density.
      const result = pointsMatchPhysical(
        gazePoints,
        stored,
        meta?.boxSize ?? { width: 1, height: 1 },
        toleranceCm,
        pointsToCm
      );

      if (cfg.logPoints) {
        console.log(`[GazeLogin] --- attempt ${attemptsRef.current + 1} for "${username}" ---`);
        console.log('[GazeLogin] tolerance:', toleranceCm.toFixed(2), 'cm');
        result.details.forEach((d) => {
          console.log(
            `[GazeLogin] point ${d.index + 1}: ` +
              `stored(${d.expected.x.toFixed(4)}, ${d.expected.y.toFixed(4)}) ` +
              `gaze(${d.gaze.x.toFixed(4)}, ${d.gaze.y.toFixed(4)}) ` +
              `distance ${d.distanceCm.toFixed(2)}cm -> ${d.ok ? 'OK' : 'FAIL'}`
          );
        });
        console.log('[GazeLogin] verdict:', result.ok ? 'MATCH' : 'NO MATCH');
      }

      if (result.ok) {
        Alert.alert('Επιτυχής σύνδεση', `Καλώς όρισες, ${username}!`, [
          { text: 'OK', onPress: () => leave(true) },
        ]);
        return;
      }

      failAttempt('mismatch');
    },
    [failAttempt, leave, storedPoints, toleranceCm, username]
  );

  // Per-attempt ceiling. Without it, a user who simply cannot land a dwell on
  // one of their points sits on this screen forever with no way forward except
  // Cancel, and the attempt is never recorded as a failure.
  // The clock only runs while the user can actually capture points: it is
  // paused while the pose lock is engaged and while drift-check dots are on
  // screen (the check at the start and the re-check after each pose lock).
  const driftBusyRef = useRef(false);
  const handleDriftBusy = useCallback((busy) => {
    driftBusyRef.current = busy;
  }, []);
  useEffect(() => {
    if (stage !== 'gaze' || !cfg.attemptTimeoutMs) return undefined;
    let elapsed = 0;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const paused = trackerRef.current.poseLock?.locked === true || driftBusyRef.current;
      if (!paused) elapsed += now - last;
      last = now;
      if (elapsed < cfg.attemptTimeoutMs) return;
      clearInterval(id);
      if (settledRef.current) return;
      settledRef.current = true;
      trackerRef.current.setPoseLockActive(false);
      console.log(`[GazeLogin] attempt timed out after ${Math.round(elapsed / 1000)}s of active time`);
      failAttemptRef.current('timeout');
    }, 250);
    return () => clearInterval(id);
  }, [stage, attemptKey]);

  // Pose lock for the gaze pass: if the head leaves the pose the calibration
  // was made in, the tracker stops counting gaze (no dwell can complete, for
  // ANY point - nothing leaks about the password) and the guide below takes
  // the user back. Released automatically once the pose is back.
  useEffect(() => {
    if (stage !== 'gaze') return undefined;
    trackerRef.current.setPoseLockActive(true);
    return () => trackerRef.current.setPoseLockActive(false);
  }, [stage, attemptKey]); // on again for every new attempt

  const gazeReady = stage === 'gaze' && displayUri;
  const poseLocked = gazeReady && tracker.poseLock?.locked && tracker.calibration?.pose;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        {gazeReady ? (
          <GazePointConfirm
            key={attemptKey}
            imageUri={displayUri}
            tracker={tracker}
            expectedCount={storedPoints.length}
            config={cfg}
            showUndo={cfg.allowUndo}
            showReset={cfg.allowReset}
            title={`Κοίτα τα σημεία του κωδικού σου με τη σειρά (${attempts + 1}/${maxAttempts})`}
            onComplete={handleAttempt}
            onCancel={() => leave(false)}
            onDriftBusyChange={handleDriftBusy}
          />
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator />
            <Text style={styles.loadingText}>{statusText}</Text>
            <TouchableOpacity style={styles.cancelButton} onPress={() => leave(false)}>
              <Text style={styles.cancelButtonText}>Ακύρωση</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>

      {/*
        The gaze cursor must sit OUTSIDE the SafeAreaView. Gaze coordinates are
        window coordinates, and inside the safe area the origin starts below the
        notch - the cursor would be drawn lower than the point being looked at.

        Off by default: the cursor is a live readout of exactly where the user
        is looking, so leaving it on makes the password readable over their
        shoulder. Turn it on in settings.json only for demos and debugging.
      */}
      {gazeReady && cfg.showGazeCircle && (
        <GazeCircle position={tracker.position} visibility={tracker.visibility} />
      )}

      {poseLocked && (
        <View style={[StyleSheet.absoluteFill, styles.poseLockOverlay]}>
          <PositionGuide
            tracker={tracker}
            reference={tracker.calibration.pose}
            autoComplete={false}
            onCancel={() => leave(false)}
          />
        </View>
      )}

      <CalibrationOverlay
        visible={stage === 'calibrate'}
        mode="calibrate"
        tracker={tracker}
        onClose={() => {
          // Only an abort if calibration didn't succeed; on success
          // handleCalibrationComplete has already moved us to 'gaze'.
          if (!calibrationDoneRef.current) leave(false);
        }}
        onComplete={handleCalibrationComplete}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  poseLockOverlay: {
    backgroundColor: 'rgba(0,0,0,0.94)',
    zIndex: 10,
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  cancelButton: {
    marginTop: 24,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  cancelButtonText: {
    color: '#dc2626',
    fontWeight: '600',
  },
});
