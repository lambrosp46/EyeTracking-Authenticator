import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import settings from '../config/settings.json';
import PositionGuide from './PositionGuide';

/**
 * Second calibration pose, the natural way: "put the phone down for a moment
 * and pick it up again the way you usually hold it".
 *
 * Why not "tilt your head 3°" (the old second pose): new users could not do
 * it by feel, kept being corrected, and then had to find their way back to
 * the first pose. Re-gripping the phone needs no explanation, and the pose
 * change it produces is exactly the natural variation the user will have at
 * login - which is what the head-pose terms of the fit should learn. If the
 * new grip happens to be almost identical, nothing is lost: the fit simply
 * keeps no per-user head terms and the shared head model still applies.
 *
 * Step 1 waits until the phone has clearly been moved (face lost, a fast
 * rotation, or a clear change of distance), or a timeout; step 2 is the normal
 * (lenient) positioning guide, which also makes the user hold still.
 */
export default function RegripStep({ tracker, onReady, onCancel }) {
  const cfg = settings.calibration.secondPose ?? {};
  const [step, setStep] = useState('move'); // move | position
  const [canSkip, setCanSkip] = useState(false);
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;

  useEffect(() => {
    if (step !== 'move') return undefined;
    const t0 = Date.now();
    const startDist = trackerRef.current.lastSampleRef?.current?.distanceCm ?? null;
    let lostSince = null;
    const id = setInterval(() => {
      const s = trackerRef.current.lastSampleRef?.current;
      const now = Date.now();
      let reason = null;
      if (!s?.isTracked) {
        lostSince = lostSince ?? now;
        if (now - lostSince >= (cfg.faceLostMs ?? 300)) reason = 'face lost';
      } else {
        lostSince = null;
        if ((s.deviceRotationDps ?? 0) > (cfg.moveRotationDps ?? 60)) reason = `rotation ${Math.round(s.deviceRotationDps)}°/s`;
        else if (startDist != null && s.distanceCm != null && Math.abs(s.distanceCm - startDist) > (cfg.moveDistanceCm ?? 6)) {
          reason = `distance ${(s.distanceCm - startDist).toFixed(1)}cm`;
        }
      }
      if (now - t0 > (cfg.skipAfterMs ?? 6000)) setCanSkip(true);
      if (reason) {
        console.log(`[Calibration] re-grip: phone moved (${reason}) after ${now - t0}ms`);
        clearInterval(id);
        setStep('position');
      }
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (step === 'position') {
    return (
      <PositionGuide
        tracker={tracker}
        onReady={onReady}
        onCancel={onCancel}
        title="Ξαναπάρε το κινητό"
        subtitle="Κράτα το όπως το κρατάς συνήθως, με το πρόσωπο μέσα στο πλαίσιο. Ακολουθούν μερικές κουκκίδες ακόμα."
      />
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.title}>Ένα λεπτό διάλειμμα</Text>
        <Text style={styles.text}>
          Άφησε για λίγο το κινητό κάτω και ξαναπάρ' το όπως το κρατάς συνήθως.
        </Text>
        <Text style={styles.note}>
          Έτσι η εφαρμογή μαθαίνει πώς αλλάζει το βλέμμα σου όταν αλλάζεις λίγο τη στάση σου.
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={[styles.button, styles.ghost]} onPress={onCancel}>
          <Text style={styles.ghostText}>Ακύρωση</Text>
        </Pressable>
        {canSkip && (
          <Pressable
            style={styles.button}
            onPress={() => {
              console.log('[Calibration] re-grip: continued without a detected move');
              setStep('position');
            }}
          >
            <Text style={styles.buttonText}>Συνέχεια</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingHorizontal: 24 },
  body: { flex: 1, justifyContent: 'center', gap: 18 },
  title: { color: '#FFF', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  text: { color: '#FFF', fontSize: 19, lineHeight: 27, textAlign: 'center' },
  note: { color: '#8E8E93', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  button: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#0A84FF', alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#3A3A3C' },
  ghostText: { color: '#E5E5EA', fontSize: 16, fontWeight: '600' },
});
