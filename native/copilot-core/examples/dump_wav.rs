//! Records both lanes through the real pipeline and writes them to WAV.
//!
//! The unit tests prove the resampler is correct against synthetic tones.
//! This proves it against a voice, and it is checked by ear — aliasing,
//! wrong playback speed, and channel-alignment slips are all obvious the
//! moment you listen, and all easy to miss in a number.
//!
//!     cargo run --example dump_wav -- --seconds 10
//!
//! Then play the two files it writes. `you.wav` should be your voice at
//! normal pitch and speed. `them.wav` should be whatever the machine played.

use anyhow::Result;
use copilot_core::audio::vad::{frame_db, Vad, VadConfig, VadEvent};
use copilot_core::capture::{Lane, Source};
use copilot_core::config::{STT_SAMPLE_RATE, VAD_FRAME_SAMPLES};
use std::io::Write;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(50);

struct Recorder {
    lane: Lane,
    samples: Vec<f32>,
    vad: Vad,
    /// Samples already scored by the detector.
    scored: usize,
    speech_runs: usize,
    voiced_samples: usize,
    peak_db: f32,
}

impl Recorder {
    fn open(source: Source) -> Result<Recorder> {
        let lane = Lane::open(source)?;
        Ok(Recorder {
            lane,
            samples: Vec::new(),
            vad: Vad::new(VadConfig::default()),
            scored: 0,
            speech_runs: 0,
            voiced_samples: 0,
            peak_db: f32::NEG_INFINITY,
        })
    }

    /// Pulls whatever has arrived and scores it, printing transitions as they
    /// happen so you can see the detector agreeing with your own ears.
    fn poll(&mut self) -> Result<()> {
        self.lane.read(&mut self.samples);

        while self.scored + VAD_FRAME_SAMPLES <= self.samples.len() {
            let frame = &self.samples[self.scored..self.scored + VAD_FRAME_SAMPLES];
            self.peak_db = self.peak_db.max(frame_db(frame));

            if self.vad.is_voiced() {
                self.voiced_samples += VAD_FRAME_SAMPLES;
            }

            match self.vad.push_frame(frame) {
                Some(VadEvent::SpeechStart) => {
                    self.speech_runs += 1;
                    print!("  {} speaking", self.lane.source.label());
                    std::io::stdout().flush()?;
                }
                Some(VadEvent::SpeechEnd) => println!(" ... stopped"),
                None => {}
            }

            self.scored += VAD_FRAME_SAMPLES;
        }
        Ok(())
    }

    fn write_wav(&self, path: &str) -> Result<()> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: STT_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(path, spec)?;
        for &sample in &self.samples {
            // Clamp before scaling: capture can exceed full scale, and
            // letting it wrap turns a loud moment into a burst of noise.
            writer.write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
        }
        writer.finalize()?;
        Ok(())
    }

    fn report(&self, path: &str) {
        let seconds = self.samples.len() as f32 / STT_SAMPLE_RATE as f32;
        let voiced = self.voiced_samples as f32 / STT_SAMPLE_RATE as f32;

        println!("\n  {} -> {path}", self.lane.source.label());
        println!("     device      {}", self.lane.device_name);
        println!(
            "     input       {} Hz, {} ch",
            self.lane.input_rate, self.lane.channels
        );
        println!("     recorded    {seconds:.1} s at {STT_SAMPLE_RATE} Hz mono");
        println!("     loudest     {:.1} dB", self.peak_db);
        println!(
            "     speech      {} run(s), {voiced:.1} s voiced",
            self.speech_runs
        );

        let dropped = self.lane.dropped();
        if dropped == 0 {
            println!("     dropped     none");
        } else {
            println!("     dropped     {dropped} samples - the reader fell behind");
        }
    }
}

fn main() -> Result<()> {
    let seconds = parse_seconds();

    println!("\nOpening lanes...\n");
    let mut you = Recorder::open(Source::Microphone)?;
    let mut them = Recorder::open(Source::SystemOutput)?;
    println!("  YOU   {}", you.lane.device_name);
    println!("  THEM  {}", them.lane.device_name);

    println!("\nRecording for {seconds} s. Talk, and play something.\n");

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(seconds) {
        you.poll()?;
        them.poll()?;
        std::thread::sleep(POLL);
    }
    // One last pass so the tail of the recording is not lost.
    you.poll()?;
    them.poll()?;

    you.write_wav("you.wav")?;
    them.write_wav("them.wav")?;

    you.report("you.wav");
    them.report("them.wav");

    println!("\n  Play both files. Your voice should sound normal - right pitch,");
    println!("  right speed, no metallic edge. Anything else means the resampler");
    println!("  or the channel handling is wrong.\n");
    Ok(())
}

fn parse_seconds() -> u64 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    args.iter()
        .position(|arg| arg == "--seconds")
        .and_then(|at| args.get(at + 1))
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(10)
}
