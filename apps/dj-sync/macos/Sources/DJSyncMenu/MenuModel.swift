import AppKit
import DJSyncCore
import Observation
import ServiceManagement

enum ServiceState: Equatable {
  case checking
  case notRunning
  case running(ServiceStatus)

  var status: ServiceStatus? {
    if case .running(let s) = self { s } else { nil }
  }
}

/// State behind the menu bar panel. Everything here runs on the main actor.
@Observable
final class MenuModel {
  private(set) var service: ServiceState = .checking
  private(set) var actionError: String?
  private(set) var isRestarting = false
  /// Whether the menu bar icon can actually be seen (set by AppDelegate).
  var menuBarIcon: MenuBarIconVisibility = .unknown

  /// Which URL was just copied, for a moment of "Copied" feedback.
  private(set) var copied: String?
  /// Assistant URLs contain a secret; masked unless the user asks.
  var revealSecrets = false
  /// A short confirmation (e.g. "Copied — paste it in ChatGPT").
  private(set) var actionNote: String?

  // Assistants (links to this Mac through the cloud)
  private(set) var links: [AssistantLink] = []
  private(set) var linksBusy = false
  /// One-scan iPhone setup, per Shortcut link (only while the app runs).
  private(set) var shortcutSetups: [String: ShortcutSetup] = [:]
  @ObservationIgnored private var linksFetchedAt: Date?
  private let linksClient = LinksClient()

  // Tools installed by dj-sync's toolbox
  private(set) var toolbox: ToolboxReport?
  private let toolboxClient = ToolboxClient()

  // Self-update
  enum UpdateState: Equatable {
    case idle
    case checking
    case upToDate(Date)
    case available(Appcast.Release)
    case installing
    case failed(String)
  }
  private(set) var update: UpdateState = .idle
  @ObservationIgnored private(set) var lastUpdateCheck: Date?
  let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
  /// A restore or apply is in progress.
  private(set) var libraryBusy = false
  private let library = LibraryClient()

  private let settings = SettingsFile.standard
  private let client = StatusClient()
  private let home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
  @ObservationIgnored private var iconCache: [String: NSImage] = [:]

  static let serviceLabel = "com.triplejmusic.dj-sync"
  static let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Logs/dj-sync.log")
  static let agentPlist = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/LaunchAgents/\(serviceLabel).plist")

  var status: ServiceStatus? { service.status }

  var menuBarSymbol: String {
    switch service {
    case .checking: "music.note.list"
    case .running(let s) where s.downloadDirWritable: "music.note.list"
    case .running, .notRunning: "exclamationmark.triangle"
    }
  }

  /// The folder to show: dj-sync's live answer, else what's saved locally.
  var downloadDir: String? { status?.downloadDir ?? settings.downloadDir() }

  func display(_ path: String) -> String { abbreviatingHome(path, home: home) }

  /// Why a folder might not work for a background service, if it might not.
  func caution(for path: String) -> String? {
    protectedLocation(of: path, home: home)
  }

  /// The folder's real Finder icon (custom icons, colour tags and all).
  func icon(forPath path: String) -> NSImage {
    if let cached = iconCache[path] { return cached }
    let icon = NSWorkspace.shared.icon(forFile: path)
    iconCache[path] = icon
    return icon
  }

  func refresh() async {
    service = await client.fetch().map(ServiceState.running) ?? .notRunning
    toolbox = status == nil ? nil : await toolboxClient.fetch()
    await refreshLinks()
  }

  /// A Telegram link is waiting for the DJ to tap Start.
  var pairingTelegram: Bool {
    links.contains { $0.assistant == .telegram && !$0.isConnected && !$0.pairingExpired() }
  }

  /// `/local/links` asks the cloud, so at most every 15 s unless forced
  /// (every 3 s while a Telegram pairing is pending, for a live check).
  func refreshLinks(force: Bool = false) async {
    guard let s = status, s.cloud.enabled, s.cloud.registered != false else { return }
    let interval: TimeInterval = pairingTelegram ? 3 : 15
    if !force, let at = linksFetchedAt, Date().timeIntervalSince(at) < interval { return }
    linksFetchedAt = Date()
    if case .success(let list) = await linksClient.list() {
      links = list
    }
  }

  // MARK: Assistants

  /// A link for `assistant`, reusing one this Mac already holds. Connector
  /// URLs (ChatGPT, Claude) are copied; Telegram shows a QR code to scan; the
  /// iPhone gets a ready-made Shortcut behind a QR code.
  @discardableResult
  func connect(_ assistant: Assistant) async -> AssistantLink? {
    linksBusy = true
    defer { linksBusy = false }
    actionError = nil
    if let existing = links.first(where: { usable($0, for: assistant) }) {
      announce(existing, for: assistant)
      if assistant == .iphone { prepareShortcut(existing) }
      return existing
    }
    switch await linksClient.create(assistant) {
    case .success(let link):
      links.append(link)
      announce(link, for: assistant)
      if assistant == .iphone { prepareShortcut(link) }
      await refreshLinks(force: true)
      return links.first { $0.id == link.id } ?? link
    case .failure(let f):
      actionError =
        f.code == "telegram_not_configured"
        ? "Telegram isn't available yet. Try ChatGPT, Claude or the iPhone Shortcut for now."
        : "Couldn't connect \(assistant.name): \(f.message)"
      return nil
    }
  }

  private func usable(_ link: AssistantLink, for assistant: Assistant) -> Bool {
    guard link.assistant == assistant else { return false }
    switch assistant {
    case .telegram: return link.url != nil && !link.pairingExpired()
    case .iphone: return link.token != nil && link.apiUrl != nil
    default: return link.url != nil
    }
  }

  private func announce(_ link: AssistantLink, for assistant: Assistant) {
    switch assistant {
    case .telegram:
      note("Scan the code with your phone, then tap Start in Telegram.")
    case .iphone:
      note("Scan the code with your iPhone camera, then tap Add Shortcut.")
    default:
      guard let url = link.url else { return }
      copy(url, key: link.id)
      note("Copied \(assistant.name)'s URL. \(assistant.steps.joined(separator: " "))")
    }
  }

  /// A fresh Telegram pairing code. Unpairs a paired chat, so that asks first.
  func newTelegramCode(_ link: AssistantLink) {
    if link.isConnected {
      let alert = NSAlert()
      alert.messageText = "Pair a different Telegram chat?"
      alert.informativeText = "\(link.displayName) stops working with DJ Sync right away. Scan the new code to pair again."
      alert.addButton(withTitle: "New Code")
      alert.addButton(withTitle: "Cancel")
      NSApp.activate()
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    Task {
      linksBusy = true
      defer { linksBusy = false }
      switch await linksClient.rotate(link.id) {
      case .success:
        note("New code ready. Scan it with your phone.")
        await refreshLinks(force: true)
      case .failure(let f):
        actionError = "Couldn't make a new code: \(f.message)"
      }
    }
  }

  /// Build, sign and upload this link's Shortcut, then show its QR code.
  func prepareShortcut(_ link: AssistantLink) {
    guard link.assistant == .iphone, shortcutSetups[link.id] != .preparing else { return }
    shortcutSetups[link.id] = .preparing
    Task {
      let result = await linksClient.installShortcut(link.id)
      shortcutSetups[link.id] = ShortcutSetup.from(result)
    }
  }

  func openGuide(_ assistant: Assistant) {
    NSWorkspace.shared.open(assistant.guideURL)
  }

  func open(_ url: String) {
    guard let u = URL(string: url) else { return }
    NSWorkspace.shared.open(u)
  }

  /// A new URL (or Shortcut key); the old one stops working at once.
  func rotate(_ link: AssistantLink) {
    let isKey = link.assistant == .iphone
    let thing = isKey ? "key" : "URL"
    let alert = NSAlert()
    alert.messageText = "Make a new \(thing) for \(link.displayName)?"
    alert.informativeText = "The current \(thing) stops working right away. Put the new one into \(isKey ? "your Shortcut" : link.displayName) to keep using DJ Sync there."
    alert.addButton(withTitle: isKey ? "New Key" : "New URL")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate()
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    Task {
      linksBusy = true
      defer { linksBusy = false }
      switch await linksClient.rotate(link.id) {
      case .success(let new):
        if isKey {
          // The old Shortcut has the old key baked in: offer a fresh one.
          shortcutSetups[new.id] = nil
          prepareShortcut(new)
          note("New key made. Scan the new code on your iPhone to replace the Shortcut.")
        } else {
          if let url = new.url { copy(url, key: new.id) }
          note("New URL copied. Paste it into \(link.displayName).")
        }
        await refreshLinks(force: true)
      case .failure(let f):
        actionError = "Couldn't make a new URL: \(f.message)"
      }
    }
  }

  func disconnect(_ link: AssistantLink) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Disconnect \(link.displayName)?"
    alert.informativeText =
      link.assistant == .telegram
      ? "The bot stops answering that chat right away. You can pair again later."
      : "It stops working with DJ Sync right away. You can connect it again later."
    alert.addButton(withTitle: "Disconnect")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate()
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    Task {
      linksBusy = true
      defer { linksBusy = false }
      switch await linksClient.delete(link.id) {
      case .success:
        links.removeAll { $0.id == link.id }
        shortcutSetups[link.id] = nil
        await refreshLinks(force: true)
      case .failure(let f):
        actionError = "Couldn't disconnect: \(f.message)"
      }
    }
  }

  func show(error: String) {
    actionError = error
  }

  private func note(_ text: String) {
    actionNote = text
    Task {
      try? await Task.sleep(for: .seconds(8))
      if actionNote == text { actionNote = nil }
    }
  }

  // MARK: Tools

  func repairTools() {
    Task {
      if await toolboxClient.install() {
        toolbox = await toolboxClient.fetch()
      } else {
        actionError = "Couldn't reach dj-sync to repair its tools."
      }
    }
  }

  // MARK: Updates

  func checkForUpdates(manual: Bool) {
    guard update != .checking, update != .installing else { return }
    if !manual, let last = lastUpdateCheck, Date().timeIntervalSince(last) < 20 * 3600 { return }
    update = .checking
    Task {
      let result = await UpdateFeed().check(currentVersion: appVersion)
      lastUpdateCheck = Date()
      switch result {
      case .upToDate: update = .upToDate(Date())
      case .available(let release): update = .available(release)
      case .failed(let why): update = manual ? .failed(why) : .idle
      }
    }
  }

  func installUpdate(_ release: Appcast.Release) {
    update = .installing
    Task {
      let app = Bundle.main.bundleURL
      do {
        _ = try await UpdateInstaller.install(
          release, over: app, bundleID: Bundle.main.bundleIdentifier ?? "com.triplejmusic.dj-sync.menu")
        relaunch(app)
      } catch UpdateError.notWritable {
        NSWorkspace.shared.open(release.dmgUrl.flatMap(URL.init(string:)) ?? UpdateFeed.latestDMG)
        update = .available(release)
      } catch {
        update = .failed(error.localizedDescription)
      }
    }
  }

  /// Open the (new) app once this process has quit.
  private func relaunch(_ app: URL) {
    let process = Process()
    process.executableURL = URL(filePath: "/bin/sh")
    process.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", app.path(percentEncoded: false)]
    try? process.run()
    NSApp.terminate(nil)
  }

  // MARK: Diagnostics

  func copyDiagnostics() {
    Task {
      let toolbox = await toolboxClient.fetch()
      let os = ProcessInfo.processInfo.operatingSystemVersion
      var info = utsname()
      uname(&info)
      let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
      let text = Diagnostics.report(
        .init(
          appVersion: appVersion,
          serviceVersion: status?.version,
          macOS: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
          chip: machine == "arm64" ? "Apple silicon" : "Intel (\(machine))",
          status: status,
          toolbox: toolbox,
          links: links,
          logLines: Diagnostics.warningLines(fromLog: Self.logURL)))
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
      note("Diagnostics copied, with secrets masked. Paste them into your message to support.")
    }
  }

  // MARK: Rekordbox library

  /// Restore a backup of Rekordbox's library, after an explicit confirmation.
  func restoreBackup(_ backup: ServiceStatus.Library.Backup) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Restore your Rekordbox library to v\(backup.version)?"
    let when = backup.date.map { " from \($0.formatted(date: .abbreviated, time: .shortened))" } ?? ""
    alert.informativeText = """
      This puts back the backup\(when): “\(backup.reason)”.

      Your current library is backed up first, so you can undo this from the same list. \
      Keep Rekordbox closed until it finishes.
      """
    alert.addButton(withTitle: "Restore")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate()
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    runLibraryAction { await $0.restore(version: backup.version) }
  }

  func applyLibraryNow() {
    runLibraryAction { await $0.applyNow() }
  }

  func retryFailedChanges() {
    runLibraryAction { await $0.retryFailed() }
  }

  func dismissFailedChanges() {
    runLibraryAction { await $0.dismissFailed() }
  }

  private func runLibraryAction(_ action: @escaping (LibraryClient) async -> LibraryClient.Reply) {
    libraryBusy = true
    actionError = nil
    Task {
      let reply = await action(library)
      if !reply.ok {
        actionError = reply.error ?? "That didn't work."
      }
      await refresh()
      libraryBusy = false
    }
  }

  func copy(_ text: String, key: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    copied = key
    Task {
      try? await Task.sleep(for: .seconds(1.5))
      if copied == key { copied = nil }
    }
  }

  // MARK: Downloads folder

  func chooseFolder() {
    let panel = NSOpenPanel()
    panel.title = "Choose where DJ Sync saves downloads"
    panel.prompt = "Use This Folder"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    if let current = downloadDir {
      panel.directoryURL = URL(filePath: current, directoryHint: .isDirectory)
    }
    // A menu bar app isn't frontmost; bring the panel to the front.
    NSApp.activate()
    guard panel.runModal() == .OK, let url = panel.url else { return }
    save(url.path(percentEncoded: false))
  }

  func useDefaultFolder() {
    save(nil)
  }

  private func save(_ path: String?) {
    do {
      try settings.setDownloadDir(path)
      actionError = nil
    } catch {
      actionError = "Couldn't save the folder: \(error.localizedDescription)"
    }
    Task { await refresh() }
  }

  func revealDownloads() {
    guard let dir = downloadDir else { return }
    NSWorkspace.shared.open(URL(filePath: dir, directoryHint: .isDirectory))
  }

  func revealXML() {
    guard let xml = status?.importXml else { return }
    NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: xml)])
  }

  // MARK: Service

  /// Restart dj-sync, or start it if its LaunchAgent isn't loaded.
  func restartService() {
    guard !isRestarting else { return }
    isRestarting = true
    actionError = nil
    Task {
      let target = "gui/\(getuid())/\(Self.serviceLabel)"
      var code = await launchctl(["kickstart", "-k", target])
      if code != 0 {
        // Not loaded (e.g. after `launchctl bootout`): load it, which starts it.
        code = await launchctl(["bootstrap", "gui/\(getuid())", Self.agentPlist.path(percentEncoded: false)])
      }
      if code != 0 {
        actionError = "Couldn't start dj-sync (launchctl exit \(code)). See the log."
      }
      try? await Task.sleep(for: .seconds(1.5))
      await refresh()
      isRestarting = false
    }
  }

  func openLog() {
    NSWorkspace.shared.open(Self.logURL)
  }

  // MARK: Launch at login

  var opensAtLogin: Bool {
    get { SMAppService.mainApp.status == .enabled }
    set {
      do {
        if newValue {
          try SMAppService.mainApp.register()
        } else {
          try SMAppService.mainApp.unregister()
        }
        actionError = nil
      } catch {
        actionError = "Couldn't change Open at Login: \(error.localizedDescription)"
      }
    }
  }
}

/// Run `launchctl` without blocking the main actor; returns its exit status.
nonisolated private func launchctl(_ arguments: [String]) async -> Int32 {
  await withCheckedContinuation { continuation in
    let process = Process()
    process.executableURL = URL(filePath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
    do {
      try process.run()
    } catch {
      continuation.resume(returning: -1)
    }
  }
}
