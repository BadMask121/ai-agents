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

  /// Cloud queue Worker health; `nil` when unreachable or the lane is off.
  private(set) var cloud: CloudHealth?
  private(set) var tunnel: TunnelConfig?
  private(set) var tunnelRunning: Bool?
  /// Which URL was just copied, for a moment of "Copied" feedback.
  private(set) var copied: String?
  /// MCP URLs contain the secret path; masked unless the user asks.
  var revealSecrets = false
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
    if let s = status, s.cloud.enabled {
      cloud = await CloudHealth.fetch(baseURL: s.cloud.baseUrl)
    } else {
      cloud = nil
    }
    tunnel = TunnelConfig.load()
    let state = await launchctlOutput(["print", "gui/\(getuid())/com.cloudflare.cloudflared"])
    tunnelRunning = state.map { $0.contains("state = running") }
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

/// `launchctl` output, or `nil` if it failed (e.g. the job isn't loaded).
nonisolated private func launchctlOutput(_ arguments: [String]) async -> String? {
  await withCheckedContinuation { continuation in
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(filePath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { process in
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      continuation.resume(
        returning: process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil)
    }
    do {
      try process.run()
    } catch {
      continuation.resume(returning: nil)
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
