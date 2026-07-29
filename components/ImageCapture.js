import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  StyleSheet,
  ActionSheetIOS,
  Alert,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

export default function ImageCapture({ onImageSelected, value, label = 'Select image' }) {
  const [imageUri, setImageUri] = useState(value ?? null);
  const [busy, setBusy] = useState(false);

  const handleResult = (uri) => {
    if (!uri) return;
    setImageUri(uri);
    onImageSelected?.(uri);
  };

  const openCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Camera permission needed', 'Please allow camera access in Settings.');
      return;
    }
    setBusy(true);
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        allowsEditing: false,
      });
      if (!result.canceled) {
        handleResult(result.assets[0].uri);
      }
    } finally {
      setBusy(false);
    }
  };

  const openLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Photos permission needed', 'Please allow photo library access in Settings.');
      return;
    }
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        allowsEditing: false,
      });
      if (!result.canceled) {
        handleResult(result.assets[0].uri);
      }
    } finally {
      setBusy(false);
    }
  };

  const openFiles = async () => {
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (!result.canceled) {
        handleResult(result.assets[0].uri);
      }
    } finally {
      setBusy(false);
    }
  };

  const presentPicker = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Take Photo', 'Choose from Library', 'Choose File'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) openCamera();
          else if (buttonIndex === 2) openLibrary();
          else if (buttonIndex === 3) openFiles();
        }
      );
    } else {
      // Android / web fallback — ActionSheetIOS doesn't exist there.
      Alert.alert('Select image', undefined, [
        { text: 'Take Photo', onPress: openCamera },
        { text: 'Choose from Library', onPress: openLibrary },
        { text: 'Choose File', onPress: openFiles },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  return (
    <View style={styles.container}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <TouchableOpacity
        style={styles.picker}
        onPress={presentPicker}
        disabled={busy}
        activeOpacity={0.7}
      >
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.preview} />
        ) : (
          <Text style={styles.placeholderText}>
            {busy ? 'Loading…' : 'Tap to add image'}
          </Text>
        )}
      </TouchableOpacity>

      {imageUri ? (
        <TouchableOpacity onPress={presentPicker} disabled={busy}>
          <Text style={styles.changeText}>Change image</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    marginVertical: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  picker: {
    width: 220,
    height: 220,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    backgroundColor: '#fafafa',
  },
  preview: {
    width: '100%',
    height: '100%',
  },
  placeholderText: {
    color: '#888',
    fontSize: 14,
  },
  changeText: {
    marginTop: 8,
    color: '#007AFF',
    fontSize: 14,
  },
});