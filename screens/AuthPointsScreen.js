import React from 'react';
import { View, Text, StyleSheet, Alert, TouchableOpacity } from 'react-native';
import PointSelector from '../components/PointSelector';
import settings from '../config/settings.json';

const { toleranceRadius } = settings.authentication;

export default function AuthPointsScreen({ route, navigation }) {
  const { username, imageUri, storedPoints } = route.params;

  const handleComplete = (attemptPoints) => {
    const sortedStored = [...storedPoints].sort(
      (a, b) => a.point_index - b.point_index
    );

    const matches =
      attemptPoints.length === sortedStored.length &&
      attemptPoints.every((point, index) => {
        const expected = sortedStored[index];
        const dx = point.x - expected.x;
        const dy = point.y - expected.y;
        return Math.sqrt(dx * dx + dy * dy) <= toleranceRadius;
      });

    if (matches) {
      Alert.alert('Login Successful', `Welcome, ${username}!`, [
        { text: 'OK', onPress: () => navigation.navigate('Home') },
      ]);
    } else {
      Alert.alert('Login Failed', 'The selected points did not match.');
    }
  };

  const handleCalibrate = () => {
    // No-op for now
  };

  const handleCancel = () => {
    navigation.goBack();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Select your login points</Text>

      <PointSelector
        imageUri={imageUri}
        maxPoints={storedPoints.length}
        showMarkers={settings.pointSelector.showSelectedPoints}
        onComplete={handleComplete}
        onCancel={handleCancel}
      />

      <TouchableOpacity style={styles.calibrateButton} onPress={handleCalibrate}>
        <Text style={styles.buttonText}>Calibrate</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    paddingTop: 40,
  },
  header: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 16,
  },
  calibrateButton: {
    backgroundColor: '#f2994a',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 16,
    marginBottom: 24,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});