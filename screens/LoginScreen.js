import React, { useState } from 'react';
import { ScrollView, Alert, KeyboardAvoidingView, StyleSheet } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import {
  BackLink,
  InstitutionHeader,
  PrimaryButton,
  ScreenTitle,
  TextField,
  layout,
} from '../components/ui';

export default function LoginScreen({ navigation }) {
  const { loadForLogin, loading } = useAuth();
  const [username, setUsername] = useState('');

  const handleLogin = async () => {
    const trimmed = username.trim();
    if (!trimmed) {
      Alert.alert('Λείπει το username', 'Πληκτρολογήστε το username σας για να συνεχίσετε.');
      return;
    }

    try {
      const result = await loadForLogin(trimmed);
      if (!result) {
        Alert.alert(
          'Δεν βρέθηκε λογαριασμός',
          `Δεν υπάρχει χρήστης «${trimmed}». Ελέγξτε το username ή κάντε εγγραφή.`,
        );
        return;
      }

      // userId travels with the rest so the login screen can append this
      // session's calibration to that user's history (drift analysis).
      navigation.navigate('AuthPoints', {
        username: trimmed,
        userId: result.userId,
        imageUri: result.imageUri,
        storedPoints: result.points,
      });
    } catch (err) {
      Alert.alert('Η σύνδεση απέτυχε', err.message || 'Δοκιμάστε ξανά.');
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={layout.screen} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <ScrollView
            contentContainerStyle={layout.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <BackLink onPress={() => navigation.goBack()} />

            <InstitutionHeader compact />

            <ScreenTitle
              title="Σύνδεση"
              lead="Πληκτρολογήστε το username σας. Μετά από μια σύντομη βαθμονόμηση θα κοιτάξετε τα σημεία της εικόνας σας."
            />

            <TextField
              label="Username"
              placeholder="π.χ. Lambros"
              returnKeyType="go"
              onSubmitEditing={handleLogin}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              editable={!loading}
            />

            <PrimaryButton
              label="Συνέχεια"
              onPress={handleLogin}
              loading={loading}
              loadingLabel="Αναζήτηση λογαριασμού…"
              style={styles.cta}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  cta: { marginTop: 20 },
});
