import { Alert, StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { shareSessionLog } from '../utils/sessionLog';
import React from 'react';

export default function HomeScreen( { navigation } ) {
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerText}>Eye Tracking Authenticator</Text>
            </View>
            <View style={styles.content}>
                <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('Login')}>
                    <Text style={styles.buttonText}>Login</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('Register')}>
                    <Text style={styles.buttonText}>Register</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('Test Eye Tracker')}>
                    <Text style={styles.buttonText}>Test Eye Tracker</Text>
                </TouchableOpacity>
                {/* Sends this launch's full log file (AirDrop, Files, Mail...). */}
                <TouchableOpacity
                    style={styles.button}
                    onPress={() => shareSessionLog().catch((e) => Alert.alert('Logs', e.message))}
                >
                    <Text style={styles.buttonText}>Αποστολή logs</Text>
                </TouchableOpacity>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
