import Foundation

/// Runs `dj-sync uninstall` for the About card's Uninstall button
/// (docs/superpowers/specs/2026-10-28-dj-sync-uninstaller-design.md §1.3).
/// The service does the work; this app only asks, then bins itself.
public enum Uninstaller {
  public struct Outcome: Sendable, Equatable {
    public let ok: Bool
    public let output: String
  }

  /// The app's own copy of the service (same version as the button), else the
  /// installed one.
  public static func helper(
    bundle: URL = Bundle.main.bundleURL,
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    isExecutable: (String) -> Bool = FileManager.default.isExecutableFile(atPath:)
  ) -> URL? {
    [bundle.appending(path: "Contents/Helpers/dj-sync"), home.appending(path: ".dj-sync/bin/dj-sync")]
      .first { isExecutable($0.path(percentEncoded: false)) }
  }

  public static func arguments(keepBackups: Bool) -> [String] {
    keepBackups ? ["uninstall"] : ["uninstall", "--delete-backups"]
  }

  /// Exit 0 means everything DJ Sync installed is gone.
  public static func run(helper: URL, keepBackups: Bool) async -> Outcome {
    await withCheckedContinuation { continuation in
      let process = Process()
      process.executableURL = helper
      process.arguments = arguments(keepBackups: keepBackups)
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      process.terminationHandler = { done in
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        continuation.resume(returning: Outcome(ok: done.terminationStatus == 0, output: text))
      }
      do {
        try process.run()
      } catch {
        continuation.resume(returning: Outcome(ok: false, output: error.localizedDescription))
      }
    }
  }
}
