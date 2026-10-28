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
    var object = readObject()
    object["download_dir"] = path
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
