import CryptoKit
import Foundation

/// The signed update feed (`appcast.json` + `appcast.json.sig`, spec §2.5).
public struct Appcast: Decodable, Equatable, Sendable {
  public struct Release: Decodable, Equatable, Sendable {
    public var version: String
    public var minMacos: String?
    /// The update zip (an `ditto -c -k --keepParent` of `DJ Sync.app`).
    public var url: String
    public var sha256: String
    public var size: Int64?
    public var publishedAt: String?
    public var notes: String?
    /// For DJs who can't be updated in place (a read-only Applications folder).
    public var dmgUrl: String?
  }

  public var latest: Release

  public static func decode(_ data: Data) throws -> Appcast {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(Appcast.self, from: data)
  }
}

public enum UpdateCheck: Equatable, Sendable {
  case upToDate
  case available(Appcast.Release)
  case failed(String)
}

/// Checks the feed: the signature must verify against the release key, and
/// only a strictly newer version (that this macOS can run) is offered.
public struct UpdateFeed: Sendable {
  public static let defaultURL = URL(string: "https://djsync.jeffrey.build/download/appcast.json")!
  public static let latestDMG = URL(string: "https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg")!
  /// Same key as `signing::RELEASE_PUBLIC_KEY` in dj-sync (Ed25519, base64).
  public static let releasePublicKey = "p43nEWbe6SB4Fi/vAcdi87m55M3+NQBhVpz+gjXG4L4="

  public var url: URL
  public var publicKey: String
  public var fetch: @Sendable (URL) async throws -> Data

  public init(
    url: URL = defaultURL,
    publicKey: String = releasePublicKey,
    fetch: @escaping @Sendable (URL) async throws -> Data = UpdateFeed.download
  ) {
    self.url = url
    self.publicKey = publicKey
    self.fetch = fetch
  }

  public static func download(_ url: URL) async throws -> Data {
    var request = URLRequest(url: url, timeoutInterval: 30)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else { throw UpdateError.http(status) }
    return data
  }

  public func check(
    currentVersion: String,
    os: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion
  ) async -> UpdateCheck {
    do {
      let data = try await fetch(url)
      let signature = try await fetch(url.appendingPathExtension("sig"))
      guard Self.verify(data, signature: String(decoding: signature, as: UTF8.self), publicKey: publicKey)
      else { return .failed("The update feed isn't signed by DJ Sync.") }
      let feed = try Appcast.decode(data)
      guard let latest = SemVer(feed.latest.version), let current = SemVer(currentVersion) else {
        return .failed("Unreadable version in the update feed.")
      }
      guard latest > current else { return .upToDate }
      if let min = feed.latest.minMacos, !Self.os(os, satisfies: min) {
        return .failed("DJ Sync \(feed.latest.version) needs macOS \(min) or later.")
      }
      return .available(feed.latest)
    } catch UpdateError.http(404) {
      return .upToDate  // nothing published yet
    } catch {
      return .failed(error.localizedDescription)
    }
  }

  /// Ed25519 (RFC 8032) — what dj-sync-sign produces.
  public static func verify(_ data: Data, signature: String, publicKey: String) -> Bool {
    guard let keyBytes = Data(base64Encoded: publicKey),
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes),
      let sig = Data(base64Encoded: signature.trimmingCharacters(in: .whitespacesAndNewlines))
    else { return false }
    return key.isValidSignature(sig, for: data)
  }

  static func os(_ os: OperatingSystemVersion, satisfies minimum: String) -> Bool {
    let parts = minimum.split(separator: ".").map { Int($0) ?? 0 }
    let need = (parts.first ?? 0, parts.count > 1 ? parts[1] : 0, parts.count > 2 ? parts[2] : 0)
    return (os.majorVersion, os.minorVersion, os.patchVersion) >= need
  }
}

public enum UpdateError: LocalizedError, Equatable {
  case http(Int)
  case checksum
  case noApp
  case wrongApp(String)
  case notWritable

  public var errorDescription: String? {
    switch self {
    case .http(let code): "The update server answered \(code)."
    case .checksum: "The download doesn't match its checksum."
    case .noApp: "The download doesn't contain DJ Sync."
    case .wrongApp(let detail): "The download isn't the expected DJ Sync: \(detail)."
    case .notWritable: "DJ Sync's folder isn't writable, so it can't update itself."
    }
  }
}

/// Download → verify → unpack → check → swap. The app relaunches itself after.
public enum UpdateInstaller {
  /// Streams the file through SHA-256 (updates are tens of MB).
  public static func sha256Hex(of file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// Install `release` over the app at `installed`. Returns the new app's URL
  /// (the same path) once it's in place.
  public static func install(
    _ release: Appcast.Release,
    over installed: URL,
    bundleID: String
  ) async throws -> URL {
    let parent = installed.deletingLastPathComponent()
    guard FileManager.default.isWritableFile(atPath: parent.path(percentEncoded: false)) else {
      throw UpdateError.notWritable
    }
    // A scratch folder on the same volume, so the final swap is a rename.
    let work = try FileManager.default.url(
      for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: installed, create: true)
    defer { try? FileManager.default.removeItem(at: work) }

    guard let url = URL(string: release.url) else { throw UpdateError.noApp }
    let (downloaded, response) = try await URLSession.shared.download(from: url)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else { throw UpdateError.http(status) }
    let zip = work.appending(path: "update.zip")
    try FileManager.default.moveItem(at: downloaded, to: zip)
    guard try sha256Hex(of: zip).caseInsensitiveCompare(release.sha256) == .orderedSame else {
      throw UpdateError.checksum
    }
    let app = try unpack(zip: zip, into: work.appending(path: "unpacked"))
    try validate(app: app, bundleID: bundleID, version: release.version)
    try replace(installed: installed, with: app)
    return installed
  }

  public static func unpack(zip: URL, into dir: URL) throws -> URL {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let ditto = Process()
    ditto.executableURL = URL(filePath: "/usr/bin/ditto")
    ditto.arguments = ["-x", "-k", zip.path(percentEncoded: false), dir.path(percentEncoded: false)]
    try ditto.run()
    ditto.waitUntilExit()
    guard ditto.terminationStatus == 0,
      let app = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        .first(where: { $0.pathExtension == "app" })
    else { throw UpdateError.noApp }
    return app
  }

  public static func validate(app: URL, bundleID: String, version: String) throws {
    guard let info = NSDictionary(contentsOf: app.appending(path: "Contents/Info.plist")) else {
      throw UpdateError.noApp
    }
    let id = info["CFBundleIdentifier"] as? String ?? "?"
    let v = info["CFBundleShortVersionString"] as? String ?? "?"
    guard id == bundleID else { throw UpdateError.wrongApp("bundle \(id)") }
    guard v == version else { throw UpdateError.wrongApp("version \(v), expected \(version)") }
  }

  /// Atomic on the same volume; the old bundle is discarded.
  public static func replace(installed: URL, with new: URL) throws {
    _ = try FileManager.default.replaceItemAt(installed, withItemAt: new)
  }
}
