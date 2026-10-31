import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { shareAllSessionLogs, shareSessionLog } from '../utils/sessionLog';

/**
 * Εργαλεία έρευνας / debug. Δεν είναι μέρος της ροής του συμμετέχοντα.
 * Για νέο εργαλείο: πρόσθεσε μια εγγραφή στο TOOLS.
 */
const TOOLS = [
  {
    key: 'gaze-test',
    title: 'Δοκιμή Eye Tracker',
    description: 'Βαθμονόμηση, επικύρωση και ζωντανός δείκτης βλέμματος.',
    run: (navigation) => navigation.navigate('Test Eye Tracker'),
  },
  {
    key: 'share-logs',
    title: 'Αποστολή logs',
    description: 'Κοινοποίηση του αρχείου καταγραφής αυτής της εκκίνησης (AirDrop, Αρχεία, Mail).',
    run: () => shareSessionLog().catch((e) => Alert.alert('Logs', e.message)),
  },
  {
    key: 'share-all-logs',
    title: 'Αποστολή όλων των logs',
    description: 'Όλα τα logs του κινητού ενωμένα σε ένα αρχείο, για ανάλυση (AirDrop, Αρχεία, Mail).',
    run: () => shareAllSessionLogs().catch((e) => Alert.alert('Logs', e.message)),
  },
];

export default function ToolsScreen({ navigation }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionLabel}>ΕΡΕΥΝΑ & DEBUG</Text>

      <View style={styles.group}>
        {TOOLS.map((tool, i) => (
          <Pressable
            key={tool.key}
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
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.note}>
        Τα εργαλεία αυτά προορίζονται για τον ερευνητή και όχι για τους συμμετέχοντες.
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
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
  },
  group: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
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
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  rowDescription: {
    marginTop: 3,
    fontSize: 13,
    color: '#6b7280',
    lineHeight: 18,
  },
  chevron: {
    fontSize: 22,
    color: '#9ca3af',
  },
  note: {
    marginTop: 12,
    marginHorizontal: 4,
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 17,
  },
});
