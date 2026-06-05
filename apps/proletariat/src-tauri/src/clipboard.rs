use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext, RustImageData};

#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    #[error("image decode failed: {0}")]
    Decode(#[from] image::ImageError),
}

/// Decode PNG bytes into (width, height, RGBA8 pixels). Pure + unit-tested.
pub fn png_to_rgba(png_bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), ClipboardError> {
    let img = image::load_from_memory(png_bytes)?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok((w, h, img.into_raw()))
}

/// Put the composite image AND (if non-empty) the message as editable plain
/// text on the system clipboard, in one operation, so both are available when
/// pasting into Claude. `arboard` can only set one format at a time, so we use
/// `clipboard-rs`, which writes multiple `ClipboardContent` formats at once.
pub fn set_clipboard_image_and_text(png_bytes: &[u8], text: &str) -> Result<(), String> {
    // Validate the PNG decodes first so we surface a clear error early.
    png_to_rgba(png_bytes).map_err(|e| e.to_string())?;

    let image = RustImageData::from_bytes(png_bytes).map_err(|e| e.to_string())?;
    let mut contents = vec![ClipboardContent::Image(image)];
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        contents.push(ClipboardContent::Text(trimmed.to_string()));
    }

    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    ctx.set(contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    #[test]
    fn round_trips_a_known_image() {
        // Build a 2x1 image: red pixel, green pixel.
        let mut img = image::RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(1, 0, image::Rgba([0, 255, 0, 255]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(img.as_raw(), 2, 1, image::ExtendedColorType::Rgba8)
            .unwrap();

        let (w, h, rgba) = png_to_rgba(&png).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 255, 0, 255]);
    }
}
