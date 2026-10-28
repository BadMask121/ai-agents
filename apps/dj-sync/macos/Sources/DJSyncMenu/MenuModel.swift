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

  private let settings = SettingsFile.standard
  private let client = StatusClient()
  private let home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)

  static let serviceLabel = "com.triplejmusic.dj-sync"
  static let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Logs/dj-sync.log")

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

  func refresh() async {
    service = await client.fetch().map(ServiceState.running) ?? .notRunning
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

  func restartService() {
    let process = Process()
    process.executableURL = URL(filePath: "/bin/launchctl")
    process.arguments = ["kickstart", "-k", "gui/\(getuid())/\(Self.serviceLabel)"]
    do {
      try process.run()
      actionError = nil
    } catch {
      actionError = "Couldn't restart dj-sync: \(error.localizedDescription)"
    }
    Task {
      try? await Task.sleep(for: .seconds(2))
      await refresh()
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
