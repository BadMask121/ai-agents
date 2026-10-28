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
    public var id: String { jobId }
  }

  public var version: String
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
