import Foundation

/// An assistant's way in to this Mac (`GET /local/links`, spec §3.2). The
/// URL is known only on this Mac; the cloud keeps a hash.
public struct AssistantLink: Decodable, Equatable, Sendable, Identifiable {
  public var id: String
  public var kind: String
  public var label: String?
  public var createdAt: String?
  public var lastUsedAt: String?
  public var url: String?
  /// Shortcut links only.
  public var apiUrl: String?
  public var token: String?

  /// The assistant has called in at least once.
  public var isConnected: Bool { lastUsedAt != nil }
  public var lastUsed: Date? { parseTimestamp(lastUsedAt) }
  public var assistant: Assistant? { Assistant(rawValue: kind) }
  public var displayName: String { label ?? assistant?.name ?? kind.capitalized }
}

/// The assistants DJ Sync walks a DJ through connecting.
public enum Assistant: String, CaseIterable, Sendable, Identifiable {
  case chatgpt
  case claude

  public var id: String { rawValue }

  public var name: String {
    switch self {
    case .chatgpt: "ChatGPT"
    case .claude: "Claude"
    }
  }

  /// Where to paste the link, in as few words as possible.
  public var steps: [String] {
    switch self {
    case .chatgpt:
      [
        "In ChatGPT, open Settings → Apps & Connectors (or Plugins).",
        "Choose Create (custom MCP server) and paste the URL.",
        "Set authentication to “No authentication”, then save.",
      ]
    case .claude:
      [
        "In Claude, open Settings → Connectors.",
        "Choose Add custom connector and paste the URL.",
        "Save. The free plan allows one custom connector.",
      ]
    }
  }

  public var example: String {
    "Add https://open.spotify.com/track/… to a playlist called Friday"
  }
}

/// `/local/links` on the dj-sync service.
public struct LinksClient: Sendable {
  public var baseURL: URL?

  public init(baseURL: URL? = nil) {
    self.baseURL = baseURL
  }

  public struct Failure: Error, Equatable, Sendable {
    public var message: String
  }

  public func list() async -> Result<[AssistantLink], Failure> {
    struct Wrapper: Decodable { var links: [AssistantLink] }
    return await request("GET", "local/links").flatMap { data in
      decode(Wrapper.self, data).map(\.links)
    }
  }

  public func create(_ assistant: Assistant) async -> Result<AssistantLink, Failure> {
    await request("POST", "local/links", body: ["kind": assistant.rawValue, "label": assistant.name])
      .flatMap { decode(AssistantLink.self, $0) }
  }

  public func rotate(_ id: String) async -> Result<AssistantLink, Failure> {
    await request("POST", "local/links/\(id)/rotate").flatMap { decode(AssistantLink.self, $0) }
  }

  public func delete(_ id: String) async -> Result<Void, Failure> {
    await request("DELETE", "local/links/\(id)").map { _ in () }
  }

  private func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> Result<T, Failure> {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    do {
      return .success(try decoder.decode(type, from: data))
    } catch {
      return .failure(Failure(message: "Unexpected reply from dj-sync."))
    }
  }

  private func request(_ method: String, _ path: String, body: [String: String]? = nil) async -> Result<Data, Failure> {
    let base = baseURL ?? ServiceEndpoint.base()
    var request = URLRequest(url: base.appending(path: path), timeoutInterval: 30)
    request.httpMethod = method
    request.cachePolicy = .reloadIgnoringLocalCacheData
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      let http = response as? HTTPURLResponse
    else { return .failure(Failure(message: "dj-sync isn't running.")) }
    guard (200..<300).contains(http.statusCode) else {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      return .failure(Failure(message: message ?? "dj-sync answered \(http.statusCode)."))
    }
    return .success(data)
  }
}
