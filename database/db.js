import { SQLiteProvider, SQLite } from 'expo-sqlite';

const DATABASE_NAME = 'EyeTracking-Auth.db';

export default function App() {
  return (
    <SQLiteProvider
      databaseName={DATABASE_NAME}
      onInit={initializeDatabase}
    >
      <MainApp />
    </SQLiteProvider>
  );
}

async function initializeDatabase(db) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS test (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}