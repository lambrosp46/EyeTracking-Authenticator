import { File, Directory, Paths } from 'expo-file-system';
import settings from '../config/settings.json';

const IMAGES_FOLDER = settings.storage.imagesFolder;

/**
 * Creates the tables if they don't exist yet.
 * Pass this directly as the `onInit` prop of <SQLiteProvider>:
 *   <SQLiteProvider databaseName={settings.storage.dbName} onInit={initDb}>
 */
export async function initDb(db) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      image_filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS SelectedPoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      point_index INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
      UNIQUE (user_id, point_index)
    );

    -- Calibration is NOT stored: every registration and every login runs a
    -- full calibration of its own. Older installs had a Calibrations table;
    -- it is removed so no calibration data stays on the device.
    DROP INDEX IF EXISTS idx_calibrations_user;
    DROP TABLE IF EXISTS Calibrations;
  `);

  // Older versions also kept the last calibration in a JSON file. Remove it.
  try {
    const legacy = new File(Paths.document, 'gaze-calibration.json');
    if (legacy.exists) legacy.delete();
  } catch (e) {
    console.warn('[db] could not remove the old calibration file', e);
  }
}

/**
 * Returns the app's permanent "images" directory, creating it if needed.
 * Lives under the document directory, which iOS/Android never clear
 * automatically (unlike the cache/tmp locations ImagePicker/DocumentPicker
 * return URIs in).
 */
function getImagesDirectory() {
  const dir = new Directory(Paths.document, IMAGES_FOLDER);
  if (!dir.exists) {
    dir.create({ idempotent: true, intermediates: true });
  }
  return dir;
}

/**
 * Copies a picked image (from ImageCapture, living in a cache/temp
 * location) into the app's permanent images directory.
 * Returns just the filename (not the full path) — that's what we
 * store in SQLite, since the full document directory path can change
 * between app reinstalls.
 */
async function saveImagePermanently(sourceUri, username) {
  const imagesDir = getImagesDirectory();

  const extMatch = sourceUri.split('.').pop()?.split('?')[0];
  const extension = extMatch && extMatch.length <= 5 ? extMatch : 'jpg';
  const filename = `${username}_${Date.now()}.${extension}`;

  const sourceFile = new File(sourceUri);
  const destFile = new File(imagesDir, filename);

  await sourceFile.copy(destFile, { overwrite: true });

  return filename;
}

/**
 * Rebuilds the full, current file:// URI for a stored filename.
 * Use this whenever you need to display an image (e.g. <Image source={{ uri }} />).
 */
export function getImageUri(filename) {
  const file = new File(getImagesDirectory(), filename);
  return file.uri;
}

/**
 * Creates a new user: copies their image into permanent storage and
 * inserts a row into Users. Returns the new user's id.
 */
export async function createUser(db, username, pickedImageUri) {
  const filename = await saveImagePermanently(pickedImageUri, username);

  const result = await db.runAsync(
    'INSERT INTO Users (username, image_filename) VALUES (?, ?)',
    username,
    filename
  );

  return result.lastInsertRowId;
}

/**
 * Saves the selected points for a user.
 * points: array of { x, y } in normalized 0-1 coordinates, in selection order.
 */
export async function savePoints(db, userId, points) {
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < points.length; i++) {
      await db.runAsync(
        'INSERT INTO SelectedPoints (user_id, point_index, x, y) VALUES (?, ?, ?, ?)',
        userId,
        i,
        points[i].x,
        points[i].y
      );
    }
  });
}

/**
 * Looks up a user by username. Returns null if not found.
 */
export async function getUserByUsername(db, username) {
  const user = await db.getFirstAsync('SELECT * FROM Users WHERE username = ?', username);
  return user ?? null;
}

/**
 * Returns the stored points for a user, ordered by selection index.
 */
export async function getUserPoints(db, userId) {
  return db.getAllAsync(
    'SELECT point_index, x, y FROM SelectedPoints WHERE user_id = ? ORDER BY point_index ASC',
    userId
  );
}

/**
 * Deletes a user, their points (via ON DELETE CASCADE), and their image file.
 */
export async function deleteUser(db, userId) {
  const user = await db.getFirstAsync('SELECT * FROM Users WHERE id = ?', userId);

  if (user) {
    const file = new File(getImagesDirectory(), user.image_filename);
    if (file.exists) file.delete();
  }

  await db.runAsync('DELETE FROM Users WHERE id = ?', userId);
}