import { requireNativeModule } from 'expo-modules-core';

/**
 * A coarse saliency heatmap: `values` is a row-major grid of `rows * cols`
 * scores in [0, 1] (0 = least visually attention-grabbing, 1 = most).
 * Uses top-left origin — row 0 is the top of the image, matching the
 * { x, y } normalized-point convention used everywhere else in this app
 * (PointSelector, stored auth points). The native side flips Vision's own
 * bottom-left-origin output to this convention.
 */
export type SaliencyMap = {
  rows: number;
  cols: number;
  values: number[];
};

const ExpoSaliencyModule = requireNativeModule('ExpoSaliencyModule');

/**
 * Runs VNGenerateAttentionBasedSaliencyImageRequest (Apple Vision) on the
 * image at `uri` and returns its saliency heatmap. iOS only.
 */
export async function computeSaliencyMap(uri: string): Promise<SaliencyMap> {
  return ExpoSaliencyModule.computeSaliencyMap(uri);
}
