//! Live level meters for the microphone and for system output loopback.
//!
//! This is a spike, not a component. Its only job is to prove that both
//! streams can be pulled off a Windows machine at once, so we know the
//! capture foundation is real before anything gets built on top of it.
//!
//!     cargo run                          # live meters, until Ctrl+C
//!     cargo run -- --seconds 5           # live meters for five seconds
//!     cargo run -- --seconds 5 --quiet   # no meters, just a loudest-seen summary

mod capture;
mod level;
mod meter;

use anyhow::{bail, Result};
use capture::{Capture, Source};
use level::Level;
use std::io::{self, Write};
use std::time::{Duration, Instant};

const FRAME: Duration = Duration::from_millis(50);
const SOURCES: [Source; 2] = [Source::Microphone, Source::SystemOutput];

fn main() -> Result<()> {
    let limit = parse_seconds_limit()?;
    let quiet = std::env::args().any(|arg| arg == "--quiet");

    println!("\nOpening capture devices...\n");
    let captures: Vec<(Source, Result<Capture>)> = SOURCES
        .iter()
        .map(|&source| (source, Capture::open(source)))
        .collect();

    for (source, result) in &captures {
        describe(*source, result);
    }

    if captures.iter().all(|(_, result)| result.is_err()) {
        bail!("neither capture stream could be opened");
    }

    println!("\n  Talk into the mic to move MIC. Play any audio to move SYSTEM.");
    match limit {
        Some(limit) => println!("  Running for {} seconds.\n", limit.as_secs()),
        None => println!("  Ctrl+C to stop.\n"),
    }

    let loudest = run_meters(&captures, limit, quiet)?;
    report_loudest(&captures, &loudest);
    Ok(())
}

/// The loudest reading seen per source is what actually answers "did this
/// stream deliver audio, or did it just open?" — a stream that opens but
/// never produces samples sits at the silence floor forever.
fn report_loudest(captures: &[(Source, Result<Capture>)], loudest: &[Option<Level>]) {
    println!("\n  Loudest seen:");
    for ((source, _), peak) in captures.iter().zip(loudest) {
        match peak {
            Some(level) if level.peak_db > level::SILENCE_DB => println!(
                "    {:<7} {:>6.1} dB peak  \u{2014} received audio",
                source.label(),
                level.peak_db
            ),
            Some(_) => println!(
                "    {:<7} silent \u{2014} stream opened but delivered no signal",
                source.label()
            ),
            None => println!("    {:<7} unavailable", source.label()),
        }
    }
    println!();
}

fn describe(source: Source, result: &Result<Capture>) {
    match result {
        Ok(capture) => println!(
            "  {:<7} ok    {} \u{2014} {} Hz, {} ch, {:?}",
            source.label(),
            capture.device_name,
            capture.sample_rate,
            capture.channels,
            capture.sample_format,
        ),
        Err(err) => {
            println!("  {:<7} FAIL  {err}", source.label());
            for cause in err.chain().skip(1) {
                println!("          caused by: {cause}");
            }
        }
    }
}

/// Samples every source once per frame, optionally drawing meters, and
/// returns the loudest level seen per source.
fn run_meters(
    captures: &[(Source, Result<Capture>)],
    limit: Option<Duration>,
    quiet: bool,
) -> Result<Vec<Option<Level>>> {
    let started = Instant::now();
    let mut stdout = io::stdout();
    let mut drawn = false;
    let mut loudest: Vec<Option<Level>> = captures
        .iter()
        .map(|(_, result)| result.as_ref().ok().map(|_| Level::silent()))
        .collect();

    loop {
        if drawn && !quiet {
            // Walk back up over the lines we drew last frame and overwrite them.
            write!(stdout, "\x1b[{}A", captures.len())?;
        }
        for (index, (source, result)) in captures.iter().enumerate() {
            let level = result.as_ref().ok().map(|capture| capture.level());
            if let (Some(level), Some(best)) = (level, loudest[index].as_mut()) {
                best.peak_db = best.peak_db.max(level.peak_db);
                best.rms_db = best.rms_db.max(level.rms_db);
            }
            if !quiet {
                write!(stdout, "{}", meter::render(source.label(), level))?;
            }
        }
        if !quiet {
            stdout.flush()?;
            drawn = true;
        }

        if limit.is_some_and(|limit| started.elapsed() >= limit) {
            return Ok(loudest);
        }
        std::thread::sleep(FRAME);
    }
}

fn parse_seconds_limit() -> Result<Option<Duration>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(position) = args.iter().position(|arg| arg == "--seconds") else {
        return Ok(None);
    };
    let Some(raw) = args.get(position + 1) else {
        bail!("--seconds needs a value, e.g. --seconds 5");
    };
    let seconds: u64 = raw
        .parse()
        .map_err(|_| anyhow::anyhow!("--seconds expects a whole number, got '{raw}'"))?;
    Ok(Some(Duration::from_secs(seconds)))
}
