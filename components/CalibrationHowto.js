import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * "Before you start" screen shown before every calibration.
 *
 * Why: in the first test with people new to eye tracking, the two errors that
 * ruined their calibrations were (1) turning the HEAD towards each dot instead
 * of moving only the eyes (head range up to 13° vs < 2° for a trained user),
 * and (2) not holding the gaze on the dot (about twice the jitter). Nobody had
 * told them how eye tracking is done. The animation shows exactly that: a face
 * that stays still while only its eyes look around.
 */
export default function CalibrationHowto({ onStart, onCancel }) {
  const px = useRef(new Animated.Value(0)).current;
  const py = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const step = (x, y) =>
      Animated.parallel([
        Animated.timing(px, { toValue: x, duration: 350, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(py, { toValue: y, duration: 350, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]);
    const hold = Animated.delay(550);
    const loop = Animated.loop(
      Animated.sequence([
        step(-1, -1), hold, step(1, -1), hold, step(1, 1), hold, step(-1, 1), hold, step(0, 0), hold,
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [px, py]);

  // the dot the eyes are looking at, in the corner they look towards
  const dotX = px.interpolate({ inputRange: [-1, 1], outputRange: [-110, 110] });
  const dotY = py.interpolate({ inputRange: [-1, 1], outputRange: [-95, 95] });
  const pupilX = px.interpolate({ inputRange: [-1, 1], outputRange: [-7, 7] });
  const pupilY = py.interpolate({ inputRange: [-1, 1], outputRange: [-5, 5] });

  const eye = (
    <View style={styles.eye}>
      <Animated.View style={[styles.pupil, { transform: [{ translateX: pupilX }, { translateY: pupilY }] }]} />
    </View>
  );

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Πριν ξεκινήσεις</Text>

      <View style={styles.stage}>
        <Animated.View style={[styles.dot, { transform: [{ translateX: dotX }, { translateY: dotY }] }]} />
        <View style={styles.face}>
          <View style={styles.eyes}>
            {eye}
            {eye}
          </View>
          <View style={styles.mouth} />
        </View>
        <Text style={styles.caption}>Το κεφάλι μένει ακίνητο — κινούνται μόνο τα μάτια</Text>
      </View>

      <View style={styles.rules}>
        <Rule n="1" text="Κράτα το κεφάλι ακίνητο. Κοίτα τις κουκκίδες κινώντας μόνο τα μάτια." />
        <Rule n="2" text="Κοίτα το κέντρο κάθε κουκκίδας μέχρι να γεμίσει και να εξαφανιστεί." />
        <Rule n="3" text="Κράτα το κινητό σταθερό και μη μιλάς. Βοηθάει καλός φωτισμός στο πρόσωπο." />
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.button, styles.ghost]} onPress={onCancel}>
          <Text style={styles.ghostText}>Ακύρωση</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={onStart}>
          <Text style={styles.buttonText}>Ξεκίνα</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Rule({ n, text }) {
  return (
    <View style={styles.rule}>
      <View style={styles.ruleNum}>
        <Text style={styles.ruleNumText}>{n}</Text>
      </View>
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

const FACE_W = 120;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingHorizontal: 24 },
  title: { color: '#FFF', fontSize: 24, fontWeight: '700', textAlign: 'center', marginTop: 24 },
  stage: { height: 300, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  dot: {
    position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFD60A',
  },
  face: {
    width: FACE_W, height: FACE_W * 1.3, borderRadius: FACE_W / 2, borderWidth: 3, borderColor: '#34C759',
    alignItems: 'center', justifyContent: 'center',
  },
  eyes: { flexDirection: 'row', gap: 18, marginBottom: 22 },
  eye: {
    width: 30, height: 20, borderRadius: 10, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center',
  },
  pupil: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#000' },
  mouth: { width: 34, height: 3, borderRadius: 2, backgroundColor: '#34C759' },
  caption: { position: 'absolute', bottom: 0, color: '#34C759', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  rules: { marginTop: 16, gap: 14 },
  rule: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  ruleNum: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFD60A', alignItems: 'center', justifyContent: 'center',
  },
  ruleNumText: { color: '#000', fontWeight: '700' },
  ruleText: { flex: 1, color: '#E5E5EA', fontSize: 16, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 'auto', marginBottom: 16 },
  button: {
    flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#0A84FF', alignItems: 'center',
  },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#3A3A3C' },
  ghostText: { color: '#E5E5EA', fontSize: 16, fontWeight: '600' },
});
