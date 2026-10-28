import Foundation

/// The three onboarding steps (spec §1).
public enum OnboardingStep: Int, CaseIterable, Comparable, Sendable {
  case tools
  case rekordbox
  case assistant

  public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

  public var title: String {
    switch self {
    case .tools: "Install the tools"
    case .rekordbox: "Find Rekordbox"
    case .assistant: "Connect your assistant"
    }
  }

  public var next: OnboardingStep? { OnboardingStep(rawValue: rawValue + 1) }
}

public enum Onboarding {
  /// Show onboarding unless it was finished, or this Mac was already set up
  /// before onboarding existed (an assistant already connected, either a
  /// link or the original secret-path URL).
  public static func shouldShow(onboarded: Bool, status: ServiceStatus?, links: [AssistantLink]) -> Bool {
    if onboarded { return false }
    if status?.mcp?.publicUrl != nil { return false }
    if links.contains(where: \.isConnected) { return false }
    return true
  }
}

/// Rekordbox as installed on this Mac (for the onboarding's Rekordbox step).
public struct RekordboxInstall: Equatable, Sendable {
  public var name: String
  public var version: String?

  /// `/Applications/rekordbox 7/rekordbox.app`, `/Applications/rekordbox 6/…`
  /// or a top-level `rekordbox*.app`; the newest version wins.
  public static func detect(in applications: URL = URL(filePath: "/Applications")) -> RekordboxInstall? {
    let fm = FileManager.default
    var apps: [URL] = []
    for entry in (try? fm.contentsOfDirectory(at: applications, includingPropertiesForKeys: nil)) ?? [] {
      let name = entry.lastPathComponent.lowercased()
      guard name.hasPrefix("rekordbox") else { continue }
      if entry.pathExtension == "app" {
        apps.append(entry)
      } else {
        apps.append(contentsOf: ((try? fm.contentsOfDirectory(at: entry, includingPropertiesForKeys: nil)) ?? [])
          .filter { $0.pathExtension == "app" && $0.lastPathComponent.lowercased().hasPrefix("rekordbox") })
      }
    }
    let found = apps.compactMap { app -> RekordboxInstall? in
      let info = NSDictionary(contentsOf: app.appending(path: "Contents/Info.plist"))
      let version = info?["CFBundleShortVersionString"] as? String
      let major = version?.split(separator: ".").first.map(String.init)
      return RekordboxInstall(name: "Rekordbox" + (major.map { " \($0)" } ?? ""), version: version)
    }
    return found.max { ($0.version ?? "").compare($1.version ?? "", options: .numeric) == .orderedAscending }
  }
}
