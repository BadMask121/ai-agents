import AppKit

// Pure AppKit entry point: the menu bar icon, popover and window are all
// owned by AppDelegate, so there is no SwiftUI `App` (and no stray Settings
// window). LSUIElement in Info.plist keeps it out of the Dock.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
