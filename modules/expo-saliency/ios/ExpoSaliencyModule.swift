import ExpoModulesCore
import Vision
import UIKit

enum SaliencyError: Error, LocalizedError {
  case invalidURI
  case decodeFailed
  case noObservation
  case bufferReadFailed

  var errorDescription: String? {
    switch self {
    case .invalidURI:
      return "Could not resolve the image URI."
    case .decodeFailed:
      return "Could not decode the image at the given URI."
    case .noObservation:
      return "Vision returned no saliency observation for this image."
    case .bufferReadFailed:
      return "Could not read the saliency pixel buffer."
    }
  }
}

// UIImage.Orientation -> CGImagePropertyOrientation, needed so Vision
// analyzes the image the way it's actually displayed (EXIF-corrected),
// not the raw sensor orientation.
extension CGImagePropertyOrientation {
  init(_ uiOrientation: UIImage.Orientation) {
    switch uiOrientation {
    case .up: self = .up
    case .upMirrored: self = .upMirrored
    case .down: self = .down
    case .downMirrored: self = .downMirrored
    case .left: self = .left
    case .leftMirrored: self = .leftMirrored
    case .right: self = .right
    case .rightMirrored: self = .rightMirrored
    @unknown default: self = .up
    }
  }
}

public class ExpoSaliencyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoSaliencyModule")

    // Runs off the JS thread — Vision's request is synchronous CPU work
    // and would otherwise block the bridge for larger images.
    AsyncFunction("computeSaliencyMap") { (uri: String) -> [String: Any] in
      try ExpoSaliencyModule.computeSaliencyMap(uri: uri)
    }
  }

  /// Runs VNGenerateAttentionBasedSaliencyImageRequest and returns a small
  /// row-major grid of saliency scores in [0, 1], flipped to top-left
  /// origin (row 0 = top of the image) so it matches the { x, y }
  /// convention used by the rest of the app (PointSelector, stored points).
  private static func computeSaliencyMap(uri: String) throws -> [String: Any] {
    guard let url = URL(string: uri) else {
      throw SaliencyError.invalidURI
    }
    guard let data = try? Data(contentsOf: url), let image = UIImage(data: data),
          let cgImage = image.cgImage else {
      throw SaliencyError.decodeFailed
    }

    let orientation = CGImagePropertyOrientation(image.imageOrientation)
    let request = VNGenerateAttentionBasedSaliencyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
    try handler.perform([request])

    guard let observation = request.results?.first as? VNSaliencyImageObservation else {
      throw SaliencyError.noObservation
    }

    let pixelBuffer = observation.pixelBuffer
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
      throw SaliencyError.bufferReadFailed
    }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    // VNSaliencyImageObservation's pixelBuffer is single-channel Float32
    // (kCVPixelFormatType_OneComponent32Float): one score per cell, in
    // Vision's bottom-left-origin coordinate space.
    let floatsPerRow = bytesPerRow / MemoryLayout<Float32>.size
    let floatBuffer = base.assumingMemoryBound(to: Float32.self)

    var values = [Double](repeating: 0, count: width * height)
    for visionRow in 0..<height {
      // Flip vertically: Vision's row 0 is the bottom of the image; this
      // module's row 0 is the top (y = 0), matching this app's points.
      let outRow = height - 1 - visionRow
      for col in 0..<width {
        values[outRow * width + col] = Double(floatBuffer[visionRow * floatsPerRow + col])
      }
    }

    return [
      "rows": height,
      "cols": width,
      "values": values,
    ]
  }
}
