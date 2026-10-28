import Foundation

/// `~/.dj-sync/settings.json`: the file dj-sync re-reads before every
/// download. This app owns it; dj-sync only reads it and ignores keys it
/// doesn't know, so other keys written here are preserved.
public struct SettingsFile: Sendable {
  public let url: URL

  public init(url: URL) {
    self.url = url
  }

  public static var standard: SettingsFile {
    SettingsFile(
      url: FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".dj-sync/settings.json"))
  }

  /// The chosen download folder, or `nil` when dj-sync uses its config default.
  public func downloadDir() -> String? {
    readObject()["download_dir"] as? String
  }

  /// Set the download folder, or pass `nil` to go back to dj-sync's default.
  public func setDownloadDir(_ path: String?) throws {
    try set("download_dir", path)
  }

  /// Onboarding finished (or skipped) on this Mac.
  public func onboarded() -> Bool {
    readObject()["onboarded"] as? Bool ?? false
  }

  public func setOnboarded(_ done: Bool) throws {
    try set("onboarded", done)
  }

  private func set(_ key: String, _ value: Any?) throws {
    var object = readObject()
    object[key] = value
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(
      withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    // Atomic, so dj-sync never reads a half-written file.
    try data.write(to: url, options: .atomic)
  }

  /// A missing or unreadable file is treated as empty; the next write replaces it.
  private func readObject() -> [String: Any] {
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
  }
}
