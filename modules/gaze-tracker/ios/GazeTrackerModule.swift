import ExpoModulesCore
import ARKit
import AVFoundation
import simd

// MARK: - Options passed from JS

struct GazeOptions: Record {
  /// Minimum time between emitted samples. ARKit runs the face session at 60 Hz;
  /// 33 ms throttles us to ~30 Hz which is plenty for a gaze cursor.
  @Field var updateIntervalMs: Double = 33.0

  /// "eyeTransforms" -> ray = +Z axis of ARFaceAnchor.left/rightEyeTransform (recommended)
  /// "lookAtPoint"   -> ray = eye -> ARFaceAnchor.lookAtPoint (Apple's coarser estimate)
  @Field var rayMode: String = "eyeTransforms"

  @Field var useLeftEye: Bool = true
  @Field var useRightEye: Bool = true

  /// Blend-shape value above which an eye counts as closed.
  @Field var blinkThreshold: Double = 0.55
}

// MARK: - Module

public class GazeTrackerModule: Module {
  private var tracker: GazeTracker?

  public func definition() -> ModuleDefinition {
    Name("GazeTracker")

    Events("onGazeSample", "onTrackingState", "onError")

    Function("isSupported") { () -> Bool in
      return ARFaceTrackingConfiguration.isSupported
    }

    Function("isRunning") { () -> Bool in
      return self.tracker?.isRunning ?? false
    }

    Function("getCameraPermissionStatus") { () -> String in
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: return "granted"
      case .denied, .restricted: return "denied"
      default: return "undetermined"
      }
    }

    AsyncFunction("requestCameraPermission") { (promise: Promise) in
      AVCaptureDevice.requestAccess(for: .video) { granted in
        promise.resolve(granted)
      }
    }

    AsyncFunction("start") { (options: GazeOptions) in
      guard ARFaceTrackingConfiguration.isSupported else {
        throw FaceTrackingUnsupportedException()
      }
      if self.tracker == nil {
        self.tracker = GazeTracker(
          onSample: { [weak self] payload in self?.sendEvent("onGazeSample", payload) },
          onState: { [weak self] payload in self?.sendEvent("onTrackingState", payload) },
          onError: { [weak self] payload in self?.sendEvent("onError", payload) }
        )
      }
      self.tracker?.apply(options: options)
      self.tracker?.start()
    }
    .runOnQueue(.main)

    AsyncFunction("stop") {
      self.tracker?.stop()
    }
    .runOnQueue(.main)

    Function("setOptions") { (options: GazeOptions) in
      self.tracker?.apply(options: options)
    }

    OnDestroy {
      self.tracker?.stop()
      self.tracker = nil
    }
  }
}

internal final class FaceTrackingUnsupportedException: Exception, @unchecked Sendable {
  override var reason: String {
    "ARFaceTrackingConfiguration is not supported on this device. A TrueDepth camera (iPhone X or newer) and a real device are required."
  }
}

// MARK: - ARKit session wrapper

/// Runs a head-less ARKit face-tracking session (no ARSCNView / no preview) and
/// projects the gaze ray of each eye onto the plane of the device screen.
///
/// Coordinate reminder (ARKit `camera.transform`):
///   The camera space is defined with the device in **landscape-right**:
///     +X = screen right in landscape-right  = "down"  in portrait
///     +Y = screen up    in landscape-right  = "right" in portrait
///     +Z = out of the screen, towards the user (so the face sits at z < 0)
///   The screen surface is therefore the plane z = 0, and the origin of that
///   plane is the front camera lens - not the corner of the display. The
///   remaining lens->corner offset is absorbed by the JS calibration fit.
final class GazeTracker: NSObject, ARSessionDelegate {

  private let session = ARSession()
  private let delegateQueue = DispatchQueue(label: "com.eyeauth.gazetracker", qos: .userInteractive)
  private let lock = NSLock()

  private let onSample: ([String: Any]) -> Void
  private let onState: ([String: Any]) -> Void
  private let onError: ([String: Any]) -> Void

  private var updateInterval: TimeInterval = 1.0 / 30.0
  private var rayMode: String = "eyeTransforms"
  private var useLeftEye = true
  private var useRightEye = true
  private var blinkThreshold: Float = 0.55

  private var lastEmit: TimeInterval = 0
  private var lastFaceVisible: Bool? = nil
  private(set) var isRunning = false

  /// Device orientation (world space) at the previous emitted sample, used to
  /// derive how fast the phone is rotating. Reset on every start.
  private var lastDeviceRotation: simd_float3x3? = nil
  private var lastRotationTime: TimeInterval = 0

  init(
    onSample: @escaping ([String: Any]) -> Void,
    onState: @escaping ([String: Any]) -> Void,
    onError: @escaping ([String: Any]) -> Void
  ) {
    self.onSample = onSample
    self.onState = onState
    self.onError = onError
    super.init()
    session.delegateQueue = delegateQueue
    session.delegate = self
  }

  func apply(options: GazeOptions) {
    lock.lock()
    updateInterval = max(0, options.updateIntervalMs) / 1000.0
    rayMode = options.rayMode
    useLeftEye = options.useLeftEye
    useRightEye = options.useRightEye
    blinkThreshold = Float(options.blinkThreshold)
    lock.unlock()
  }

  /// One place for the session configuration, so a resumed session runs with
  /// exactly the same settings as a fresh one. `.gravity` matters: it is what
  /// makes the world y-axis point up, which the device tilt below relies on.
  private func makeConfiguration() -> ARFaceTrackingConfiguration {
    let config = ARFaceTrackingConfiguration()
    config.isLightEstimationEnabled = false
    config.maximumNumberOfTrackedFaces = 1
    config.worldAlignment = .gravity
    return config
  }

  func start() {
    guard !isRunning else { return }
    session.run(makeConfiguration(), options: [.resetTracking, .removeExistingAnchors])
    isRunning = true
    lastEmit = 0
    lastFaceVisible = nil
    lastDeviceRotation = nil
    lastRotationTime = 0
    onState(["state": "started", "isRunning": true])
  }

  func stop() {
    guard isRunning else { return }
    session.pause()
    isRunning = false
    onState(["state": "stopped", "isRunning": false])
  }

  // MARK: ARSessionDelegate

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    lock.lock()
    let interval = updateInterval
    let mode = rayMode
    let wantsLeft = useLeftEye
    let wantsRight = useRightEye
    let blinkLimit = blinkThreshold
    lock.unlock()

    let now = frame.timestamp

    guard let face = frame.anchors.compactMap({ $0 as? ARFaceAnchor }).first else {
      if lastFaceVisible != false {
        lastFaceVisible = false
        onState(["state": "faceLost", "isRunning": true])
      }
      return
    }

    if lastFaceVisible != true {
      lastFaceVisible = true
      onState(["state": "faceFound", "isRunning": true])
    }

    guard now - lastEmit >= interval else { return }
    lastEmit = now

    let view = simd_inverse(frame.camera.transform)

    let left = wantsLeft ? intersect(eye: face.leftEyeTransform, face: face, view: view, mode: mode) : nil
    let right = wantsRight ? intersect(eye: face.rightEyeTransform, face: face, view: view, mode: mode) : nil

    let blinkLeft = face.blendShapes[.eyeBlinkLeft]?.floatValue ?? 0
    let blinkRight = face.blendShapes[.eyeBlinkRight]?.floatValue ?? 0

    let leftOpen = blinkLeft < blinkLimit
    let rightOpen = blinkRight < blinkLimit

    // Only average eyes that are both open and produced a valid intersection.
    var hits: [EyeHit] = []
    if let l = left, leftOpen { hits.append(l) }
    if let r = right, rightOpen { hits.append(r) }

    var payload: [String: Any] = [
      "timestamp": now,
      "isTracked": face.isTracked,
      "blinkLeft": blinkLeft,
      "blinkRight": blinkRight,
      "eyesOpen": leftOpen && rightOpen,
      "hasHit": !hits.isEmpty
    ]

    // The OTHER ray mode too, so both can be compared offline on the same data
    // (altSx/altSy, same portrait axes and same open-eye rule as sx/sy).
    let altMode = mode == "lookAtPoint" ? "eyeTransforms" : "lookAtPoint"
    var altHits: [EyeHit] = []
    if wantsLeft, leftOpen, let h = intersect(eye: face.leftEyeTransform, face: face, view: view, mode: altMode) { altHits.append(h) }
    if wantsRight, rightOpen, let h = intersect(eye: face.rightEyeTransform, face: face, view: view, mode: altMode) { altHits.append(h) }
    if !altHits.isEmpty {
      let n = Float(altHits.count)
      payload["altSx"] = altHits.reduce(Float(0)) { $0 + $1.point.y } / n
      payload["altSy"] = altHits.reduce(Float(0)) { $0 + $1.point.x } / n
    }

    // Eye blend shapes. Eyelid opening follows vertical gaze closely, which is
    // the axis ARKit's eye rotation gets worst - useful as extra fit features.
    for (key, location) in GazeTracker.eyeShapes {
      payload[key] = face.blendShapes[location]?.floatValue ?? 0
    }

    // Head and device pose. Computed whenever a face anchor exists, even when the
    // gaze ray misses the screen, because the positioning guide needs them most
    // exactly when the user is badly placed.
    for (key, value) in headPose(face: face, view: view) { payload[key] = value }
    for (key, value) in devicePose(camera: frame.camera.transform, time: now) { payload[key] = value }

    if let l = left {
      payload["leftSx"] = l.point.x
      payload["leftSy"] = l.point.y
    }
    if let r = right {
      payload["rightSx"] = r.point.x
      payload["rightSy"] = r.point.y
    }

    if !hits.isEmpty {
      var sx: Float = 0, sy: Float = 0, dist: Float = 0
      for h in hits {
        sx += h.point.x
        sy += h.point.y
        dist += h.distanceMeters
      }
      let n = Float(hits.count)
      // sx = metres to the RIGHT of the lens, sy = metres BELOW the lens (portrait).
      payload["sx"] = sy / n   // camera +Y -> portrait right
      payload["sy"] = sx / n   // camera +X -> portrait down
      payload["distanceCm"] = (dist / n) * 100.0
      payload["eyesUsed"] = hits.count

      // Convergence between the two eye rays: a cheap confidence proxy.
      if let l = left, let r = right, leftOpen, rightOpen {
        payload["eyeDisparityCm"] = simd_distance(l.point, r.point) * 100.0
      }
    }

    onSample(payload)
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    onError(["message": error.localizedDescription])
    isRunning = false
  }

  func sessionWasInterrupted(_ session: ARSession) {
    onState(["state": "interrupted", "isRunning": isRunning])
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    onState(["state": "resumed", "isRunning": isRunning])
    if isRunning {
      // Previously a bare configuration was used here, which silently dropped
      // maximumNumberOfTrackedFaces and the gravity alignment after an interruption.
      lastDeviceRotation = nil
      session.run(makeConfiguration(), options: [.resetTracking, .removeExistingAnchors])
    }
  }

  // MARK: Head & device pose

  private static let eyeShapes: [(String, ARFaceAnchor.BlendShapeLocation)] = [
    ("lookUpL", .eyeLookUpLeft), ("lookUpR", .eyeLookUpRight),
    ("lookDownL", .eyeLookDownLeft), ("lookDownR", .eyeLookDownRight),
    ("lookInL", .eyeLookInLeft), ("lookInR", .eyeLookInRight),
    ("lookOutL", .eyeLookOutLeft), ("lookOutR", .eyeLookOutRight),
    ("squintL", .eyeSquintLeft), ("squintR", .eyeSquintRight),
    ("wideL", .eyeWideLeft), ("wideR", .eyeWideRight),
  ]

  private static let radToDeg: Float = 180.0 / .pi

  /// Where the head is and which way it faces, relative to the phone.
  ///
  /// Everything is expressed in the same portrait frame as `sx`/`sy`
  /// (camera +Y = right, camera +X = down) so JS can relate it to the screen:
  ///   headX/Y/ZCm  midpoint between the eyes: cm right of / below the lens,
  ///                and distance in front of the screen plane
  ///   faceDirX/Y/Z unit vector out of the face (where the nose points):
  ///                right, down, and towards the screen (> 0 when facing it)
  ///   headRollDeg  sideways tilt of the head relative to the phone, 0 = upright
  /// Angles relative to the screen are derived in JS (utils/headPose.js),
  /// because they need the screen size, which only JS knows.
  private func headPose(face: ARFaceAnchor, view: simd_float4x4) -> [String: Any] {
    let faceInCamera = view * face.transform
    let leftEye = simd_make_float3((faceInCamera * face.leftEyeTransform).columns.3)
    let rightEye = simd_make_float3((faceInCamera * face.rightEyeTransform).columns.3)
    let mid = (leftEye + rightEye) * 0.5

    // Face anchor axes: +Z out of the face, +Y up the face.
    let forward = simd_normalize(simd_make_float3(faceInCamera.columns.2))
    let up = simd_normalize(simd_make_float3(faceInCamera.columns.1))

    // Upright head in a portrait phone: face-up = portrait-up = camera -X,
    // i.e. up = (-1, 0, 0) -> roll 0. Positive = top of the head towards +right.
    let rollDeg = atan2(up.y, -up.x) * GazeTracker.radToDeg

    return [
      "headXCm": mid.y * 100,
      "headYCm": mid.x * 100,
      "headZCm": -mid.z * 100,
      "faceDirX": forward.y,
      "faceDirY": forward.x,
      "faceDirZ": forward.z,
      "headRollDeg": rollDeg,
      "interEyeCm": simd_distance(leftEye, rightEye) * 100,
    ]
  }

  /// How the phone itself is held. With `.gravity` alignment the world y-axis is
  /// "up", so the camera transform already carries the accelerometer/gyro fusion
  /// ARKit does - no CoreMotion and no extra permission needed.
  ///   deviceTiltDeg      angle of the screen normal above the horizon:
  ///                      0 = phone upright, + = leaned back (screen facing up),
  ///                      90 = lying flat face-up
  ///   deviceRotationDps  how fast the phone is rotating, any axis, deg/s
  private func devicePose(camera: simd_float4x4, time: TimeInterval) -> [String: Any] {
    let c0 = simd_make_float3(camera.columns.0)
    let c1 = simd_make_float3(camera.columns.1)
    let c2 = simd_make_float3(camera.columns.2)

    // The face sits at camera z < 0, so the screen normal towards the user is -Z.
    // This only uses Z, which does not depend on the front camera's mirroring.
    let normalTowardsUser = -simd_normalize(c2)
    let tiltDeg = asin(max(-1, min(1, normalTowardsUser.y))) * GazeTracker.radToDeg

    var payload: [String: Any] = ["deviceTiltDeg": tiltDeg]

    let rotation = simd_float3x3(columns: (c0, c1, c2))
    if let previous = lastDeviceRotation, time > lastRotationTime {
      // Relative rotation R = Rprev^T * Rnow; its angle is acos((trace - 1) / 2).
      let relative = simd_transpose(previous) * rotation
      let trace = relative.columns.0.x + relative.columns.1.y + relative.columns.2.z
      let angle = acos(max(-1, min(1, (trace - 1) / 2)))
      payload["deviceRotationDps"] = angle * GazeTracker.radToDeg / Float(time - lastRotationTime)
    }
    lastDeviceRotation = rotation
    lastRotationTime = time

    return payload
  }

  // MARK: Geometry

  private struct EyeHit {
    /// Intersection with the screen plane, in **camera space metres** (x = portrait down, y = portrait right).
    let point: simd_float2
    /// Distance from the eye to the camera plane, in metres.
    let distanceMeters: Float
  }

  private func intersect(
    eye eyeTransform: simd_float4x4,
    face: ARFaceAnchor,
    view: simd_float4x4,
    mode: String
  ) -> EyeHit? {
    // Eye transform is relative to the face anchor -> lift it into world space.
    let eyeWorld = face.transform * eyeTransform
    let originWorld = simd_make_float3(eyeWorld.columns.3)

    let directionWorld: simd_float3
    if mode == "lookAtPoint" {
      let target = face.transform * simd_float4(face.lookAtPoint, 1)
      let d = simd_make_float3(target) - originWorld
      guard simd_length(d) > 1e-5 else { return nil }
      directionWorld = simd_normalize(d)
    } else {
      // The eye looks along the +Z axis of its own transform.
      directionWorld = simd_normalize(simd_make_float3(eyeWorld.columns.2))
    }

    let o = simd_make_float3(view * simd_float4(originWorld, 1))
    let d = simd_normalize(simd_make_float3(view * simd_float4(directionWorld, 0)))

    // The screen is the plane z = 0; the face sits at z < 0, so a usable ray must
    // travel towards +Z. Anything else means the user is looking away from the device.
    guard d.z > 1e-4 else { return nil }
    let t = -o.z / d.z
    guard t > 0, t.isFinite else { return nil }

    let hit = o + t * d
    guard hit.x.isFinite, hit.y.isFinite else { return nil }

    return EyeHit(point: simd_float2(hit.x, hit.y), distanceMeters: -o.z)
  }
}
