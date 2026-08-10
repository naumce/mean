//! Every tunable in one place.
//!
//! Audio pipelines accumulate magic numbers faster than most code — a
//! threshold here, a window length there — and once they are scattered you
//! can no longer tell which one to move when something misbehaves. So they
//! all live here, named, with the reasoning attached.

/// What speech recognition wants. Whisper resamples internally to 16 kHz
/// mono, so handing it anything else just moves the work around.
pub const STT_SAMPLE_RATE: u32 = 16_000;

/// Length of the block the voice-activity detector scores at a time.
///
/// 20 ms is the usual choice: long enough that the energy estimate is stable,
/// short enough that a transition lands close to the real word boundary.
pub const VAD_FRAME_MS: u32 = 20;

/// Samples in one VAD frame at the recognition rate.
pub const VAD_FRAME_SAMPLES: usize = (STT_SAMPLE_RATE as usize * VAD_FRAME_MS as usize) / 1000;

/// Voice-activity thresholds, in dBFS.
///
/// Two thresholds rather than one. A single threshold chatters when the level
/// sits right on top of it; requiring a louder level to enter than to leave
/// gives the detector hysteresis and a stable output.
pub const VAD_ENTER_DB: f32 = -42.0;
pub const VAD_EXIT_DB: f32 = -48.0;

/// Floor for level readings, in dBFS.
///
/// Digital silence is negative infinity, which is useless in a comparison and
/// worse in a meter. Everything quieter than this reports as this.
pub const SILENCE_DB: f32 = -90.0;

/// How long the lane must stay quiet before speech is considered over.
///
/// Below roughly 200 ms this cuts words in half at natural pauses. Above
/// roughly 500 ms every utterance carries the delay as dead air.
pub const VAD_HANGOVER_MS: u32 = 300;
