import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import {
  createUser,
  savePoints,
  getUserByUsername,
  getUserPoints,
  getImageUri,
  saveUserCalibration,
  getUserCalibration,
} from '../database/db';

export function useAuth() {
  const db = useSQLiteContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Registers a new user: saves the image permanently, creates the
   * Users row, then saves the selected points.
   * Throws if the username is already taken.
   *
   * `calibration` is the gaze mapping fitted during registration. It is stored
   * per user rather than in one shared file, because the fit encodes that
   * person's own eye geometry - sharing one across accounts would make every
   * user after the first authenticate through someone else's correction.
   */
  async function register(username, imageUri, points, calibration = null, quality = null) {
    setLoading(true);
    setError(null);
    try {
      const trimmed = username.trim();
      if (!trimmed) throw new Error('Username is required.');

      const existing = await getUserByUsername(db, trimmed);
      if (existing) throw new Error('Username already taken.');

      const userId = await createUser(db, trimmed, imageUri);
      await savePoints(db, userId, points);
      if (calibration) {
        await saveUserCalibration(db, userId, calibration, quality);
      }

      return userId;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Loads a user's stored image URI + points, ready for a login/verify screen.
   * Returns null if the username doesn't exist.
   */
  async function loadForLogin(username) {
    setLoading(true);
    setError(null);
    try {
      const user = await getUserByUsername(db, username.trim());
      if (!user) return null;

      const points = await getUserPoints(db, user.id);
      const calibration = await getUserCalibration(db, user.id);
      return {
        userId: user.id,
        imageUri: getImageUri(user.image_filename),
        points, // stored points, to compare against a new attempt
        calibration, // this user's own gaze mapping, or null if never calibrated
      };
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Stores the calibration fitted at the start of a login session.
   *
   * Rows are appended, never replaced, so the Calibrations table becomes a
   * per-user timeline: one fit per registration plus one per login. That
   * history is what makes it possible to show how a user's accuracy drifts
   * across sessions, which a single overwritten "current" fit could not.
   *
   * Deliberately does NOT touch `loading` - it runs in the background while the
   * user is already looking at their points, and must never gate the UI or make
   * a login fail because a write was slow.
   */
  async function saveSessionCalibration(userId, calibration, quality = null) {
    if (!userId || !calibration) return null;
    return saveUserCalibration(db, userId, calibration, quality);
  }

  return { register, loadForLogin, saveSessionCalibration, loading, error };
}
