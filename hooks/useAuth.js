import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';

export function useAuth() {
    const db = useSQLiteContext();
    const [testData, setTestData] = useState([]);

    async function dbTest() {
        try {
            const result = await db.getAllAsync('SELECT * FROM test;');
            console.log('Database test result:', result);
            setTestData(result);
            return result;
        } catch (error) {
            console.error('Error executing database test:', error);
        }
    }

    async function addTest(data) {
        try {
            console.log('Adding test with data:', data);
            await db.runAsync('INSERT INTO test (username) VALUES (?)', [data.username]);
            console.log('Test data added successfully');
            await dbTest(); // Refresh data after inserting
        } catch (error) {
            console.error('Error adding test data:', error);
        }
    }

    return { dbTest, addTest, testData };
};