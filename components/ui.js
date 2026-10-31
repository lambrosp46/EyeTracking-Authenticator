import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Κοινά δομικά στοιχεία UI για Home / Login / Register, ώστε οι τρεις οθόνες
 * να έχουν το ίδιο layout, τα ίδια χρώματα και τα ίδια κουμπιά.
 */

export const COLORS = {
  bg: '#f9fafb',
  surface: '#ffffff',
  ink: '#111827',
  body: '#4b5563',
  muted: '#6b7280',
  line: '#d1d5db',
  accent: '#4f46e5',
  accentSoft: '#eef2ff',
  success: '#15803d',
  successSoft: '#dcfce7',
};

/** "‹ Αρχική" — αντικαθιστά το native header στις οθόνες χωρίς header. */
export function BackLink({ label = 'Αρχική', onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Πίσω στην ${label}`}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.back, pressed && styles.pressed]}
    >
      <Text style={styles.backChevron}>‹</Text>
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
}

export function ScreenTitle({ title, lead }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
    </View>
  );
}

/** Κύριο κουμπί. Με `loading` δείχνει spinner και το `loadingLabel`. */
export function PrimaryButton({ label, onPress, disabled, loading, loadingLabel, style }) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        inactive && !loading && styles.primaryDisabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.primaryText}>{loadingLabel}</Text>
        </View>
      ) : (
        <Text style={[styles.primaryText, inactive && styles.primaryTextDisabled]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.secondary, disabled && styles.secondaryDisabled, pressed && styles.pressed, style]}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

/** Πεδίο κειμένου με ετικέτα και ορατή κατάσταση focus. */
export function TextField({ label, style, ...inputProps }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={style}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={COLORS.muted}
        {...inputProps}
        onFocus={(e) => {
          setFocused(true);
          inputProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          inputProps.onBlur?.(e);
        }}
        style={[styles.input, focused && styles.inputFocused]}
      />
    </View>
  );
}

/** Logo + όνομα τμήματος στην κορυφή των οθόνων. */
export function InstitutionHeader({ compact }) {
  return (
    <View style={styles.institution}>
      <Image
        source={require('../assets/logo-pan-patron.png')}
        style={compact ? styles.institutionLogoCompact : styles.institutionLogo}
        accessibilityIgnoresInvertColors
      />
      <Text style={styles.institutionText}>Τμήμα Μηχανικών Η/Υ & Πληροφορικής</Text>
    </View>
  );
}

/**
 * Πεδίο-επιλογή (π.χ. "Σημεία" στην Εγγραφή). Ίδια εμφάνιση με το TextField
 * και το κουμπί εικόνας, ώστε η φόρμα να διαβάζεται ως ένα σύνολο.
 * state: 'empty' | 'loading' | 'done'
 */
export function PickerField({ label, actionLabel, state = 'empty', disabled, onPress, helper, helperTone, style }) {
  const done = state === 'done';
  const loading = state === 'loading';
  const inactive = disabled || loading;
  return (
    <View style={style}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${actionLabel}`}
        accessibilityState={{ disabled: !!inactive, busy: loading, checked: done }}
        disabled={inactive}
        onPress={onPress}
        style={({ pressed }) => [styles.picker, inactive && styles.pickerDisabled, pressed && styles.pressed]}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.accent} style={styles.pickerBadgeSlot} />
        ) : (
          <View style={[styles.pickerBadge, done && styles.pickerBadgeDone]}>
            <Text style={styles.pickerBadgeText}>{done ? '✓' : '+'}</Text>
          </View>
        )}
        <Text style={styles.pickerText}>{actionLabel}</Text>
      </Pressable>
      {helper ? (
        <Text style={[styles.helper, helperTone === 'success' && styles.helperSuccess]}>{helper}</Text>
      ) : null}
    </View>
  );
}

export const layout = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 32 },
});

const styles = StyleSheet.create({
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 44,
    marginLeft: -6,
    paddingRight: 8,
  },
  backChevron: { color: COLORS.accent, fontSize: 30, lineHeight: 32, marginRight: 2 },
  backText: { color: COLORS.accent, fontSize: 17 },

  titleBlock: { alignItems: 'center', marginTop: 24, marginBottom: 28 },
  title: { fontSize: 28, fontWeight: '700', color: COLORS.ink, letterSpacing: -0.4, textAlign: 'center' },
  lead: { marginTop: 8, fontSize: 16, lineHeight: 23, color: COLORS.body, maxWidth: 320, textAlign: 'center' },

  primary: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  primaryDisabled: { backgroundColor: '#c7d2fe' },
  primaryText: { fontSize: 17, fontWeight: '600', color: '#ffffff' },
  primaryTextDisabled: { color: '#ffffff' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  secondary: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  secondaryDisabled: { opacity: 0.4 },
  secondaryText: { fontSize: 17, fontWeight: '600', color: COLORS.accent },

  fieldLabel: { fontSize: 15, fontWeight: '600', color: COLORS.ink, marginBottom: 8 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 16,
    fontSize: 17,
    color: COLORS.ink,
  },
  inputFocused: { borderColor: COLORS.accent, borderWidth: 2, paddingHorizontal: 15 },

  institution: { alignItems: 'center' },
  institutionLogo: { width: 110, height: 110, marginBottom: 12 },
  institutionLogoCompact: { width: 84, height: 84, marginBottom: 10 },
  institutionText: { fontSize: 15, fontWeight: '600', color: '#374151', textAlign: 'center' },

  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 16,
    gap: 10,
  },
  pickerDisabled: { opacity: 0.45 },
  pickerBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerBadgeDone: { backgroundColor: '#22c55e' },
  pickerBadgeSlot: { width: 22 },
  pickerBadgeText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  pickerText: { fontSize: 16, fontWeight: '600', color: COLORS.accent },
  helper: { marginTop: 6, fontSize: 14, lineHeight: 19, color: COLORS.muted },
  helperSuccess: { color: COLORS.success },

  pressed: { opacity: 0.7 },
});
