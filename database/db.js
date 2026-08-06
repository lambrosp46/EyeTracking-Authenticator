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

    CREATE TABLE IF NOT EXISTS Calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      coef_x TEXT NOT NULL,
      coef_y TEXT NOT NULL,
      rmse_cm REAL,
      max_cm REAL,
      sample_count INTEGER,
      distance_cm REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_calibrations_user
      ON Calibrations (user_id, created_at DESC);
  `);
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
 * Saves a fitted calibration for a user.
 *
 * Rows are kept rather than overwritten: each login/registration can produce a
 * new fit, and the history is what lets you show accuracy drift over time in
 * the evaluation. `getUserCalibration` always returns the newest.
 *
 * The coefficient arrays are stored as JSON text — SQLite has no array type,
 * and the length varies with the model (3 per axis for affine, 6 for quadratic).
 */
export async function saveUserCalibration(db, userId, calibration, quality = null) {
  const result = await db.runAsync(
    `INSERT INTO Calibrations
       (user_id, model, coef_x, coef_y, rmse_cm, max_cm, sample_count, distance_cm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    calibration.model,
    JSON.stringify(calibration.coefX),
    JSON.stringify(calibration.coefY),
    quality?.rmseCm ?? null,
    quality?.maxCm ?? null,
    quality?.sampleCount ?? calibration.sampleCount ?? null,
    quality?.distanceCm ?? null
  );
  return result.lastInsertRowId;
}

/**
 * Returns a user's most recent calibration in the shape the gaze mapping
 * expects ({ model, coefX, coefY }), or null if they have never calibrated.
 */
export async function getUserCalibration(db, userId) {
  const row = await db.getFirstAsync(
    'SELECT * FROM Calibrations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    userId
  );
  if (!row) return null;

  try {
    return {
      model: row.model,
      coefX: JSON.parse(row.coef_x),
      coefY: JSON.parse(row.coef_y),
      rmseCm: row.rmse_cm,
      maxCm: row.max_cm,
      sampleCount: row.sample_count,
      distanceCm: row.distance_cm,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/** Full calibration history for a user — useful for the drift analysis. */
export async function getUserCalibrationHistory(db, userId) {
  return db.getAllAsync(
    `SELECT id, model, rmse_cm, max_cm, sample_count, distance_cm, created_at
     FROM Calibrations WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    userId
  );
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