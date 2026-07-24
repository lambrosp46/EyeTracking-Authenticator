import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function GazeCircle({ visible, x, y }) {
  if (!visible) {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      style={[
        styles.circle,
        {
          left: x - 15,
          top: y - 15
        }
      ]}
    />
  );
}

const styles = StyleSheet.create({
  circle: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.25)'    
  }
});