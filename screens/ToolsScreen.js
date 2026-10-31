import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { shareSessionLog } from '../utils/sessionLog';

/**
 * Εργαλεία έρευνας / debug. Δεν είναι μέρος της ροής του συμμετέχοντα.
 * Για νέο εργαλείο: πρόσθεσε μια εγγραφή στο TOOLS.
 * opensScreen: true → δείχνει "›" (ανοίγει νέα οθόνη). false → ενέργεια επί τόπου.
 */
const TOOLS = [
  {
    key: 'gaze-test',
    title: 'Δοκιμή Eye Tracker',
    description: 'Βαθμονόμηση, έλεγχος ακρίβειας και ζωντανός δείκτης βλέμματος.',
    opensScreen: true,
    run: (navigation) => navigation.navigate('Test Eye Tracker'),
  },
  {
    key: 'share-logs',
    title: 'Αποστολή logs',
    description: 'Στέλνει το αρχείο καταγραφής αυτής της εκκίνησης μέσω AirDrop, Αρχείων ή Mail.',
    opensScreen: false,
    run: () => shareSessionLog().catch((e) => Alert.alert('Αποστολή logs', e.message)),
  },
];

export default function ToolsScreen({ navigation }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.group}>
        {TOOLS.map((tool, i) => (
          <Pressable
            key={tool.key}
            accessibilityRole="button"
            accessibilityHint={tool.description}
            onPress={() => tool.run(navigation)}
            style={({ pressed }) => [
              styles.row,
              i > 0 && styles.rowDivider,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{tool.title}</Text>
              <Text style={styles.rowDescription}>{tool.description}</Text>
            </View>
            {tool.opensScreen && (
              <Text style={styles.chevron} importantForAccessibility="no">
                ›
              </Text>
            )}
          </Pressable>
        ))}
      </View>

      <Text style={styles.note}>
        Τα εργαλεία αυτά είναι για τον ερευνητή, όχι για τους συμμετέχοντες.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  content: {
    padding: 20,
  },
  group: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#ffffff',
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  rowPressed: {
    backgroundColor: '#f3f4f6',
  },
  rowText: {
    flex: 1,
    paddingRight: 12,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  rowDescription: {
    marginTop: 3,
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 19,
  },
  chevron: {
    fontSize: 24,
    color: '#9ca3af',
  },
  note: {
    marginTop: 12,
    marginHorizontal: 4,
    fontSize: 13,
    color: '#6b7280',
    lineHeight: 18,
  },
});
