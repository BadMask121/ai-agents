import Foundation

/// What dj-sync's `GET /local/status` returns.
public struct ServiceStatus: Decodable, Equatable, Sendable {
  public struct Cloud: Decodable, Equatable, Sendable {
    public var enabled: Bool
    public var baseUrl: String
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

  public var version: String
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
  return formatter.date(from: string)
}

/// Talks to the dj-sync service on this Mac.
public struct StatusClient: Sendable {
  public var url: URL

  public init(url: URL = URL(string: "http://127.0.0.1:8000/local/status")!) {
    self.url = url
  }

  /// `nil` means dj-sync isn't running (or its HTTP lane is off).
  public func fetch() async -> ServiceStatus? {
    var request = URLRequest(url: url, timeoutInterval: 2)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? ServiceStatus.decode(data)
  }
}
