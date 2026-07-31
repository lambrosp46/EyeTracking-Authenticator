import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import settings from '../config/settings.json';
import { cmToPoints } from '../utils/physicalSize';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COVERAGE = settings.pointSelector.screenCoverage;
const BOX_WIDTH = SCREEN_WIDTH * COVERAGE; // width is always fixed at this — never shrinks
const MAX_BOX_HEIGHT = SCREEN_HEIGHT * 1.5; // generous safety cap for extreme aspect ratios;
const DOT_SIZE = cmToPoints(settings.pointSelector.dotDiameterCm);

/**
 * PointSelector
 * --------------
 * Displays an image and lets the user tap up to maxPoints points on it.
 * Points are stored as normalized coordinates { x, y } in the [0, 1] range,
 * so they stay valid regardless of screen size / resolution.
 *
 * The image is sized to fit, without cropping, inside a bounding box that's
 * `screenCoverage` (settings.json, default 80%) of the screen's width and
 * height — matching the password-space assumption that the usable area is
 * ~80% of the physical screen. We read the image's real dimensions first
 * (Image.getSize) and fit it to that box preserving aspect ratio, so the
 * displayed area always matches the actual visible image exactly (no
 * letterboxing, no cropped edges) — which keeps tap-to-normalized-coordinate
 * mapping accurate.
 *
 * Props:
 *   - imageUri: string                        -> required, the image to show
 *   - onComplete(points): void                 -> called once maxPoints are picked, then user confirms
 *   - maxPoints?: number                       -> defaults to settings.json -> pointSelector.maxPoints
 *   - showMarkers?: boolean                    -> whether to draw dots where the user tapped.
 *                                                  Defaults to settings.json -> pointSelector.showSelectedPoints.
 *                                                  Useful to set to false during login/verification,
 *                                                  so a shoulder-surfer can't see the pattern being entered.
 *   - onCancel?: () => void                     -> if provided, renders a Cancel button alongside the others.
 */
export default function PointSelector({
  imageUri,
  onComplete,
  onCancel,
  maxPoints = settings.pointSelector.maxPoints,
  showMarkers = settings.pointSelector.showSelectedPoints,
}) {
  const [points, setPoints] = useState([]);
  const [boxSize, setBoxSize] = useState({ width: BOX_WIDTH, height: BOX_WIDTH });
  const [layout, setLayout] = useState({ width: BOX_WIDTH, height: BOX_WIDTH });

  // Width is always fixed at `screenCoverage` of the screen — this is what
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

    setPoints((prev) => [...prev, { x, y }]);
  };

  const undoLast = () => setPoints((prev) => prev.slice(0, -1));
  const reset = () => setPoints([]);

  const isComplete = points.length === maxPoints;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Επίλεξε {maxPoints} σημεία στην εικόνα ({points.length}/{maxPoints})
      </Text>

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

      <View style={styles.actions}>
        {onCancel && (
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel}>
            <Text style={styles.cancelButtonText}>Άκυρο</Text>
          </Pressable>
        )}

        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={undoLast}
          disabled={points.length === 0}
        >
          <Text style={styles.secondaryButtonText}>Undo</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={reset}
          disabled={points.length === 0}
        >
          <Text style={styles.secondaryButtonText}>Reset</Text>
        </Pressable>

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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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