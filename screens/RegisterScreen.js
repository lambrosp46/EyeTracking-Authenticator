import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Image, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Modal } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import ImageCapture from '../components/ImageCapture';
import PointSelector from '../components/PointSelector';

export default function RegisterScreen({ navigation }) {
  const { register, loading } = useAuth();
  const [username, setUsername] = useState('');
  const [imageUri, setImageUri] = useState(null);
  const [points, setPoints] = useState(null);
  const [pointsModalVisible, setPointsModalVisible] = useState(false);

  const handleImageCapture = (uri) => {
    setImageUri(uri);
    setPoints(null);
    setPointsModalVisible(true); // open the point-selection modal right after picking an image
  };

  // Called by PointSelector's own Confirm button — only reachable once
  // all required points are placed. This just closes the modal and
  // stores the points locally; it does NOT touch the database.
  const handlePointsSelected = (selectedPoints) => {
    setPoints(selectedPoints);
    setPointsModalVisible(false);
  };

  // Cancel button in the modal header — closes without saving.
  // Any previously confirmed points (if the user was re-selecting) are left untouched.
  const handleCancelPoints = () => {
    setPointsModalVisible(false);
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

            {imageUri && !points && !loading && (
              <TouchableOpacity onPress={() => setPointsModalVisible(true)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Επιλογή σημείων</Text>
              </TouchableOpacity>
            )}

            {imageUri && points && !loading && (
              <TouchableOpacity onPress={() => setPointsModalVisible(true)} style={styles.secondaryButton}>
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
              {imageUri && (
                <PointSelector
                  imageUri={imageUri}
                  onComplete={handlePointsSelected}
                  onCancel={handleCancelPoints}
                />
              )}
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
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