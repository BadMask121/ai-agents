import AppKit
import DJSyncCore
import SwiftUI
import os

private let log = Logger(subsystem: "com.triplejmusic.dj-sync.menu", category: "app")

/// Owns the menu bar icon, its popover, and the standalone window.
///
/// An `NSStatusItem` (rather than SwiftUI's `MenuBarExtra`) so the icon can
/// be placed by the clock instead of leftmost — on a crowded notched MacBook
/// the leftmost icons disappear behind the notch.
final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = MenuModel()
  private var statusItem: NSStatusItem?
  private let popover = NSPopover()
  private var window: NSWindow?
  private var onboardingWindow: NSWindow?
  private let notifier = Notifier()
  private var watcher = JobWatcher()
  private var libraryWatcher = LibraryWatcher()

  private static let autosaveName = "DJSyncStatusItem"

  func applicationDidFinishLaunching(_ notification: Notification) {
    installStatusItem()
    startNotifications()
    Task { await startUp() }
  }

  /// Opening the app again while it's running (Finder, Spotlight, `open`).
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if SettingsFile.standard.onboarded() {
      showWindow()
    } else {
      showOnboarding()
    }
    return true
  }

  // MARK: Start-up

  /// Install (or update) the background service this app carries, then
  /// show onboarding on a fresh Mac, or the panel when opened by hand.
  private func startUp() async {
    // Where this app lives: dj-sync stops itself once it's been deleted.
    do {
      try SettingsFile.standard.recordAppPath(Bundle.main.bundleURL)
    } catch {
      log.error("couldn't record the app's path: \(error.localizedDescription, privacy: .public)")
    }
    let outcome = await ServiceInstaller().ensureInstalled()
    log.notice("service install: \(String(describing: outcome), privacy: .public)")
    if case .failed(let why) = outcome {
      model.show(error: "Couldn't start DJ Sync's background service: \(why)")
    }

    // Give a just-(re)started service a moment before deciding.
    var status: ServiceStatus?
    for _ in 0..<20 {
      status = await StatusClient().fetch()
      if status != nil { break }
      try? await Task.sleep(for: .seconds(1))
    }
    var links: [AssistantLink] = []
    if status?.cloud.registered == true, case .success(let list) = await LinksClient().list() {
      links = list
    }
    let settings = SettingsFile.standard
    if Onboarding.shouldShow(onboarded: settings.onboarded(), status: status, links: links) {
      showOnboarding()
    } else {
      // Set up before onboarding existed: don't ask again.
      if !settings.onboarded() { try? settings.setOnboarded(true) }
      // Login-item launches happen right after boot; stay in the menu bar then.
      if ProcessInfo.processInfo.systemUptime > 300 {
        showWindow()
      }
    }
    startUpdateChecks()
  }

  /// Daily, quietly; the About card has the manual check.
  private func startUpdateChecks() {
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(60))
      while !Task.isCancelled {
        self?.model.checkForUpdates(manual: false)
        try? await Task.sleep(for: .seconds(6 * 3600))
      }
    }
  }

  func showOnboarding() {
    if onboardingWindow == nil {
      let onboarding = OnboardingModel(menu: model)
      onboarding.onFinish = { [weak self] in
        self?.onboardingWindow?.close()
        self?.onboardingWindow = nil
        self?.showWindow()
      }
      // Default sizing (not .preferredContentSize): with a full-size content
      // view that loops on safe-area changes until AppKit throws.
      let hosting = NSHostingController(rootView: OnboardingView(model: onboarding))
      let window = NSWindow(contentViewController: hosting)
      window.title = "Welcome to DJ Sync"
      window.styleMask = [.titled, .closable, .fullSizeContentView]
      window.titlebarAppearsTransparent = true
      window.titleVisibility = .hidden
      window.isMovableByWindowBackground = true
      window.isReleasedWhenClosed = false
      window.center()
      onboardingWindow = window
    }
    NSApp.activate()
    onboardingWindow?.makeKeyAndOrderFront(nil)
  }

  // MARK: Menu bar icon

  private func installStatusItem() {
    // First run only: ask to sit just left of the clock and Control Centre.
    // Afterwards macOS remembers wherever the user ⌘-drags it.
    let positionKey = "NSStatusItem Preferred Position \(Self.autosaveName)"
    if UserDefaults.standard.object(forKey: positionKey) == nil {
      UserDefaults.standard.set(220, forKey: positionKey)
    }

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.autosaveName = Self.autosaveName
    item.button?.target = self
    item.button?.action = #selector(togglePopover)
    item.button?.setAccessibilityLabel("DJ Sync")
    statusItem = item
    updateIcon()

    // Opened many times a day: no open/close animation.
    popover.animates = false
    popover.behavior = .transient
    // Compact single column; the popover follows its content's size.
    let hosting = NSHostingController(rootView: MenuView(model: model))
    hosting.sizingOptions = [.preferredContentSize]
    popover.contentViewController = hosting

    // Check where the icon landed (again whenever screens change), so a
    // hidden icon can be explained in the window instead of just missing.
    Task {
      try? await Task.sleep(for: .seconds(1))
      checkPlacement()
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(screensChanged),
      name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  @objc private func screensChanged() {
    Task {
      try? await Task.sleep(for: .seconds(1))
      checkPlacement()
    }
  }

  /// Keep the icon in step with the model (warning triangle when unhealthy).
  private func updateIcon() {
    let symbol = withObservationTracking {
      model.menuBarSymbol
    } onChange: { [weak self] in
      Task { @MainActor in self?.updateIcon() }
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "DJ Sync")
    image?.isTemplate = true
    statusItem?.button?.image = image
  }

  @objc private func togglePopover() {
    guard let button = statusItem?.button else { return }
    if popover.isShown {
      popover.performClose(nil)
    } else {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
    }
  }

  private func checkPlacement() {
    guard let item = statusItem, let window = item.button?.window,
      let screen = window.screen ?? NSScreen.main
    else {
      model.menuBarIcon = .hidden(reason: "macOS didn't create the menu bar icon.")
      return
    }
    let placement = MenuBarPlacement(
      itemMinX: window.frame.minX,
      itemWidth: window.frame.width,
      screenWidth: screen.frame.width,
      leftAreaWidth: screen.auxiliaryTopLeftArea.map { Double($0.width) },
      rightAreaWidth: screen.auxiliaryTopRightArea.map { Double($0.width) },
      occluded: !window.occlusionState.contains(.visible),
      userHidden: !item.isVisible)
    model.menuBarIcon = placement.visibility
    placement.write(to: FileManager.default.homeDirectoryForCurrentUser
      .appending(path: ".dj-sync/menu-bar.json"))
    log.notice("menu bar icon: \(String(describing: placement.visibility), privacy: .public)")
  }

  // MARK: Notifications

  /// Watch dj-sync in the background (the panel's own polling only runs
  /// while it's open) and notify about new requests and finished jobs.
  private func startNotifications() {
    notifier.onOpen = { [weak self] in self?.showWindow() }
    notifier.start()
    Task { [weak self] in
      let client = StatusClient()
      while !Task.isCancelled {
        if let status = await client.fetch(), let self {
          for event in self.watcher.update(status.recentJobs) {
            self.notifier.post(event)
          }
          if let applied = self.libraryWatcher.update(status.rekordboxDb?.lastApplied) {
            self.notifier.postLibrary(applied)
          }
        }
        try? await Task.sleep(for: .seconds(4))
      }
    }
  }

  // MARK: Window

  func showWindow() {
    checkPlacement()
    if window == nil {
      // The same compact panel, edge to edge under a transparent title bar.
      // Default sizing (not .preferredContentSize): with a full-size content
      // view that loops on safe-area changes until AppKit throws.
      let hosting = NSHostingController(rootView: MenuView(model: model, topInset: 16))
      let window = NSWindow(contentViewController: hosting)
      window.title = "DJ Sync"
      window.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
      window.titlebarAppearsTransparent = true
      window.titleVisibility = .hidden
      window.isMovableByWindowBackground = true
      window.isReleasedWhenClosed = false
      window.center()
      self.window = window
    }
    NSApp.activate()
    window?.makeKeyAndOrderFront(nil)
  }
}
