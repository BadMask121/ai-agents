import Foundation

/// The text behind About → Copy diagnostics: enough to help a DJ, with every
/// secret, token and link path masked.
public enum Diagnostics {
  /// Long opaque runs (link secrets, tokens, the MCP secret path, hashes)
  /// keep their first four characters; `Bearer …` values go entirely.
  public static func mask(_ text: String) -> String {
    var out = text
    out = out.replacingOccurrences(
      of: #"(?i)(bearer\s+)\S+"#, with: "$1…", options: .regularExpression)
    // Telegram pairing codes (t.me/<bot>?start=<code>) are short but secret.
    out = out.replacingOccurrences(
      of: #"(?i)([?&]start=)[A-Za-z0-9_\-]+"#, with: "$1…", options: .regularExpression)
    out = out.replacingOccurrences(
      of: #"(?<![A-Za-z0-9_\-])([A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9_\-])"#,
      with: "$1…", options: .regularExpression)
    return out
  }

  public struct Input: Sendable {
    public var appVersion: String
    public var serviceVersion: String?
    public var macOS: String
    public var chip: String
    public var status: ServiceStatus?
    public var toolbox: ToolboxReport?
    public var links: [AssistantLink]
    public var logLines: [String]

    public init(
      appVersion: String, serviceVersion: String?, macOS: String, chip: String,
      status: ServiceStatus?, toolbox: ToolboxReport?, links: [AssistantLink], logLines: [String]
    ) {
      self.appVersion = appVersion
      self.serviceVersion = serviceVersion
      self.macOS = macOS
      self.chip = chip
      self.status = status
      self.toolbox = toolbox
      self.links = links
      self.logLines = logLines
    }
  }

  public static func report(_ i: Input) -> String {
    var lines = [
      "DJ Sync diagnostics · \(ISO8601DateFormatter().string(from: Date()))",
      "App \(i.appVersion) · service \(i.serviceVersion ?? "not running")",
      "macOS \(i.macOS) · \(i.chip)",
    ]
    if let s = i.status {
      lines.append(
        "Cloud: \(s.cloud.enabled ? "on" : "off")"
          + (s.cloud.protocol.map { " · protocol \($0)" } ?? "")
          + (s.cloud.connected.map { $0 ? " · connected" : " · not connected" } ?? ""))
      lines.append("Downloads: \(s.downloadDir) (\(s.downloadDirWritable ? "writable" : "NOT writable"))")
      lines.append("Import XML: \(s.importXml)" + (s.xmlVersion.map { " · v\($0)" } ?? ""))
      if let lib = s.rekordboxDb {
        lines.append(
          "Rekordbox library: v\(lib.currentVersion ?? "–") · \(lib.pending.count) pending · \(lib.failed.count) failed"
            + (lib.rekordboxRunning ? " · Rekordbox open" : ""))
        if let e = lib.lastError { lines.append("  last error: \(e)") }
      }
      for job in s.recentJobs.prefix(5) {
        lines.append("Job \(job.jobId) \(job.state): \(job.message)")
      }
    }
    if let t = i.toolbox {
      lines.append(
        "Tools: " + t.all.map { "\($0.name) \($0.displayVersion ?? "missing")\($0.ready ? "" : " (not ready)")" }
          .joined(separator: ", "))
      if let e = t.error { lines.append("  toolbox error: \(e)") }
      if let m = t.manifest { lines.append("  manifest: \(m)") }
    }
    lines.append(
      "Assistants: "
        + (i.links.isEmpty
          ? "none"
          : i.links.map { "\($0.displayName)\($0.isConnected ? " (used)" : " (not used yet)")" }
            .joined(separator: ", ")))
    lines.append("")
    lines.append("Recent warnings and errors:")
    lines.append(contentsOf: i.logLines.isEmpty ? ["(none)"] : i.logLines)
    return mask(lines.joined(separator: "\n"))
  }

  /// The last `limit` WARN/ERROR lines of dj-sync's log (reads the tail only).
  public static func warningLines(fromLog url: URL, limit: Int = 50, tailBytes: UInt64 = 512 * 1024) -> [String] {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? handle.close() }
    let size = (try? handle.seekToEnd()) ?? 0
    try? handle.seek(toOffset: size > tailBytes ? size - tailBytes : 0)
    let text = String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
    let hits = text.split(separator: "\n").filter { $0.contains(" WARN ") || $0.contains(" ERROR ") }
    return hits.suffix(limit).map(String.init)
  }
}
