import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import settings from '../config/settings.json';

/**
 * Center-crops an image to a standard aspect ratio, so every user's
 * point-selection image ends up the same shape (keeps the visible area,
 * and therefore the tap-target density, consistent across registrations).
 *
 * The target ratio is settings.imageProcessing.standardAspectWidth/Height
 * (16:9 by default), but the ORIENTATION of the original image is always
 * preserved: a portrait photo is cropped towards 9:16, a landscape photo
 * towards 16:9. Applying a literal landscape 16:9 crop to a portrait photo
 * would discard most of the image, so this avoids that.
 *
 * Dimensions are read via a no-op ImageManipulator pass rather than RN's
 * Image.getSize(), because Image.getSize() can report the raw sensor
 * (pre-EXIF-rotation) dimensions for some photos, while ImageManipulator's
 * crop coordinates operate on the EXIF-corrected, visually-upright image —
 * mixing the two silently produces a wrong (but non-crashing) crop.
 *
 * Returns the new (cropped) file's URI. On any failure, logs a warning and
 * returns the original URI unchanged, so a processing hiccup never blocks
 * registration.
 */
export async function cropToStandardAspectRatio(uri) {
  try {
    const { standardAspectWidth, standardAspectHeight } = settings.imageProcessing;

    // Probe pass: no operations, just decode to learn the real,
    // EXIF-corrected width/height.
    const probeContext = ImageManipulator.manipulate(uri);
    const probeRendered = await probeContext.renderAsync();
    const { width, height } = probeRendered;
    probeContext.release();
    probeRendered.release();

    const isPortrait = height > width;
    const targetRatio = isPortrait
      ? standardAspectHeight / standardAspectWidth // e.g. 9/16
      : standardAspectWidth / standardAspectHeight; // e.g. 16/9

    const currentRatio = width / height;

    let cropWidth = width;
    let cropHeight = height;

    if (currentRatio > targetRatio) {
      // wider than target -> crop the sides
      cropWidth = Math.round(height * targetRatio);
    } else if (currentRatio < targetRatio) {
      // taller than target -> crop top/bottom
      cropHeight = Math.round(width / targetRatio);
    } else {
      return uri; // already the right shape, skip processing
    }

    const originX = Math.round((width - cropWidth) / 2);
    const originY = Math.round((height - cropHeight) / 2);

    const context = ImageManipulator.manipulate(uri);
    const rendered = await context
      .crop({ originX, originY, width: cropWidth, height: cropHeight })
      .renderAsync();
    const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });

    context.release();
    rendered.release();

    console.log('cropToStandardAspectRatio: done', {
      original: { width, height },
      cropped: { width: result.width, height: result.height, ratio: (result.width / result.height).toFixed(3) },
    });

    return result.uri;
  } catch (error) {
    console.warn('cropToStandardAspectRatio: failed, using original image', error);
    return uri;
  }
}