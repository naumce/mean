//! Grabbing the screen, for questions that are easier to show than to say.
//!
//! A code sample, a diagram, an error dialog — the fastest way to ask about
//! any of them is to point at them. This captures a whole monitor in one click
//! rather than asking for a region: a second step costs more attention mid-call
//! than the ambiguity saves, and the models this feeds read a full-resolution
//! screen without needing to be aimed.
//!
//! Which monitor is the interesting question on a multi-screen desk, and the
//! obvious answer is wrong. Capturing the primary monitor photographs whichever
//! screen Windows was configured with, not the one you are looking at. Worse,
//! by the time you have clicked a button in this app, this app is the thing in
//! front — so the picture is of the copilot sitting on top of the very thing
//! you wanted read. See [`Target`].
//!
//! JPEG rather than PNG because a screenshot goes over the network on its way
//! into a request, and a PNG of a 1080p desktop is several megabytes where the
//! JPEG is a few hundred kilobytes with no difference the model can see.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;

use crate::llm::Image;

/// Quality for the encoded screenshot.
///
/// High enough that small text stays legible, which is the whole point when
/// the screen holds a code sample or a stack trace.
const QUALITY: u8 = 85;

/// Which screen a question is about.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Target {
    /// The monitor holding the window you were last actually using.
    ///
    /// The default, because it is right by construction and needs no decision.
    /// A dropdown asking which monitor is a question answered identically
    /// every time until the day a window moves and the saved answer is
    /// silently wrong.
    #[default]
    Active,
    /// A specific monitor, indexed into [`monitors`].
    ///
    /// For pinning the choice when following the active window is not what is
    /// wanted — a screen being shared, say, or one deliberately left alone.
    Monitor(usize),
}

/// A monitor, as the setup screen needs to describe it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    /// The manufacturer's name where one is reported, so the list reads
    /// "27G2G5" rather than "\\.\DISPLAY2".
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// Every monitor, in the order [`Target::Monitor`] indexes them.
pub fn monitors() -> Vec<MonitorInfo> {
    let Ok(found) = xcap::Monitor::all() else {
        return Vec::new();
    };

    found
        .iter()
        .enumerate()
        .map(|(index, monitor)| MonitorInfo {
            index,
            name: describe(monitor),
            width: monitor.width().unwrap_or(0),
            height: monitor.height().unwrap_or(0),
            primary: monitor.is_primary().unwrap_or(false),
        })
        .collect()
}

/// A screenshot, and which screen it came from.
///
/// The name travels with the picture on purpose. Following the active window
/// is a guess about intent, and a guess nobody can see is a guess nobody can
/// correct — being told the shot came from `27G2G5` is what turns "the answer
/// was about the wrong thing" into "it photographed the wrong screen".
pub struct Shot {
    pub image: Image,
    pub monitor: String,
}

/// Captures a screen as a JPEG, ready to attach to a question.
pub fn capture(target: Target) -> Result<Shot> {
    let monitors = xcap::Monitor::all().context("could not enumerate monitors")?;

    let monitor = match target {
        Target::Monitor(index) => monitors
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow!("there is no monitor {index}"))?,
        // Falling back rather than failing: not finding a window to follow is
        // ordinary — an empty desktop does it — and a screenshot of the wrong
        // screen is still worth more than an error where an answer should be.
        Target::Active => match active_monitor() {
            Some(monitor) => monitor,
            None => primary_monitor(&monitors)?,
        },
    };

    let name = describe(&monitor);
    let frame = monitor
        .capture_image()
        .context("could not capture the screen")?;

    Ok(Shot {
        image: encode(frame)?,
        monitor: name,
    })
}

fn describe(monitor: &xcap::Monitor) -> String {
    monitor
        .friendly_name()
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| monitor.name().ok())
        .unwrap_or_else(|| "unknown screen".into())
}

fn primary_monitor(monitors: &[xcap::Monitor]) -> Result<xcap::Monitor> {
    // Falling back to the first found means a machine reporting no primary
    // still captures something rather than failing.
    monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .cloned()
        .ok_or_else(|| anyhow!("no monitor found to capture"))
}

/// A window, reduced to what choosing between them needs.
///
/// Separating this from the enumeration is what makes the rule testable: the
/// interesting part is which window wins, and that should not require a
/// desktop, two monitors, and a person arranging them.
#[derive(Clone, Copy, Debug)]
struct Candidate {
    pid: u32,
    focused: bool,
    minimized: bool,
}

/// Picks the window a screenshot should follow, from a list ordered front to
/// back, and returns its position.
///
/// Our own windows never win. Pressing the screenshot button necessarily puts
/// this app in front, so counting it would mean every screenshot was a picture
/// of the copilot.
fn choose(candidates: &[Candidate], ours: u32) -> Option<usize> {
    let usable = |candidate: &&Candidate| candidate.pid != ours && !candidate.minimized;

    // Focus is the stronger signal where it exists: it survives an always-on-
    // top widget sitting in front of the window actually being used.
    candidates
        .iter()
        .position(|candidate| usable(&candidate) && candidate.focused)
        .or_else(|| candidates.iter().position(|c| usable(&c)))
}

/// The monitor holding the window last actually in use.
fn active_monitor() -> Option<xcap::Monitor> {
    let ours = std::process::id();
    // `Window::all` enumerates top-level windows in z order, frontmost first,
    // so position in this list is how far forward a window is.
    let windows = xcap::Window::all().ok()?;

    let candidates: Vec<Candidate> = windows
        .iter()
        .map(|window| Candidate {
            // A window whose owner cannot be determined is treated as ours, so
            // an unreadable window is skipped rather than photographed.
            pid: window.pid().unwrap_or(ours),
            focused: window.is_focused().unwrap_or(false),
            minimized: window.is_minimized().unwrap_or(true),
        })
        .collect();

    windows
        .get(choose(&candidates, ours)?)?
        .current_monitor()
        .ok()
}

fn encode(frame: image::RgbaImage) -> Result<Image> {
    // JPEG has no alpha channel, so the RGBA frame is flattened first rather
    // than letting the encoder reject it.
    let opaque = image::DynamicImage::ImageRgba8(frame).to_rgb8();

    let mut bytes = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, QUALITY);

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

    const OURS: u32 = 100;
    const THEIRS: u32 = 200;

    fn other() -> Candidate {
        Candidate {
            pid: THEIRS,
            focused: false,
            minimized: false,
        }
    }

    fn ours() -> Candidate {
        Candidate {
            pid: OURS,
            focused: false,
            minimized: false,
        }
    }

    fn focused(mut candidate: Candidate) -> Candidate {
        candidate.focused = true;
        candidate
    }

    fn minimized(mut candidate: Candidate) -> Candidate {
        candidate.minimized = true;
        candidate
    }

    #[test]
    fn the_focused_window_wins() {
        let windows = [other(), focused(other()), other()];
        assert_eq!(choose(&windows, OURS), Some(1));
    }

    /// The case the whole feature exists for. Clicking the screenshot button
    /// focuses this app and puts it in front, so counting our own window would
    /// photograph the copilot instead of the thing behind it.
    #[test]
    fn our_own_window_never_wins_even_when_focused_and_in_front() {
        let windows = [focused(ours()), other()];
        assert_eq!(choose(&windows, OURS), Some(1));
    }

    /// With nothing focused — which is what a global hotkey can leave behind —
    /// the frontmost other window is the one being looked at.
    #[test]
    fn without_focus_the_frontmost_other_window_wins() {
        let windows = [ours(), other(), other()];
        assert_eq!(choose(&windows, OURS), Some(1));
    }

    /// A minimized window is on no monitor in any useful sense.
    #[test]
    fn minimized_windows_are_skipped() {
        let windows = [minimized(other()), other()];
        assert_eq!(choose(&windows, OURS), Some(1));
    }

    /// Even focus does not rescue a minimized window.
    #[test]
    fn a_minimized_window_does_not_win_on_focus() {
        let windows = [minimized(focused(other())), other()];
        assert_eq!(choose(&windows, OURS), Some(1));
    }

    /// Nothing to follow. The caller falls back to the primary monitor rather
    /// than failing, because a screenshot of the wrong screen still beats an
    /// error where an answer should be.
    #[test]
    fn an_empty_desktop_chooses_nothing() {
        assert_eq!(choose(&[], OURS), None);
        assert_eq!(choose(&[ours(), ours()], OURS), None);
    }

    /// Encoding is testable without a screen; capture is not.
    #[test]
    fn a_frame_encodes_to_base64_jpeg() {
        let frame = image::RgbaImage::from_pixel(16, 16, image::Rgba([120, 90, 200, 255]));

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
        let frame = image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 20, 30, 0]));
        assert!(encode(frame).is_ok());
    }
}
