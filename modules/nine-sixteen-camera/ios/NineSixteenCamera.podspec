Pod::Spec.new do |s|
  s.name           = 'NineSixteenCamera'
  s.version        = '1.0.0'
  s.summary        = 'Custom AVFoundation camera capture locked to a 9:16 framing guide'
  s.author         = ''
  s.homepage       = 'https://github.com/lambrosp46/EyeTracking-Authenticator'
  s.platforms      = { ios: '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
