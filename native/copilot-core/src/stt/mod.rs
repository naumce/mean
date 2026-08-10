//! Turning audio into text.
//!
//! Two things live behind this boundary. [`Segmenter`] decides *what* to
//! transcribe — where one utterance ends and the next begins — and a
//! [`Transcriber`] turns a finished utterance into words.
//!
//! Splitting them apart is what makes the surrounding logic testable. Whisper
//! needs a 141 MB model file, several hundred milliseconds per call, and a
//! working build of a C++ library. Nothing that merely *consumes* transcripts
//! should have to care, so the trait exists and [`MockTranscriber`] stands in.

pub mod hallucination;
pub mod mock;
pub mod segmenter;

#[cfg(feature = "whisper")]
pub mod whisper;

pub use mock::MockTranscriber;
pub use segmenter::{Segmenter, SegmenterConfig, Utterance};

use anyhow::Result;

/// Anything that can turn 16 kHz mono audio into words.
pub trait Transcriber: Send {
    /// Transcribes one complete utterance.
    ///
    /// Returns `None` when the audio produced nothing worth keeping — either
    /// genuinely empty, or text the hallucination filter rejected.
    fn transcribe(&mut self, samples: &[f32]) -> Result<Option<String>>;

    /// Short name for the model in use, for display.
    fn name(&self) -> String;
}
