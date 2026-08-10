//! Speech recognition through whisper.cpp.
//!
//! Whisper transcribes a finished chunk rather than a stream, so the
//! [`Segmenter`](super::Segmenter) upstream decides what a chunk is and this
//! only has to turn one into words.
//!
//! Two settings here are load-bearing rather than incidental:
//!
//! **No carried context.** Whisper can be told to condition each call on the
//! text it produced last time, which helps accuracy on continuous audio. It
//! is switched off, because when it does go wrong it goes wrong permanently:
//! one bad transcription becomes the context for the next, and the model
//! spirals into repeating itself. Independent utterances cannot spiral.
//!
//! **Padding.** Whisper works in 30-second windows and behaves poorly on very
//! short input, so anything under a second is padded with silence.
//!
//! Hallucinations get filtered twice. The model reports, per segment, how
//! likely it thinks that segment was actually silence — a far better signal
//! than guessing from the words, because it is the model's own uncertainty
//! rather than an outside heuristic. Segments it doubts are dropped, and what
//! survives still passes through
//! [`hallucination::keep`](super::hallucination::keep) for the stock phrases
//! it produces confidently.

use anyhow::{Context, Result};
use std::sync::Once;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::{hallucination, Transcriber};
use crate::config::STT_SAMPLE_RATE;

/// Shortest audio handed to whisper. Below this it is padded with silence.
const MIN_SAMPLES: usize = STT_SAMPLE_RATE as usize;

/// Drop a segment once the model thinks it is this likely to have been
/// silence. Speech normally scores far below this, so the threshold is loose
/// enough not to discard a quiet real sentence.
const NO_SPEECH_MAX: f32 = 0.6;

static LOGGING: Once = Once::new();

pub struct WhisperTranscriber {
    /// Created once and reused. Each state carries about 230 MB of compute
    /// buffers, so building one per utterance would spend more time
    /// allocating than recognizing.
    state: WhisperState,
    threads: usize,
    model_name: String,
    /// The state borrows nothing from this, but the model must outlive it.
    _context: WhisperContext,
}

impl WhisperTranscriber {
    /// Loads a ggml model from disk.
    ///
    /// `threads` defaults to leaving two cores free — recognition must not
    /// starve the audio capture threads, which have a real deadline.
    pub fn load(model_path: &str, threads: Option<usize>) -> Result<Self> {
        // whisper.cpp is chatty on stderr by default, which lands in the
        // middle of the transcript. This routes it through the `log` crate
        // instead; with no logger installed it goes nowhere, and a caller
        // that wants the detail can install one.
        LOGGING.call_once(whisper_rs::install_logging_hooks);

        let context = WhisperContext::new_with_params(
            model_path,
            WhisperContextParameters::default(),
        )
        .with_context(|| format!("could not load whisper model at '{model_path}'"))?;

        let state = context
            .create_state()
            .context("could not create whisper state")?;

        let threads = threads.unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get().saturating_sub(2).max(1))
                .unwrap_or(4)
        });

        let model_name = std::path::Path::new(model_path)
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "whisper".into());

        Ok(Self {
            state,
            threads,
            model_name,
            _context: context,
        })
    }

    pub fn threads(&self) -> usize {
        self.threads
    }
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(&mut self, samples: &[f32]) -> Result<Option<String>> {
        if samples.is_empty() {
            return Ok(None);
        }

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads as i32);
        params.set_language(Some("en"));
        params.set_translate(false);
        // See the module note: carried context turns one bad guess into a
        // permanent one.
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        let padded;
        let audio = if samples.len() < MIN_SAMPLES {
            padded = {
                let mut buffer = Vec::with_capacity(MIN_SAMPLES);
                buffer.extend_from_slice(samples);
                buffer.resize(MIN_SAMPLES, 0.0);
                buffer
            };
            &padded[..]
        } else {
            samples
        };

        self.state.full(params, audio).context("whisper failed")?;

        let mut text = String::new();
        for segment in self.state.as_iter() {
            if segment.no_speech_probability() > NO_SPEECH_MAX {
                continue;
            }
            if let Ok(piece) = segment.to_str_lossy() {
                text.push_str(&piece);
            }
        }

        Ok(hallucination::keep(&text))
    }

    fn name(&self) -> String {
        self.model_name.clone()
    }
}
