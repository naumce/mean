//! Grabbing the screen, for questions that are easier to show than to say.
//!
//! A code sample, a diagram, an error dialog — the fastest way to ask about
//! any of them is to point at them. This captures the whole screen in one
//! click rather than asking for a region: a second step costs more attention
//! mid-call than the ambiguity saves, and the models this feeds read a
//! full-resolution screen without needing to be aimed.
//!
//! JPEG rather than PNG because a screenshot goes over the network on its way
//! into a request, and a PNG of a 1080p desktop is several megabytes where the
//! JPEG is a few hundred kilobytes with no difference the model can see.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use std::io::Cursor;

use crate::llm::Image;

/// Quality for the encoded screenshot.
///
/// High enough that small text stays legible, which is the whole point when
/// the screen holds a code sample or a stack trace.
const QUALITY: u8 = 85;

/// Captures the primary monitor as a JPEG, ready to attach to a question.
pub fn primary() -> Result<Image> {
    let monitors = xcap::Monitor::all().context("could not enumerate monitors")?;

    // The primary monitor is where a shared window almost always is. Falling
    // back to the first found means a machine that reports no primary still
    // captures something rather than failing.
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| anyhow!("no monitor found to capture"))?;

    let frame = monitor
        .capture_image()
        .context("could not capture the screen")?;

    encode(frame)
}

fn encode(frame: image::RgbaImage) -> Result<Image> {
    // JPEG has no alpha channel, so the RGBA frame is flattened first rather
    // than letting the encoder reject it.
    let opaque = image::DynamicImage::ImageRgba8(frame).to_rgb8();

    let mut bytes = Cursor::new(Vec::new());
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, QUALITY);

    encoder
        .encode(
            opaque.as_raw(),
            opaque.width(),
            opaque.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("could not encode the screenshot")?;

    Ok(Image {
        media_type: "image/jpeg".into(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encoding is testable without a screen; capture is not.
    #[test]
    fn a_frame_encodes_to_base64_jpeg() {
        let frame = image::RgbaImage::from_pixel(
            16,
            16,
            image::Rgba([120, 90, 200, 255]),
        );

        let image = encode(frame).expect("should encode");

        assert_eq!(image.media_type, "image/jpeg");
        assert!(!image.base64.is_empty());

        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&image.base64)
            .expect("should be valid base64");

        // JPEG's magic number. Catches an encoder that silently wrote
        // something else, which would be rejected by the API rather than here.
        assert_eq!(&decoded[..2], &[0xFF, 0xD8], "not a JPEG");
    }

    /// A transparent frame must still encode — JPEG has no alpha channel, so
    /// the flattening step is load-bearing rather than tidiness.
    #[test]
    fn a_frame_with_transparency_still_encodes() {
        let frame =
            image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 20, 30, 0]));
        assert!(encode(frame).is_ok());
    }
}
