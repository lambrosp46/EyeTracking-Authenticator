import UIKit
import AVFoundation

struct NineSixteenPhotoResult {
  let fileURL: URL
  let width: Int
  let height: Int
}

enum NineSixteenCaptureOutcome {
  case success(NineSixteenPhotoResult)
  case cancelled
  case failure(Error)
}

enum NineSixteenCameraError: LocalizedError {
  case deviceUnavailable
  case cropFailed

  var errorDescription: String? {
    switch self {
    case .deviceUnavailable:
      return "The camera is unavailable or access was denied."
    case .cropFailed:
      return "Failed to process the captured photo."
    }
  }
}

/// Full-screen camera capture screen. Shows a dimmed overlay with a
/// punched-out 9:16 guide rectangle so the user can frame the shot
/// correctly, then center-crops the captured photo to exactly 9:16
/// before handing it back.
final class CameraViewController: UIViewController {
  var onCapture: ((NineSixteenCaptureOutcome) -> Void)?

  /// width / height
  private let targetAspect: CGFloat = 9.0 / 16.0

  private let session = AVCaptureSession()
  private let photoOutput = AVCapturePhotoOutput()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let sessionQueue = DispatchQueue(label: "nine-sixteen-camera.session-queue")
  private var currentInput: AVCaptureDeviceInput?
  private var currentPosition: AVCaptureDevice.Position = .back

  /// `AVCaptureDevice.RotationCoordinator` (iOS 17+) — stored as `Any?`
  /// since the type itself is only available from iOS 17, and a stored
  /// property can't be conditionally typed with `@available`.
  private var rotationCoordinator: Any?
  private var rotationObservations: [NSKeyValueObservation] = []

  private let dimOverlayView = UIView()
  private let guideFrameView = UIView()
  private let shutterButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private let flipButton = UIButton(type: .system)
  private let hintLabel = UILabel()

  private let reviewImageView = UIImageView()
  private let retakeButton = UIButton(type: .system)
  private let useButton = UIButton(type: .system)
  private var pendingResult: NineSixteenPhotoResult?

  /// The guide frame's rect (in view/layer coordinates) captured at the
  /// moment the shutter is tapped, used to map screen coordinates to
  /// image pixel coordinates for an accurate crop.
  private var pendingGuideFrame: CGRect = .zero
  private let processingIndicator = UIActivityIndicatorView(style: .large)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    setupPreviewLayer()
    setupDimOverlay()
    setupCaptureControls()
    setupReviewControls()
    checkPermissionsAndStart()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
    layoutGuideFrame()
  }

  // MARK: - Setup

  private func setupPreviewLayer() {
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    view.layer.insertSublayer(layer, at: 0)
    previewLayer = layer
  }

  private func setupDimOverlay() {
    dimOverlayView.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    dimOverlayView.isUserInteractionEnabled = false
    view.addSubview(dimOverlayView)
    dimOverlayView.frame = view.bounds
    dimOverlayView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    guideFrameView.layer.borderColor = UIColor.white.cgColor
    guideFrameView.layer.borderWidth = 2
    guideFrameView.backgroundColor = .clear
    guideFrameView.isUserInteractionEnabled = false
    view.addSubview(guideFrameView)

    hintLabel.text = "Ευθυγραμμίστε την εικόνα μέσα στο πλαίσιο"
    hintLabel.textColor = .white
    hintLabel.font = .systemFont(ofSize: 14, weight: .medium)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 2
    view.addSubview(hintLabel)
    hintLabel.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      hintLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      hintLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 56),
    ])
  }

  private func layoutGuideFrame() {
    let bounds = view.bounds
    guard bounds.width > 0, bounds.height > 0 else { return }

    var guideWidth = bounds.width
    var guideHeight = guideWidth / targetAspect
    if guideHeight > bounds.height {
      guideHeight = bounds.height
      guideWidth = guideHeight * targetAspect
    }
    let guideFrame = CGRect(
      x: (bounds.width - guideWidth) / 2,
      y: (bounds.height - guideHeight) / 2,
      width: guideWidth,
      height: guideHeight
    )
    guideFrameView.frame = guideFrame

    // Punch a hole in the dim overlay so the guide area reads clearly.
    let path = UIBezierPath(rect: bounds)
    path.append(UIBezierPath(rect: guideFrame).reversing())
    let maskLayer = CAShapeLayer()
    maskLayer.path = path.cgPath
    maskLayer.fillRule = .evenOdd
    dimOverlayView.layer.mask = maskLayer
  }

  private func setupCaptureControls() {
    shutterButton.backgroundColor = .white
    shutterButton.layer.cornerRadius = 36
    shutterButton.layer.borderWidth = 4
    shutterButton.layer.borderColor = UIColor.white.withAlphaComponent(0.4).cgColor
    shutterButton.addTarget(self, action: #selector(didTapShutter), for: .touchUpInside)
    view.addSubview(shutterButton)
    shutterButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      shutterButton.widthAnchor.constraint(equalToConstant: 72),
      shutterButton.heightAnchor.constraint(equalToConstant: 72),
      shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
    ])

    cancelButton.setTitle("Άκυρο", for: .normal)
    cancelButton.setTitleColor(.white, for: .normal)
    cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    cancelButton.addTarget(self, action: #selector(didTapCancel), for: .touchUpInside)
    view.addSubview(cancelButton)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      cancelButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
    ])

    let flipIcon = UIImage(systemName: "arrow.triangle.2.circlepath.camera")
    flipButton.setImage(flipIcon, for: .normal)
    flipButton.tintColor = .white
    flipButton.addTarget(self, action: #selector(didTapFlip), for: .touchUpInside)
    view.addSubview(flipButton)
    flipButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      flipButton.widthAnchor.constraint(equalToConstant: 32),
      flipButton.heightAnchor.constraint(equalToConstant: 32),
      flipButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      flipButton.centerYAnchor.constraint(equalTo: cancelButton.centerYAnchor),
    ])

    processingIndicator.color = .white
    processingIndicator.hidesWhenStopped = true
    view.addSubview(processingIndicator)
    processingIndicator.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      processingIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      processingIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  private func setupReviewControls() {
    reviewImageView.contentMode = .scaleAspectFit
    reviewImageView.backgroundColor = .black
    reviewImageView.isHidden = true
    view.addSubview(reviewImageView)
    reviewImageView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      reviewImageView.topAnchor.constraint(equalTo: view.topAnchor),
      reviewImageView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      reviewImageView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      reviewImageView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    retakeButton.setTitle("Επανάληψη", for: .normal)
    retakeButton.setTitleColor(.white, for: .normal)
    retakeButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    retakeButton.isHidden = true
    retakeButton.addTarget(self, action: #selector(didTapRetake), for: .touchUpInside)
    view.addSubview(retakeButton)
    retakeButton.translatesAutoresizingMaskIntoConstraints = false

    var useConfiguration = UIButton.Configuration.filled()
    useConfiguration.title = "Χρήση φωτογραφίας"
    useConfiguration.baseBackgroundColor = .systemBlue
    useConfiguration.baseForegroundColor = .white
    useConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
    useConfiguration.background.cornerRadius = 10
    useConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = .systemFont(ofSize: 16, weight: .semibold)
      return outgoing
    }
    useButton.configuration = useConfiguration
    useButton.isHidden = true
    useButton.addTarget(self, action: #selector(didTapUsePhoto), for: .touchUpInside)
    view.addSubview(useButton)
    useButton.translatesAutoresizingMaskIntoConstraints = false

    NSLayoutConstraint.activate([
      retakeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      retakeButton.centerYAnchor.constraint(equalTo: useButton.centerYAnchor),

      useButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      useButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
    ])
  }

  // MARK: - Permissions & session

  private func checkPermissionsAndStart() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          if granted {
            self?.configureSession()
          } else {
            self?.finish(.failure(NineSixteenCameraError.deviceUnavailable))
          }
        }
      }
    default:
      finish(.failure(NineSixteenCameraError.deviceUnavailable))
    }
  }

  private func configureSession() {
    sessionQueue.async { [weak self] in
      guard let self = self else { return }
      self.session.beginConfiguration()
      // 1080p is already ~1080x1920 once rotated to portrait — matches
      // 9:16 almost exactly and processes far faster than the full
      // sensor resolution `.photo` preset would (no need for that much
      // detail on an image that's only used for tap-point selection).
      self.session.sessionPreset = self.session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .high

      guard
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: self.currentPosition),
        let input = try? AVCaptureDeviceInput(device: device),
        self.session.canAddInput(input)
      else {
        self.session.commitConfiguration()
        DispatchQueue.main.async { self.finish(.failure(NineSixteenCameraError.deviceUnavailable)) }
        return
      }
      self.session.addInput(input)
      self.currentInput = input

      if self.session.canAddOutput(self.photoOutput) {
        self.session.addOutput(self.photoOutput)
      }

      self.session.commitConfiguration()
      DispatchQueue.main.async { self.configureRotationHandling(for: device) }
      self.session.startRunning()
    }
  }

  /// The camera sensor is natively landscape. Without correct rotation
  /// handling, both the preview and the captured photo's pixel buffer
  /// come out rotated.
  ///
  /// On iOS 17+ this uses `AVCaptureDevice.RotationCoordinator` — the
  /// approach Apple's own AVCam sample uses — which resolves the correct
  /// rotation angle for the preview and for capture based on the
  /// device's supported interface orientations (portrait-only, here),
  /// and keeps observing it so it stays correct if that ever changes.
  /// Older OS versions fall back to manually locking both connections
  /// to `.portrait` via the deprecated but still-functional API.
  private func configureRotationHandling(for device: AVCaptureDevice) {
    rotationObservations.forEach { $0.invalidate() }
    rotationObservations.removeAll()

    if #available(iOS 17.0, *) {
      let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
      rotationCoordinator = coordinator

      applyRotationAngle(coordinator.videoRotationAngleForHorizonLevelPreview, to: previewLayer?.connection)
      applyRotationAngle(coordinator.videoRotationAngleForHorizonLevelCapture, to: photoOutput.connection(with: .video))

      let previewObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, change in
        guard let angle = change.newValue else { return }
        DispatchQueue.main.async { self?.applyRotationAngle(angle, to: self?.previewLayer?.connection) }
      }
      let captureObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, change in
        guard let angle = change.newValue else { return }
        DispatchQueue.main.async { self?.applyRotationAngle(angle, to: self?.photoOutput.connection(with: .video)) }
      }
      rotationObservations = [previewObservation, captureObservation]
    } else {
      rotationCoordinator = nil
      for connection in [previewLayer?.connection, photoOutput.connection(with: .video)] {
        guard let connection = connection, connection.isVideoOrientationSupported else { continue }
        connection.videoOrientation = .portrait
      }
    }
  }

  @available(iOS 17.0, *)
  private func applyRotationAngle(_ angle: CGFloat, to connection: AVCaptureConnection?) {
    guard let connection = connection, connection.isVideoRotationAngleSupported(angle) else { return }
    connection.videoRotationAngle = angle
  }

  // MARK: - Actions

  @objc private func didTapShutter() {
    shutterButton.isEnabled = false
    // Snapshot now — layout could theoretically shift before the async
    // capture completes, and we need the exact rect that was on screen
    // when the user tapped.
    pendingGuideFrame = guideFrameView.frame
    processingIndicator.startAnimating()

    let settings = AVCapturePhotoSettings()
    // Auto flash does a pre-capture metering flash that adds noticeable
    // delay; skip it since this isn't a low-light photography use case.
    settings.flashMode = .off
    if #available(iOS 13.0, *) {
      settings.photoQualityPrioritization = .speed
    }
    photoOutput.capturePhoto(with: settings, delegate: self)
  }

  @objc private func didTapFlip() {
    flipButton.isEnabled = false
    let newPosition: AVCaptureDevice.Position = currentPosition == .back ? .front : .back

    sessionQueue.async { [weak self] in
      guard let self = self else { return }
      self.session.beginConfiguration()
      defer { self.session.commitConfiguration() }

      if let existingInput = self.currentInput {
        self.session.removeInput(existingInput)
      }

      guard
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition),
        let newInput = try? AVCaptureDeviceInput(device: device),
        self.session.canAddInput(newInput)
      else {
        // Revert to the previous input if the new one can't be added.
        if let existingInput = self.currentInput, self.session.canAddInput(existingInput) {
          self.session.addInput(existingInput)
        }
        DispatchQueue.main.async { self.flipButton.isEnabled = true }
        return
      }

      self.session.addInput(newInput)
      self.currentInput = newInput
      self.currentPosition = newPosition

      DispatchQueue.main.async {
        self.configureRotationHandling(for: device)
        self.flipButton.isEnabled = true
      }
    }
  }

  @objc private func didTapCancel() {
    sessionQueue.async { [weak self] in self?.session.stopRunning() }
    finish(.cancelled)
  }

  @objc private func didTapRetake() {
    pendingResult = nil
    reviewImageView.image = nil
    reviewImageView.isHidden = true
    retakeButton.isHidden = true
    useButton.isHidden = true
    shutterButton.isHidden = false
    shutterButton.isEnabled = true
    cancelButton.isHidden = false
    flipButton.isHidden = false
    dimOverlayView.isHidden = false
    guideFrameView.isHidden = false
    hintLabel.isHidden = false
    sessionQueue.async { [weak self] in self?.session.startRunning() }
  }

  @objc private func didTapUsePhoto() {
    guard let result = pendingResult else { return }
    finish(.success(result))
  }

  private func finish(_ outcome: NineSixteenCaptureOutcome) {
    let callback = onCapture
    onCapture = nil
    callback?(outcome)
  }

  // MARK: - Crop

  /// Redraws the image so its pixel buffer matches its displayed
  /// (EXIF-corrected) orientation. `cgImage.width`/`height` always report
  /// the RAW, pre-rotation sensor buffer regardless of `imageOrientation`
  /// — cropping against those raw dimensions silently produces a wrong
  /// (landscape-shaped) crop on a portrait photo. This bakes the rotation
  /// in first, as a safety net on top of `configureRotationHandling()`,
  /// so cropping is always correct even if a connection's orientation
  /// setting didn't take effect on a given device/iOS version.
  private func normalizedOrientation(_ image: UIImage) -> UIImage {
    if image.imageOrientation == .up { return image }
    let renderer = UIGraphicsImageRenderer(size: image.size)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  private func cropToTargetAspect(_ image: UIImage) -> UIImage? {
    let upright = normalizedOrientation(image)
    guard let cgImage = upright.cgImage else { return nil }
    let width = CGFloat(cgImage.width)
    let height = CGFloat(cgImage.height)
    let currentAspect = width / height

    let cropRect: CGRect
    if currentAspect > targetAspect {
      let newWidth = height * targetAspect
      cropRect = CGRect(x: (width - newWidth) / 2, y: 0, width: newWidth, height: height)
    } else if currentAspect < targetAspect {
      let newHeight = width / targetAspect
      cropRect = CGRect(x: 0, y: (height - newHeight) / 2, width: width, height: newHeight)
    } else {
      cropRect = CGRect(x: 0, y: 0, width: width, height: height)
    }

    guard let cropped = cgImage.cropping(to: cropRect) else { return nil }
    return UIImage(cgImage: cropped, scale: upright.scale, orientation: .up)
  }

  /// Crops the captured photo to exactly the region the user saw inside
  /// the on-screen guide frame. The preview fills the *entire* screen via
  /// `resizeAspectFill`, which is a different (taller) aspect ratio than
  /// the 9:16 guide box drawn inside it — so a naive "crop the final
  /// image to 9:16 around its own center" does NOT land on the same
  /// region the guide box highlighted. `metadataOutputRectConverted`
  /// does the correct screen-coordinates -> image-coordinates mapping
  /// (accounting for aspectFill scaling, current orientation, and
  /// mirroring), so what's cropped matches what was framed.
  private func cropToGuideFrame(_ image: UIImage) -> UIImage? {
    guard let previewLayer = previewLayer, pendingGuideFrame != .zero else {
      return cropToTargetAspect(image) // Fallback if we somehow have no guide rect.
    }

    let normalizedRect = previewLayer.metadataOutputRectConverted(fromLayerRect: pendingGuideFrame)

    let upright = normalizedOrientation(image)
    guard let cgImage = upright.cgImage else { return nil }
    let width = CGFloat(cgImage.width)
    let height = CGFloat(cgImage.height)

    var pixelRect = CGRect(
      x: normalizedRect.origin.x * width,
      y: normalizedRect.origin.y * height,
      width: normalizedRect.size.width * width,
      height: normalizedRect.size.height * height
    ).integral

    pixelRect = pixelRect.intersection(CGRect(x: 0, y: 0, width: width, height: height))

    guard pixelRect.width > 1, pixelRect.height > 1, let cropped = cgImage.cropping(to: pixelRect) else {
      return cropToTargetAspect(image) // Fallback if the mapping produced something unusable.
    }
    return UIImage(cgImage: cropped, scale: upright.scale, orientation: .up)
  }
}

// MARK: - AVCapturePhotoCaptureDelegate

extension CameraViewController: AVCapturePhotoCaptureDelegate {
  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    if let error = error {
      DispatchQueue.main.async {
        self.processingIndicator.stopAnimating()
        self.shutterButton.isEnabled = true
      }
      finish(.failure(error))
      return
    }

    guard
      let data = photo.fileDataRepresentation(),
      let rawImage = UIImage(data: data),
      let cropped = cropToGuideFrame(rawImage),
      let jpegData = cropped.jpegData(compressionQuality: 0.9)
    else {
      DispatchQueue.main.async {
        self.processingIndicator.stopAnimating()
        self.shutterButton.isEnabled = true
      }
      finish(.failure(NineSixteenCameraError.cropFailed))
      return
    }

    let fileName = "nine-sixteen-\(UUID().uuidString).jpg"
    let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)

    do {
      try jpegData.write(to: fileURL)
    } catch {
      DispatchQueue.main.async {
        self.processingIndicator.stopAnimating()
        self.shutterButton.isEnabled = true
      }
      finish(.failure(error))
      return
    }

    sessionQueue.async { [weak self] in self?.session.stopRunning() }

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.processingIndicator.stopAnimating()
      self.shutterButton.isEnabled = true
      self.pendingResult = NineSixteenPhotoResult(
        fileURL: fileURL,
        width: cropped.cgImage?.width ?? Int(cropped.size.width),
        height: cropped.cgImage?.height ?? Int(cropped.size.height)
      )
      self.reviewImageView.image = cropped
      self.reviewImageView.isHidden = false
      self.retakeButton.isHidden = false
      self.useButton.isHidden = false
      self.shutterButton.isHidden = true
      self.cancelButton.isHidden = true
      self.flipButton.isHidden = true
      self.dimOverlayView.isHidden = true
      self.guideFrameView.isHidden = true
      self.hintLabel.isHidden = true
    }
  }
}
