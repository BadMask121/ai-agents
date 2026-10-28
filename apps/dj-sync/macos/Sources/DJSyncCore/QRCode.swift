import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/// QR codes for pairing links (Telegram's `t.me/<bot>?start=<code>`).
public enum QRCode {
  /// One pixel per module, with no quiet zone of its own: draw it scaled up
  /// with interpolation off (crisp edges) on a white, padded background.
  public static func image(for text: String) -> CGImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    return CIContext().createCGImage(output, from: output.extent.integral)
  }
}
