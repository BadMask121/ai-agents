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

  private static let autosaveName = "DJSyncStatusItem"

  func applicationDidFinishLaunching(_ notification: Notification) {
    installStatusItem()
    // Login-item launches happen right after boot; stay in the menu bar then.
    if ProcessInfo.processInfo.systemUptime > 300 {
      showWindow()
    }
  }

  /// Opening the app again while it's running (Finder, Spotlight, `open`).
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
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
    // Half-width single column under the menu bar; it follows its content's size.
    let hosting = NSHostingController(rootView: MenuView(model: model, layout: .compact))
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

  // MARK: Window

  func showWindow() {
    checkPlacement()
    if window == nil {
      // The wide two-column panel, edge to edge under a transparent title bar.
      let hosting = NSHostingController(rootView: MenuView(model: model, layout: .wide, topInset: 16))
      hosting.sizingOptions = [.preferredContentSize]
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
