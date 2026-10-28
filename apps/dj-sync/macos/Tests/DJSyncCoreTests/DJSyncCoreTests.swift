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

  @Test func `nothing listening means not running`() async {
    let client = StatusClient(url: URL(string: "http://127.0.0.1:9/local/status")!)
    #expect(await client.fetch() == nil)
  }
}
