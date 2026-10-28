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
    #expect(h.agent?.online == true)
    #expect(h.queued == 2)
    #expect(h.protocol == "1.0.0")
    // Worker 1.0 (multi-DJ) reports no single agent.
    let v2 = try CloudHealth.decode(Data(#"{"status":"ok","version":"1.0.0","protocol":"2.0.0"}"#.utf8))
    #expect(v2.agent == nil && v2.queued == nil)
  }
}

struct JobWatcherTests {
  func job(_ id: String, _ state: String, playlist: String = "Friday") -> ServiceStatus.Job {
    ServiceStatus.Job(jobId: id, state: state, playlist: playlist, message: "", createdAt: nil, finishedAt: nil)
  }

  @Test func `launching doesn't replay existing jobs`() {
    var w = JobWatcher()
    #expect(w.update([job("a", "done"), job("b", "running")]).isEmpty)
  }

  @Test func `a new request, then its completion`() {
    var w = JobWatcher()
    _ = w.update([])
    #expect(w.update([job("a", "queued")]) == [.requested(job("a", "queued"))])
    #expect(w.update([job("a", "running")]).isEmpty, "running isn't news")
    #expect(w.update([job("a", "done")]) == [.finished(job("a", "done"))])
    #expect(w.update([job("a", "done")]).isEmpty, "only once")
  }

  @Test func `a job waiting in the queue is announced once`() {
    var w = JobWatcher()
    _ = w.update([])
    #expect(w.update([job("q", "queued")]).count == 1)
    #expect(w.update([job("q", "queued")]).isEmpty)
    #expect(w.update([job("q", "queued")]).isEmpty)
  }

  @Test func `new and already over is one event`() {
    var w = JobWatcher()
    _ = w.update([])
    #expect(w.update([job("x", "failed")]) == [.failed(job("x", "failed"))])
  }

  @Test func `several at once are announced oldest first`() {
    var w = JobWatcher()
    _ = w.update([job("old", "done")])
    let events = w.update([job("c", "queued"), job("b", "running"), job("old", "done")])
    #expect(events == [.requested(job("b", "running")), .requested(job("c", "queued"))])
  }

  @Test func `jobs from a restarted dj-sync are new`() {
    var w = JobWatcher()
    _ = w.update([job("a", "done")])
    _ = w.update([])  // dj-sync restarted: history gone
    #expect(w.update([job("z", "queued")]) == [.requested(job("z", "queued"))])
  }
}

struct LibraryTests {
  static let json = #"""
    {"service":"dj-sync","version":"0.6.0","download_dir":"/m","download_dir_source":"config",
     "download_dir_writable":true,"download_dir_error":null,"import_xml":"/x.xml","xml_version":"1.3.0",
     "cloud":{"enabled":true,"base_url":"https://mcp.triplejmusic.art"},"recent_jobs":[],
     "rekordbox_db":{"db_path":"/Users/me/Library/Pioneer/rekordbox/master.db","rekordbox_running":false,
       "pending":[{"id":"p1","created_at":"2026-10-28T03:58:00+00:00","summary":"Add 2 track(s) to “Fri”"}],
       "failed":[],"last_applied":{"at":"2026-10-28T03:58:05+00:00","version":"1.1.0","summary":"Add 1 track(s) to “DJ Sync Test”"},
       "last_error":null,"current_version":"1.1.0",
       "backups":[{"version":"1.1.0","created_at":"2026-10-28T03:58:05+00:00","reason":"Add 1 track(s) to “DJ Sync Test”","size_bytes":116219904},
                  {"version":"1.0.0","created_at":"2026-10-28T03:57:59+00:00","reason":"Library before dj-sync's changes","size_bytes":116215808}]}}
    """#

  @Test func `decodes the library section`() throws {
    let s = try ServiceStatus.decode(Data(Self.json.utf8))
    let lib = try #require(s.rekordboxDb)
    #expect(lib.currentVersion == "1.1.0")
    #expect(lib.pending.count == 1)
    #expect(lib.backups.map(\.version) == ["1.1.0", "1.0.0"])
    #expect(lib.backups.last?.date != nil)
  }

  @Test func `library updates are noticed once, not on launch`() {
    var w = LibraryWatcher()
    let a = ServiceStatus.Library.Applied(at: "t1", version: "1.1.0", summary: "x")
    #expect(w.update(a) == nil, "seeded silently")
    #expect(w.update(a) == nil)
    let b = ServiceStatus.Library.Applied(at: "t2", version: "1.2.0", summary: "y")
    #expect(w.update(b) == b)
    #expect(w.update(b) == nil)
  }

  @Test func `first ever apply after launch is noticed`() {
    var w = LibraryWatcher()
    #expect(w.update(nil) == nil)
    let a = ServiceStatus.Library.Applied(at: "t1", version: "1.1.0", summary: "x")
    #expect(w.update(a) == a)
  }
}

@Suite struct ServiceEndpointTests {
  @Test func readsThePortTheServiceWrote() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "runtime.json")
    try Data(#"{"port": 51234, "pid": 1, "version": "0.9.0"}"#.utf8).write(to: file)
    #expect(ServiceEndpoint.base(runtimeFile: file).absoluteString == "http://127.0.0.1:51234")
  }

  @Test func fallsBackWhenMissingOrNonsense() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "runtime.json")
    #expect(ServiceEndpoint.base(runtimeFile: file) == ServiceEndpoint.defaultBase)
    try Data(#"{"port": 99999}"#.utf8).write(to: file)
    #expect(ServiceEndpoint.base(runtimeFile: file) == ServiceEndpoint.defaultBase)
  }
}
