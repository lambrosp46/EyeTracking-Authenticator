import { SQLiteProvider } from 'expo-sqlite';

export default function App() {
  return (
    <SQLiteProvider
      databaseName="EyeTracking-Auth.db"
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