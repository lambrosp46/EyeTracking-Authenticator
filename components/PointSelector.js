import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Dimensions,
  Alert,
} from 'react-native';
import settings from '../config/settings.json';
import { cmToPoints } from '../utils/physicalSize';
import { isHighSaliency, sampleSaliency } from '../utils/saliency';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COVERAGE = settings.pointSelector.screenCoverage;
const BOX_WIDTH = SCREEN_WIDTH * COVERAGE; // width is always fixed at this -- never shrinks
const MAX_BOX_HEIGHT = SCREEN_HEIGHT * 1.5; // generous safety cap for extreme aspect ratios; scrollable beyond screen height
const DOT_SIZE = cmToPoints(settings.pointSelector.dotDiameterCm);
// Minimum physical distance (in RN layout points, i.e. screen-independent
// units -- see utils/physicalSize.js) required between two *consecutively*
// tapped points. Defined in cm rather than pixels/normalized units so it
// stays consistent across devices, per the thesis's physical-independence
// requirement for tolerances.
const MIN_DISTANCE = cmToPoints(settings.pointSelector.minDistanceCm ?? 2.0);

/**
 * PointSelector
 * --------------
 * Displays an image and lets the user tap up to maxPoints points on it.
 * Points are stored as normalized coordinates { x, y } in the [0, 1] range,
 * so they stay valid regardless of screen size / resolution.
 *
 * When `enforceMinDistance` is true (the default), each new tap must land
 * at least `settings.pointSelector.minDistanceCm` away from the immediately
 * preceding point (measured as a real physical distance, not normalized
 * units) -- a tap that's too close to, or on top of, the last point is
 * rejected with an Alert and not recorded. This is meant for registration
 * only; pass `enforceMinDistance={false}` for login/verification, where the
 * user is replicating an already-validated pattern and gaze-tracking noise
 * could otherwise cause spurious rejections unrelated to a real mistake.
 *
 * The image is sized to fit, without cropping, inside a bounding box that's
 * `screenCoverage` (settings.json) of the screen's width -- a fixed width
 * that never shrinks, so there's no left/right gap regardless of what else
 * is shown around it. Height is derived from the image's real aspect ratio
 * (Image.getSize) and allowed to grow freely, only capped by a generous
 * safety limit for extreme aspect-ratio images (screen scrolls if needed).
 *
 * Props:
 *   - imageUri: string                        -> required, the image to show
 *   - onComplete(points): void                 -> called once maxPoints are picked, then user confirms
 *   - onCancel?: () => void                     -> if provided, renders a Cancel button alongside the others.
 *   - maxPoints?: number                       -> defaults to settings.json -> pointSelector.maxPoints
 *   - showMarkers?: boolean                    -> whether to draw dots where the user tapped.
 *                                                  Defaults to settings.json -> pointSelector.showSelectedPoints.
 *                                                  Useful to set to false during login/verification,
 *                                                  so a shoulder-surfer can't see the pattern being entered.
 *   - title?: string                            -> overrides the leading instructions text (before the
 *                                                  "(x/maxPoints)" counter). Defaults to "Επίλεξε N σημεία στην εικόνα".
 *                                                  Only used when showInstructions is true.
 *   - showInstructions?: boolean                -> whether to show the "Επίλεξε N σημεία..." title. Defaults to true.
 *   - showCounter?: boolean                     -> if showInstructions is false, whether to show a plain
 *                                                  "x/maxPoints" counter in the same spot instead. Defaults to false.
 *   - showUndo?: boolean                        -> whether to render the Undo button. Defaults to true.
 *   - showReset?: boolean                       -> whether to render the Reset button. Defaults to true.
 *   - showConfirmButton?: boolean               -> whether to render the Confirm button. Defaults to true.
 *   - autoSubmit?: boolean                      -> if true, calls onComplete automatically once maxPoints
 *                                                  are picked, without waiting for a Confirm tap. Defaults to false.
 *   - saliencyMap?: SaliencyMap                 -> optional saliency heatmap (see utils/saliency.js). If provided,
 *                                                  caps how many of the (up to maxPoints) taps may land on a
 *                                                  high-saliency region -- see saliencyMaxHighCount. If omitted/null,
 *                                                  no gating happens regardless of saliencyMaxHighCount.
 *   - saliencyMaxHighCount?: number             -> the maximum number of taps (out of all maxPoints, in any
 *                                                  order) allowed to land on a high-saliency region. Low-saliency
 *                                                  taps are never limited. Defaults to 0 (no high-saliency taps
 *                                                  allowed at all, when saliencyMap is provided).
 *   - saliencyMinScore?: number                 -> the [0, 1] threshold a tap's saliency score must meet to
 *                                                  count as "high". Defaults to settings.json -> saliency.minScore.
 *   - enforceMinDistance?: boolean              -> whether consecutive taps must be at least
 *                                                  settings.json -> pointSelector.minDistanceCm apart.
 *                                                  Defaults to true; set false for login/verification.
 *
 * If none of onCancel / showUndo / showReset / showConfirmButton apply, the
 * whole bottom action row is omitted, so the image gets that space too.
 */
export default function PointSelector({
  imageUri,
  onComplete,
  onCancel,
  maxPoints = settings.pointSelector.maxPoints,
  showMarkers = settings.pointSelector.showSelectedPoints,
  title,
  showInstructions = true,
  showCounter = false,
  showUndo = true,
  showReset = true,
  showConfirmButton = true,
  autoSubmit = false,
  saliencyMap = null,
  saliencyMaxHighCount = 0,
  saliencyMinScore = settings.saliency.minScore,
  enforceMinDistance = true,
}) {
  const [points, setPoints] = useState([]);
  const [boxSize, setBoxSize] = useState({ width: BOX_WIDTH, height: BOX_WIDTH });
  const [layout, setLayout] = useState({ width: BOX_WIDTH, height: BOX_WIDTH });

  const showCancel = !!onCancel;
  const showActionsRow = showCancel || showUndo || showReset || showConfirmButton;

  // Width is always fixed at `screenCoverage` of the screen -- this is what
  // eliminates the left/right empty gap. Height is derived from the image's
  // real aspect ratio and allowed to grow freely (the screen scrolls if it
  // doesn't fit), only capped by a generous safety limit for extreme
  // aspect-ratio images.
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
        console.warn('PointSelector: could not read image size, using square fallback', error);
        setBoxSize({ width: BOX_WIDTH, height: BOX_WIDTH });
      }
    );
  }, [imageUri]);

  const handleLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ width, height });
  }, []);

  const handlePress = (e) => {
    if (points.length >= maxPoints) return;
    const { locationX, locationY } = e.nativeEvent;

    const x = Math.min(Math.max(locationX / layout.width, 0), 1);
    const y = Math.min(Math.max(locationY / layout.height, 0), 1);

    // Consecutive points may not overlap or land too close to one another.
    // Distance is measured in actual on-screen RN layout points (derived
    // from the normalized coords via the current `layout` size), not raw
    // normalized units, so the cm-based threshold is meaningful regardless
    // of the image's displayed size on this device.
    if (enforceMinDistance && points.length > 0) {
      const prev = points[points.length - 1];
      const dx = (x - prev.x) * layout.width;
      const dy = (y - prev.y) * layout.height;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < MIN_DISTANCE) {
        Alert.alert(
          'Πολύ κοντά στο προηγούμενο σημείο',
          `Διάλεξε ένα σημείο που απέχει τουλάχιστον ${settings.pointSelector.minDistanceCm} εκ. από το προηγούμενο.`
        );
        return;
      }
    }

    // At most `saliencyMaxHighCount` of the (up to maxPoints) taps, in any
    // order, may land on a high-saliency region of the image (per the
    // saliency map computed at image-upload time). Low-saliency taps are
    // never limited. A tap that would exceed the cap is rejected outright
    // -- it's not added to `points` -- and the user sees an Alert instead,
    // asking them to pick a less visually-obvious point.
    if (saliencyMap) {
      const score = sampleSaliency(saliencyMap, x, y);
      const tapIsHighSaliency = score >= saliencyMinScore;
      if (tapIsHighSaliency) {
        const highSoFar = points.filter((p) =>
          isHighSaliency(saliencyMap, p.x, p.y, saliencyMinScore)
        ).length;
        const rejected = highSoFar >= saliencyMaxHighCount;
        console.log(
          `[PointSelector] tap ${points.length + 1}: (${x.toFixed(3)}, ${y.toFixed(3)}) score=${score.toFixed(3)} high=true highSoFar=${highSoFar}/${saliencyMaxHighCount} -> ${rejected ? 'REJECTED (cap reached)' : 'accepted'}`
        );
        if (rejected) {
          Alert.alert(
            'Πολύ έντονο σημείο',
            `Έχεις ήδη επιλέξει το μέγιστο (${saliencyMaxHighCount}) σημείων υψηλής οπτικής προσοχής. Δοκίμασε ένα λιγότερο χαρακτηριστικό σημείο της εικόνας.`
          );
          return;
        }
      } else {
        console.log(
          `[PointSelector] tap ${points.length + 1}: (${x.toFixed(3)}, ${y.toFixed(3)}) score=${score.toFixed(3)} high=false -> accepted`
        );
      }
    }

    const newPoints = [...points, { x, y }];
    setPoints(newPoints);

    if (autoSubmit && newPoints.length === maxPoints) {
      onComplete?.(newPoints);
    }
  };

  const undoLast = () => setPoints((prev) => prev.slice(0, -1));
  const reset = () => setPoints([]);

  const isComplete = points.length === maxPoints;

  return (
    <View style={styles.container}>
      {showInstructions && (
        <Text style={styles.title}>
          {title ?? `Επίλεξε ${maxPoints} σημεία στην εικόνα`} ({points.length}/{maxPoints})
        </Text>
      )}
      {!showInstructions && showCounter && (
        <Text style={styles.title}>
          {points.length}/{maxPoints}
        </Text>
      )}
      <Pressable
        onPress={handlePress}
        style={[styles.imageWrapper, { width: boxSize.width, height: boxSize.height }]}
      >
        <Image
          source={{ uri: imageUri }}
          style={styles.image}
          resizeMode="contain"
          onLayout={handleLayout}
        />
        {showMarkers &&
          points.map((p, i) => (
            <View
              key={i}
              pointerEvents="none"
              style={[
                styles.dot,
                {
                  left: p.x * layout.width - DOT_SIZE / 2,
                  top: p.y * layout.height - DOT_SIZE / 2,
                  backgroundColor: settings.pointSelector.dotColor,
                },
              ]}
            >
              <Text style={styles.dotText}>{i + 1}</Text>
            </View>
          ))}
      </Pressable>

      {showActionsRow && (
        <View style={styles.actions}>
          {showCancel && (
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel}>
              <Text style={styles.cancelButtonText}>Άκυρο</Text>
            </Pressable>
          )}

          {showUndo && (
            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={undoLast}
              disabled={points.length === 0}
            >
              <Text style={styles.secondaryButtonText}>Undo</Text>
            </Pressable>
          )}

          {showReset && (
            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={reset}
              disabled={points.length === 0}
            >
              <Text style={styles.secondaryButtonText}>Reset</Text>
            </Pressable>
          )}

          {showConfirmButton && (
            <Pressable
              style={[
                styles.button,
                styles.primaryButton,
                !isComplete && styles.buttonDisabled,
              ]}
              onPress={() => isComplete && onComplete?.(points)}
              disabled={!isComplete}
            >
              <Text style={styles.primaryButtonText}>Confirm</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  imageWrapper: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#eee',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  dot: {
    position: 'absolute',
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: 'rgba(0, 122, 255, 0.85)',
    borderWidth: 2,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    paddingHorizontal: 16,
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#f0f0f0',
  },
  secondaryButtonText: {
    color: '#333',
    fontWeight: '600',
  },
  cancelButtonText: {
    color: '#dc2626',
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});