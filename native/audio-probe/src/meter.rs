//! Drawing a level meter in the terminal.

use crate::level::Level;

const BAR_WIDTH: usize = 32;
/// Anything at or below this reads as an empty bar.
const FLOOR_DB: f32 = -60.0;

/// Renders one labelled meter line, including the trailing newline.
///
/// `level` is `None` when that source failed to open, so the display can show
/// which stream is missing instead of silently drawing a dead bar.
pub fn render(label: &str, level: Option<Level>) -> String {
    match level {
        Some(level) => format!(
            "  {label:<7}[{bar}] {rms:>6.1} dB   peak {peak:>6.1}\x1b[K\n",
            bar = bar(level.rms_db),
            rms = level.rms_db,
            peak = level.peak_db,
        ),
        None => format!("  {label:<7}[{}] unavailable\x1b[K\n", " ".repeat(BAR_WIDTH)),
    }
}

fn bar(db: f32) -> String {
    let fraction = ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0);
    let filled = (fraction * BAR_WIDTH as f32).round() as usize;
    let mut out = String::with_capacity(BAR_WIDTH * 3);
    for slot in 0..BAR_WIDTH {
        out.push_str(if slot < filled { "\u{2588}" } else { "\u{2591}" });
    }
    out
}
