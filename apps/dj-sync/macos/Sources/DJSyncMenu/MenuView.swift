import AppKit
import DJSyncCore
import SwiftUI

/// The panel shown from the menu bar icon, and in a window when the app is
/// opened directly. Motion is limited to state changes; opening the panel is
/// instant because it happens many times a day.
/// The DJ Sync panel: one compact 340 pt column, used both in the popover
/// under the menu bar icon and in the window shown when the app is opened.
struct MenuView: View {
  @Bindable var model: MenuModel
  /// Extra top space under a transparent window title bar.
  var topInset: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Header(service: model.service)
      // Only in the window: from the popover, the icon is obviously visible.
      if topInset > 0, case .hidden(let reason) = model.menuBarIcon {
        HiddenIconCard(reason: reason)
          .transition(.enter(reduceMotion))
      }
      if case .notRunning = model.service {
        NotRunningCard(isStarting: model.isRestarting, start: model.restartService)
          .transition(.enter(reduceMotion))
      }
      DownloadsCard(model: model)
      RekordboxCard(model: model)
      ConnectionsCard(model: model)
      if let jobs = model.status?.recentJobs, !jobs.isEmpty {
        RecentCard(jobs: Array(jobs.prefix(3)))
          .transition(.enter(reduceMotion))
      }
      FooterActions(model: model)
        .padding(.top, 2)
      if let error = model.actionError {
        Banner(text: error)
      }
    }
    .padding(16)
    .padding(.top, topInset)
    .frame(width: 372)
    .fixedSize(horizontal: false, vertical: true)
    .animation(.easeOut(duration: 0.2), value: model.service)
    .animation(.easeOut(duration: 0.2), value: model.actionError)
    .animation(.easeOut(duration: 0.2), value: model.menuBarIcon)
    // Poll while visible; SwiftUI cancels this when the panel closes.
    .task {
      while !Task.isCancelled {
        await model.refresh()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }
}

// MARK: - Header

private struct Header: View {
  let service: ServiceState

  var body: some View {
    HStack(spacing: 10) {
      AppGlyph()
      VStack(alignment: .leading, spacing: 2) {
        Text("DJ Sync").font(.headline)
        HStack(spacing: 5) {
          Circle()
            .fill(dotColor)
            .frame(width: 6, height: 6)
          Text(statusText)
            .font(.caption)
            .foregroundStyle(.secondary)
            .contentTransition(.opacity)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }

  private var dotColor: Color {
    switch service {
    case .checking: .secondary
    case .notRunning: .red
    case .running: .green
    }
  }

  private var statusText: String {
    switch service {
    case .checking: "Checking…"
    case .notRunning: "Not running"
    case .running(let s): "Running · v\(s.version)" + (s.cloud.enabled ? " · Cloud queue on" : "")
    }
  }
}

private struct AppGlyph: View {
  var body: some View {
    RoundedRectangle(cornerRadius: 8, style: .continuous)
      .fill(
        LinearGradient(
          colors: [Color(red: 0.55, green: 0.36, blue: 0.97), Color(red: 0.94, green: 0.30, blue: 0.60)],
          startPoint: .topLeading, endPoint: .bottomTrailing)
      )
      .frame(width: 34, height: 34)
      .overlay {
        Image(systemName: "music.note.list")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white)
      }
      .overlay {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(.white.opacity(0.18), lineWidth: 0.5)
      }
      .shadow(color: .black.opacity(0.12), radius: 1.5, y: 1)
      .accessibilityHidden(true)
  }
}

// MARK: - Cards

private struct NotRunningCard: View {
  let isStarting: Bool
  let start: () -> Void

  var body: some View {
    Card(title: "Service", systemImage: "bolt.horizontal.circle") {
      EmptyView()
    } content: {
      Text("dj-sync isn't running. Downloads you request wait in the cloud queue until it's back.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Button(action: start) {
        HStack(spacing: 6) {
          if isStarting { ProgressView().controlSize(.mini) }
          Text(isStarting ? "Starting…" : "Start dj-sync")
        }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .disabled(isStarting)
    }
  }
}

private struct HiddenIconCard: View {
  let reason: String

  var body: some View {
    Card(title: "Menu bar", systemImage: "menubar.rectangle") {
      EmptyView()
    } content: {
      Text(reason)
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
      Text("Hold ⌘ and drag other icons out of the menu bar to make room — DJ Sync sits next to the clock. Until then, open DJ Sync from Spotlight (⌘ Space, “DJ Sync”) to get this window.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct DownloadsCard: View {
  @Bindable var model: MenuModel

  var body: some View {
    Card(title: "Downloads", systemImage: "arrow.down.circle") {
      if let status = model.status {
        Badge(
          text: status.usesCustomFolder ? "Custom" : "Default",
          tint: status.usesCustomFolder ? .accentColor : .secondary)
      }
    } content: {
      if let dir = model.downloadDir {
        PathRow(
          icon: model.icon(forPath: dir),
          title: (dir as NSString).lastPathComponent,
          subtitle: model.display((dir as NSString).deletingLastPathComponent),
          help: "Show in Finder",
          action: model.revealDownloads)
      } else {
        Text("Start dj-sync to see where songs are saved.")
          .font(.callout)
          .foregroundStyle(.secondary)
      }

      if let warning = folderWarning {
        Banner(text: warning)
      }

      HStack(spacing: 8) {
        Button("Change Folder…", action: model.chooseFolder)
          .buttonStyle(.borderedProminent)
          .help("New downloads go to the folder you pick. Songs already saved stay where they are.")
        if model.status?.usesCustomFolder == true {
          Button("Use Default", action: model.useDefaultFolder)
        }
        Spacer(minLength: 0)
      }
      .controlSize(.small)

      Text("Applies from the next download.")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var folderWarning: String? {
    if let s = model.status, !s.downloadDirWritable {
      return s.downloadDirError ?? "dj-sync can't write to this folder."
    }
    if let dir = model.downloadDir, let place = model.caution(for: dir) {
      return "macOS may block the background service from saving to \(place). If downloads fail, pick a folder in ~/Music."
    }
    return nil
  }
}

private struct RekordboxCard: View {
  @Bindable var model: MenuModel
  @State private var showBackups = false

  var body: some View {
    Card(title: "Rekordbox", systemImage: "square.stack.3d.up") {
      if let version = model.status?.rekordboxDb?.currentVersion {
        Badge(text: "Library v\(version)", tint: .purple, monospaced: true)
          .help("Semver of your Rekordbox library's latest backup")
      }
    } content: {
      if let library = model.status?.rekordboxDb {
        LibraryState(library: library)
        if !library.failed.isEmpty {
          ForEach(library.failed) { failed in
            Banner(text: "Couldn't apply “\(failed.summary)”: \(failed.error)")
          }
          HStack(spacing: 8) {
            Button("Retry", action: model.retryFailedChanges)
            Button("Dismiss", action: model.dismissFailedChanges)
          }
          .controlSize(.small)
          .disabled(model.libraryBusy)
        }
        if !library.pending.isEmpty, !library.rekordboxRunning {
          Button(model.libraryBusy ? "Applying…" : "Apply Now", action: model.applyLibraryNow)
            .controlSize(.small)
            .disabled(model.libraryBusy)
        }
        if !library.backups.isEmpty {
          DisclosureGroup(isExpanded: $showBackups) {
            VStack(spacing: 6) {
              ForEach(library.backups) { backup in
                BackupRow(
                  backup: backup,
                  isLatest: backup.id == library.backups.first?.id,
                  canRestore: !library.rekordboxRunning && !model.libraryBusy
                ) { model.restoreBackup(backup) }
              }
              if library.rekordboxRunning {
                Text("Quit Rekordbox to restore a backup.")
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
              }
            }
            .padding(.top, 6)
          } label: {
            Text("Backups (\(library.backups.count))")
              .font(.callout)
          }
        }
      }

      if let xml = model.status?.importXml {
        HStack(spacing: 6) {
          Image(systemName: "doc.text")
            .foregroundStyle(.secondary)
          Text("rekordbox xml" + (model.status?.xmlVersion.map { " · v\($0)" } ?? ""))
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer(minLength: 0)
          Button("Show", action: model.revealXML)
            .buttonStyle(.borderless)
            .font(.caption)
            .help(model.display(xml))
        }
      } else {
        Text("Shown when dj-sync is running.")
          .font(.callout)
          .foregroundStyle(.secondary)
      }
    }
  }
}

/// Where Rekordbox's own library stands: up to date, or changes waiting.
private struct LibraryState: View {
  let library: ServiceStatus.Library

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Circle().fill(tint).frame(width: 6, height: 6)
        Text(headline)
          .font(.callout)
          .fixedSize(horizontal: false, vertical: true)
          .contentTransition(.opacity)
      }
      if let detail {
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
          .padding(.leading, 12)
      }
    }
    .help(library.dbPath)
  }

  private var waiting: Int { library.pending.count }

  private var tint: Color {
    switch (waiting, library.rekordboxRunning) {
    case (0, _): .green
    case (_, true): .orange
    case (_, false): .accentColor
    }
  }

  private var headline: String {
    switch (waiting, library.rekordboxRunning) {
    case (0, true): "Up to date · Rekordbox is open"
    case (0, false): "Up to date"
    case (let n, true): "\(n) change\(n == 1 ? "" : "s") waiting — quit Rekordbox to apply"
    case (let n, false): "Applying \(n) change\(n == 1 ? "" : "s")…"
    }
  }

  private var detail: String? {
    if waiting > 0, let error = library.lastError {
      return "Last try failed: \(error)"
    }
    if waiting > 0 {
      return library.pending.map(\.summary).joined(separator: " · ")
    }
    if let last = library.lastApplied {
      let when = parseTimestamp(last.at).map {
        $0.formatted(.relative(presentation: .named))
      }
      return [last.summary, when].compactMap { $0 }.joined(separator: " · ")
    }
    return nil
  }
}

private struct BackupRow: View {
  let backup: ServiceStatus.Library.Backup
  let isLatest: Bool
  let canRestore: Bool
  let restore: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text("v\(backup.version)")
            .font(.caption.monospaced().weight(.semibold))
          if let date = backup.date {
            Text(date, format: .relative(presentation: .named))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          if isLatest {
            Badge(text: "Latest", tint: .secondary)
          }
        }
        Text(backup.reason)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 8)
      Button("Restore", action: restore)
        .controlSize(.small)
        .disabled(!canRestore)
    }
    .help(backup.reason)
  }
}

private struct ConnectionsCard: View {
  @Bindable var model: MenuModel

  var body: some View {
    Card(title: "Connections", systemImage: "network") {
      IconButton(
        systemImage: model.revealSecrets ? "eye.slash" : "eye",
        label: model.revealSecrets ? "Hide secret URLs" : "Show secret URLs"
      ) {
        model.revealSecrets.toggle()
      }
      .padding(.vertical, -6)
    } content: {
      if let mcp = model.status?.mcp {
        if let url = mcp.publicUrl {
          URLRow(
            title: "ChatGPT plugin (MCP)", url: url, reveal: model.revealSecrets,
            copied: model.copied == "public"
          ) { model.copy(url, key: "public") }
        }
        URLRow(
          title: "On this Mac (testing)", url: mcp.localUrl, reveal: model.revealSecrets,
          copied: model.copied == "local"
        ) { model.copy(mcp.localUrl, key: "local") }
      } else if model.status != nil {
        Text("Update dj-sync to 0.3 or later to see its URLs.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if let status = model.status, status.cloud.enabled {
        StatusRow(title: "Cloud queue", detail: hostOnly(status.cloud.baseUrl), state: cloudState)
      }
      StatusRow(title: "Tunnel", detail: tunnelDetail, state: tunnelState)
    }
  }

  private var cloudState: (Color, String) {
    guard let health = model.cloud else { return (.red, "Unreachable") }
    let queued = health.queued == 0 ? "Queue empty" : "\(health.queued) waiting"
    return health.agent.online
      ? (.green, "Mac online · \(queued) · Worker v\(health.version)")
      : (.orange, "Mac offline · \(queued)")
  }

  private var tunnelDetail: String {
    guard let t = model.tunnel else { return "Not configured" }
    let route = [t.hostname.map { "https://\($0)" }, t.service].compactMap { $0 }.joined(separator: " → ")
    return route.isEmpty ? String(t.tunnelId.prefix(8)) + "…" : route
  }

  private var tunnelState: (Color, String) {
    switch (model.tunnel, model.tunnelRunning) {
    case (nil, _): (.secondary, "Not set up")
    case (_, true?):
      model.status?.cloud.enabled == true
        ? (.green, "Running · standby (the cloud queue answers this hostname)")
        : (.green, "Running")
    case (_, false?), (_, nil): (.secondary, "Stopped")
    }
  }

  private func hostOnly(_ url: String) -> String {
    URL(string: url)?.host() ?? url
  }
}

/// A labelled URL, masked by default, with a Copy button that confirms.
private struct URLRow: View {
  let title: String
  let url: String
  let reveal: Bool
  let copied: Bool
  let copy: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(title).font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 8)
        Button(action: copy) {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            .font(.caption)
            .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.borderless)
        .foregroundStyle(copied ? Color.green : Color.accentColor)
        .help("Copy the full URL")
      }
      Text(reveal ? url : maskingSecretPath(url))
        .font(.caption.monospaced())
        .lineLimit(1)
        .truncationMode(.middle)
        .textSelection(.enabled)
        .contentTransition(.opacity)
    }
    .animation(.easeOut(duration: 0.15), value: copied)
    .animation(.easeOut(duration: 0.15), value: reveal)
  }
}

private struct StatusRow: View {
  let title: String
  let detail: String
  let state: (Color, String)

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 5) {
        Text(title).font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 8)
        Circle().fill(state.0).frame(width: 6, height: 6)
        Text(state.1)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .contentTransition(.opacity)
      }
      Text(detail)
        .font(.caption.monospaced())
        .lineLimit(1)
        .truncationMode(.middle)
        .textSelection(.enabled)
    }
    .help(state.1)
  }
}

private struct RecentCard: View {
  let jobs: [ServiceStatus.Job]

  var body: some View {
    Card(title: "Recent", systemImage: "clock") {
      EmptyView()
    } content: {
      VStack(spacing: 6) {
        ForEach(jobs) { job in
          JobRow(job: job)
        }
      }
    }
  }
}

private struct JobRow: View {
  let job: ServiceStatus.Job

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: symbol)
        .foregroundStyle(tint)
        .symbolEffect(.pulse, isActive: job.state == "running")
        .frame(width: 16)
      Text(job.playlist)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 8)
      Group {
        if job.state == "running" {
          Text("Downloading")
        } else if let date = job.date {
          Text(date, format: .relative(presentation: .named))
        } else {
          Text(job.state.capitalized)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .monospacedDigit()
    }
    .font(.callout)
    .help(job.message)
  }

  private var symbol: String {
    switch job.state {
    case "done": "checkmark.circle.fill"
    case "failed": "xmark.octagon.fill"
    case "running": "arrow.down.circle.fill"
    default: "clock.fill"
    }
  }

  private var tint: Color {
    switch job.state {
    case "done": .green
    case "failed": .red
    case "running": .accentColor
    default: .secondary
    }
  }
}

/// Open at Login on the left; Restart, Log and Quit on the right.
private struct FooterActions: View {
  @Bindable var model: MenuModel

  var body: some View {
    HStack(spacing: 4) {
      Toggle("Open at Login", isOn: $model.opensAtLogin)
        .toggleStyle(.switch)
        .controlSize(.mini)
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer(minLength: 0)
      IconButton(systemImage: "arrow.clockwise", label: "Restart dj-sync", busy: model.isRestarting) {
        model.restartService()
      }
      IconButton(systemImage: "doc.text.magnifyingglass", label: "Open Log") {
        model.openLog()
      }
      IconButton(systemImage: "power", label: "Quit DJ Sync") {
        NSApp.terminate(nil)
      }
    }
  }
}

// MARK: - Building blocks

private struct Card<Accessory: View, Content: View>: View {
  let title: String
  let systemImage: String
  @ViewBuilder var accessory: Accessory
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
        Text(title.uppercased())
          .font(.caption2.weight(.semibold))
          .tracking(0.6)
        Spacer(minLength: 8)
        accessory
      }
      .foregroundStyle(.secondary)
      content
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quaternary, in: .rect(cornerRadius: 10, style: .continuous))
  }
}

/// A file or folder: real Finder icon, name, parent path. Click to reveal.
private struct PathRow: View {
  let icon: NSImage
  let title: String
  let subtitle: String
  let help: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(nsImage: icon)
          .resizable()
          .frame(width: 32, height: 32)
        VStack(alignment: .leading, spacing: 1) {
          Text(title)
            .font(.body.weight(.medium))
            .lineLimit(1)
            .truncationMode(.middle)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
        }
        Spacer(minLength: 0)
        Image(systemName: "arrow.up.forward.app")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .opacity(hovering ? 1 : 0)
      }
      .padding(6)
      .background(
        Color.primary.opacity(hovering ? 0.06 : 0),
        in: .rect(cornerRadius: 8, style: .continuous))
      .contentShape(.rect)
    }
    .buttonStyle(PressableStyle())
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.15), value: hovering)
    .padding(-6)
    .help(help)
    .accessibilityLabel("\(title), \(subtitle)")
    .accessibilityHint(help)
  }
}

private struct Badge: View {
  let text: String
  let tint: Color
  var monospaced = false

  var body: some View {
    Text(text)
      .font(monospaced ? .caption2.monospaced().weight(.semibold) : .caption2.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(tint.opacity(0.14), in: .capsule)
      .contentTransition(.opacity)
  }
}

private struct Banner: View {
  let text: String
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Label {
      Text(text).fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill")
    }
    .font(.caption)
    .foregroundStyle(.orange)
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.orange.opacity(0.12), in: .rect(cornerRadius: 7, style: .continuous))
    .transition(.enter(reduceMotion))
  }
}

private struct IconButton: View {
  let systemImage: String
  let label: String
  var busy = false
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      ZStack {
        if busy {
          ProgressView().controlSize(.mini)
        } else {
          Image(systemName: systemImage)
            .font(.system(size: 12, weight: .medium))
        }
      }
      .frame(width: 26, height: 26)
      .background(
        Color.primary.opacity(hovering ? 0.08 : 0),
        in: .rect(cornerRadius: 6, style: .continuous))
      .contentShape(.rect)
    }
    .buttonStyle(PressableStyle(pressedScale: 0.92))
    .foregroundStyle(.secondary)
    .disabled(busy)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.15), value: hovering)
    .help(label)
    .accessibilityLabel(label)
  }
}

/// Subtle press feedback: the control visibly "hears" the click.
private struct PressableStyle: ButtonStyle {
  var pressedScale: CGFloat = 0.97
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed && !reduceMotion ? pressedScale : 1)
      .opacity(configuration.isPressed ? 0.8 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

extension AnyTransition {
  /// Fade in with a hint of scale from the top; just a fade with Reduce Motion.
  static func enter(_ reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98, anchor: .top))
  }
}
