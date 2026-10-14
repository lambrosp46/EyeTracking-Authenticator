import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

/**
 * Thin JS wrapper around the native ARKit module.
 *
 * The native module only exists in a development build on a real iOS device with
 * a TrueDepth camera. On Expo Go, the simulator, Android or web we fall back to a
 * stub so the rest of the app (and the test screen) can still render.
 */

let native = null;
let loadError = null;

if (Platform.OS === 'ios') {
  try {
    native = requireNativeModule('GazeTracker');
  } catch (e) {
    loadError = e;
  }
}

export const isNativeModuleAvailable = native !== null;
export const nativeModuleError = loadError ? String(loadError.message ?? loadError) : null;

/** True only on a physical iPhone X or newer running a dev build. */
export function isSupported() {
  return native ? native.isSupported() : false;
}

export function isRunning() {
  return native ? native.isRunning() : false;
}

/** 'granted' | 'denied' | 'undetermined' */
export function getCameraPermissionStatus() {
  return native ? native.getCameraPermissionStatus() : 'denied';
}

export async function requestCameraPermission() {
  if (!native) return false;
  return native.requestCameraPermission();
}

export async function start(options = {}) {
  if (!native) throw new Error(unavailableMessage());
  return native.start(options);
}

export async function stop() {
  if (!native) return;
  return native.stop();
}

export function setOptions(options = {}) {
  if (!native) return;
  return native.setOptions(options);
}

/**
 * @param {(sample: GazeSample) => void} listener
 * @returns {{ remove: () => void }}
 */
export function addGazeListener(listener) {
  if (!native) return { remove: () => {} };
  return native.addListener('onGazeSample', listener);
}

export function addTrackingStateListener(listener) {
  if (!native) return { remove: () => {} };
  return native.addListener('onTrackingState', listener);
}

export function addErrorListener(listener) {
  if (!native) return { remove: () => {} };
  return native.addListener('onError', listener);
}

function unavailableMessage() {
  if (Platform.OS !== 'ios') return 'Eye tracking is only available on iOS.';
  return (
    'The GazeTracker native module is not loaded. Run a development build ' +
    '(npx expo prebuild && npx expo run:ios) on a physical device - it does not work in Expo Go.'
  );
}

/**
 * @typedef {Object} GazeSample
 * @property {number}  timestamp     ARKit frame time, seconds.
 * @property {boolean} isTracked     Face anchor currently tracked.
 * @property {boolean} hasHit        The gaze ray intersected the screen plane.
 * @property {number} [sx]           Metres right of the front camera lens.
 * @property {number} [sy]           Metres below the front camera lens.
 * @property {number} [distanceCm]   Eye-to-screen distance.
 * @property {number}  blinkLeft     0..1 blend shape.
 * @property {number}  blinkRight    0..1 blend shape.
 * @property {boolean} eyesOpen
 * @property {number} [eyesUsed]     How many eyes contributed to sx/sy.
 * @property {number} [eyeDisparityCm] Distance between the two per-eye hits.
 *
 * Head pose - sent whenever a face anchor exists, even if the gaze ray misses
 * the screen. Same portrait frame as sx/sy (x right, y down, from the lens).
 * @property {number} [headXCm]      Eye midpoint, cm right of the lens.
 * @property {number} [headYCm]      Eye midpoint, cm below the lens.
 * @property {number} [headZCm]      Eye midpoint, cm in front of the screen plane.
 * @property {number} [faceDirX]     Unit vector out of the face: right component.
 * @property {number} [faceDirY]     ... down component.
 * @property {number} [faceDirZ]     ... towards-the-screen component (> 0 when facing it).
 * @property {number} [headRollDeg]  Sideways head tilt relative to the phone, 0 = upright.
 * @property {number} [interEyeCm]   Distance between the eye centres (sanity check, ~6 cm).
 *
 * Research extras (used by the calibration data dump):
 * @property {number} [altSx]   sx computed with the OTHER rayMode (lookAtPoint <-> eyeTransforms).
 * @property {number} [altSy]   sy, same.
 * @property {number} lookUpL / lookUpR / lookDownL / lookDownR / lookInL / lookInR /
 *           lookOutL / lookOutR / squintL / squintR / wideL / wideR   eye blend shapes 0..1
 *
 * Device pose - from ARKit's gravity-aligned camera transform.
 * @property {number} [deviceTiltDeg]     0 = upright, + = leaned back, 90 = flat face-up.
 * @property {number} [deviceRotationDps] Rotation speed of the phone, deg/s.
 */
