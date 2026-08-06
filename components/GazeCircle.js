import React, { useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import settings from '../config/settings.json';
import { cmToPoints } from '../utils/gazeMapping';

/**
 * Debug-only cursor that renders where the user is currently looking.
 *
 * Driven entirely by Animated.Values so a 30 Hz gaze stream never re-renders
 * React. Not meant to ship in the authentication flow - seeing the cursor
 * changes how people look at the screen (they chase it), which would bias the
 * evaluation of the real point-selection accuracy.
 *
 * @param {Animated.ValueXY} position   cursor centre in screen points
 * @param {Animated.Value}   visibility 0..1 opacity, driven by sample validity
 */
export default function GazeCircle({
  position,
  visibility,
  diameterCm = settings.gazeCircle.diameterCm,
  color = settings.gazeCircle.color,
  borderColor = settings.gazeCircle.borderColor,
  borderWidth = settings.gazeCircle.borderWidth,
  showCrosshair = settings.gazeCircle.showCrosshair,
  crosshairColor = settings.gazeCircle.crosshairColor,
  label,
}) {
  const size = useMemo(() => cmToPoints(diameterCm), [diameterCm]);
  const radius = size / 2;

  const translateX = useMemo(() => Animated.subtract(position.x, radius), [position.x, radius]);
  const translateY = useMemo(() => Animated.subtract(position.y, radius), [position.y, radius]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: visibility }]}
    >
      <Animated.View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: color,
          borderColor,
          borderWidth,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ translateX }, { translateY }],
        }}
      >
        {showCrosshair && (
          <>
            <View style={[styles.tick, { width: size * 0.42, height: 1, backgroundColor: crosshairColor }]} />
            <View style={[styles.tick, { width: 1, height: size * 0.42, backgroundColor: crosshairColor }]} />
            <View style={[styles.dot, { backgroundColor: crosshairColor }]} />
          </>
        )}
        {label ? <View style={styles.labelAnchor}>{label}</View> : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tick: {
    position: 'absolute',
    opacity: 0.85,
  },
  dot: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
  },
  labelAnchor: {
    position: 'absolute',
    top: '100%',
    marginTop: 4,
  },
});
