//! Deciding what counts as one utterance.
//!
//! Whisper is not a streaming model. It transcribes a finished chunk of audio,
//! so something has to choose where the chunks end — and that choice sets both
//! how accurate the text is and how quickly it appears. Cut too eagerly and
//! whisper loses the context it needs to disambiguate; cut too late and the
//! transcript lags behind the conversation.
//!
//! Three details matter more than they look:
//!
//! **Pre-roll.** The detector reports speech on the frame that crosses the
//! threshold, but the word started before that — the leading consonant is
//! quieter than the vowel behind it. So a rolling buffer of the audio just
//! before the trigger is kept and prepended. Without it "start" arrives as
//! "art", and there is no way to recover it later.
//!
//! **A hard cap.** Someone talking without pause for two minutes must still
//! produce text along the way, so an utterance is cut at a maximum length
//! whether or not they have stopped.
//!
//! **A floor.** A door closing or a key press trips an energy detector. If it
//! did not contain enough voiced audio to be a word, it is discarded rather
//! than sent off to be hallucinated over.

use std::collections::VecDeque;

use crate::audio::vad::{frame_db, Vad, VadConfig, VadEvent};
use crate::config::{
    MAX_UTTERANCE_MS, MIN_VOICED_MS, PREROLL_MS, STT_SAMPLE_RATE, VAD_FRAME_SAMPLES,
};

/// One stretch of speech, ready to transcribe.
#[derive(Clone, Debug)]
pub struct Utterance {
    /// Increases monotonically within a lane; used to match a transcript back
    /// to the audio it came from.
    pub id: u64,
    pub samples: Vec<f32>,
    pub start_ms: u64,
    pub end_ms: u64,
}

impl Utterance {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SegmenterConfig {
    pub sample_rate: u32,
    pub vad: VadConfig,
    /// Audio retained from before speech was detected.
    pub preroll_ms: u32,
    /// Longest an utterance may run before being cut anyway.
    pub max_utterance_ms: u32,
    /// Least voiced audio an utterance must contain to be worth transcribing.
    pub min_voiced_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            sample_rate: STT_SAMPLE_RATE,
            vad: VadConfig::default(),
            preroll_ms: PREROLL_MS,
            max_utterance_ms: MAX_UTTERANCE_MS,
            min_voiced_ms: MIN_VOICED_MS,
        }
    }
}

pub struct Segmenter {
    config: SegmenterConfig,
    vad: Vad,

    /// Samples not yet forming a whole detector frame.
    pending: Vec<f32>,
    /// Rolling pre-speech audio, capped at the pre-roll length.
    history: VecDeque<f32>,
    /// The utterance being accumulated, empty when not speaking.
    buffer: Vec<f32>,

    /// Total samples fed in, which is also the current position on the lane's
    /// timeline.
    consumed: u64,
    /// Where the utterance in `buffer` starts, in samples.
    start_sample: u64,
    /// Voiced samples inside the current utterance, used against the floor.
    voiced_samples: usize,

    next_id: u64,
    preroll_samples: usize,
    max_samples: usize,
    min_voiced_samples: usize,
}

impl Segmenter {
    pub fn new(config: SegmenterConfig) -> Self {
        let rate = config.sample_rate as usize;
        let samples_for = |ms: u32| rate * ms as usize / 1000;

        Self {
            vad: Vad::new(config.vad),
            pending: Vec::new(),
            history: VecDeque::with_capacity(samples_for(config.preroll_ms) + 1),
            buffer: Vec::new(),
            consumed: 0,
            start_sample: 0,
            voiced_samples: 0,
            next_id: 0,
            preroll_samples: samples_for(config.preroll_ms),
            max_samples: samples_for(config.max_utterance_ms),
            min_voiced_samples: samples_for(config.min_voiced_ms),
            config,
        }
    }

    /// Feeds 16 kHz mono audio, appending any utterances it completed.
    pub fn push(&mut self, samples: &[f32], out: &mut Vec<Utterance>) {
        // Moved out so the loop below can borrow the buffer and `self` at the
        // same time. Whole frames only — a partial frame waits for the rest
        // of itself, which is what makes the result independent of how the
        // caller happened to chunk its input.
        let mut pending = std::mem::take(&mut self.pending);
        pending.extend_from_slice(samples);

        let mut offset = 0;
        while offset + VAD_FRAME_SAMPLES <= pending.len() {
            self.handle_frame(&pending[offset..offset + VAD_FRAME_SAMPLES], out);
            offset += VAD_FRAME_SAMPLES;
        }

        pending.drain(..offset);
        self.pending = pending;
    }

    /// Whether this lane is mid-utterance right now.
    pub fn is_speaking(&self) -> bool {
        self.vad.is_voiced()
    }

    /// Ends any utterance in progress. For shutdown, so the last thing said
    /// is not lost.
    pub fn flush(&mut self, out: &mut Vec<Utterance>) {
        if !self.buffer.is_empty() {
            self.emit(out);
        }
        self.vad = Vad::new(self.config.vad);
        self.pending.clear();
        self.history.clear();
    }

    fn handle_frame(&mut self, frame: &[f32], out: &mut Vec<Utterance>) {
        // Measured here as well as inside the detector, because "counts
        // toward the length of this utterance" is a different question from
        // "is this lane still speaking". The hangover frames at the end are
        // part of the audio but are not someone talking, and counting them
        // would let a door slam clear the minimum-length floor.
        let is_loud = frame_db(frame) >= self.config.vad.exit_db;

        match self.vad.push_frame(frame) {
            Some(VadEvent::SpeechStart) => self.begin(frame),
            Some(VadEvent::SpeechEnd) => {
                self.buffer.extend_from_slice(frame);
                self.emit(out);
            }
            None if self.vad.is_voiced() => {
                self.buffer.extend_from_slice(frame);
                if is_loud {
                    self.voiced_samples += frame.len();
                }
                if self.buffer.len() >= self.max_samples {
                    self.cut(out);
                }
            }
            None => self.remember(frame),
        }

        self.consumed += frame.len() as u64;
    }

    /// Opens an utterance, backdated to include the pre-roll.
    fn begin(&mut self, frame: &[f32]) {
        self.start_sample = self.consumed - self.history.len() as u64;

        self.buffer.clear();
        self.buffer.extend(self.history.iter().copied());
        self.buffer.extend_from_slice(frame);
        self.history.clear();

        self.voiced_samples = frame.len();
    }

    /// Keeps the most recent pre-roll of quiet audio, discarding the rest.
    fn remember(&mut self, frame: &[f32]) {
        if self.preroll_samples == 0 {
            return;
        }
        for &sample in frame {
            if self.history.len() >= self.preroll_samples {
                self.history.pop_front();
            }
            self.history.push_back(sample);
        }
    }

    /// Ends the utterance in progress, discarding it if it never contained
    /// enough voiced audio to be a word.
    fn emit(&mut self, out: &mut Vec<Utterance>) {
        let samples = std::mem::take(&mut self.buffer);
        let voiced = self.voiced_samples;

        self.voiced_samples = 0;
        self.history.clear();

        if voiced < self.min_voiced_samples {
            return;
        }

        let rate = self.config.sample_rate as u64;
        let start_ms = self.start_sample * 1000 / rate;
        let end_ms = start_ms + samples.len() as u64 * 1000 / rate;

        out.push(Utterance {
            id: self.next_id,
            samples,
            start_ms,
            end_ms,
        });
        self.next_id += 1;
    }

    /// Ends an utterance that hit the length cap and immediately opens the
    /// next one, since the speaker has not actually stopped.
    fn cut(&mut self, out: &mut Vec<Utterance>) {
        let length = self.buffer.len() as u64;
        self.emit(out);
        self.start_sample += length;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: usize = STT_SAMPLE_RATE as usize;

    fn at_db(level_db: f32, samples: usize) -> Vec<f32> {
        let amplitude = 10f32.powf(level_db / 20.0);
        (0..samples)
            .map(|n| if n % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    fn loud(ms: usize) -> Vec<f32> {
        at_db(-20.0, RATE * ms / 1000)
    }

    fn quiet(ms: usize) -> Vec<f32> {
        at_db(-70.0, RATE * ms / 1000)
    }

    fn segmenter() -> Segmenter {
        Segmenter::new(SegmenterConfig::default())
    }

    /// Feeds audio in realistic small pieces rather than one large slice, so
    /// anything depending on chunk size gets caught.
    fn feed(seg: &mut Segmenter, audio: &[f32], out: &mut Vec<Utterance>) {
        for chunk in audio.chunks(777) {
            seg.push(chunk, out);
        }
    }

    #[test]
    fn silence_produces_no_utterances() {
        let mut seg = segmenter();
        let mut out = Vec::new();
        feed(&mut seg, &quiet(3000), &mut out);
        assert!(out.is_empty());
        assert!(!seg.is_speaking());
    }

    #[test]
    fn speech_followed_by_silence_produces_one_utterance() {
        let mut seg = segmenter();
        let mut out = Vec::new();
        feed(&mut seg, &loud(1000), &mut out);
        assert!(out.is_empty(), "must not emit while still speaking");
        assert!(seg.is_speaking());

        feed(&mut seg, &quiet(1000), &mut out);
        assert_eq!(out.len(), 1);
        assert!(!seg.is_speaking());
    }

    /// The onset of the first word is quieter than the threshold that
    /// triggered detection, so it must be recovered from the pre-roll.
    #[test]
    fn the_utterance_includes_audio_from_before_speech_was_detected() {
        let cfg = SegmenterConfig::default();
        let mut seg = Segmenter::new(cfg);
        let mut out = Vec::new();

        feed(&mut seg, &quiet(1000), &mut out);
        feed(&mut seg, &loud(500), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        let utterance = out.first().expect("no utterance");
        let preroll = RATE * cfg.preroll_ms as usize / 1000;
        assert!(
            utterance.samples.len() > RATE * 500 / 1000 + preroll / 2,
            "utterance is {} samples, too short to contain the pre-roll",
            utterance.samples.len()
        );
    }

    #[test]
    fn two_separated_bursts_produce_two_utterances_with_rising_ids() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &loud(600), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);
        feed(&mut seg, &loud(600), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        assert_eq!(out.len(), 2);
        assert!(out[1].id > out[0].id);
        assert!(
            out[1].start_ms > out[0].end_ms,
            "second utterance should begin after the first ends"
        );
    }

    /// A gap shorter than the detector's hangover is inside one sentence, not
    /// between two.
    #[test]
    fn a_short_gap_does_not_split_an_utterance() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &loud(400), &mut out);
        feed(&mut seg, &quiet(150), &mut out);
        feed(&mut seg, &loud(400), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        assert_eq!(out.len(), 1, "a between-words gap split the utterance");
    }

    #[test]
    fn a_click_too_short_to_be_speech_is_discarded() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &loud(40), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        assert!(out.is_empty(), "a 40 ms transient should not be an utterance");
    }

    #[test]
    fn continuous_speech_is_cut_at_the_maximum_length() {
        let cfg = SegmenterConfig::default();
        let mut seg = Segmenter::new(cfg);
        let mut out = Vec::new();

        // Two and a half times the cap, without ever pausing.
        feed(&mut seg, &loud(cfg.max_utterance_ms as usize * 5 / 2), &mut out);

        assert!(
            out.len() >= 2,
            "a monologue must still produce text along the way, got {}",
            out.len()
        );
        for utterance in &out {
            assert!(
                utterance.duration_ms() <= cfg.max_utterance_ms as u64 + 100,
                "utterance ran {} ms, over the {} ms cap",
                utterance.duration_ms(),
                cfg.max_utterance_ms
            );
        }
    }

    #[test]
    fn timestamps_line_up_with_how_much_audio_was_fed() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &quiet(2000), &mut out);
        feed(&mut seg, &loud(500), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        let utterance = out.first().expect("no utterance");
        // Speech began at 2000 ms; the pre-roll pulls the start slightly
        // earlier, and nothing should place it after the speech itself.
        assert!(
            (1600..=2100).contains(&utterance.start_ms),
            "start_ms was {}, expected near 2000",
            utterance.start_ms
        );
        assert!(
            utterance.end_ms > utterance.start_ms,
            "utterance ends before it starts"
        );
        assert!(
            utterance.end_ms <= 3500,
            "end_ms was {}, past all the audio fed in",
            utterance.end_ms
        );
    }

    #[test]
    fn samples_and_timestamps_agree() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &quiet(500), &mut out);
        feed(&mut seg, &loud(800), &mut out);
        feed(&mut seg, &quiet(1000), &mut out);

        let utterance = out.first().expect("no utterance");
        let from_samples = utterance.samples.len() as u64 * 1000 / STT_SAMPLE_RATE as u64;
        assert!(
            from_samples.abs_diff(utterance.duration_ms()) <= 30,
            "{} ms of samples but timestamps claim {} ms",
            from_samples,
            utterance.duration_ms()
        );
    }

    #[test]
    fn flush_emits_speech_that_was_still_in_progress() {
        let mut seg = segmenter();
        let mut out = Vec::new();

        feed(&mut seg, &loud(800), &mut out);
        assert!(out.is_empty());

        seg.flush(&mut out);
        assert_eq!(out.len(), 1, "flush lost the utterance in progress");
        assert!(!seg.is_speaking());
    }

    #[test]
    fn flush_while_silent_emits_nothing() {
        let mut seg = segmenter();
        let mut out = Vec::new();
        feed(&mut seg, &quiet(500), &mut out);
        seg.flush(&mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn frames_are_scored_the_same_whatever_size_the_caller_pushes() {
        let audio: Vec<f32> = quiet(500)
            .into_iter()
            .chain(loud(700))
            .chain(quiet(1000))
            .collect();

        let mut one_shot = Vec::new();
        segmenter().push(&audio, &mut one_shot);

        let mut in_pieces = Vec::new();
        let mut seg = segmenter();
        for chunk in audio.chunks(VAD_FRAME_SAMPLES * 3 + 11) {
            seg.push(chunk, &mut in_pieces);
        }

        assert_eq!(one_shot.len(), in_pieces.len());
        assert_eq!(one_shot[0].samples.len(), in_pieces[0].samples.len());
        assert_eq!(one_shot[0].start_ms, in_pieces[0].start_ms);
    }
}
