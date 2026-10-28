import Foundation

/// What `GET /local/toolbox` reports (dj-sync's `toolbox::Report`).
public struct ToolboxReport: Decodable, Equatable, Sendable {
  public struct Tool: Decodable, Equatable, Sendable, Identifiable {
    public var name: String
    /// A version, or for Python environments the installed requirements
    /// (`spotdl==4.6.0`).
    public var installed: String?
    public var wanted: String
    public var ready: Bool
    public var id: String { name }

    /// `spotdl==4.6.0` → `4.6.0`.
    public var displayVersion: String? {
      guard let installed else { return nil }
      return installed.components(separatedBy: "==").last ?? installed
    }
  }

  public var tools: [Tool]
  public var venvs: [Tool]
  public var installing: Bool
  public var step: String?
  public var progress: Double?
  public var error: String?
  public var manifest: String?
  public var checkedAt: String?

  public var all: [Tool] { tools + venvs }
  public var allReady: Bool { !all.isEmpty && all.allSatisfy(\.ready) }

  public static func decode(_ data: Data) throws -> ToolboxReport {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(ToolboxReport.self, from: data)
  }
}

public struct ToolboxClient: Sendable {
  public var baseURL: URL?

  public init(baseURL: URL? = nil) {
    self.baseURL = baseURL
  }

  public func fetch() async -> ToolboxReport? {
    var request = URLRequest(url: base.appending(path: "local/toolbox"), timeoutInterval: 3)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? ToolboxReport.decode(data)
  }

  /// Install or repair now (dj-sync's toolbox loop wakes up).
  public func install() async -> Bool {
    var request = URLRequest(url: base.appending(path: "local/toolbox/install"), timeoutInterval: 10)
    request.httpMethod = "POST"
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 202
  }

  private var base: URL { baseURL ?? ServiceEndpoint.base() }
}
