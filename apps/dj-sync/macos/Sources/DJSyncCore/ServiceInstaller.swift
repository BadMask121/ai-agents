import Foundation

/// Installs the dj-sync service the app carries (`Contents/Helpers/dj-sync`)
/// as a LaunchAgent, spec §2.1. It runs from a copy in `~/.dj-sync/bin`
/// written byte by byte, so it carries no quarantine attribute and never
/// trips Gatekeeper on its own.
public struct ServiceInstaller: Sendable {
  public static let label = "com.triplejmusic.dj-sync"

  public var home: URL
  public var bundledService: URL?
  public var uid: UInt32
  /// `launchctl` with these arguments; returns its exit status.
  public var launchctl: @Sendable ([String]) async -> Int32

  public init(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    bundledService: URL? = Bundle.main.bundleURL.appending(path: "Contents/Helpers/dj-sync"),
    uid: UInt32 = getuid(),
    launchctl: @escaping @Sendable ([String]) async -> Int32 = ServiceInstaller.runLaunchctl
  ) {
    self.home = home
    self.bundledService = bundledService
    self.uid = uid
    self.launchctl = launchctl
  }

  public var installedService: URL { home.appending(path: ".dj-sync/bin/dj-sync") }
  public var plistURL: URL { home.appending(path: "Library/LaunchAgents/\(Self.label).plist") }
  var target: String { "gui/\(uid)/\(Self.label)" }

  public func plist() -> [String: Any] {
    let h = home.path(percentEncoded: false).trimmingSuffix("/")
    return [
      "Label": Self.label,
      "ProgramArguments": [installedService.path(percentEncoded: false)],
      "WorkingDirectory": "\(h)/.dj-sync",
      "EnvironmentVariables": [
        // launchd's default PATH is bare; dj-sync uses absolute tool paths,
        // this is for the tools' own helpers.
        "PATH": "\(h)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "RUST_LOG": "dj_sync=info",
      ],
      "RunAtLoad": true,
      "KeepAlive": true,
      // Don't spin if something's broken; retry every 30 s.
      "ThrottleInterval": 30,
      "StandardErrorPath": "\(h)/Library/Logs/dj-sync.log",
      "StandardOutPath": "\(h)/Library/Logs/dj-sync.out.log",
    ]
  }

  public enum Outcome: Equatable, Sendable {
    /// Running from Xcode/SwiftPM: no bundled service to install.
    case notBundled
    case upToDate
    case installed(serviceChanged: Bool, plistChanged: Bool)
    case failed(String)
  }

  /// Copy the service and (re)write the LaunchAgent when they differ from
  /// what this app carries, then make sure launchd runs it.
  public func ensureInstalled() async -> Outcome {
    guard let bundledService, FileManager.default.isExecutableFile(atPath: bundledService.path(percentEncoded: false))
    else { return .notBundled }
    do {
      let fm = FileManager.default
      for dir in [installedService.deletingLastPathComponent(), plistURL.deletingLastPathComponent(),
                  home.appending(path: "Library/Logs")] {
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      }

      let bundled = try Data(contentsOf: bundledService)
      let serviceChanged = (try? Data(contentsOf: installedService)) != bundled
      if serviceChanged {
        let tmp = installedService.appendingPathExtension("new")
        try bundled.write(to: tmp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmp.path(percentEncoded: false))
        _ = try? fm.removeItem(at: installedService)
        try fm.moveItem(at: tmp, to: installedService)
      }

      let desired = plist()
      let current = (try? Data(contentsOf: plistURL)).flatMap {
        try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
      }
      let plistChanged = current.map { !NSDictionary(dictionary: $0).isEqual(to: desired) } ?? true
      if plistChanged {
        let data = try PropertyListSerialization.data(fromPropertyList: desired, format: .xml, options: 0)
        try data.write(to: plistURL, options: .atomic)
      }

      let loaded = await launchctl(["print", target]) == 0
      if plistChanged || !loaded {
        if loaded { _ = await launchctl(["bootout", target]) }
        // bootout returns before the old job is fully gone; bootstrap may
        // need a moment.
        var status: Int32 = -1
        for attempt in 0..<10 {
          status = await launchctl(["bootstrap", "gui/\(uid)", plistURL.path(percentEncoded: false)])
          if status == 0 { break }
          if attempt < 9 { try? await Task.sleep(for: .milliseconds(500)) }
        }
        guard status == 0 else { return .failed("launchctl bootstrap exited \(status)") }
      } else if serviceChanged {
        _ = await launchctl(["kickstart", "-k", target])
      }
      return serviceChanged || plistChanged
        ? .installed(serviceChanged: serviceChanged, plistChanged: plistChanged) : .upToDate
    } catch {
      return .failed(error.localizedDescription)
    }
  }

  public static func runLaunchctl(_ arguments: [String]) async -> Int32 {
    await withCheckedContinuation { continuation in
      let process = Process()
      process.executableURL = URL(filePath: "/bin/launchctl")
      process.arguments = arguments
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
      do {
        try process.run()
      } catch {
        continuation.resume(returning: -1)
      }
    }
  }
}

extension String {
  func trimmingSuffix(_ suffix: String) -> String {
    hasSuffix(suffix) && count > suffix.count ? String(dropLast(suffix.count)) : self
  }
}
