import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import React from 'react';

export default function HomeScreen( { navigation } ) {
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerText}>Eye Tracking Authenticator</Text>
            </View>
            <View style={styles.content}>
                {/*<Text style={styles.paragraph}>Welcome to the Eye Tracking Authenticator!</Text>
                <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('Login')}>
                    <Text style={styles.buttonText}>Login</Text>
                </TouchableOpacity>*/}
                <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('Register')}>
                    <Text style={styles.buttonText}>Register</Text>
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
