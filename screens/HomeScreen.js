import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Αρχική οθόνη: μόνο οι δύο ροές του χρήστη (Σύνδεση / Εγγραφή).
 * Τα εργαλεία έρευνας/debug (Test Eye Tracker, αποστολή logs) ζουν στην
 * οθόνη "Tools" ώστε να μην μπερδεύουν τους συμμετέχοντες του πειράματος.
 */
export default function HomeScreen({ navigation }) {
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.hero}>
        <Image source={require('../assets/logo-pan-patron.gif')} style={styles.logo} />
        <Text style={styles.title}>Eye Tracking Authenticator</Text>
        <Text style={styles.subtitle}>Τμήμα Μηχανικών Η/Υ & Πληροφορικής</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLead}>
          Συνδεθείτε κοιτάζοντας τα μυστικά σημεία της εικόνας σας.
        </Text>

        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={styles.primaryButtonText}>Σύνδεση</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => navigation.navigate('Register')}
        >
          <Text style={styles.secondaryButtonText}>Εγγραφή νέου χρήστη</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Pressable
          hitSlop={12}
          style={({ pressed }) => [styles.toolsLink, pressed && styles.pressed]}
          onPress={() => navigation.navigate('Tools')}
        >
          <Text style={styles.toolsLinkText}>Εργαλεία έρευνας  ›</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    paddingHorizontal: 20,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 28,
  },
  logo: {
    width: 110,
    height: 110,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  card: {
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
  cardLead: {
    fontSize: 14,
    color: '#4b5563',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  primaryButton: {
    height: 52,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  secondaryButton: {
    marginTop: 12,
    height: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#4f46e5',
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4f46e5',
  },
  footer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 12,
  },
  toolsLink: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  toolsLinkText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  pressed: {
    opacity: 0.7,
  },
});
