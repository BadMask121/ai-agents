import Foundation
import Testing

@testable import DJSyncCore

@Suite struct ConnectAnywhereTests {
  private func decode(_ json: String) throws -> AssistantLink {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(AssistantLink.self, from: Data(json.utf8))
  }

  @Test func assistantsMapToLinkKindsAndGuides() {
    #expect(Assistant.allCases.map(\.rawValue) == ["chatgpt", "claude", "telegram", "shortcut"])
    #expect(Assistant(rawValue: "shortcut") == .iphone)
    #expect(Assistant.iphone.guideURL.absoluteString == "https://djsync.jeffrey.build/connect/iphone/")
    #expect(Assistant.chatgpt.guideURL.absoluteString == "https://djsync.jeffrey.build/connect/chatgpt/")
    #expect(Assistant.telegram.guideURL.absoluteString == "https://djsync.jeffrey.build/connect/telegram/")
    #expect(Assistant.chatgpt.cost == "Paid plan")
    #expect(Assistant.allCases.filter { $0 != .chatgpt }.allSatisfy { $0.cost == "Free" })
    #expect(Assistant.onboarding == [.chatgpt, .claude, .telegram])
    #expect(Assistant.chatgpt.usesConnectorURL && !Assistant.telegram.usesConnectorURL)
  }

  @Test func telegramLinksAreConnectedOnlyOncePaired() throws {
    let waiting = try decode(
      #"{"id":"t1","kind":"telegram","label":"Telegram","url":"https://t.me/djsync_bot?start=abc","expires_at":"2026-10-28T12:10:00Z","paired":false,"last_used_at":null}"#
    )
    #expect(!waiting.isConnected)
    #expect(waiting.displayName == "Telegram")
    #expect(!waiting.pairingExpired(now: ISO8601DateFormatter().date(from: "2026-10-28T12:05:00Z")!))
    #expect(waiting.pairingExpired(now: ISO8601DateFormatter().date(from: "2026-10-28T12:11:00Z")!))

    let paired = try decode(
      #"{"id":"t1","kind":"telegram","label":"Telegram","paired":true,"telegram_username":"djjj","last_used_at":"2026-10-28T12:06:00Z"}"#
    )
    #expect(paired.isConnected)
    #expect(paired.displayName == "Telegram (@djjj)")
    #expect(!paired.pairingExpired(now: .distantFuture), "a paired chat never 'expires'")

    // Rotating unpairs: an earlier use doesn't count as connected.
    let rotated = try decode(#"{"id":"t1","kind":"telegram","paired":false,"last_used_at":"2026-10-28T12:06:00Z"}"#)
    #expect(!rotated.isConnected)
  }

  @Test func shortcutLinksCarryTheirURLAndKey() throws {
    let link = try decode(
      #"{"id":"s1","kind":"shortcut","label":"iPhone","api_url":"https://djsync.jeffrey.build/api/downloads","token":"u2dDy37bIx227JDdDMLBoA.secretsecretsecretsecretsecret","last_used_at":null}"#
    )
    #expect(link.assistant == .iphone)
    #expect(link.apiUrl == "https://djsync.jeffrey.build/api/downloads")
    #expect(link.token?.hasPrefix("u2dD") == true)
    #expect(!link.isConnected)
    #expect(link.displayName == "iPhone")
  }

  @Test func refusalsBecomeFriendlyMessages() {
    let notReady = LinksClient.Failure.from(
      status: 503, body: Data(#"{"ok":false,"error":"Telegram isn't set up","code":"telegram_not_configured"}"#.utf8))
    #expect(notReady.code == "telegram_not_configured")
    #expect(notReady.message == "Telegram isn't available yet.")
    let other = LinksClient.Failure.from(status: 409, body: Data(#"{"ok":false,"error":"too_many_links","code":"too_many_links"}"#.utf8))
    #expect(other.message == "too_many_links")
    #expect(LinksClient.Failure.from(status: 502, body: Data()).message == "dj-sync answered 502.")
  }

  @Test func qrCodesAreSquareAndScannableSized() throws {
    let image = try #require(QRCode.image(for: "https://t.me/djsync_bot?start=AbCdEfGhIjKlMnOpQrStUv"))
    #expect(image.width == image.height)
    #expect(image.width >= 21, "at least a version-1 QR code")
  }

  @Test func diagnosticsMaskPairingCodes() {
    let masked = Diagnostics.mask("open https://t.me/djsync_bot?start=AbCdEfGhIjKlMnOpQrStUv now")
    #expect(masked == "open https://t.me/djsync_bot?start=… now")
    #expect(!Diagnostics.mask("token u2dDy37bIx227JDdDMLBoA.Qx9AhD7Kl_2mWvVn0pR8tYcE4bU1sN6oF3gJiZ5aXkL").contains("Qx9AhD7Kl_2m"))
  }
}

@Suite struct ShortcutSetupTests {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)
  private func iso(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: d)
  }

  @Test func decodesTheInstallReply() throws {
    let json = #"{"install_url":"https://djsync.jeffrey.build/i/t/abc","expires_at":"2027-01-15T08:00:00.123Z"}"#
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let install = try decoder.decode(ShortcutInstall.self, from: Data(json.utf8))
    #expect(install.installUrl == "https://djsync.jeffrey.build/i/t/abc")
    #expect(install.expires != nil)
  }

  @Test func readyShowsTheQRUntilItExpires() {
    let install = ShortcutInstall(installUrl: "https://djsync.jeffrey.build/i/t/abc", expiresAt: iso(now.addingTimeInterval(600)))
    let setup = ShortcutSetup.from(.success(install))
    #expect(setup == .ready(install))
    #expect(setup.installURL(now: now) == install.installUrl)
    #expect(!setup.expired(now: now))
    #expect(setup.installURL(now: now.addingTimeInterval(601)) == nil)
    #expect(setup.expired(now: now.addingTimeInterval(601)))
    #expect(!setup.wantsManualSetup)
  }

  @Test func signingFailureOpensTheManualSetup() {
    let body = Data(#"{"ok":false,"error":"macOS couldn't sign the Shortcut: not signed in. Make sure this Mac is signed into iCloud …","code":"shortcut_signing_failed"}"#.utf8)
    let failure = LinksClient.Failure.from(status: 409, body: body)
    let setup = ShortcutSetup.from(.failure(failure))
    #expect(setup.wantsManualSetup)
    if case .failed(let message, let signing) = setup {
      #expect(signing)
      #expect(message.contains("iCloud"))
    } else {
      Issue.record("expected .failed")
    }
    #expect(setup.installURL(now: now) == nil)
  }

  @Test func otherFailuresKeepTheQRPath() {
    let failure = LinksClient.Failure(message: "dj-sync isn't running.")
    let setup = ShortcutSetup.from(.failure(failure))
    #expect(!setup.wantsManualSetup)
    #expect(ShortcutSetup.idle.installURL() == nil)
    #expect(!ShortcutSetup.preparing.expired())
  }

  @Test func iPhoneStepsAreTheOneScanFlow() {
    #expect(Assistant.iphone.steps.first == "Scan the code with your iPhone camera.")
    #expect(Assistant.iphone.steps.contains("Tap Add Shortcut."))
  }
}
