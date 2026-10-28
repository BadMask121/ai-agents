import AppKit
import DJSyncCore
import SwiftUI

/// The DJ Sync panel: one compact 372 pt column, used both in the popover
/// under the menu bar icon and in the window shown when the app is opened.
/// Motion is limited to state changes; opening the panel is instant because
/// it happens many times a day.
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
      if let jobs = model.status?.recentJobs, !jobs.isEmpty {
        RecentCard(jobs: Array(jobs.prefix(3)))
          .transition(.enter(reduceMotion))
      }
      // Tools only show up when they're being set up or need repair.
      ToolsNotice(model: model)
      AssistantsCard(model: model)
      DownloadsCard(model: model)
      RekordboxCard(model: model)
      AboutCard(model: model)
      if let note = model.actionNote {
        Banner(text: note, tone: .success)
      }
      if let error = model.actionError {
        Banner(text: error)
      }
      FooterActions(model: model)
        .padding(.top, 2)
    }
    .padding(16)
    .padding(.top, topInset)
    .frame(width: 372)
    .fixedSize(horizontal: false, vertical: true)
    .animation(.easeOut(duration: 0.2), value: model.service)
    .animation(.easeOut(duration: 0.2), value: model.actionError)
    .animation(.easeOut(duration: 0.2), value: model.actionNote)
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
    case .running(let s):
      switch (s.cloud.enabled, s.cloud.connected) {
      case (false, _): "Running · cloud off"
      case (true, true?): "Running · connected to the cloud"
      case (true, false?): "Running · cloud not reachable yet"
      case (true, nil): "Running · v\(s.version)"
      }
    }
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

// MARK: - Assistants

private struct AssistantsCard: View {
  @Bindable var model: MenuModel

  var body: some View {
    Card(title: "Assistants", systemImage: "sparkles") {
      if model.links.contains(where: { $0.url != nil || $0.token != nil }) {
        IconButton(
          systemImage: model.revealSecrets ? "eye.slash" : "eye",
          label: model.revealSecrets ? "Hide the private URLs and keys" : "Show the private URLs and keys"
        ) {
          model.revealSecrets.toggle()
        }
        .padding(.vertical, -6)
      }
    } content: {
      if model.links.isEmpty {
        Text("Connect one, then ask for tracks or playlist changes from your phone, even while this Mac sleeps.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      ForEach(model.links) { link in
        switch link.assistant {
        case .telegram: TelegramRow(link: link, model: model)
        case .iphone: ShortcutRow(link: link, model: model)
        default: LinkRow(link: link, model: model)
        }
      }
      let missing = Assistant.allCases.filter { a in !model.links.contains { $0.assistant == a } }
      if !missing.isEmpty {
        ConnectGrid(assistants: missing, model: model)
      }
      if let s = model.status, s.cloud.enabled {
        CloudLine(connected: s.cloud.connected)
      }
    }
  }
}

/// "Connect …" buttons, two to a row, each with what it costs.
private struct ConnectGrid: View {
  let assistants: [Assistant]
  @Bindable var model: MenuModel

  var body: some View {
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
      ForEach(assistants) { assistant in
        Button {
          Task { await model.connect(assistant) }
        } label: {
          HStack(spacing: 5) {
            Image(systemName: "plus").font(.caption.weight(.semibold))
            Text(assistant.name)
            Spacer(minLength: 4)
            Text(assistant.cost)
              .font(.caption2)
              .foregroundStyle(assistant.cost == "Free" ? Color.green : Color.secondary)
          }
          .frame(maxWidth: .infinity)
        }
        .help("Connect \(assistant.name) (\(assistant.cost.lowercased()))")
      }
    }
    .controlSize(.small)
    .disabled(model.linksBusy || model.status?.cloud.registered == false)
  }
}

/// The dot, name, last use and the "…" menu every assistant row shares.
private struct LinkHeader<Trailing: View>: View {
  let link: AssistantLink
  let detail: String
  @Bindable var model: MenuModel
  var menu: [(String, () -> Void)] = []
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(link.isConnected ? Color.green : Color.orange)
        .frame(width: 6, height: 6)
      Text(link.displayName).font(.callout.weight(.medium)).lineLimit(1)
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 8)
      trailing
      Menu {
        ForEach(Array(menu.enumerated()), id: \.offset) { _, item in
          Button(item.0, action: item.1)
        }
        if let assistant = link.assistant {
          Button("Setup Guide") { model.openGuide(assistant) }
        }
        Divider()
        Button("Disconnect…", role: .destructive) { model.disconnect(link) }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .help("More")
    }
  }
}

private func usage(_ link: AssistantLink) -> String {
  guard let used = link.lastUsed else { return "· not used yet" }
  return "· used " + used.formatted(.relative(presentation: .named))
}

/// A Copy button that confirms for a moment.
private struct CopyButton: View {
  let value: String
  let key: String
  var help = "Copy"
  @Bindable var model: MenuModel

  var body: some View {
    Button {
      model.copy(value, key: key)
    } label: {
      Label(model.copied == key ? "Copied" : "Copy", systemImage: model.copied == key ? "checkmark" : "doc.on.doc")
        .font(.caption)
        .contentTransition(.symbolEffect(.replace))
    }
    .buttonStyle(.borderless)
    .foregroundStyle(model.copied == key ? Color.green : Color.accentColor)
    .help(help)
  }
}

/// ChatGPT and Claude: a connector (MCP) URL to paste in.
private struct LinkRow: View {
  let link: AssistantLink
  @Bindable var model: MenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      LinkHeader(link: link, detail: usage(link), model: model, menu: [("New URL…", { model.rotate(link) })]) {
        if let url = link.url {
          CopyButton(value: url, key: link.id, help: "Copy this assistant's private URL", model: model)
        }
      }
      HStack(spacing: 8) {
        if let url = link.url {
          Text(model.revealSecrets ? url : maskingSecretPath(url))
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        } else {
          Text("Made on another Mac or before a reinstall: choose New URL to get one here.")
            .font(.caption)
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 4)
        if let assistant = link.assistant {
          GuideLink(assistant: assistant, model: model)
        }
      }
      .padding(.leading, 12)
    }
    .animation(.easeOut(duration: 0.15), value: model.copied)
  }
}

private struct GuideLink: View {
  let assistant: Assistant
  @Bindable var model: MenuModel

  var body: some View {
    Button("Setup guide") { model.openGuide(assistant) }
      .buttonStyle(.link)
      .font(.caption)
      .fixedSize()
      .help("How to set up \(assistant.name), on djsync.jeffrey.build")
  }
}

/// Telegram: scan-to-pair until a chat is paired, then just the chat.
private struct TelegramRow: View {
  let link: AssistantLink
  @Bindable var model: MenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LinkHeader(
        link: link,
        detail: link.isConnected ? "· paired" : "· waiting for Start",
        model: model,
        menu: [("New Code…", { model.newTelegramCode(link) })]
      ) {
        EmptyView()
      }
      if link.isConnected {
        HStack(spacing: 8) {
          Text("Send the bot Spotify or YouTube links, or /playlists.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 4)
          GuideLink(assistant: .telegram, model: model)
        }
        .padding(.leading, 12)
      } else {
        TelegramPairing(
          link: link, busy: model.linksBusy,
          open: { model.open($0) }, newCode: { model.newTelegramCode(link) }
        )
        .padding(.leading, 12)
        .transition(.opacity)
      }
    }
    .animation(.easeOut(duration: 0.2), value: link.isConnected)
  }
}

/// The iPhone Share-sheet Shortcut: an API URL and a bearer key.
private struct ShortcutRow: View {
  let link: AssistantLink
  @Bindable var model: MenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      LinkHeader(link: link, detail: usage(link), model: model, menu: [("New Key…", { model.rotate(link) })]) {
        EmptyView()
      }
      if let api = link.apiUrl, let token = link.token {
        field("URL", shown: api, value: api, key: "\(link.id).url")
        field(
          "Key", shown: model.revealSecrets ? token : String(token.prefix(4)) + "…",
          value: token, key: "\(link.id).key")
        HStack {
          Text("Build the Shortcut on your iPhone with these.")
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer(minLength: 4)
          GuideLink(assistant: .iphone, model: model)
        }
        .padding(.leading, 12)
      } else {
        Text("Made on another Mac or before a reinstall: choose New Key to get one here.")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.leading, 12)
      }
    }
    .animation(.easeOut(duration: 0.15), value: model.copied)
  }

  private func field(_ title: String, shown: String, value: String, key: String) -> some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(width: 28, alignment: .leading)
      Text(shown)
        .font(.caption.monospaced())
        .lineLimit(1)
        .truncationMode(.middle)
        .textSelection(.enabled)
      Spacer(minLength: 4)
      CopyButton(value: value, key: key, help: "Copy the \(title.lowercased()) for the Shortcut", model: model)
    }
    .padding(.leading, 12)
  }
}

private struct CloudLine: View {
  let connected: Bool?

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(tint).frame(width: 6, height: 6)
      Text(text)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var tint: Color {
    switch connected {
    case true?: .green
    case false?: .orange
    case nil: .secondary
    }
  }

  private var text: String {
    switch connected {
    case true?: "Connected to DJ Sync cloud: requests arrive instantly."
    case false?: "Not connected right now. Requests wait in the cloud until this Mac is back."
    case nil: "Cloud queue on."
    }
  }
}

// MARK: - Tools

/// Nothing while the tools are fine; a compact card while they're being
/// installed, or when one needs repair.
private struct ToolsNotice: View {
  @Bindable var model: MenuModel

  var body: some View {
    if let report = model.toolbox, report.installing || !report.allReady {
      Card(title: "Tools", systemImage: "wrench.and.screwdriver") {
        Badge(
          text: report.installing ? "Installing" : "Needs repair",
          tint: report.installing ? .accentColor : .orange)
      } content: {
        if report.installing {
          VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: report.progress ?? 0)
            Text(report.step ?? "Installing…")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        } else {
          if let error = report.error {
            Banner(text: error)
          } else {
            Text("Missing: \(report.all.filter { !$0.ready }.map(\.name).joined(separator: ", "))")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          Button("Repair Tools", action: model.repairTools)
            .controlSize(.small)
        }
      }
      .transition(.opacity)
    }
  }
}

// MARK: - About

private struct AboutCard: View {
  @Bindable var model: MenuModel

  var body: some View {
    Card(title: "About", systemImage: "info.circle") {
      Badge(text: "v\(model.appVersion)", tint: .secondary, monospaced: true)
    } content: {
      HStack(spacing: 8) {
        Text(updateText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .contentTransition(.opacity)
        Spacer(minLength: 8)
        if case .available(let release) = model.update {
          Button("Update to \(release.version)") { model.installUpdate(release) }
            .buttonStyle(.borderedProminent)
        } else {
          Button("Check for Updates") { model.checkForUpdates(manual: true) }
            .disabled(model.update == .checking || model.update == .installing)
        }
      }
      .controlSize(.small)
      Button("Copy Diagnostics", action: model.copyDiagnostics)
        .buttonStyle(.borderless)
        .font(.caption)
        .help("Versions, tool states and recent errors, with every secret masked, for support")
    }
  }

  private var updateText: String {
    switch model.update {
    case .idle: "DJ Sync checks for updates once a day."
    case .checking: "Checking for updates…"
    case .upToDate(let at): "Up to date · checked \(at.formatted(.relative(presentation: .named)))"
    case .available(let r): "DJ Sync \(r.version) is available."
    case .installing: "Installing the update… DJ Sync restarts when it's done."
    case .failed(let why): "Couldn't check for updates: \(why)"
    }
  }
}
