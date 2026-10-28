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
  /// Telegram links: a chat has been paired, and who it is.
  public var paired: Bool?
  public var telegramUsername: String?
  /// Telegram links: when the pairing code in `url` stops working.
  public var expiresAt: String?

  public init(
    id: String, kind: String, label: String? = nil, createdAt: String? = nil, lastUsedAt: String? = nil,
    url: String? = nil, apiUrl: String? = nil, token: String? = nil, paired: Bool? = nil,
    telegramUsername: String? = nil, expiresAt: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.label = label
    self.createdAt = createdAt
    self.lastUsedAt = lastUsedAt
    self.url = url
    self.apiUrl = apiUrl
    self.token = token
    self.paired = paired
    self.telegramUsername = telegramUsername
    self.expiresAt = expiresAt
  }

  /// Telegram: a chat is paired. Others: the assistant has called in once.
  public var isConnected: Bool {
    assistant == .telegram ? paired == true : lastUsedAt != nil
  }
  public var lastUsed: Date? { parseTimestamp(lastUsedAt) }
  public var expires: Date? { parseTimestamp(expiresAt) }
  public var assistant: Assistant? { Assistant(rawValue: kind) }
  public var displayName: String {
    if assistant == .telegram, paired == true, let user = telegramUsername, !user.isEmpty {
      return "Telegram (@\(user))"
    }
    return label ?? assistant?.name ?? kind.capitalized
  }

  /// Telegram: the pairing code can no longer be used.
  public func pairingExpired(now: Date = Date()) -> Bool {
    guard assistant == .telegram, !isConnected, let expires else { return false }
    return expires <= now
  }
}

/// The ways a DJ connects to this Mac. The raw value is the link kind.
public enum Assistant: String, CaseIterable, Sendable, Identifiable {
  case chatgpt
  case claude
  case telegram
  /// The iPhone Share-sheet Shortcut (REST, link kind `shortcut`).
  case iphone = "shortcut"

  public var id: String { rawValue }

  /// The ones offered while onboarding (the iPhone Shortcut is an extra).
  public static let onboarding: [Assistant] = [.chatgpt, .claude, .telegram]

  public var name: String {
    switch self {
    case .chatgpt: "ChatGPT"
    case .claude: "Claude"
    case .telegram: "Telegram"
    case .iphone: "iPhone"
    }
  }

  /// Connected by pasting a connector (MCP) URL into the assistant.
  public var usesConnectorURL: Bool { self == .chatgpt || self == .claude }

  /// What it costs the DJ, in a word or two.
  public var cost: String { self == .chatgpt ? "Paid plan" : "Free" }

  public var systemImage: String {
    switch self {
    case .chatgpt: "bubble.left.and.bubble.right"
    case .claude: "asterisk"
    case .telegram: "paperplane"
    case .iphone: "iphone"
    }
  }

  /// The step-by-step guide on the website.
  public var guideURL: URL {
    let slug = self == .iphone ? "iphone" : rawValue
    return URL(string: "https://djsync.jeffrey.build/connect/\(slug)/")!
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
    case .telegram:
      [
        "Scan the code with your phone's camera (or click Open Telegram).",
        "Tap Start in the DJ Sync bot.",
        "Send it Spotify or YouTube links, or ask for /playlists.",
      ]
    case .iphone:
      [
        "Open the setup guide on your iPhone.",
        "Build the Shortcut with the URL and key below.",
        "Share a Spotify or YouTube link → Send to DJ Sync.",
      ]
    }
  }

  public var example: String {
    switch self {
    case .telegram: "send the bot a Spotify link"
    case .iphone: "share a Spotify link → Send to DJ Sync"
    default: "Add https://open.spotify.com/track/… to a playlist called Friday"
    }
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
    /// The cloud's error code, when it refused on purpose.
    public var code: String?

    public init(message: String, code: String? = nil) {
      self.message = message
      self.code = code
    }

    /// From a non-2xx `/local/links` reply.
    public static func from(status: Int, body: Data) -> Failure {
      let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
      let code = json?["code"] as? String
      if code == "telegram_not_configured" {
        return Failure(message: "Telegram isn't available yet.", code: code)
      }
      return Failure(message: (json?["error"] as? String) ?? "dj-sync answered \(status).", code: code)
    }
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
      return .failure(Failure.from(status: http.statusCode, body: data))
    }
    return .success(data)
  }
}
