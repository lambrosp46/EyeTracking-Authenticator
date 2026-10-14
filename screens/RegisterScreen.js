import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Image, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Modal } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import ImageCapture from '../components/ImageCapture';
import PointSelector from '../components/PointSelector';
import settings from '../config/settings.json';
import { pointsMatchPhysical } from '../utils/points';
import { pointsToCm } from '../utils/gazeMapping';
import { getSaliencyMap, logSaliencyMapStats } from '../utils/saliency';
import CalibrationOverlay from '../components/CalibrationOverlay';
import GazePointConfirm from '../components/GazePointConfirm';
import GazeCircle from '../components/GazeCircle';
import PositionGuide from '../components/PositionGuide';
import useGazeTracker from '../hooks/useGazeTracker';

const { minScore: saliencyMinScore, maxHighSaliencyPoints } = settings.saliency;

// iOS needs the previous modal fully dismissed before the next is presented.
const MODAL_SWAP_MS = 450;

export default function RegisterScreen({ navigation }) {
  const { register, loading } = useAuth();
  const tracker = useGazeTracker();
  const [username, setUsername] = useState('');
  const [imageUri, setImageUri] = useState(null);
  const [points, setPoints] = useState(null);
  const [pointsModalVisible, setPointsModalVisible] = useState(false);
  // Saliency map (Vision's VNGenerateAttentionBasedSaliencyImageRequest) for
  // the currently-uploaded image, computed once right after upload. Caps
  // how many of the 5 points (in any order) may land on a high-saliency
  // region — see PointSelector's saliencyMaxHighCount. Left null if the
  // native call fails (e.g. non-iOS) so registration still works, just
  // without the cap.
  const [saliencyMap, setSaliencyMap] = useState(null);
  const [saliencyLoading, setSaliencyLoading] = useState(false);

  // Registration confirms the points by GAZE rather than by a second tap.
  // Tapping twice only proves the user can repeat a tap; looking at the points
  // proves they are reachable at this user's actual gaze accuracy, which is
  // what decides whether they can ever log in. A point too near an edge, or two
  // points closer together than the gaze error, now fails here instead of
  // silently becoming an un-loginable account.
  //
  //   'select'  -> tap the points, press Confirm
  //   'calibrate' -> fit this user's gaze mapping
  //   'gaze'    -> look at the same points, in order
  const [pointsStage, setPointsStage] = useState('select');
  const [pendingPoints, setPendingPoints] = useState(null);
  const [gazeAttempts, setGazeAttempts] = useState(0);
  // CalibrationOverlay fires onComplete then onClose synchronously, so onClose
  // cannot read the stage state it just set. A ref sees the write immediately.
  const calibrationDoneRef = useRef(false);
  // Bumped to remount PointSelector (clearing its internal taps) whenever
  // we move between stages or restart after a mismatched confirmation.
  const [selectorKey, setSelectorKey] = useState(0);

  // Pose lock during the gaze confirmation, exactly as at login: if the head
  // leaves the calibration pose, gaze stops counting and the guide brings the
  // user back. Refs keep the effect independent of the tracker's re-renders.
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  useEffect(() => {
    if (pointsStage !== 'gaze') return undefined;
    trackerRef.current.setPoseLockActive(true);
    return () => trackerRef.current.setPoseLockActive(false);
  }, [pointsStage]);
  const poseLocked = pointsStage === 'gaze' && tracker.poseLock?.locked && tracker.calibration?.pose;

  // Runs saliency analysis (Vision) right after the image is uploaded, then
  // opens the point-selection modal — with the saliency map ready in time
  // to cap high-saliency taps in PointSelector. If Vision fails (or isn't
  // available, e.g. Android/web), registration still proceeds, just
  // without the cap.
  const handleImageCapture = async (uri) => {
    setImageUri(uri);
    setPoints(null);
    setPendingPoints(null);
    setPointsStage('select');
    setSelectorKey((k) => k + 1);
    setSaliencyMap(null);

    setSaliencyLoading(true);
    try {
      const map = await getSaliencyMap(uri);
      logSaliencyMapStats(map, 'RegisterScreen');
      setSaliencyMap(map);
    } catch (err) {
      console.warn('RegisterScreen: saliency computation failed, continuing without saliency gating', err);
      setSaliencyMap(null);
    } finally {
      setSaliencyLoading(false);
      setPointsModalVisible(true); // open the point-selection modal right after analysis
    }
  };

  // Called by PointSelector's own Confirm button — only reachable once
  // all required points are placed. Hands off to calibration, then to the
  // gaze confirmation pass.
  const handlePointsSelected = async (selectedPoints) => {
    console.log('[Register] points confirmed, starting gaze session');
    setPendingPoints(selectedPoints);
    setGazeAttempts(0);
    calibrationDoneRef.current = false;

    if (!settings.gazeConfirm.requireCalibration) {
      setPointsStage('gaze');
      return;
    }

    // The gaze session has to be live before the calibration overlay opens,
    // otherwise it has nothing to collect.
    const ok = await tracker.start();
    console.log('[Register] tracker.start ->', ok, 'error:', tracker.error);
    if (!ok) {
      Alert.alert(
        'Το eye tracking δεν είναι διαθέσιμο',
        tracker.error ??
          'Χρειάζεται συσκευή με TrueDepth κάμερα και development build. Δες την οθόνη Gaze Test.'
      );
      return;
    }

    // iOS will not present a second modal while the first is still up - the
    // new one silently never appears. Dismiss the point-selection modal, wait
    // for the dismissal to finish, then open calibration.
    setPointsModalVisible(false);
    setTimeout(() => {
      console.log('[Register] opening calibration overlay');
      setPointsStage('calibrate');
    }, MODAL_SWAP_MS);
  };

  // Calibration finished — the fit lives only in the tracker for this session
  // (calibration is never stored) - move to gaze confirm.
  const handleCalibrationComplete = (result) => {
    console.log('[Register] calibration complete:', result?.quality?.rmseCm, 'cm');
    if (!result?.calibration) {
      abortToSelection();
      return;
    }
    calibrationDoneRef.current = true;
    // Same modal-swap dance in reverse: the calibration modal has to finish
    // dismissing before the point modal can be presented again.
    setTimeout(() => {
      setPointsStage('gaze');
      setPointsModalVisible(true);
    }, MODAL_SWAP_MS);
  };

  // Gaze confirmation pass: the looked-at points must match the tapped ones,
  // in order, within the same tolerance login will use. This is the only place
  // that stores `points`; it still does NOT touch the database.
  const handleGazeConfirmed = (gazePoints, meta) => {
    // Verification rule: the gaze dot and the tapped dot count as the same
    // point when their circles TOUCH, i.e. centre-to-centre distance <= the sum
    // of the two radii. Both are drawn at dotDiameterCm, so that sum is one
    // diameter. Comparing in centimetres (not normalized units) keeps the
    // tolerance a true circle regardless of the image's aspect ratio.
    const toleranceCm =
      settings.gazeConfirm.matchToleranceCm ?? settings.pointSelector.dotDiameterCm;

    const result = pointsMatchPhysical(
      gazePoints,
      pendingPoints,
      meta?.boxSize ?? { width: 1, height: 1 },
      toleranceCm,
      pointsToCm
    );

    if (settings.gazeConfirm.logPoints) {
      console.log('[Register] --- gaze verification ---');
      console.log('[Register] tolerance:', toleranceCm.toFixed(2), 'cm (dots touching)');
      result.details.forEach((d) => {
        console.log(
          `[Register] point ${d.index + 1}: ` +
            `tapped(${d.expected.x.toFixed(4)}, ${d.expected.y.toFixed(4)}) ` +
            `gaze(${d.gaze.x.toFixed(4)}, ${d.gaze.y.toFixed(4)}) ` +
            `distance ${d.distanceCm.toFixed(2)}cm -> ${d.ok ? 'OK' : 'FAIL'}`
        );
      });
      console.log('[Register] verdict:', result.ok ? 'MATCH' : 'NO MATCH');
    }

    if (result.ok) {
      setPoints(pendingPoints);
      setPointsStage('select');
      setPointsModalVisible(false);
      tracker.stop();
      return;
    }

    const attempts = gazeAttempts + 1;
    setGazeAttempts(attempts);

    if (attempts >= settings.gazeConfirm.maxAttempts) {
      Alert.alert(
        'Η επιβεβαίωση με το βλέμμα απέτυχε',
        'Δοκίμασε να επιλέξεις σημεία πιο μακριά μεταξύ τους και πιο μέσα από τις άκρες της εικόνας.'
      );
      setPendingPoints(null);
      setGazeAttempts(0);
      setPointsStage('select');
      setSelectorKey((k) => k + 1);
    } else {
      const worst = result.details.reduce(
        (a, b) => (b.distanceCm > a.distanceCm ? b : a),
        result.details[0]
      );
      Alert.alert(
        'Δεν ταίριαξε',
        `Τα σημεία που κοίταξες δεν ταιριάζουν. Χειρότερη απόκλιση: σημείο ${
          worst.index + 1
        }, ${worst.distanceCm.toFixed(1)}cm (όριο ${toleranceCm.toFixed(1)}cm). ` +
          `Προσπάθεια ${attempts}/${settings.gazeConfirm.maxAttempts}.`
      );
      // Remount the confirm view so its captured points reset.
      setSelectorKey((k) => k + 1);
    }
  };

  // Calibration was cancelled or failed: drop back to point selection and
  // bring the selection modal back up.
  const abortToSelection = () => {
    setPointsStage('select');
    setSelectorKey((k) => k + 1);
    setTimeout(() => setPointsModalVisible(true), MODAL_SWAP_MS);
  };

  // Cancel button in the modal header — closes without saving.
  // Any previously confirmed points (if the user was re-selecting) are left untouched.
  const handleCancelPoints = () => {
    setPointsModalVisible(false);
    setPendingPoints(null);
    setPointsStage('select');
    setGazeAttempts(0);
    tracker.stop();
  };

  // Opens the point-selection modal fresh, always starting at the
  // 'select' stage (covers both first-time selection and "Αλλαγή σημείων"
  // re-selection of already-confirmed points).
  const openPointsModal = () => {
    setPendingPoints(null);
    setPointsStage('select');
    setGazeAttempts(0);
    setSelectorKey((k) => k + 1);
    setPointsModalVisible(true);
  };

  // The only place that actually writes to the database.
  const handleRegister = async () => {
    if (!username.trim()) {
      Alert.alert('Missing username', 'Please enter a username first.');
      return;
    }
    if (!imageUri || !points) {
      Alert.alert('Incomplete', 'Please select an image and your 5 points first.');
      return;
    }

    try {
      await register(username, imageUri, points);
      Alert.alert('Success', 'Registration saved.');
      navigation?.goBack?.();
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong while saving.');
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={true}>
          <View style={styles.header}>
            <Image source={require('../assets/logo-pan-patron.gif')} style={styles.logo} />
            <Text style={styles.registerTitle}>Τμήμα Μηχανικών Η/Υ & Πληροφορικής</Text>
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.registerText}>Username</Text>
            <TextInput
              style={styles.input}
              placeholder="Πληκτρολογήστε username"
              placeholderTextColor="#6b7280"
              returnKeyType="done"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />

            <ImageCapture
              imageUri={imageUri}
              onImageCapture={handleImageCapture}
              label="Ανεβάστε εικόνα για κωδικό"
              showPreview={false}
            />

            {imageUri && saliencyLoading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator />
                <Text style={styles.loadingText}>Ανάλυση εικόνας…</Text>
              </View>
            )}

            {imageUri && !saliencyLoading && !points && !loading && (
              <TouchableOpacity onPress={openPointsModal} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Επιλογή σημείων</Text>
              </TouchableOpacity>
            )}

            {imageUri && points && !loading && (
              <TouchableOpacity onPress={openPointsModal} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Αλλαγή σημείων</Text>
              </TouchableOpacity>
            )}

            {loading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator />
                <Text style={styles.loadingText}>Saving…</Text>
              </View>
            )}

            {points && !loading && (
              <>
                <View style={styles.successBox}>
                  <Text style={styles.successText}>✓ {points.length} σημεία επιλέχθηκαν</Text>
                </View>
                <TouchableOpacity style={styles.registerButton} onPress={handleRegister}>
                  <Text style={styles.registerButtonText}>Register</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>

      <Modal
        visible={pointsModalVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={handleCancelPoints}
      >
        <SafeAreaProvider>
          <SafeAreaView style={styles.modalContainer}>
            <View style={styles.modalBody}>
              {imageUri && pointsStage === 'select' && (
                <PointSelector
                  key={selectorKey}
                  imageUri={imageUri}
                  onComplete={handlePointsSelected}
                  onCancel={handleCancelPoints}
                  saliencyMap={saliencyMap}
                  saliencyMaxHighCount={maxHighSaliencyPoints}
                  saliencyMinScore={saliencyMinScore}
                />
              )}

              {imageUri && pointsStage === 'gaze' && (
                <GazePointConfirm
                  key={selectorKey}
                  imageUri={imageUri}
                  tracker={tracker}
                  expectedCount={settings.pointSelector.maxPoints}
                  onComplete={handleGazeConfirmed}
                  onCancel={handleCancelPoints}
                />
              )}
            </View>
          </SafeAreaView>
        </SafeAreaProvider>

        {/*
          The gaze cursor must be a direct child of the Modal, NOT inside the
          SafeAreaView. GazeCircle positions itself with absoluteFill and the
          gaze coordinates are window coordinates - nested inside the safe area
          its origin starts below the notch, so the cursor would be drawn lower
          than the point actually being looked at.
        */}
        {pointsStage === 'gaze' && settings.gazeConfirm.showGazeCircle && (
          <GazeCircle position={tracker.position} visibility={tracker.visibility} />
        )}

        {/* Inside the same Modal, so it covers the gaze screen. */}
        {poseLocked && (
          <View style={[StyleSheet.absoluteFill, styles.poseLockOverlay]}>
            <SafeAreaProvider>
              <PositionGuide
                tracker={tracker}
                reference={tracker.calibration.pose}
                autoComplete={false}
                onCancel={handleCancelPoints}
              />
            </SafeAreaProvider>
          </View>
        )}
      </Modal>

      <CalibrationOverlay
        visible={pointsStage === 'calibrate'}
        mode="calibrate"
        tracker={tracker}
        onClose={() => {
          // Only treat this as an abort if calibration didn't actually succeed;
          // on success handleCalibrationComplete has already moved us to 'gaze'.
          if (!calibrationDoneRef.current) abortToSelection();
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
    backgroundColor: '#f9fafb',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: {
    width: 110,
    height: 110,
    marginBottom: 16,
  },
  registerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  inputContainer: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  registerText: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  input: {
    width: '100%',
    height: 52,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#111827',
  },
  secondaryButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  secondaryButtonText: {
    color: '#4f46e5',
    fontWeight: '600',
    fontSize: 14,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  loadingText: {
    fontSize: 14,
    color: '#555',
  },
  successBox: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#e8f5e9',
    borderRadius: 12,
  },
  successText: {
    color: '#2e7d32',
    fontWeight: '600',
  },
  registerButton: {
    marginTop: 16,
    height: 52,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  registerButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalBody: {
    flex: 1,
    paddingTop: 16,
  },
});