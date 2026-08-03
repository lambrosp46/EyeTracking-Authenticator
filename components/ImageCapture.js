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
import { cropToStandardAspectRatio, isLandscapeImage } from '../utils/imageAspect';

/**
 * ImageCapture
 * -------------
 * Single unified component that lets the user pick an image via:
 *   1. Camera (live capture)
 *   2. Photo Library
 *   3. Files (document picker)
 *
 * On iOS it shows the native ActionSheetIOS.
 * On Android/Web it falls back to Alert.alert with buttons,
 * since ActionSheetIOS only exists on iOS.
 *
 * Props:
 *   - onImageCapture(uri: string): called with the picked image's local URI
 *   - imageUri?: string              -> optional current image URI to preview
 *   - label?: string                 -> optional label above the picker
 */
export default function ImageCapture({
  onImageCapture,
  imageUri: externalUri,
  label = 'Select image',
  showPreview = true,
}) {
  const [imageUri, setImageUri] = useState(externalUri ?? null);
  const [busy, setBusy] = useState(false);

  const handleResult = async (uri) => {
    if (!uri) return;

    let landscape = false;
    try {
      landscape = await isLandscapeImage(uri);
    } catch (error) {
      console.warn('ImageCapture: could not check image orientation', error);
    }

    if (landscape) {
      Alert.alert(
        'Μη έγκυρη εικόνα',
        'Οι οριζόντιες (16:9) εικόνες δεν επιτρέπονται. Παρακαλώ επιλέξτε μια κάθετη εικόνα.'
      );
      return;
    }

    const croppedUri = await cropToStandardAspectRatio(uri);
    setImageUri(croppedUri);
    onImageCapture?.(croppedUri);
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
        await handleResult(result.assets[0].uri);
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
        await handleResult(result.assets[0].uri);
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
        await handleResult(result.assets[0].uri);
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

      {showPreview ? (
        <>
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
        </>
      ) : (
        <TouchableOpacity
          style={styles.compactRow}
          onPress={presentPicker}
          disabled={busy}
          activeOpacity={0.7}
        >
          <View style={[styles.compactBadge, imageUri && styles.compactBadgeDone]}>
            <Text style={styles.compactBadgeText}>{imageUri ? '✓' : '+'}</Text>
          </View>
          <Text style={styles.compactText}>
            {busy ? 'Loading…' : imageUri ? 'Αλλαγή εικόνας' : 'Προσθήκη εικόνας'}
          </Text>
        </TouchableOpacity>
      )}
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
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  compactBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ccc',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  compactBadgeDone: {
    backgroundColor: '#22c55e',
  },
  compactBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  compactText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
