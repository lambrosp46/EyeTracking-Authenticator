import { React, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Image, TouchableOpacity, FlatList, ScrollView } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import DbShow from '../components/dbShow';

export default function RegisterScreen({ navigation }) {
  const { addTest, dbTest, testData } = useAuth();
  const [username, setUsername] = useState('');
  const [displayData, setDisplayData] = useState(false);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={true}>
          <View style={styles.header}>
            <Image source={require('../assets/logo-pan-patron.gif')} style={styles.logo} />
            <Text style={styles.registerTitle}>Τμήμα Μηχανικών Η/Υ & Πληροφορικής</Text>
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.registerText}>Username</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your username"
              placeholderTextColor="#6b7280"
              returnKeyType="done"
              onChangeText={(text) => setUsername(text)}
            />
            
            <Text style={styles.registerText}>Ανεβάστε εικόνα για κωδικό</Text>
            <TouchableOpacity style={styles.button} onPress={() => addTest({ username: username })}>
              <Text style={styles.buttonText}>Test</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={() => {dbTest(); setDisplayData(!displayData)}} > 
              <Text style={styles.buttonText}>{displayData ? 'Hide' : 'Display'}</Text>
            </TouchableOpacity>
            {displayData && <DbShow testData={testData} />}
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottomizontal: 20,
    paddingTop: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: {
    width: 110,
    height: 110,
    marginBottom: 16,
  },
  registerTitle: {
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
  registerText: {
    fontSize: 15,
    color: '#374151',
    marginBottom: 10,
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
  button: {
    width: '100%',
    height: 52,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
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