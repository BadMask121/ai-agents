/// Something worth a notification.
public enum JobEvent: Equatable, Sendable {
  case requested(ServiceStatus.Job)
  case finished(ServiceStatus.Job)
  case failed(ServiceStatus.Job)
}

/// Turns successive `/local/status` job lists into events.
///
/// - The first snapshot only seeds what's known, so launching the app
///   doesn't replay old jobs.
/// - A job that's both new and already over by the next check produces one
///   event (finished or failed), not two in a row.
public struct JobWatcher: Sendable {
  private var known: [String: String]?

  public init() {}

  public mutating func update(_ jobs: [ServiceStatus.Job]) -> [JobEvent] {
    defer {
      known = Dictionary(jobs.map { ($0.jobId, $0.state) }, uniquingKeysWith: { first, _ in first })
    }
    guard let previous = known else { return [] }

    var events: [JobEvent] = []
    // Newest first from dj-sync; announce oldest first.
    for job in jobs.reversed() {
      let before = previous[job.jobId]
      switch job.state {
      case "done" where before != "done":
        events.append(.finished(job))
      case "failed" where before != "failed":
        events.append(.failed(job))
      case "queued" where before == nil, "running" where before == nil:
        events.append(.requested(job))
      default:
        break
      }
    }
    return events
  }
}
