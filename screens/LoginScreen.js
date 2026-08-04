import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';

export default function LoginScreen({ navigation }) {
  const { loadForLogin, loading } = useAuth();
  const [username, setUsername] = useState('');

  const handleLogin = async () => {
    const trimmed = username.trim();
    if (!trimmed) {
      Alert.alert('Error', 'Please enter a username.');
      return;
    }

    try {
      const result = await loadForLogin(trimmed);
      if (!result) {
        Alert.alert('Error', 'No account found for that username.');
        return;
      }

      navigation.navigate('AuthPoints', {
        username: trimmed,
        imageUri: result.imageUri,
        storedPoints: result.points,
      });
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong while logging in.');
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={true}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.header}>
              <Image source={require('../assets/logo-pan-patron.gif')} style={styles.logo} />
              <Text style={styles.loginTitle}>Τμήμα Μηχανικών Η/Υ & Πληροφορικής</Text>
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.loginText}>Username</Text>
              <TextInput
                style={styles.input}
                placeholder="Πληκτρολογήστε username"
                placeholderTextColor="#6b7280"
                returnKeyType="done"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />

              {loading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator />
                  <Text style={styles.loadingText}>Συνδέεση…</Text>
                </View>
              ) : (
                <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
                  <Text style={styles.loginButtonText}>Login</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 40,
    paddingBottom: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  logo: {
    width: 90,
    height: 90,
    marginBottom: 12,
  },
  loginTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  inputContainer: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  loginText: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  input: {
    width: '100%',
    height: 52,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#111827',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  loadingText: {
    fontSize: 14,
    color: '#555',
  },
  loginButton: {
    marginTop: 16,
    height: 52,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loginButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
});