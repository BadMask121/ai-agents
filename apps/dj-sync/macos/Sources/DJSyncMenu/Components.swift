import AppKit
import DJSyncCore
import SwiftUI

// Shared by the panel and the onboarding window.

struct AppGlyph: View {
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

struct Card<Accessory: View, Content: View>: View {
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
struct PathRow: View {
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

struct Badge: View {
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

struct Banner: View {
  enum Tone {
    case warning
    case success
  }

  let text: String
  var tone: Tone = .warning
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Label {
      Text(text).fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: tone == .warning ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
    }
    .font(.caption)
    .foregroundStyle(tint)
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tint.opacity(0.12), in: .rect(cornerRadius: 7, style: .continuous))
    .transition(.enter(reduceMotion))
  }

  private var tint: Color { tone == .warning ? .orange : .green }
}

struct IconButton: View {
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
struct PressableStyle: ButtonStyle {
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

// MARK: - Telegram pairing

/// A QR code drawn crisp at any size, dark on white (so it scans in dark
/// mode too).
struct QRCodeView: View {
  let text: String
  var size: CGFloat = 112

  var body: some View {
    Group {
      if let image = QRCode.image(for: text) {
        Image(decorative: image, scale: 1)
          .interpolation(.none)
          .resizable()
          .aspectRatio(1, contentMode: .fit)
      } else {
        Image(systemName: "qrcode").font(.largeTitle).foregroundStyle(.secondary)
      }
    }
    .padding(8)
    .frame(width: size, height: size)
    .background(.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(.black.opacity(0.08), lineWidth: 0.5)
    }
    .accessibilityLabel("QR code to pair Telegram")
  }
}

/// Scan-to-pair for a Telegram link that isn't paired yet: the QR code of
/// its `t.me` deep link, Open Telegram, New code, and the code's expiry.
struct TelegramPairing: View {
  let link: AssistantLink
  var busy = false
  let open: (String) -> Void
  let newCode: () -> Void

  var body: some View {
    if let url = link.url {
      TimelineView(.periodic(from: .now, by: 15)) { context in
        let expired = link.pairingExpired(now: context.date)
        HStack(alignment: .top, spacing: 12) {
          QRCodeView(text: url)
            .opacity(expired ? 0.25 : 1)
            .overlay {
              if expired {
                Image(systemName: "clock.badge.xmark").font(.title2).foregroundStyle(.secondary)
              }
            }
          VStack(alignment: .leading, spacing: 6) {
            Text(expired ? "This code has expired." : "Scan with your phone's camera, then tap Start in Telegram.")
              .font(.caption)
              .fixedSize(horizontal: false, vertical: true)
            if !expired {
              Button("Open Telegram") { open(url) }
                .controlSize(.small)
                .help("Opens the DJ Sync bot in Telegram on this Mac")
            }
            Button(expired ? "Get a New Code" : "New Code", action: newCode)
              .controlSize(.small)
              .disabled(busy)
            if let note = expiryNote(now: context.date) {
              Text(note)
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
          Spacer(minLength: 0)
        }
        .animation(.easeOut(duration: 0.2), value: expired)
      }
    } else {
      HStack(spacing: 8) {
        Text("Paired from another Mac or before a reinstall.")
          .font(.caption)
          .foregroundStyle(.tertiary)
        Button("New Code", action: newCode).controlSize(.small).disabled(busy)
      }
    }
  }

  private func expiryNote(now: Date) -> String? {
    guard let expires = link.expires, expires > now else { return nil }
    let minutes = Int((expires.timeIntervalSince(now) / 60).rounded(.up))
    return minutes <= 1 ? "Expires in under a minute" : "Expires in \(minutes) min"
  }
}

