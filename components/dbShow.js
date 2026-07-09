import React from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';

export default function DbShow({ testData }) {
  if (!testData || testData.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No data to display</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={testData}
      keyExtractor={(item) => item.id.toString()}
      renderItem={({ item }) => (
        <View style={styles.itemContainer}>
          <Text style={styles.itemText}>ID: {item.id}</Text>
          <Text style={styles.itemText}>Username: {item.username}</Text>
          <Text style={styles.itemText}>Created At: {item.created_at}</Text>
        </View>
      )}
      scrollEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  emptyContainer: {
    padding: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
  },
  itemContainer: {
    backgroundColor: '#f3f4f6',
    padding: 12,
    marginTop: 12,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#4f46e5',
  },
  itemText: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 4,
  },
});