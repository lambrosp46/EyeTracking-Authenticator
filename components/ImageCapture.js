import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';

export default function ImageCapture({ imageUri, onImageCapture, label = 'Select Image' }) {
  const handlePickImage = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'We need permission to access your photos.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });

      if (!result.canceled) {
        const selectedImageUri = result.assets[0].uri;
        const filename = `password_image_${Date.now()}.jpg`;
        const destinationUri = FileSystem.documentDirectory + filename;
        
        const copyResult = await FileSystem.copyAsync({
          from: selectedImageUri,
          to: destinationUri,
        });
        
        console.log('Copy result:', copyResult);
        onImageCapture(destinationUri);
        console.log('Image saved at:', destinationUri);
      }
    } catch (error) {
      console.error('Error picking image:', error);
      Alert.alert('Error', 'Failed to pick image');
    }
  };

  const handleCameraCapture = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'We need permission to access your camera.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 1,
      });

      if (!result.canceled) {
        const capturedImageUri = result.assets[0].uri;
        const filename = `password_image_${Date.now()}.jpg`;
        const destinationUri = FileSystem.documentDirectory + filename;
        
        const copyResult = await FileSystem.copyAsync({
          from: capturedImageUri,
          to: destinationUri,
        });
        
        console.log('Copy result:', copyResult);
        onImageCapture(destinationUri);
        console.log('Image saved at:', destinationUri);
      }
    } catch (error) {
      console.error('Error capturing image:', error);
      Alert.alert('Error', 'Failed to capture image');
    }
  };

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.button} onPress={handlePickImage}>
          <Text style={styles.buttonText}>Upload Image</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={handleCameraCapture}>
          <Text style={styles.buttonText}>Capture Photo</Text>
        </TouchableOpacity>
      </View>

      {imageUri && (
        <View style={styles.previewContainer}>
          <Text style={styles.label}>Selected Image:</Text>
          <Image source={{ uri: imageUri }} style={styles.preview} />
          <Text style={styles.uriText}>Image URI: {imageUri}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 15,
    color: '#374151',
    marginBottom: 10,
  },
  buttonContainer: {
    marginTop: 12,
    gap: 10,
  },
  button: {
    width: '100%',
    height: 52,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  previewContainer: {
    marginTop: 20,
    padding: 12,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    alignItems: 'center',
  },
  preview: {
    width: 200,
    height: 150,
    borderRadius: 10,
    marginTop: 10,
    marginBottom: 10,
  },
  uriText: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
    fontFamily: 'monospace',
  },
});
