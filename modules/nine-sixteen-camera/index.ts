import { requireNativeModule } from 'expo-modules-core';

export type NineSixteenCameraResult = {
  uri: string;
  width: number;
  height: number;
};

const NineSixteenCameraModule = requireNativeModule('NineSixteenCamera');

/**
 * Presents a full-screen custom camera with a 9:16 framing guide overlay.
 * Resolves with the captured (and already 9:16-cropped) photo's file URI,
 * or `null` if the user cancelled.
 */
export async function presentNineSixteenCamera(): Promise<NineSixteenCameraResult | null> {
  return await NineSixteenCameraModule.presentCamera();
}
