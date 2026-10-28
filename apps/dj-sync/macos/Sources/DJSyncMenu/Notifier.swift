import DJSyncCore
import Foundation
import UserNotifications

/// Posts macOS notifications for download requests and results. Users tune
/// or mute them in System Settings → Notifications → DJ Sync.
final class Notifier: NSObject {
  private let center = UNUserNotificationCenter.current()
  /// Called when a notification is clicked.
  var onOpen: () -> Void = {}

  static let auditLog = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: ".dj-sync/notifications.log")

  func start() {
    center.delegate = self
    Task {
      _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
  }

  func post(_ event: JobEvent) {
    let content = UNMutableNotificationContent()
    let (job, kind): (ServiceStatus.Job, String)
    switch event {
    case .requested(let j):
      (job, kind) = (j, "requested")
      content.title = "New download request"
      content.body = "\(count(j.links, "link")) → “\(j.playlist)”"
    case .finished(let j):
      (job, kind) = (j, "finished")
      content.title = "Added to Rekordbox"
      content.body =
        "\(count(j.tracks, "track")) in “\(j.playlist)”"
        + (j.xmlVersion.map { " · XML v\($0)" } ?? "")
    case .failed(let j):
      (job, kind) = (j, "failed")
      content.title = "Download failed"
      content.body = "“\(j.playlist)”: " + String(j.message.prefix(160))
    }
    content.sound = .default
    content.threadIdentifier = job.jobId  // a job's notifications group together
    center.add(UNNotificationRequest(identifier: "\(job.jobId)-\(kind)", content: content, trigger: nil))
    audit(kind, id: job.jobId, label: job.playlist)
  }

  /// dj-sync wrote to Rekordbox's own library (after Rekordbox closed).
  func postLibrary(_ applied: ServiceStatus.Library.Applied) {
    let content = UNMutableNotificationContent()
    content.title = "Rekordbox library updated"
    content.body = applied.summary + (applied.version.map { " · v\($0)" } ?? "")
    content.sound = .default
    center.add(UNNotificationRequest(identifier: "library-\(applied.at)", content: content, trigger: nil))
    audit("library", id: applied.version.map { "v\($0)" } ?? "-", label: applied.summary)
  }

  /// "1 link", "3 tracks"; just "Links" when an older dj-sync didn't say.
  private func count(_ n: Int?, _ noun: String) -> String {
    guard let n else { return noun.capitalized + "s" }
    return "\(n) \(noun)\(n == 1 ? "" : "s")"
  }

  /// One line per notification, for "did it notify me?" troubleshooting.
  private func audit(_ kind: String, id: String, label: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(kind) \(id) \(label)\n"
    guard let data = line.data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: Self.auditLog) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: Self.auditLog)
    }
  }
}

extension Notifier: UNUserNotificationCenterDelegate {
  /// Show banners even while DJ Sync's window is in front.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    await MainActor.run { onOpen() }
  }
}
