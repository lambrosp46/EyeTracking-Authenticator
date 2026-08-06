Pod::Spec.new do |s|
  s.name           = 'GazeTracker'
  s.version        = '1.0.0'
  s.summary        = 'ARKit face/eye tracking bridge for the EyeTracking-Authenticator app'
  s.description    = 'Head-less ARFaceTrackingConfiguration session that projects each eye gaze ray onto the device screen plane.'
  s.author         = 'lambrosp46'
  s.homepage       = 'https://github.com/lambrosp46/EyeTracking-Authenticator'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
