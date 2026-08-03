import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import PointSelector from '../components/PointSelector';
import settings from '../config/settings.json';
import { cropToStandardAspectRatio } from '../utils/imageAspect';

const { toleranceRadius } = settings.authentication;

export default function AuthPointsScreen({ route, navigation }) {
  const { username, imageUri, storedPoints } = route.params;
  const [displayUri, setDisplayUri] = useState(null);

  // Re-crop the stored image to the standard 16:9-family aspect ratio before
  // showing it, so it lines up with the coordinate space the points were
  // originally saved in (matters for images stored before this crop existed).
  useEffect(() => {
    let cancelled = false;
    setDisplayUri(null);
    cropToStandardAspectRatio(imageUri).then((uri) => {
      if (!cancelled) setDisplayUri(uri);
    });
    return () => {
      cancelled = true;
    };
  }, [imageUri]);

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
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        {displayUri ? (
          <PointSelector
            imageUri={displayUri}
            maxPoints={storedPoints.length}
            showMarkers={settings.pointSelector.showSelectedPoints}
            onComplete={handleComplete}
            showInstructions={false}
            showCounter
            showUndo={false}
            showReset={false}
            showConfirmButton={false}
            autoSubmit
          />
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator />
          </View>
        )}

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.calibrateButton} onPress={handleCalibrate}>
            <Text style={styles.buttonText}>Calibrate</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  calibrateButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#007AFF',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
  },
  cancelButtonText: {
    color: '#dc2626',
    fontWeight: '600',
  },
});