import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import settings from '../config/settings.json';

const DOT_SIZE = 28;
const { width: SCREEN_WIDTH } = Dimensions.get('window');
const IMAGE_SIZE = SCREEN_WIDTH - 48; // 24px padding on each side

/**
 * PointSelector
 * --------------
 * Displays an image and lets the user tap up to MAX_POINTS points on it.
 * Points are stored as normalized coordinates { x, y } in the [0, 1] range,
 * so they stay valid regardless of screen size / resolution.
 *
 * Props:
 *   - imageUri: string                        -> required, the image to show
 *   - onComplete(points): void                 -> called once maxPoints are picked, then user confirms
 *   - maxPoints?: number                       -> defaults to settings.json -> pointSelector.maxPoints
 *   - showMarkers?: boolean                    -> whether to draw dots where the user tapped.
 *                                                  Defaults to settings.json -> pointSelector.showSelectedPoints.
 *                                                  Useful to set to false during login/verification,
 *                                                  so a shoulder-surfer can't see the pattern being entered.
 */
export default function PointSelector({
  imageUri,
  onComplete,
  maxPoints = settings.pointSelector.maxPoints,
  showMarkers = settings.pointSelector.showSelectedPoints,
}) {
  const [points, setPoints] = useState([]);
  const [layout, setLayout] = useState({ width: IMAGE_SIZE, height: IMAGE_SIZE });

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

      <Pressable onPress={handlePress} style={styles.imageWrapper}>
        <Image
          source={{ uri: imageUri }}
          style={styles.image}
          resizeMode="cover"
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
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  imageWrapper: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
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
  buttonDisabled: {
    opacity: 0.4,
  },
});
