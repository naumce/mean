//! Is anyone actually talking?
//!
//! Everything downstream depends on the answer. The segmenter needs it to
//! know where one utterance ends and the next begins. Whisper needs it
//! because it invents text when handed silence — "Thank you." and stray
//! subtitle credits are the classic symptoms. Turn detection needs it to
//! decide when a question is finished.
//!
//! The detector here is energy with hysteresis and a hangover, which is the
//! simple option. A neural detector such as Silero is better at separating
//! speech from background noise, but most of what it buys is separating a
//! voice from other sound in the same signal — and our two lanes are already
//! physically separate. That is most of the problem, solved by the wiring.
//!
//! Two details do the real work:
//!
//! **Hysteresis.** Entering speech takes a higher level than leaving it. With
//! one threshold, a level sitting on top of it produces a stream of spurious
//! transitions.
//!
//! **Hangover.** Speech is only over once the lane has been quiet for a
//! while. Without it, the natural gaps inside a sentence — between words, and
//! the stop before a plosive — each end the utterance and chop it to pieces.

use crate::config::{VAD_ENTER_DB, VAD_EXIT_DB, VAD_HANGOVER_MS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    SpeechStart,
    SpeechEnd,
}

#[derive(Clone, Copy, Debug)]
pub struct VadConfig {
    pub sample_rate: u32,
    /// Level a frame must reach to begin speech.
    pub enter_db: f32,
    /// Level a frame must fall below to count toward ending speech.
    pub exit_db: f32,
    /// How long the lane stays quiet before speech is declared over.
    pub hangover_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate: crate::config::STT_SAMPLE_RATE,
            enter_db: VAD_ENTER_DB,
            exit_db: VAD_EXIT_DB,
            hangover_ms: VAD_HANGOVER_MS,
        }
    }
}

pub struct Vad {
    config: VadConfig,
    voiced: bool,
    /// Samples seen below the exit threshold since the last voiced frame.
    /// Counted in samples rather than frames so the behaviour does not change
    /// if the caller hands over a short frame.
    quiet_samples: usize,
    hangover_samples: usize,
}

impl Vad {
    pub fn new(config: VadConfig) -> Self {
        let hangover_samples =
            (config.sample_rate as usize * config.hangover_ms as usize) / 1000;

        Self {
            config,
            voiced: false,
            quiet_samples: 0,
            hangover_samples,
        }
    }

    /// Scores one frame and reports a transition if this frame caused one.
    ///
    /// Frames are expected to be [`crate::config::VAD_FRAME_SAMPLES`] long;
    /// a short final frame is scored on what it has.
    pub fn push_frame(&mut self, frame: &[f32]) -> Option<VadEvent> {
        if frame.is_empty() {
            return None;
        }

        let level_db = frame_db(frame);

        if !self.voiced {
            // Silent: only a frame at the higher threshold starts speech.
            if level_db >= self.config.enter_db {
                self.voiced = true;
                self.quiet_samples = 0;
                return Some(VadEvent::SpeechStart);
            }
            return None;
        }

        // Voiced: anything not clearly quiet resets the hangover, which is
        // what holds an utterance together across the gaps between words.
        if level_db >= self.config.exit_db {
            self.quiet_samples = 0;
            return None;
        }

        self.quiet_samples += frame.len();
        if self.quiet_samples >= self.hangover_samples {
            self.voiced = false;
            self.quiet_samples = 0;
            return Some(VadEvent::SpeechEnd);
        }

        None
    }

    pub fn is_voiced(&self) -> bool {
        self.voiced
    }
}

/// Frame level in dBFS. Silence floors at [`crate::config::SILENCE_DB`]
/// rather than negative infinity so the value stays usable in comparisons
/// and in a meter.
pub fn frame_db(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return crate::config::SILENCE_DB;
    }

    let mean_square = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    let rms = mean_square.sqrt();

    (20.0 * rms.max(1e-12).log10()).max(crate::config::SILENCE_DB)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VAD_FRAME_SAMPLES;

    const FRAME: usize = VAD_FRAME_SAMPLES;

    fn at_db(level_db: f32) -> Vec<f32> {
        let amplitude = 10f32.powf(level_db / 20.0);
        // A square wave, so peak and RMS are both exactly the amplitude and
        // the test is stating the level it means.
        (0..FRAME)
            .map(|n| if n % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    fn loud() -> Vec<f32> {
        at_db(-20.0)
    }

    fn quiet() -> Vec<f32> {
        at_db(-70.0)
    }

    fn frames_for(ms: u32) -> usize {
        (ms as usize * crate::config::STT_SAMPLE_RATE as usize) / (1000 * FRAME)
    }

    #[test]
    fn frame_db_reports_the_level_it_was_given() {
        assert!((frame_db(&at_db(-20.0)) - (-20.0)).abs() < 0.1);
        assert!((frame_db(&at_db(-60.0)) - (-60.0)).abs() < 0.1);
    }

    #[test]
    fn digital_silence_floors_instead_of_going_to_negative_infinity() {
        let db = frame_db(&vec![0.0; FRAME]);
        assert!(db <= -90.0 && db.is_finite(), "got {db}");
    }

    #[test]
    fn starts_out_silent() {
        let vad = Vad::new(VadConfig::default());
        assert!(!vad.is_voiced());
    }

    #[test]
    fn a_loud_frame_starts_speech() {
        let mut vad = Vad::new(VadConfig::default());
        assert_eq!(vad.push_frame(&loud()), Some(VadEvent::SpeechStart));
        assert!(vad.is_voiced());
    }

    #[test]
    fn quiet_frames_alone_never_start_speech() {
        let mut vad = Vad::new(VadConfig::default());
        for _ in 0..100 {
            assert_eq!(vad.push_frame(&quiet()), None);
        }
        assert!(!vad.is_voiced());
    }

    #[test]
    fn speech_start_fires_once_not_on_every_loud_frame() {
        let mut vad = Vad::new(VadConfig::default());
        assert_eq!(vad.push_frame(&loud()), Some(VadEvent::SpeechStart));
        for _ in 0..50 {
            assert_eq!(vad.push_frame(&loud()), None);
        }
    }

    /// The gap between words must not end the utterance.
    #[test]
    fn a_pause_shorter_than_the_hangover_does_not_end_speech() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        vad.push_frame(&loud());

        // Two thirds of the hangover, then talking again.
        for _ in 0..(frames_for(cfg.hangover_ms) * 2 / 3) {
            assert_eq!(vad.push_frame(&quiet()), None);
        }
        assert!(vad.is_voiced(), "a between-words gap ended the utterance");
        assert_eq!(vad.push_frame(&loud()), None);
    }

    #[test]
    fn sustained_quiet_ends_speech() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        vad.push_frame(&loud());

        let mut ended = None;
        for i in 0..(frames_for(cfg.hangover_ms) + 5) {
            if let Some(event) = vad.push_frame(&quiet()) {
                ended = Some((i, event));
                break;
            }
        }

        let (frame, event) = ended.expect("speech never ended");
        assert_eq!(event, VadEvent::SpeechEnd);
        assert!(!vad.is_voiced());
        // It should end close to the hangover, not immediately and not late.
        let expected = frames_for(cfg.hangover_ms);
        assert!(
            frame + 1 >= expected && frame <= expected + 2,
            "ended at frame {frame}, expected about {expected}"
        );
    }

    /// The hangover restarts on every voiced frame, so a long utterance with
    /// pauses throughout stays a single utterance.
    #[test]
    fn the_hangover_resets_each_time_talking_resumes() {
        let cfg = VadConfig::default();
        let mut vad = Vad::new(cfg);
        vad.push_frame(&loud());

        let nearly = frames_for(cfg.hangover_ms) - 1;
        for _ in 0..6 {
            for _ in 0..nearly {
                assert_eq!(vad.push_frame(&quiet()), None);
            }
            assert_eq!(vad.push_frame(&loud()), None);
        }
        assert!(vad.is_voiced());
    }

    /// Between the two thresholds is the ambiguous zone. It must not toggle
    /// the state in either direction.
    #[test]
    fn a_level_between_the_thresholds_holds_the_current_state() {
        let cfg = VadConfig::default();
        let between = at_db((cfg.enter_db + cfg.exit_db) / 2.0);

        let mut silent = Vad::new(cfg);
        for _ in 0..50 {
            assert_eq!(silent.push_frame(&between), None);
        }
        assert!(!silent.is_voiced(), "ambiguous level should not start speech");

        let mut voiced = Vad::new(cfg);
        voiced.push_frame(&loud());
        for _ in 0..50 {
            assert_eq!(voiced.push_frame(&between), None);
        }
        assert!(voiced.is_voiced(), "ambiguous level should not end speech");
    }
}
