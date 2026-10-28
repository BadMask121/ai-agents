import Foundation
import Testing

@testable import DJSyncCore

struct UninstallerTests {
  let bundle = URL(filePath: "/Applications/DJ Sync.app")
  let home = URL(filePath: "/Users/dj")

  @Test func `runs the app's own service copy, else the installed one`() {
    let bundled = "/Applications/DJ Sync.app/Contents/Helpers/dj-sync"
    let installed = "/Users/dj/.dj-sync/bin/dj-sync"
    #expect(Uninstaller.helper(bundle: bundle, home: home) { _ in true }?.path(percentEncoded: false) == bundled)
    #expect(Uninstaller.helper(bundle: bundle, home: home) { $0 == installed }?.path(percentEncoded: false) == installed)
    #expect(Uninstaller.helper(bundle: bundle, home: home) { _ in false } == nil)
  }

  @Test func `keeping backups is the default; unticking deletes them`() {
    #expect(Uninstaller.arguments(keepBackups: true) == ["uninstall"])
    #expect(Uninstaller.arguments(keepBackups: false) == ["uninstall", "--delete-backups"])
  }

  @Test func `reports the command's exit status and output`() async throws {
    let script = FileManager.default.temporaryDirectory.appending(path: "fake-dj-sync-\(UUID().uuidString)")
    try Data("#!/bin/sh\necho \"args: $*\"\n[ \"$2\" = --delete-backups ] && exit 1\nexit 0\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path())
    let kept = await Uninstaller.run(helper: script, keepBackups: true)
    #expect(kept == .init(ok: true, output: "args: uninstall\n"))
    let deleted = await Uninstaller.run(helper: script, keepBackups: false)
    #expect(deleted == .init(ok: false, output: "args: uninstall --delete-backups\n"))
  }
}

struct AppPathTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  var file: SettingsFile { SettingsFile(url: dir.appending(path: "settings.json")) }

  @Test func `records an installed app, keeping other keys`() throws {
    try file.setDownloadDir("/Users/dj/Music/DJ")
    #expect(try file.recordAppPath(URL(filePath: "/Applications/DJ Sync.app")))
    #expect(file.appPath() == "/Applications/DJ Sync.app")
    #expect(file.downloadDir() == "/Users/dj/Music/DJ")
  }

  @Test func `skips the installer disk and App Translocation, which vanish on quit`() throws {
    try file.recordAppPath(URL(filePath: "/Users/dj/Applications/DJ Sync.app"))
    #expect(!(try file.recordAppPath(URL(filePath: "/Volumes/DJ Sync 1.3.0/DJ Sync.app"))))
    #expect(
      !(try file.recordAppPath(
        URL(filePath: "/private/var/folders/x/T/AppTranslocation/ABC-123/d/DJ Sync.app"))))
    #expect(file.appPath() == "/Users/dj/Applications/DJ Sync.app")
  }
}
