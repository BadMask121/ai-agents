import Foundation

/// What dj-sync's `GET /local/status` returns.
public struct ServiceStatus: Decodable, Equatable, Sendable {
  public struct Cloud: Decodable, Equatable, Sendable {
    public var enabled: Bool
    public var baseUrl: String
    /// dj-sync ≥ 0.9: agent protocol MAJOR, and the cloud v2 identity.
    public var `protocol`: Int?
    public var registered: Bool?
    public var connected: Bool?
  }

  public struct Job: Decodable, Equatable, Sendable, Identifiable {
    public var jobId: String
    public var state: String
    public var playlist: String
    public var message: String
    public var createdAt: String?
    public var finishedAt: String?
    /// Counts and version (dj-sync ≥ 0.5; optional for older versions).
    public var links: Int?
    public var tracks: Int?
    public var errors: Int?
    public var xmlVersion: String?
    public var id: String { jobId }

    /// When it finished, else when it was queued.
    public var date: Date? { parseTimestamp(finishedAt ?? createdAt) }
  }

  public struct Mcp: Decodable, Equatable, Sendable {
    /// What ChatGPT connects to (contains the secret path).
    public var publicUrl: String?
    /// The same endpoint on this Mac, for testing tools.
    public var localUrl: String
  }

  /// Rekordbox's own library (master.db), when dj-sync writes to it.
  public struct Library: Decodable, Equatable, Sendable {
    public struct Pending: Decodable, Equatable, Sendable, Identifiable {
      public var id: String
      public var createdAt: String
      public var summary: String
    }
    public struct Failed: Decodable, Equatable, Sendable, Identifiable {
      public var id: String
      public var summary: String
      public var error: String
    }
    public struct Applied: Decodable, Equatable, Sendable {
      public var at: String
      public var version: String?
      public var summary: String
    }
    public struct Backup: Decodable, Equatable, Sendable, Identifiable {
      public var version: String
      public var createdAt: String
      public var reason: String
      public var sizeBytes: Int64
      public var id: String { version }
      public var date: Date? { parseTimestamp(createdAt) }
    }

    public var dbPath: String
    public var rekordboxRunning: Bool
    public var pending: [Pending]
    public var failed: [Failed]
    public var lastApplied: Applied?
    public var lastError: String?
    public var currentVersion: String?
    /// Newest first.
    public var backups: [Backup]
  }

  public var version: String
  /// dj-sync ≥ 0.6 with `[rekordbox_db] enabled`.
  public var rekordboxDb: Library?
  /// Optional so the app still works with dj-sync < 0.3.
  public var mcp: Mcp?
  public var shortcutUrl: String?
  public var downloadDir: String
  /// `"settings"` when chosen in this app, `"config"` for dj-sync's default.
  public var downloadDirSource: String
  public var downloadDirWritable: Bool
  public var downloadDirError: String?
  public var importXml: String
  public var xmlVersion: String?
  public var cloud: Cloud
  public var recentJobs: [Job]

  public var usesCustomFolder: Bool { downloadDirSource == "settings" }

  public static func decode(_ data: Data) throws -> ServiceStatus {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(ServiceStatus.self, from: data)
  }
}

/// dj-sync writes RFC 3339 timestamps (`2026-10-28T02:34:13+00:00`).
public func parseTimestamp(_ string: String?) -> Date? {
  guard let string else { return nil }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  if let date = formatter.date(from: string) { return date }
  // The cloud writes milliseconds (`2026-10-28T05:30:49.375Z`).
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: string)
}

/// Talks to the dj-sync service on this Mac.
public struct StatusClient: Sendable {
  /// A fixed URL (tests); `nil` follows `ServiceEndpoint`.
  public var url: URL?

  public init(url: URL? = nil) {
    self.url = url
  }

  /// `nil` means dj-sync isn't running (or its HTTP lane is off).
  public func fetch() async -> ServiceStatus? {
    let url = url ?? ServiceEndpoint.base().appending(path: "local/status")
    var request = URLRequest(url: url, timeoutInterval: 2)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? ServiceStatus.decode(data)
  }
}

/// The library actions dj-sync exposes to this app (localhost only).
public struct LibraryClient: Sendable {
  /// A fixed base (tests); `nil` follows `ServiceEndpoint`.
  public var baseURL: URL?

  public init(baseURL: URL? = nil) {
    self.baseURL = baseURL
  }

  public struct Reply: Decodable, Sendable {
    public var ok: Bool
    public var message: String?
    public var error: String?
    /// `takeBaseline`: the backup's version.
    public var version: String?
  }

  /// Restore a backup of Rekordbox's library (Rekordbox must be closed).
  public func restore(version: String) async -> Reply {
    await post("local/rekordbox/restore", body: ["version": version])
  }

  /// Apply queued changes now (does nothing while Rekordbox is open).
  public func applyNow() async -> Reply {
    await post("local/rekordbox/apply", body: [:])
  }

  /// Back up the library now, before DJ Sync ever changes it (onboarding).
  /// Fails politely while Rekordbox is open.
  public func takeBaseline() async -> Reply {
    await post("local/rekordbox/baseline", body: [:])
  }

  /// Requeue changes that were set aside after failing.
  public func retryFailed() async -> Reply {
    await post("local/rekordbox/retry", body: [:])
  }

  /// Forget changes that were set aside after failing.
  public func dismissFailed() async -> Reply {
    await post("local/rekordbox/dismiss", body: [:])
  }

  private func post(_ path: String, body: [String: String]) async -> Reply {
    let base = baseURL ?? ServiceEndpoint.base()
    var request = URLRequest(url: base.appending(path: path), timeoutInterval: 120)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, _) = try? await URLSession.shared.data(for: request) else {
      return Reply(ok: false, message: nil, error: "dj-sync isn't running.", version: nil)
    }
    return (try? JSONDecoder().decode(Reply.self, from: data))
      ?? Reply(ok: false, message: nil, error: "Unexpected reply from dj-sync.", version: nil)
  }
}
