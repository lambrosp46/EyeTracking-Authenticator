import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COLORS, InstitutionHeader, PrimaryButton, SecondaryButton } from '../components/ui';

/**
 * Αρχική οθόνη: μόνο οι δύο ροές του χρήστη (Σύνδεση / Εγγραφή).
 * Τα εργαλεία έρευνας/debug (Test Eye Tracker, αποστολή logs) ζουν στην
 * οθόνη "Tools" ώστε να μην μπερδεύουν τους συμμετέχοντες του πειράματος.
 */
export default function HomeScreen({ navigation }) {
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} bounces={false}>
        <View style={styles.top}>
          <InstitutionHeader compact />
        </View>

        <View style={styles.hero}>
          <GazeMotif />
          <Text style={styles.title} accessibilityRole="header">
            Eye Tracking Authenticator
          </Text>
          <Text style={styles.lead}>
            Συνδεθείτε κοιτάζοντας τα μυστικά σημεία της εικόνας σας.
          </Text>
        </View>

        <View style={styles.actions}>
          <PrimaryButton label="Σύνδεση" onPress={() => navigation.navigate('Login')} />
          <SecondaryButton label="Εγγραφή νέου χρήστη" onPress={() => navigation.navigate('Register')} />
        </View>

        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Ανοίγει τα εργαλεία του ερευνητή"
            style={({ pressed }) => [styles.toolsLink, pressed && styles.pressed]}
            onPress={() => navigation.navigate('Tools')}
          >
            <Text style={styles.toolsLinkText}>Εργαλεία έρευνας</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ------------------------------------------------------------------ motif

const FRAME = 152;
const RING = 34;
// Διακοσμητικές θέσεις (κλάσμα του πλαισίου), ΔΕΝ σχετίζονται με κανένα πραγματικό συνθηματικό.
const DOTS = [
  { x: 0.24, y: 0.28 },
  { x: 0.7, y: 0.22 },
  { x: 0.52, y: 0.52 },
  { x: 0.26, y: 0.76 },
  { x: 0.76, y: 0.72 },
];
const toPos = (d) => ({ x: d.x * FRAME - RING / 2, y: d.y * FRAME - RING / 2 });

/**
 * Μια "εικόνα" με 5 σημεία και ένα δαχτυλίδι βλέμματος που περνά από το καθένα.
 * Εξηγεί το concept με μια ματιά. Με Reduce Motion το δαχτυλίδι μένει ακίνητο.
 */
function GazeMotif() {
  const pos = useRef(new Animated.ValueXY(toPos(DOTS[0]))).current;

  useEffect(() => {
    let loop;
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || cancelled) return;
      const steps = [...DOTS.slice(1), DOTS[0]].map((d) =>
        Animated.sequence([
          Animated.timing(pos, {
            toValue: toPos(d),
            duration: 650,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.delay(750),
        ]),
      );
      loop = Animated.loop(Animated.sequence([Animated.delay(750), ...steps]));
      loop.start();
    });

    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [pos]);

  return (
    <View style={styles.frame} accessible={false} importantForAccessibility="no-hide-descendants">
      {DOTS.map((d, i) => (
        <View
          key={i}
          style={[styles.dot, { left: d.x * FRAME - DOT / 2, top: d.y * FRAME - DOT / 2 }]}
        />
      ))}
      <Animated.View
        style={[styles.ring, { transform: [{ translateX: pos.x }, { translateY: pos.y }] }]}
      />
    </View>
  );
}

const DOT = 10;
const INDIGO = COLORS.accent;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  top: {
    paddingTop: 16,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 24,
    paddingBottom: 32,
  },

  frame: {
    width: FRAME,
    height: FRAME,
    borderRadius: 28,
    backgroundColor: '#eef2ff',
    borderWidth: 1,
    borderColor: '#e0e7ff',
    marginBottom: 28,
  },
  dot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: INDIGO,
  },
  ring: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: INDIGO,
    backgroundColor: 'rgba(79,70,229,0.12)',
  },

  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  lead: {
    marginTop: 10,
    maxWidth: 300,
    fontSize: 16,
    lineHeight: 23,
    color: '#4b5563',
    textAlign: 'center',
  },

  actions: {
    gap: 12,
  },

  footer: {
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 8,
  },
  toolsLink: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  toolsLinkText: {
    fontSize: 15,
    fontWeight: '500',
    color: INDIGO,
  },
  pressed: {
    opacity: 0.7,
  },
});
