// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "DJSyncMenu",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "DJSyncMenu", targets: ["DJSyncMenu"])],
  targets: [
    // Pure logic (settings file, paths, status decoding): no AppKit, nonisolated.
    .target(name: "DJSyncCore"),
    // The menu bar app. UI code lives on the main actor by default.
    .executableTarget(
      name: "DJSyncMenu",
      dependencies: ["DJSyncCore"],
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
    .testTarget(name: "DJSyncCoreTests", dependencies: ["DJSyncCore"]),
  ]
)
