import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import {
  createUser,
  savePoints,
  getUserByUsername,
  getUserPoints,
  getImageUri,
} from '../database/db';

export function useAuth() {
  const db = useSQLiteContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Registers a new user: saves the image permanently, creates the
   * Users row, then saves the selected points.
   * Throws if the username is already taken.
   */
  async function register(username, imageUri, points) {
    setLoading(true);
    setError(null);
    try {
      const trimmed = username.trim();
      if (!trimmed) throw new Error('Username is required.');

      const existing = await getUserByUsername(db, trimmed);
      if (existing) throw new Error('Username already taken.');

      const userId = await createUser(db, trimmed, imageUri);
      await savePoints(db, userId, points);

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
      return {
        userId: user.id,
        imageUri: getImageUri(user.image_filename),
        points, // stored points, to compare against a new attempt
      };
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  return { register, loadForLogin, loading, error };
}
