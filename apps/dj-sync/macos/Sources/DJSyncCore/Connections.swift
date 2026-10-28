import Foundation

/// `https://host/<long secret>/mcp` → `https://host/c14d…/mcp`, so the URL
/// can be recognised on screen without exposing the secret.
public func maskingSecretPath(_ url: String) -> String {
  var parts = url.components(separatedBy: "/")
  guard parts.count >= 2, parts[parts.count - 1] == "mcp" else { return url }
  let secret = parts[parts.count - 2]
  guard secret.count >= 16 else { return url }
  parts[parts.count - 2] = secret.prefix(4) + "…"
  return parts.joined(separator: "/")
}

/// The bits of `~/.cloudflared/config.yml` worth showing.
public struct TunnelConfig: Equatable, Sendable {
  public var tunnelId: String
  public var hostname: String?
  public var service: String?

  public static let standardURL = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: ".cloudflared/config.yml")

  /// A deliberately small reader for cloudflared's flat config: `tunnel:`,
  /// then the first ingress rule's `hostname:` / `service:`.
  public static func parse(_ yaml: String) -> TunnelConfig? {
    var tunnel: String?
    var hostname: String?
    var service: String?
    for raw in yaml.split(separator: "\n", omittingEmptySubsequences: true) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("#") { continue }
      let item = line.hasPrefix("- ") ? String(line.dropFirst(2)) : line
      guard let colon = item.firstIndex(of: ":") else { continue }
      let key = item[..<colon].trimmingCharacters(in: .whitespaces)
      let value = item[item.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      switch key {
      case "tunnel" where tunnel == nil: tunnel = value
      case "hostname" where hostname == nil: hostname = value
      case "service" where service == nil && hostname != nil: service = value
      default: break
      }
    }
    guard let tunnel, !tunnel.isEmpty else { return nil }
    return TunnelConfig(tunnelId: tunnel, hostname: hostname, service: service)
  }

  public static func load(from url: URL = standardURL) -> TunnelConfig? {
    (try? String(contentsOf: url, encoding: .utf8)).flatMap(parse)
  }
}

/// The cloud queue Worker's public `GET /health`.
public struct CloudHealth: Decodable, Equatable, Sendable {
  public struct Agent: Decodable, Equatable, Sendable {
    public var online: Bool
    public var lastSeen: String?
    public var version: String?
  }

  public var status: String
  public var version: String
  public var `protocol`: String
  public var agent: Agent
  public var queued: Int

  public static func decode(_ data: Data) throws -> CloudHealth {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(CloudHealth.self, from: data)
  }

  /// `nil` when the Worker can't be reached.
  public static func fetch(baseURL: String) async -> CloudHealth? {
    guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/health")
    else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 4)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? decode(data)
  }
}
