import DJSyncCore
import SwiftUI

struct MenuView: View {
  @Bindable var model: MenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      Divider()
      downloadsSection
      Divider()
      rekordboxSection
      if let jobs = model.status?.recentJobs, !jobs.isEmpty {
        Divider()
        recentSection(jobs)
      }
      Divider()
      footer
    }
    .padding(14)
    .frame(width: 320)
    // Poll while the panel is open; SwiftUI cancels this when it closes.
    .task {
      while !Task.isCancelled {
        await model.refresh()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private var header: some View {
    HStack {
      Text("DJ Sync").font(.headline)
      Spacer()
      switch model.service {
      case .checking:
        ProgressView().controlSize(.small)
      case .notRunning:
        Label("Not running", systemImage: "circle.fill")
          .foregroundStyle(.red)
          .font(.caption)
      case .running(let s):
        Label("Running · v\(s.version)", systemImage: "circle.fill")
          .foregroundStyle(.green)
          .font(.caption)
      }
    }
    .labelStyle(StatusDotLabelStyle())
  }

  private var downloadsSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Downloads folder").font(.subheadline).foregroundStyle(.secondary)
      if let dir = model.downloadDir {
        Text(model.display(dir))
          .font(.system(.body, design: .monospaced))
          .lineLimit(2)
          .truncationMode(.middle)
          .textSelection(.enabled)
        if let s = model.status {
          Text(s.usesCustomFolder ? "Chosen here" : "dj-sync default")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      } else {
        Text("Start dj-sync to see the folder.").foregroundStyle(.secondary)
      }

      HStack {
        Button("Change…", action: model.chooseFolder)
        Button("Show in Finder", action: model.revealDownloads)
          .disabled(model.downloadDir == nil)
        if model.status?.usesCustomFolder == true {
          Button("Use Default", action: model.useDefaultFolder)
        }
      }
      .controlSize(.small)

      folderWarning
      Text("New downloads go here from the next job on. Files already downloaded stay where they are.")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var folderWarning: some View {
    if let s = model.status, !s.downloadDirWritable {
      warning(s.downloadDirError ?? "dj-sync can't write to this folder.")
    } else if let dir = model.downloadDir, let place = model.caution(for: dir) {
      warning(
        "macOS may block the background service from saving to \(place). If downloads fail, pick a folder in ~/Music."
      )
    }
  }

  private func warning(_ text: String) -> some View {
    Label(text, systemImage: "exclamationmark.triangle.fill")
      .font(.caption)
      .foregroundStyle(.orange)
      .fixedSize(horizontal: false, vertical: true)
  }

  private var rekordboxSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("Rekordbox XML").font(.subheadline).foregroundStyle(.secondary)
        Spacer()
        if let v = model.status?.xmlVersion {
          Text("v\(v)").font(.caption.monospaced()).foregroundStyle(.secondary)
        }
      }
      if let s = model.status {
        Text(model.display(s.importXml))
          .font(.system(.caption, design: .monospaced))
          .lineLimit(2)
          .truncationMode(.middle)
        Button("Show in Finder", action: model.revealXML).controlSize(.small)
      }
    }
  }

  private func recentSection(_ jobs: [ServiceStatus.Job]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Recent").font(.subheadline).foregroundStyle(.secondary)
      ForEach(jobs) { job in
        HStack(spacing: 6) {
          Image(systemName: symbol(for: job.state))
            .foregroundStyle(job.state == "failed" ? .red : .secondary)
          Text(job.playlist).lineLimit(1)
          Spacer()
          Text(job.state).font(.caption).foregroundStyle(.secondary)
        }
        .help(job.message)
      }
    }
  }

  private func symbol(for state: String) -> String {
    switch state {
    case "done": "checkmark.circle"
    case "failed": "xmark.octagon"
    case "running": "arrow.down.circle"
    default: "clock"
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let error = model.actionError {
        warning(error)
      }
      Toggle("Open at Login", isOn: $model.opensAtLogin)
        .toggleStyle(.checkbox)
      HStack {
        Button("Restart Service", action: model.restartService)
        Button("Open Log", action: model.openLog)
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }
      }
      .controlSize(.small)
    }
  }
}

/// A small coloured dot before the text, instead of a full-size icon.
private struct StatusDotLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) {
      configuration.icon.font(.system(size: 7))
      configuration.title
    }
  }
}
