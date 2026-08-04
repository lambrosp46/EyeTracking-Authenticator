require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoSaliency'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'EyeTrackingAuthenticator'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platform       = :ios, '16.4'
  s.source         = { git: '' }
  s.static_framework = true
  s.license        = package['license']

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
end
