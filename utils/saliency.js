import { computeSaliencyMap as computeSaliencyMapNative } from '../modules/expo-saliency';

// Per-imageUri cache, so re-opening/remounting PointSelector for the same
// registration image (e.g. the "confirm" pass, or re-tapping "Αλλαγή
// σημείων") doesn't re-run Vision's saliency request every time.
const cache = new Map();

/**
 * Computes (and caches) the saliency map for `uri` via the native
 * expo-saliency module (Vision's VNGenerateAttentionBasedSaliencyImageRequest).
 * iOS only — rejects on Android/web, callers should catch and degrade
 * gracefully (skip saliency gating) rather than block registration.
 */
export async function getSaliencyMap(uri) {
  if (cache.has(uri)) return cache.get(uri);
  const map = await computeSaliencyMapNative(uri);
  cache.set(uri, map);
  return map;
}

/**
 * Samples a saliency map at a normalized { x, y } point (top-left origin,
 * [0, 1] range — same convention as PointSelector's tap points). Uses
 * nearest-cell lookup: the map is a coarse grid (tens of cells per side),
 * so bilinear interpolation wouldn't meaningfully change which side of the
 * high/low-saliency threshold a tap falls on.
 */
export function sampleSaliency(map, x, y) {
  if (!map || !map.rows || !map.cols) return 0;
  const col = Math.min(map.cols - 1, Math.max(0, Math.floor(x * map.cols)));
  const row = Math.min(map.rows - 1, Math.max(0, Math.floor(y * map.rows)));
  return map.values[row * map.cols + col];
}

/** Whether the point { x, y } lands on a region scoring >= minScore. */
export function isHighSaliency(map, x, y, minScore) {
  return sampleSaliency(map, x, y) >= minScore;
}

// Grayscale ramp used by saliencyMapToAscii, darkest (lowest score) first.
const ASCII_RAMP = ' .:-=+*#%@';

/**
 * Renders a saliency map as a small ASCII-art heatmap (one character per
 * cell, brighter/denser characters = higher saliency), downsampled to at
 * most `maxWidth` columns so it stays readable in a console/log viewer.
 * Debug-only helper — see logSaliencyMapStats.
 */
export function saliencyMapToAscii(map, maxWidth = 64) {
  if (!map || !map.rows || !map.cols) return '(no map)';
  const { rows, cols, values } = map;
  const step = Math.max(1, Math.ceil(cols / maxWidth));
  let out = '';
  for (let r = 0; r < rows; r += step) {
    let line = '';
    for (let c = 0; c < cols; c += step) {
      const v = values[r * cols + c] ?? 0;
      const idx = Math.min(ASCII_RAMP.length - 1, Math.max(0, Math.round(v * (ASCII_RAMP.length - 1))));
      line += ASCII_RAMP[idx];
    }
    out += `${line}\n`;
  }
  return out;
}

/**
 * Debug helper: logs the saliency map's dimensions, min/max/mean score, and
 * an ASCII-art rendering of it, so you can eyeball whether Vision actually
 * highlighted the right region of the image (e.g. a face) instead of
 * silently trusting the gating logic. Call once right after computing the
 * map — remove/guard behind __DEV__ once you're confident it's correct.
 */
export function logSaliencyMapStats(map, label = 'saliency map') {
  if (!map || !map.values || !map.values.length) {
    console.log(`[${label}] no map / empty values`, map);
    return;
  }
  const { rows, cols, values } = map;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let maxIndex = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) {
      max = v;
      maxIndex = i;
    }
    sum += v;
  }
  const mean = sum / values.length;
  // Center of the highest-scoring cell, in the same normalized { x, y }
  // (top-left origin) units as tap points — compare this directly against
  // where you actually tapped to sanity-check the mapping.
  const peakRow = Math.floor(maxIndex / cols);
  const peakCol = maxIndex % cols;
  const peakX = (peakCol + 0.5) / cols;
  const peakY = (peakRow + 0.5) / rows;
  console.log(
    `[${label}] ${cols}x${rows} grid — min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${mean.toFixed(3)} peak@(${peakX.toFixed(3)}, ${peakY.toFixed(3)})`
  );
  console.log(`[${label}] ascii heatmap (brighter = higher saliency):\n${saliencyMapToAscii(map)}`);
}
