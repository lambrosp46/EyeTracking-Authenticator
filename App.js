import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SQLiteProvider } from 'expo-sqlite';

import settings from './config/settings.json';
import { initDb } from './database/db';

import HomeScreen from './screens/HomeScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <SQLiteProvider
      databaseName={settings.storage.dbName}
      onInit={initDb}
      onError={(error) => console.error('DB init failed:', error)}
    >
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
          {/*<Stack.Screen name="Login" component={LoginScreen} /> */}
        </Stack.Navigator>
      </NavigationContainer>
    </SQLiteProvider>
  );
}