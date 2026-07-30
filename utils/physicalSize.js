import { Platform } from 'react-native';

/**
 * Converts a physical length in centimeters to React Native's
 * density-independent layout units (iOS points / Android dp).
 *
 * These units are DESIGNED by each platform to represent a roughly
 * constant physical size across different screen resolutions/pixel
 * densities — that's the whole reason they exist, so this conversion
 * does NOT need PixelRatio.
 *
 * Caveats (worth noting in your methodology):
 * - iOS: ~163 points/inch is Apple's baseline for most iPhones.
 *   "Plus"/"Max" models render at a slightly different effective
 *   density (~153 pt/inch) due to their downsampled @3x rendering,
 *   so on those specific models the physical size will be a few
 *   percent larger than requested.
 * - Android: 160dp/inch is Google's nominal baseline, but real-world
 *   accuracy depends on each manufacturer correctly reporting screen
 *   density — this can be noticeably off on some devices.
 *
 * For UX-level sizing (e.g. how big a target circle looks) this
 * approximation is standard practice and good enough. If you later
 * need millimeter-accurate calibration for the actual eye-tracking
 * hit-test radius (not just this visual indicator), consider
 * calibrating against a known on-screen reference object at app
 * startup instead of relying on a static conversion.
 */
const POINTS_PER_INCH = Platform.select({ ios: 163, android: 160, default: 160 });
const CM_PER_INCH = 2.54;

export function cmToPoints(cm) {
  return (cm / CM_PER_INCH) * POINTS_PER_INCH;
}
