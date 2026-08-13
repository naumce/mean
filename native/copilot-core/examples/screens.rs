//! What monitors exist, and which one a screenshot would actually follow.
//!
//! Following the active window is a guess about intent. This is where the
//! guess can be checked without spending a request to find out: put a window
//! in front on one screen, run this, and see whether it agrees with you.
//!
//!     cargo run --example screens --no-default-features

use anyhow::Result;
use copilot_core::capture::screen;
use std::time::Instant;

fn main() -> Result<()> {
    println!();
    for monitor in screen::monitors() {
        println!(
            "  [{}] {:<24} {}x{}{}",
            monitor.index,
            monitor.name,
            monitor.width,
            monitor.height,
            if monitor.primary { "  (primary)" } else { "" }
        );
    }

    let began = Instant::now();
    let shot = screen::capture(screen::Target::Active)?;

    println!(
        "\n  would capture: {} — {} ms, {} KB on the wire\n",
        shot.monitor,
        began.elapsed().as_millis(),
        shot.image.base64.len() / 1024
    );

    Ok(())
}
