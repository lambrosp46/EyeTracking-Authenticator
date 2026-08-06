import { File, Paths } from 'expo-file-system';
import settings from '../config/settings.json';

/**
 * Persists the fitted calibration as JSON in the document directory.
 * Same pattern as the image storage: only stable, relative names are stored,
 * never absolute paths (the iOS sandbox UUID changes across reinstalls).
 */

const FILE_NAME = settings.calibration?.storageFile ?? 'gaze-calibration.json';

function calibrationFile() {
  return new File(Paths.document, FILE_NAME);
}

export async function saveCalibration(calibration) {
  try {
    const file = calibrationFile();
    if (!file.exists) file.create({ overwrite: true, intermediates: true });
    file.write(JSON.stringify(calibration));
    return true;
  } catch (e) {
    console.warn('[calibrationStore] save failed:', e);
    return false;
  }
}

export async function loadCalibration() {
  try {
    const file = calibrationFile();
    if (!file.exists) return null;
    const raw = file.text();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.coefX || !parsed?.coefY) return null;
    return parsed;
  } catch (e) {
    console.warn('[calibrationStore] load failed:', e);
    return null;
  }
}

export async function clearCalibration() {
  try {
    const file = calibrationFile();
    if (file.exists) file.delete();
    return true;
  } catch (e) {
    console.warn('[calibrationStore] delete failed:', e);
    return false;
  }
}
