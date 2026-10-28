/// `/Users/me/Music/DJ` → `~/Music/DJ` for display.
public func abbreviatingHome(_ path: String, home: String) -> String {
  if path == home { return "~" }
  let prefix = home.hasSuffix("/") ? home : home + "/"
  return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
}

/// dj-sync runs as a background LaunchAgent, and macOS privacy controls (TCC)
/// block background processes from these places unless they've been granted
/// access. Returns a short name for the place, or `nil` if the folder is fine.
public func protectedLocation(of path: String, home: String) -> String? {
  let places: [(String, String)] = [
    (home + "/Desktop", "your Desktop"),
    (home + "/Documents", "Documents"),
    (home + "/Downloads", "Downloads"),
    (home + "/Library/Mobile Documents", "iCloud Drive"),
    ("/Volumes", "an external or network drive"),
  ]
  for (root, name) in places where path == root || path.hasPrefix(root + "/") {
    return name
  }
  return nil
}
