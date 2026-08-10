//! Turning what the sound card gives us into what speech recognition wants.
//!
//! Capture hands over 48 kHz interleaved stereo floats on a realtime thread.
//! Recognition wants 16 kHz mono, on any thread but that one. The modules
//! here bridge the gap, in order:
//!
//! ```text
//! convert.rs    interleaved stereo -> mono
//! resample.rs   48 kHz -> 16 kHz, without aliasing
//! ring.rs       off the audio thread, without blocking it
//! vad.rs        is anyone actually talking?
//! ```

pub mod convert;
pub mod resample;
pub mod ring;
pub mod vad;
