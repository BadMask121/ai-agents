import Foundation

/// Where the dj-sync service listens. It writes `~/.dj-sync/runtime.json`
/// (`{port, pid, version}`) at start, because it falls back to a free port
/// when another app holds 8000. Read on every request, so a restart on a new
/// port is picked up straight away.
public enum ServiceEndpoint {
  public static let defaultBase = URL(string: "http://127.0.0.1:8000")!

  public static let runtimeFile = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: ".dj-sync/runtime.json")

  public static func base(runtimeFile: URL = runtimeFile) -> URL {
    guard let data = try? Data(contentsOf: runtimeFile),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = object["port"] as? Int, (1...65_535).contains(port)
    else { return defaultBase }
    return URL(string: "http://127.0.0.1:\(port)")!
  }
}
