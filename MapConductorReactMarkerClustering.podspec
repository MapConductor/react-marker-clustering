require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name = "MapConductorReactMarkerClustering"
  s.version = package["version"]
  s.summary = package["description"]
  s.license = package["license"]
  s.author = package["author"]
  s.homepage = "https://github.com/mapconductor/react-sdk"
  s.source = { :path => __dir__ }
  s.platform = :ios, "15.1"
  s.source_files = "ios/*.{h,m,mm,swift}"
  # MapConductorMarkerCluster is a source pod (see ios-sdk/ios-marker-cluster's podspec), not a
  # vendored prebuilt xcframework - see ios-sdk/CLAUDE.md's "iOS Provider Distribution" section:
  # any module that imports MapConductorCore directly must build in the same (source-pod, no
  # library evolution) mode MapConductorCore itself uses, or Xcode's module-interface
  # verification fails with mismatched-deployment-target/"cannot load underlying module" errors.
  s.dependency "React-Core"
  s.dependency "MapConductorCore"
  s.dependency "MapConductorReactNativeCore"
  s.dependency "MapConductorMarkerCluster"
end
