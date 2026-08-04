import ExpoModulesCore

public class NineSixteenCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NineSixteenCamera")

    AsyncFunction("presentCamera") { (promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = NineSixteenCameraModule.topViewController() else {
          promise.reject(
            "ERR_NO_PRESENTER",
            "Could not find a view controller to present the camera from."
          )
          return
        }

        let cameraVC = CameraViewController()
        cameraVC.modalPresentationStyle = .fullScreen

        cameraVC.onCapture = { outcome in
          presenter.dismiss(animated: true) {
            switch outcome {
            case .success(let result):
              promise.resolve([
                "uri": result.fileURL.absoluteString,
                "width": result.width,
                "height": result.height,
              ])
            case .cancelled:
              promise.resolve(nil)
            case .failure(let error):
              promise.reject("ERR_CAPTURE_FAILED", error.localizedDescription)
            }
          }
        }

        presenter.present(cameraVC, animated: true)
      }
    }
  }

  /// Walks the currently active window's view controller hierarchy to find
  /// the top-most view controller to present the camera modal from.
  private static func topViewController(_ base: UIViewController? = {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first { $0.isKeyWindow }?.rootViewController
  }()) -> UIViewController? {
    if let nav = base as? UINavigationController {
      return topViewController(nav.visibleViewController)
    }
    if let tab = base as? UITabBarController, let selected = tab.selectedViewController {
      return topViewController(selected)
    }
    if let presented = base?.presentedViewController {
      return topViewController(presented)
    }
    return base
  }
}
