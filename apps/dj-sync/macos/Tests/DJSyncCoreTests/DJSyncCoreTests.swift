import Foundation
import Testing

@testable import DJSyncCore

struct SettingsFileTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  var file: SettingsFile { SettingsFile(url: dir.appending(path: "settings.json")) }

  @Test func `missing file means dj-sync default`() {
    #expect(file.downloadDir() == nil)
  }

  @Test func `choosing a folder writes the key dj-sync reads, keeping other keys`() throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data(#"{"future_key": 7}"#.utf8).write(to: file.url)

    try file.setDownloadDir("/Users/me/Music/DJ Sets")
    #expect(file.downloadDir() == "/Users/me/Music/DJ Sets")

    let object = try #require(
      JSONSerialization.jsonObject(with: Data(contentsOf: file.url)) as? [String: Any])
    #expect(object["download_dir"] as? String == "/Users/me/Music/DJ Sets")
    #expect(object["future_key"] as? Int == 7)
  }

  @Test func `use default removes the key`() throws {
    try file.setDownloadDir("/Users/me/Music/X")
    try file.setDownloadDir(nil)
    #expect(file.downloadDir() == nil)
  }

  @Test func `a corrupt file is replaced on the next write`() throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: file.url)
    #expect(file.downloadDir() == nil)
    try file.setDownloadDir("/Users/me/Music/X")
    #expect(file.downloadDir() == "/Users/me/Music/X")
  }
}

struct PathTests {
  let home = "/Users/me"

  @Test(arguments: [
    ("/Users/me/Music/DJ", "~/Music/DJ"),
    ("/Users/me", "~"),
    ("/Users/meow/Music", "/Users/meow/Music"),
    ("/Volumes/USB/DJ", "/Volumes/USB/DJ"),
  ])
  func `paths under home are abbreviated`(path: String, expected: String) {
    #expect(abbreviatingHome(path, home: home) == expected)
  }

  @Test(arguments: [
    ("/Users/me/Desktop/DJ", "your Desktop"),
    ("/Users/me/Documents", "Documents"),
    ("/Users/me/Downloads/sets", "Downloads"),
    ("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/DJ", "iCloud Drive"),
    ("/Volumes/CDJ/Music", "an external or network drive"),
  ])
  func `background-blocked places are flagged`(path: String, place: String) {
    #expect(protectedLocation(of: path, home: home) == place)
  }

  @Test(arguments: ["/Users/me/Music/DJ_Downloads", "/Users/me/Desktopish", "/Users/me/DJ"])
  func `ordinary folders are fine`(path: String) {
    #expect(protectedLocation(of: path, home: home) == nil)
  }
}

struct ServiceStatusTests {
  /// Shape produced by dj-sync's `GET /local/status`.
  static let sample = #"""
    {"service":"dj-sync","version":"0.3.0",
     "download_dir":"/Users/me/Music/DJ_Downloads","download_dir_source":"settings",
     "download_dir_writable":false,"download_dir_error":"macOS won't let dj-sync write…",
     "import_xml":"/Users/me/Library/rekordbox/rekordbox/rekordbox.xml","xml_version":"1.1.0",
     "cloud":{"enabled":true,"base_url":"https://mcp.triplejmusic.art"},
     "recent_jobs":[{"job_id":"67669f13e405","state":"done","playlist":"Offline Test",
                     "message":"Added 1 track(s)…","created_at":"x","finished_at":null}]}
    """#

  @Test func `decodes the status endpoint`() throws {
    let s = try ServiceStatus.decode(Data(Self.sample.utf8))
    #expect(s.version == "0.3.0")
    #expect(s.usesCustomFolder)
    #expect(!s.downloadDirWritable)
    #expect(s.downloadDirError?.hasPrefix("macOS") == true)
    #expect(s.xmlVersion == "1.1.0")
    #expect(s.cloud.enabled)
    #expect(s.recentJobs.first?.playlist == "Offline Test")
  }

  @Test func `job dates come from finished_at, else created_at`() throws {
    let s = try ServiceStatus.decode(Data(Self.sample.utf8))
    #expect(s.recentJobs.first?.date == nil, "created_at \"x\" isn't a date")
    let date = try #require(parseTimestamp("2026-10-28T02:34:13+00:00"))
    #expect(date.timeIntervalSince1970 == 1_793_154_853)
    #expect(parseTimestamp(nil) == nil)
  }

  @Test func `nothing listening means not running`() async {
    let client = StatusClient(url: URL(string: "http://127.0.0.1:9/local/status")!)
    #expect(await client.fetch() == nil)
  }
}

struct MenuBarPlacementTests {
  /// 16" MacBook Pro: 1728 pt wide, notch between x=771 and x=956.
  func placement(x: Double, notch: Bool = true, occluded: Bool = false, userHidden: Bool = false)
    -> MenuBarPlacement
  {
    MenuBarPlacement(
      itemMinX: x, itemWidth: 28, screenWidth: 1728,
      leftAreaWidth: notch ? 771 : nil, rightAreaWidth: notch ? 772 : nil,
      occluded: occluded, userHidden: userHidden)
  }

  @Test func `right of the notch is visible`() {
    #expect(placement(x: 1500).visibility == .visible)
  }

  @Test(arguments: [800.0, 760.0, 940.0])
  func `overlapping the notch is hidden`(x: Double) {
    #expect(placement(x: x).underNotch)
    #expect(placement(x: x).visibility != .visible)
  }

  @Test func `no notch, no notch problem`() {
    #expect(placement(x: 800, notch: false).visibility == .visible)
  }

  @Test func `off-screen or removed is hidden; occlusion alone is not`() {
    // Occlusion also happens when the menu bar auto-hides in full screen.
    #expect(placement(x: 1500, occluded: true).visibility == .visible)
    #expect(placement(x: -40).visibility != .visible)
    #expect(placement(x: 1500, userHidden: true).visibility != .visible)
  }
}

struct ConnectionsTests {
  @Test(arguments: [
    ("https://mcp.triplejmusic.art/c14d12f694749358212013e9623b4dc0c5fcd70c6439d91d/mcp",
     "https://mcp.triplejmusic.art/c14d…/mcp"),
    ("http://127.0.0.1:8000/c14d12f694749358212013e9623b4dc0c5fcd70c6439d91d/mcp",
     "http://127.0.0.1:8000/c14d…/mcp"),
    ("https://example.com/short/mcp", "https://example.com/short/mcp"),
    ("https://mcp.triplejmusic.art/health", "https://mcp.triplejmusic.art/health"),
  ])
  func `secret path segment is masked`(url: String, masked: String) {
    #expect(maskingSecretPath(url) == masked)
  }

  @Test func `reads tunnel id and first ingress rule`() throws {
    let yaml = """
      # comment
      tunnel: 44ec5053-29d3-4dca-9c65-014b4d3a586f
      credentials-file: /Users/me/.cloudflared/44ec5053.json

      ingress:
        # 127.0.0.1, not localhost
        - hostname: mcp.triplejmusic.art
          service: http://127.0.0.1:8000
        - service: http_status:404
      """
    let t = try #require(TunnelConfig.parse(yaml))
    #expect(t.tunnelId == "44ec5053-29d3-4dca-9c65-014b4d3a586f")
    #expect(t.hostname == "mcp.triplejmusic.art")
    #expect(t.service == "http://127.0.0.1:8000")
    #expect(TunnelConfig.parse("ingress:\n  - service: http_status:404") == nil)
  }

  @Test func `decodes worker health`() throws {
    let json = #"{"status":"ok","version":"0.1.0","protocol":"1.0.0","agent":{"online":true,"last_seen":"2026-10-28T02:34:40.599Z","version":"0.2.0"},"queued":2}"#
    let h = try CloudHealth.decode(Data(json.utf8))
    #expect(h.agent.online)
    #expect(h.queued == 2)
    #expect(h.protocol == "1.0.0")
  }
}
