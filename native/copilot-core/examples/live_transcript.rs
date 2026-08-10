//! Live transcript of both lanes, in a terminal.
//!
//! This is phase 2: everything the engine needs to produce text, with no
//! window around it yet. If the transcript is wrong here, no amount of UI
//! will fix it, so it is worth getting right on its own first.
//!
//!     cargo run --example live_transcript
//!     cargo run --example live_transcript -- --seconds 60
//!
//! Talk, and play something with speech in it. Lines appear a beat after each
//! person stops — whisper transcribes finished utterances, not a stream, so
//! the pause at the end of a sentence is what triggers it.

use anyhow::{bail, Result};
use copilot_core::capture::{Lane, Source};
use copilot_core::stt::{Segmenter, SegmenterConfig, Transcriber, Utterance};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(feature = "whisper")]
use copilot_core::stt::whisper::WhisperTranscriber;

const POLL: Duration = Duration::from_millis(50);

struct LaneState {
    lane: Lane,
    segmenter: Segmenter,
    audio: Vec<f32>,
}

impl LaneState {
    fn open(source: Source) -> Result<Self> {
        Ok(Self {
            lane: Lane::open(source)?,
            segmenter: Segmenter::new(SegmenterConfig::default()),
            audio: Vec::new(),
        })
    }

    fn collect(&mut self, out: &mut Vec<Utterance>) {
        self.audio.clear();
        self.lane.read(&mut self.audio);
        // Taking a local avoids holding a borrow of `self.audio` across the
        // call that also mutates `self.segmenter`.
        let audio = std::mem::take(&mut self.audio);
        self.segmenter.push(&audio, out);
        self.audio = audio;
    }
}

fn main() -> Result<()> {
    let seconds = flag("--seconds").and_then(|v| v.parse().ok());
    let model = match flag("--model").map(PathBuf::from).or_else(find_model) {
        Some(path) => path,
        None => bail!(
            "could not find models/ggml-base.en.bin. Pass --model <path>, or download it:\n  \
             https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
        ),
    };

    println!("\nLoading {}...", model.display());
    let mut transcriber = load_transcriber(&model)?;

    let mut lanes = [
        LaneState::open(Source::Microphone)?,
        LaneState::open(Source::SystemOutput)?,
    ];

    println!("\n  model   {} ", transcriber.name());
    for state in &lanes {
        println!(
            "  {:<7} {}",
            state.lane.source.label(),
            state.lane.device_name
        );
    }
    match seconds {
        Some(s) => println!("\nListening for {s} s.\n"),
        None => println!("\nListening. Ctrl+C to stop.\n"),
    }

    let started = Instant::now();
    let mut utterances = Vec::new();

    loop {
        for state in &mut lanes {
            utterances.clear();
            state.collect(&mut utterances);

            for utterance in &utterances {
                let began = Instant::now();
                let text = transcriber.transcribe(&utterance.samples)?;
                let took = began.elapsed();

                if let Some(text) = text {
                    println!(
                        "  [{}] {:<5} {}   ({:.1}s audio, {:.0}ms to transcribe)",
                        clock(utterance.start_ms),
                        state.lane.source.label(),
                        text,
                        utterance.duration_ms() as f32 / 1000.0,
                        took.as_secs_f32() * 1000.0,
                    );
                }
            }
        }

        if seconds.is_some_and(|s| started.elapsed() >= Duration::from_secs(s)) {
            break;
        }
        std::thread::sleep(POLL);
    }

    // Whatever was still being said when time ran out.
    let mut tail = Vec::new();
    for state in &mut lanes {
        tail.clear();
        state.segmenter.flush(&mut tail);
        for utterance in &tail {
            if let Some(text) = transcriber.transcribe(&utterance.samples)? {
                println!(
                    "  [{}] {:<5} {}",
                    clock(utterance.start_ms),
                    state.lane.source.label(),
                    text
                );
            }
        }
    }

    for state in &lanes {
        let dropped = state.lane.dropped();
        if dropped > 0 {
            println!(
                "\n  {} dropped {dropped} samples - transcription could not keep up",
                state.lane.source.label()
            );
        }
    }
    println!();
    Ok(())
}

#[cfg(feature = "whisper")]
fn load_transcriber(model: &Path) -> Result<Box<dyn Transcriber>> {
    Ok(Box::new(WhisperTranscriber::load(
        &model.to_string_lossy(),
        None,
    )?))
}

#[cfg(not(feature = "whisper"))]
fn load_transcriber(_model: &Path) -> Result<Box<dyn Transcriber>> {
    bail!("built without the whisper feature; rebuild with --features whisper")
}

fn clock(ms: u64) -> String {
    format!("{:02}:{:02}", ms / 60_000, (ms / 1000) % 60)
}

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1).cloned()
}

/// Looks for the model beside the current directory or above it, so the
/// example runs the same from the repo root or from inside `native/`.
fn find_model() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join("models").join("ggml-base.en.bin");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}
