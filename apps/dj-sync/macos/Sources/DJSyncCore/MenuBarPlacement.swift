import Foundation

public enum MenuBarIconVisibility: Equatable, Sendable, CustomStringConvertible {
  case unknown
  case visible
  case hidden(reason: String)

  public var description: String {
    switch self {
    case .unknown: "unknown"
    case .visible: "visible"
    case .hidden(let reason): "hidden: \(reason)"
    }
  }
}

/// Where the menu bar icon ended up, in screen points. Notched MacBooks only
/// have room for icons to the right of the notch; when the bar is full, the
/// leftmost icons slide behind it.
public struct MenuBarPlacement: Sendable, Equatable {
  public var itemMinX: Double
  public var itemWidth: Double
  public var screenWidth: Double
  /// Widths of the usable menu bar either side of the notch (`nil` = no notch).
  public var leftAreaWidth: Double?
  public var rightAreaWidth: Double?
  /// Not trusted on its own: also true while the menu bar auto-hides (e.g.
  /// in a full-screen app). Reported for troubleshooting only.
  public var occluded: Bool
  public var userHidden: Bool

  public init(
    itemMinX: Double, itemWidth: Double, screenWidth: Double,
    leftAreaWidth: Double?, rightAreaWidth: Double?, occluded: Bool, userHidden: Bool
  ) {
    self.itemMinX = itemMinX
    self.itemWidth = itemWidth
    self.screenWidth = screenWidth
    self.leftAreaWidth = leftAreaWidth
    self.rightAreaWidth = rightAreaWidth
    self.occluded = occluded
    self.userHidden = userHidden
  }

  public var underNotch: Bool {
    guard let left = leftAreaWidth, let right = rightAreaWidth else { return false }
    let notchStart = left
    let notchEnd = screenWidth - right
    return itemMinX + itemWidth > notchStart && itemMinX < notchEnd
  }

  public var offScreen: Bool { itemMinX < 0 || itemMinX >= screenWidth }

  public var visibility: MenuBarIconVisibility {
    if userHidden {
      .hidden(reason: "The DJ Sync icon was removed from the menu bar.")
    } else if underNotch {
      .hidden(reason: "Your menu bar is full, so macOS put the DJ Sync icon behind the notch.")
    } else if offScreen {
      .hidden(reason: "Your menu bar is full, so macOS hid the DJ Sync icon.")
    } else {
      .visible
    }
  }

  /// A small JSON report (`~/.dj-sync/menu-bar.json`) for troubleshooting.
  public func write(to url: URL) {
    let report: [String: Any] = [
      "visible": visibility == .visible,
      "occluded": occluded,
      "status": visibility.description,
      "item_x": itemMinX,
      "item_width": itemWidth,
      "screen_width": screenWidth,
      "notch": leftAreaWidth.map { left in [left, screenWidth - (rightAreaWidth ?? 0)] } ?? [],
      "checked_at": ISO8601DateFormatter().string(from: Date()),
    ]
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    else { return }
    try? data.write(to: url, options: .atomic)
  }
}
