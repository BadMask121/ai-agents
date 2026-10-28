import AppKit
import DJSyncCore
import Observation
import SwiftUI

/// First-run setup (spec §1): tools → Rekordbox → connect an assistant.
/// Resumable: it shows again until finished or skipped.
@Observable
final class OnboardingModel {
  var step: OnboardingStep = .tools
  private(set) var toolbox: ToolboxReport?
  private(set) var status: ServiceStatus?
  let rekordbox = RekordboxInstall.detect()

  enum Baseline: Equatable {
    case waiting
    case working
    case done(String)
    case later(String)
  }
  private(set) var baseline: Baseline = .waiting

  private(set) var assistant: Assistant?
  private(set) var link: AssistantLink?
  private(set) var connecting = false
  private(set) var error: String?
  private(set) var copied = false

  let menu: MenuModel
  @ObservationIgnored var onFinish: () -> Void = {}
  private let statusClient = StatusClient()
  private let toolboxClient = ToolboxClient()
  private let linksClient = LinksClient()
  private let library = LibraryClient()

  init(menu: MenuModel) {
    self.menu = menu
  }

  var toolsReady: Bool { toolbox?.allReady == true }
  var connected: Bool { link?.isConnected == true }

  /// Keeps the window live while it's open (SwiftUI cancels it on close).
  func poll() async {
    while !Task.isCancelled {
      status = await statusClient.fetch()
      toolbox = status == nil ? nil : await toolboxClient.fetch()
      if step == .rekordbox, baseline == .waiting, status?.rekordboxDb != nil {
        await takeBaseline()
      }
      if step == .assistant, let id = link?.id, !connected,
        case .success(let links) = await linksClient.list()
      {
        link = links.first { $0.id == id } ?? link
      }
      try? await Task.sleep(for: .seconds(2))
    }
  }

  func advance() {
    error = nil
    if let next = step.next {
      step = next
    } else {
      finish()
    }
  }

  func repairTools() {
    Task { _ = await toolboxClient.install() }
  }

  private func takeBaseline() async {
    baseline = .working
    let reply = await library.takeBaseline()
    baseline = reply.ok ? .done(reply.version ?? "1.0.0") : .later(reply.error ?? "Rekordbox is open.")
  }

  func choose(_ assistant: Assistant) {
    self.assistant = assistant
    error = nil
    Task {
      connecting = true
      defer { connecting = false }
      if let link = await menu.connect(assistant) {
        self.link = link
        copied = true
      } else {
        error = menu.actionError ?? "Couldn't make a link. Is this Mac online?"
      }
    }
  }

  func copyLink() {
    guard let url = link?.url else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(url, forType: .string)
    copied = true
  }

  func finish() {
    try? SettingsFile.standard.setOnboarded(true)
    onFinish()
  }
}

struct OnboardingView: View {
  @Bindable var model: OnboardingModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 10) {
        AppGlyph()
        VStack(alignment: .leading, spacing: 2) {
          Text("Welcome to DJ Sync").font(.headline)
          Text("Step \(model.step.rawValue + 1) of 3 · \(model.step.title)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .contentTransition(.opacity)
        }
        Spacer(minLength: 0)
        StepDots(current: model.step)
      }

      Group {
        switch model.step {
        case .tools: ToolsStep(model: model)
        case .rekordbox: RekordboxStep(model: model)
        case .assistant: AssistantStep(model: model)
        }
      }
      .transition(.enter(reduceMotion))
      .id(model.step)

      if let error = model.error {
        Banner(text: error)
      }

      HStack(spacing: 8) {
        if model.step == .assistant {
          Button(model.connected ? "Done" : "Skip for Now", action: model.finish)
            .keyboardShortcut(model.connected ? .defaultAction : .cancelAction)
            .buttonStyle(model.connected ? AnyButtonStyle(.borderedProminent) : AnyButtonStyle(.bordered))
        } else {
          Spacer(minLength: 0)
          if model.step == .tools && !model.toolsReady && model.toolbox?.error != nil {
            Button("Continue Anyway", action: model.advance)
          }
          Button("Continue", action: model.advance)
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
            .disabled(model.step == .tools && !model.toolsReady)
        }
        if model.step == .assistant { Spacer(minLength: 0) }
      }
      .controlSize(.large)
    }
    .padding(20)
    .padding(.top, 12)
    .frame(width: 372)
    .fixedSize(horizontal: false, vertical: true)
    .animation(.easeOut(duration: 0.2), value: model.step)
    .animation(.easeOut(duration: 0.2), value: model.connected)
    .task { await model.poll() }
  }
}

private struct StepDots: View {
  let current: OnboardingStep

  var body: some View {
    HStack(spacing: 5) {
      ForEach(OnboardingStep.allCases, id: \.self) { step in
        Capsule()
          .fill(step <= current ? Color.accentColor : Color.secondary.opacity(0.3))
          .frame(width: step == current ? 14 : 6, height: 6)
      }
    }
    .accessibilityHidden(true)
  }
}

private struct ToolsStep: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    Card(title: "Tools", systemImage: "wrench.and.screwdriver") {
      if model.toolsReady { Badge(text: "Ready", tint: .green) }
    } content: {
      Text("DJ Sync downloads the free tools it uses (yt-dlp, spotdl, ffmpeg) from their official sources and keeps them up to date. About 250 MB, once.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if let report = model.toolbox {
        if report.installing || !report.allReady {
          ProgressView(value: report.installing ? (report.progress ?? 0) : (report.allReady ? 1 : 0))
          Text(report.step ?? (report.allReady ? "All set." : "Starting…"))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 3) {
          ForEach(report.all) { tool in
            HStack(spacing: 6) {
              Image(systemName: tool.ready ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(tool.ready ? .green : .secondary)
              Text(tool.name)
              Spacer(minLength: 8)
              Text(tool.displayVersion ?? "…")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
            .font(.callout)
          }
        }
        if let error = report.error, !report.installing, !report.allReady {
          Banner(text: error)
          Button("Try Again", action: model.repairTools)
            .controlSize(.small)
        }
      } else {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Starting DJ Sync's background service…")
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }
    }
  }
}

private struct RekordboxStep: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    Card(title: "Rekordbox", systemImage: "square.stack.3d.up") {
      if let r = model.rekordbox {
        Badge(text: r.version.map { "\(r.name) · \($0)" } ?? r.name, tint: .purple)
      }
    } content: {
      if model.rekordbox == nil && model.status?.rekordboxDb == nil {
        Text("Rekordbox isn't installed here. DJ Sync still saves your songs and writes a rekordbox xml file; install Rekordbox any time and they'll show up.")
          .font(.callout)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("New songs and playlist changes go straight into your Rekordbox library (a DJ Sync folder in Playlists). With Rekordbox open, they appear under rekordbox xml and land in the library when you quit it.")
          .font(.callout)
          .fixedSize(horizontal: false, vertical: true)
        BaselineLine(baseline: model.baseline)
      }
    }
    Card(title: "Downloads", systemImage: "arrow.down.circle") {
      EmptyView()
    } content: {
      if let dir = model.menu.downloadDir ?? model.status?.downloadDir {
        PathRow(
          icon: model.menu.icon(forPath: dir),
          title: (dir as NSString).lastPathComponent,
          subtitle: model.menu.display((dir as NSString).deletingLastPathComponent),
          help: "Show in Finder",
          action: model.menu.revealDownloads)
      }
      Button("Change Folder…", action: model.menu.chooseFolder)
        .controlSize(.small)
    }
  }
}

private struct BaselineLine: View {
  let baseline: OnboardingModel.Baseline

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      switch baseline {
      case .waiting, .working:
        ProgressView().controlSize(.mini)
        Text("Backing up your library…")
      case .done(let version):
        Image(systemName: "checkmark.shield.fill").foregroundStyle(.green)
        Text("Backed up as v\(version). Every change is backed up first; restore any time from the menu.")
      case .later:
        Image(systemName: "clock.fill").foregroundStyle(.orange)
        Text("Rekordbox is open, so DJ Sync will back up your library before its first change. Restore any time from the menu.")
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct AssistantStep: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    Card(title: "Assistant", systemImage: "sparkles") {
      EmptyView()
    } content: {
      Text("Pick where you'll ask for tracks. DJ Sync gives it a private link to this Mac. It works from your phone too, even while this Mac is asleep. Telegram and Claude are free; ChatGPT needs a paid plan.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        ForEach(Assistant.onboarding) { assistant in
          Button {
            model.choose(assistant)
          } label: {
            Text(assistant.name).frame(maxWidth: .infinity)
          }
          .buttonStyle(model.assistant == assistant ? AnyButtonStyle(.borderedProminent) : AnyButtonStyle(.bordered))
          .controlSize(.large)
          .disabled(model.connecting)
        }
      }
    }
    if let assistant = model.assistant, assistant == .telegram {
      Card(title: "Pair Telegram", systemImage: "paperplane") {
        EmptyView()
      } content: {
        if let link = model.link {
          TelegramPairing(
            link: link, busy: model.connecting,
            open: { url in if let u = URL(string: url) { NSWorkspace.shared.open(u) } },
            newCode: { model.menu.newTelegramCode(link) }
          )
          LiveCheck(connected: model.connected, assistant: assistant)
        } else {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Making your pairing code…").font(.callout).foregroundStyle(.secondary)
          }
        }
      }
    } else if let assistant = model.assistant {
      Card(title: "Paste this into \(assistant.name)", systemImage: "link") {
        EmptyView()
      } content: {
        if let url = model.link?.url {
          HStack(spacing: 8) {
            Text(maskingSecretPath(url))
              .font(.caption.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 8)
            Button(model.copied ? "Copied" : "Copy URL", action: model.copyLink)
              .controlSize(.small)
          }
          VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(assistant.steps.enumerated()), id: \.offset) { i, step in
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(i + 1).").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(step).font(.caption).fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          LiveCheck(connected: model.connected, assistant: assistant)
        } else {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Making your private link…").font(.callout).foregroundStyle(.secondary)
          }
        }
      }
    }
  }
}

private struct LiveCheck: View {
  let connected: Bool
  let assistant: Assistant

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      if connected {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        Text("Connected. Try: “\(assistant.example)”")
      } else {
        ProgressView().controlSize(.mini)
        Text(
          assistant == .telegram
            ? "Waiting for you to tap Start in Telegram…" : "Waiting for \(assistant.name) to connect…")
      }
    }
    .font(.caption)
    .foregroundStyle(connected ? .primary : .secondary)
    .fixedSize(horizontal: false, vertical: true)
    .contentTransition(.opacity)
  }
}

/// Switch button styles without changing the view's type.
struct AnyButtonStyle: PrimitiveButtonStyle {
  private let make: (Configuration) -> AnyView

  init<S: PrimitiveButtonStyle>(_ style: S) {
    make = { AnyView(style.makeBody(configuration: $0)) }
  }

  func makeBody(configuration: Configuration) -> some View {
    make(configuration)
  }
}
