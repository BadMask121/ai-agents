import CryptoKit
import Foundation
import Testing

@testable import DJSyncCore

private func tempDir() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "djsync-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

@Suite struct SemVerTests {
  @Test func ordersReleasesAndPrereleases() throws {
    let order = ["0.9.0", "1.0.0-alpha", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.1", "1.10.0", "2.0.0"]
    let parsed = try order.map { try #require(SemVer($0)) }
    for (a, b) in zip(parsed, parsed.dropFirst()) {
      #expect(a < b, "\(a) < \(b)")
    }
    #expect(SemVer("v1.2.3") == SemVer("1.2.3+build.5"))
    #expect(SemVer("1.2") == nil)
    #expect(SemVer("1.2.3-") == nil)
    #expect(SemVer("1.0.0-rc.1")?.description == "1.0.0-rc.1")
  }
}

@Suite struct UpdateFeedTests {
  /// Signed by `dj-sync-sign` with the real release key: CryptoKit must
  /// accept what ed25519-dalek produces.
  @Test func verifiesTheReleaseKeysSignatures() {
    let data = Data("dj-sync interop test\n".utf8)
    let sig = "VooTwp+ZVckbabNr8jvn1UnSfTz94cGdqYtweBEqXfA2UQYayNQu2lbtgJEVfYjHQDIeEuDnuru/6YqEGTbyDQ=="
    #expect(UpdateFeed.verify(data, signature: sig + "\n", publicKey: UpdateFeed.releasePublicKey))
    #expect(!UpdateFeed.verify(Data("tampered\n".utf8), signature: sig, publicKey: UpdateFeed.releasePublicKey))
    #expect(!UpdateFeed.verify(data, signature: "nonsense", publicKey: UpdateFeed.releasePublicKey))
  }

  private func feed(_ version: String, minMacos: String? = nil, signer: Curve25519.Signing.PrivateKey) throws
    -> (UpdateFeed, Data)
  {
    var latest: [String: Any] = [
      "version": version, "url": "https://example.test/DJ-Sync-\(version).zip",
      "sha256": String(repeating: "a", count: 64),
    ]
    latest["min_macos"] = minMacos
    let data = try JSONSerialization.data(withJSONObject: ["latest": latest])
    let sig = try signer.signature(for: data).base64EncodedString()
    let key = signer.publicKey.rawRepresentation.base64EncodedString()
    let url = URL(string: "https://example.test/appcast.json")!
    let f = UpdateFeed(url: url, publicKey: key) { requested in
      requested.pathExtension == "sig" ? Data(sig.utf8) : data
    }
    return (f, data)
  }

  @Test func offersOnlyNewerVersions() async throws {
    let key = Curve25519.Signing.PrivateKey()
    let (newer, _) = try feed("1.0.0", signer: key)
    guard case .available(let r) = await newer.check(currentVersion: "1.0.0-rc.1") else {
      Issue.record("expected an update")
      return
    }
    #expect(r.version == "1.0.0")
    #expect(await newer.check(currentVersion: "1.0.0") == .upToDate)
    #expect(await newer.check(currentVersion: "1.2.0") == .upToDate, "never downgrades")
  }

  @Test func refusesFeedsSignedByAnotherKey() async throws {
    let (f, _) = try feed("9.9.9", signer: Curve25519.Signing.PrivateKey())
    var forged = f
    forged.publicKey = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
    guard case .failed = await forged.check(currentVersion: "1.0.0") else {
      Issue.record("a forged feed must fail")
      return
    }
  }

  @Test func respectsTheMinimumMacOS() async throws {
    let (f, _) = try feed("2.0.0", minMacos: "99.0", signer: Curve25519.Signing.PrivateKey())
    guard case .failed(let why) = await f.check(currentVersion: "1.0.0") else {
      Issue.record("expected a refusal")
      return
    }
    #expect(why.contains("99.0"))
  }

  @Test func nothingPublishedYetIsUpToDate() async {
    let f = UpdateFeed(url: URL(string: "https://example.test/appcast.json")!) { _ in throw UpdateError.http(404) }
    #expect(await f.check(currentVersion: "1.0.0") == .upToDate)
  }
}

@Suite struct UpdateInstallerTests {
  private func fakeApp(in dir: URL, id: String, version: String) throws -> URL {
    let app = dir.appending(path: "DJ Sync.app")
    try FileManager.default.createDirectory(at: app.appending(path: "Contents/MacOS"), withIntermediateDirectories: true)
    let info: NSDictionary = ["CFBundleIdentifier": id, "CFBundleShortVersionString": version]
    try info.write(to: app.appending(path: "Contents/Info.plist"))
    try Data("binary \(version)".utf8).write(to: app.appending(path: "Contents/MacOS/DJSyncMenu"))
    return app
  }

  @Test func checksumsUnpacksValidatesAndSwaps() throws {
    let root = try tempDir()
    let installed = try fakeApp(in: root.appending(path: "Applications"), id: "com.x.menu", version: "1.0.0")
    let built = try fakeApp(in: root.appending(path: "build"), id: "com.x.menu", version: "1.0.1")
    let zip = root.appending(path: "update.zip")
    let ditto = Process()
    ditto.executableURL = URL(filePath: "/usr/bin/ditto")
    ditto.arguments = ["-c", "-k", "--keepParent", built.path(percentEncoded: false), zip.path(percentEncoded: false)]
    try ditto.run()
    ditto.waitUntilExit()

    let sum = try UpdateInstaller.sha256Hex(of: zip)
    #expect(sum.count == 64)
    let unpacked = try UpdateInstaller.unpack(zip: zip, into: root.appending(path: "unpacked"))
    #expect(throws: UpdateError.wrongApp("version 1.0.1, expected 1.0.2")) {
      try UpdateInstaller.validate(app: unpacked, bundleID: "com.x.menu", version: "1.0.2")
    }
    #expect(throws: UpdateError.wrongApp("bundle com.x.menu")) {
      try UpdateInstaller.validate(app: unpacked, bundleID: "com.other", version: "1.0.1")
    }
    try UpdateInstaller.validate(app: unpacked, bundleID: "com.x.menu", version: "1.0.1")
    try UpdateInstaller.replace(installed: installed, with: unpacked)
    let binary = try String(contentsOf: installed.appending(path: "Contents/MacOS/DJSyncMenu"), encoding: .utf8)
    #expect(binary == "binary 1.0.1")
  }
}

@Suite struct ServiceInstallerTests {
  actor Calls {
    var log: [[String]] = []
    var loaded = false
    func run(_ args: [String]) -> Int32 {
      log.append(args)
      switch args.first {
      case "print": return loaded ? 0 : 113
      case "bootstrap": loaded = true; return 0
      case "bootout": loaded = false; return 0
      default: return 0
      }
    }
    func verbs() -> [String] { log.compactMap(\.first) }
  }

  @Test func installsThenOnlyRestartsWhenSomethingChanged() async throws {
    let home = try tempDir()
    let bundled = home.appending(path: "Bundle/dj-sync")
    try FileManager.default.createDirectory(at: bundled.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("v1".utf8).write(to: bundled)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundled.path(percentEncoded: false))
    let calls = Calls()
    let installer = ServiceInstaller(home: home, bundledService: bundled, uid: 501) { await calls.run($0) }

    #expect(await installer.ensureInstalled() == .installed(serviceChanged: true, plistChanged: true))
    #expect(try Data(contentsOf: installer.installedService) == Data("v1".utf8))
    let plist = try #require(NSDictionary(contentsOf: installer.plistURL))
    #expect((plist["ProgramArguments"] as? [String])?.first == installer.installedService.path(percentEncoded: false))
    #expect(plist["KeepAlive"] as? Bool == true)
    #expect(await calls.verbs() == ["print", "bootstrap"])

    #expect(await installer.ensureInstalled() == .upToDate)
    #expect(await calls.verbs() == ["print", "bootstrap", "print"], "nothing to do")

    try Data("v2".utf8).write(to: bundled)
    #expect(await installer.ensureInstalled() == .installed(serviceChanged: true, plistChanged: false))
    #expect(await calls.verbs().suffix(2) == ["print", "kickstart"], "new binary: restart only")
  }

  @Test func takesOverAnOlderAgentDefinition() async throws {
    let home = try tempDir()
    let bundled = home.appending(path: "dj-sync")
    try Data("svc".utf8).write(to: bundled)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundled.path(percentEncoded: false))
    let calls = Calls()
    await calls.run(["bootstrap"])  // the old agent is loaded
    let installer = ServiceInstaller(home: home, bundledService: bundled, uid: 501) { await calls.run($0) }
    try FileManager.default.createDirectory(
      at: installer.plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let old: NSDictionary = ["Label": ServiceInstaller.label, "ProgramArguments": ["/Users/x/.cargo/bin/dj-sync"]]
    try old.write(to: installer.plistURL)

    #expect(await installer.ensureInstalled() == .installed(serviceChanged: true, plistChanged: true))
    #expect(await calls.verbs().suffix(3) == ["print", "bootout", "bootstrap"])
  }

  @Test func doesNothingWithoutABundledService() async {
    let installer = ServiceInstaller(home: URL(filePath: "/nonexistent"), bundledService: nil, uid: 501) { _ in 0 }
    #expect(await installer.ensureInstalled() == .notBundled)
  }
}

@Suite struct DecodingTests {
  @Test func linksAndToolboxReports() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let link = try decoder.decode(
      AssistantLink.self,
      from: Data(
        #"{"id":"qIDZ83oN4bog","kind":"chatgpt","label":"ChatGPT","created_at":"2026-10-28T05:31:00.000Z","last_used_at":"2026-10-28T05:31:02.120Z","url":"https://mcp.example/T/S/mcp"}"#
          .utf8))
    #expect(link.isConnected)
    #expect(link.lastUsed != nil, "the cloud's millisecond timestamps parse")
    #expect(link.assistant == .chatgpt)
    let fresh = try decoder.decode(AssistantLink.self, from: Data(#"{"id":"a","kind":"claude"}"#.utf8))
    #expect(!fresh.isConnected)
    #expect(fresh.displayName == "Claude")

    let report = try ToolboxReport.decode(
      Data(
        #"{"tools":[{"name":"yt-dlp","installed":"2026.10.26","wanted":"2026.10.26","ready":true}],"venvs":[{"name":"spotdl","installed":"spotdl==4.6.0","wanted":"spotdl==4.6.0","ready":true}],"installing":false,"step":null,"progress":null,"error":null,"manifest":"built-in","checked_at":"2026-10-28T05:30:48Z"}"#
          .utf8))
    #expect(report.allReady)
    #expect(report.venvs[0].displayVersion == "4.6.0")
  }
}

@Suite struct DiagnosticsTests {
  @Test func masksSecretsButKeepsTheShape() {
    let text = """
      url https://mcp.triplejmusic.art/u2dDy37bIx227JDdDMLBoA/Qx9AhD7Kl_2mWvVn0pR8tYcE4bU1sN6oF3gJiZ5aXkL/mcp
      Authorization: Bearer djsa_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG
      legacy /0123456789abcdef0123456789abcdef0123456789abcdef/mcp
      short words stay: yt-dlp 2026.10.26 ok
      """
    let masked = Diagnostics.mask(text)
    #expect(!masked.contains("Qx9AhD7Kl_2mWvVn0pR8"))
    #expect(!masked.contains("abcdefghijklmnopqrstuvwxyz"))
    #expect(!masked.contains("0123456789abcdef0123456789abcdef"))
    #expect(masked.contains("/Qx9A…/mcp"))
    #expect(masked.contains("Bearer …"))
    #expect(masked.contains("yt-dlp 2026.10.26 ok"))
  }

  @Test func readsOnlyWarningsAndErrorsFromTheLogTail() throws {
    let log = try tempDir().appending(path: "dj-sync.log")
    let lines = (1...80).map { i in
      i % 2 == 0 ? "2026-10-28T05:00:\(i)Z  WARN dj_sync: thing \(i)" : "2026-10-28T05:00:\(i)Z  INFO dj_sync: fine \(i)"
    }
    try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: log)
    let hits = Diagnostics.warningLines(fromLog: log, limit: 5)
    #expect(hits.count == 5)
    #expect(hits.last?.hasSuffix("thing 80") == true)
    #expect(hits.allSatisfy { $0.contains(" WARN ") })
  }
}

@Suite struct OnboardingTests {
  @Test func existingSetupsSkipOnboarding() throws {
    #expect(Onboarding.shouldShow(onboarded: false, status: nil, links: []))
    #expect(!Onboarding.shouldShow(onboarded: true, status: nil, links: []))
    let used = AssistantLink(id: "a", kind: "chatgpt", lastUsedAt: "2026-10-28T05:31:02Z")
    #expect(!Onboarding.shouldShow(onboarded: false, status: nil, links: [used]))
    let unused = AssistantLink(id: "b", kind: "claude")
    #expect(Onboarding.shouldShow(onboarded: false, status: nil, links: [unused]))
    #expect(OnboardingStep.tools.next == .rekordbox)
    #expect(OnboardingStep.assistant.next == nil)
  }

  @Test func findsTheNewestRekordbox() throws {
    let apps = try tempDir()
    for (folder, version) in [("rekordbox 6", "6.8.5"), ("rekordbox 7", "7.2.11")] {
      let app = apps.appending(path: "\(folder)/rekordbox.app/Contents")
      try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
      try (["CFBundleShortVersionString": version] as NSDictionary).write(to: app.appending(path: "Info.plist"))
    }
    #expect(RekordboxInstall.detect(in: apps) == RekordboxInstall(name: "Rekordbox 7", version: "7.2.11"))
    #expect(RekordboxInstall.detect(in: try tempDir()) == nil)
  }

  @Test func settingsRememberOnboardingAndKeepOtherKeys() throws {
    let file = SettingsFile(url: try tempDir().appending(path: "settings.json"))
    try file.setDownloadDir("/Users/dj/Music/DJ")
    #expect(!file.onboarded())
    try file.setOnboarded(true)
    #expect(file.onboarded())
    #expect(file.downloadDir() == "/Users/dj/Music/DJ")
  }
}

@Test func updateTargetsTheRealAppWhenRunningTranslocated() {
  let moved = URL(filePath: "/private/var/folders/x/T/AppTranslocation/ABC/d/DJ Sync.app")
  let real = URL(filePath: "/Applications/DJ Sync.app")
  #expect(UpdateInstaller.installedLocation(of: moved, candidates: [URL(filePath: "/Applications")], exists: { $0 == real }) == real)
  #expect(UpdateInstaller.installedLocation(of: real, exists: { _ in false }) == real)
  #expect(UpdateInstaller.installedLocation(of: moved, exists: { _ in false }) == moved)
}
