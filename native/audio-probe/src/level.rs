//! Turning blocks of samples into loudness figures, and handing those
//! figures from the audio thread to the UI thread without locking.

use std::sync::atomic::{AtomicU32, Ordering};

/// Anything quieter than this reads as silence.
pub const SILENCE_DB: f32 = -90.0;

/// Peak and RMS loudness for one block of samples, in dBFS.
#[derive(Clone, Copy, Debug)]
pub struct Level {
    pub peak_db: f32,
    pub rms_db: f32,
}

impl Level {
    pub fn silent() -> Self {
        Level { peak_db: SILENCE_DB, rms_db: SILENCE_DB }
    }

    /// Takes an iterator so callers can convert their native sample format
    /// inline, without allocating a scratch buffer on the audio thread.
    pub fn from_iter<I: Iterator<Item = f32>>(samples: I) -> Self {
        let mut peak = 0.0f32;
        let mut sum_squares = 0.0f64;
        let mut count = 0usize;

        for sample in samples {
            let magnitude = sample.abs();
            if magnitude > peak {
                peak = magnitude;
            }
            sum_squares += (sample as f64) * (sample as f64);
            count += 1;
        }

        if count == 0 {
            return Level::silent();
        }

        let rms = (sum_squares / count as f64).sqrt() as f32;
        Level { peak_db: to_db(peak), rms_db: to_db(rms) }
    }
}

fn to_db(amplitude: f32) -> f32 {
    if amplitude <= 0.0 {
        return SILENCE_DB;
    }
    (20.0 * amplitude.log10()).max(SILENCE_DB)
}

/// A lock-free slot for passing the latest `Level` out of the audio callback.
///
/// The audio thread must never block, so this stores the two floats as raw
/// bits in atomics rather than taking a mutex. Same reason the real capture
/// path will use a lock-free ring buffer once we're moving samples, not just
/// measurements.
#[derive(Debug)]
pub struct SharedLevel {
    peak_db: AtomicU32,
    rms_db: AtomicU32,
}

impl SharedLevel {
    pub fn new() -> Self {
        SharedLevel {
            peak_db: AtomicU32::new(SILENCE_DB.to_bits()),
            rms_db: AtomicU32::new(SILENCE_DB.to_bits()),
        }
    }

    pub fn store(&self, level: Level) {
        self.peak_db.store(level.peak_db.to_bits(), Ordering::Relaxed);
        self.rms_db.store(level.rms_db.to_bits(), Ordering::Relaxed);
    }

    pub fn load(&self) -> Level {
        Level {
            peak_db: f32::from_bits(self.peak_db.load(Ordering::Relaxed)),
            rms_db: f32::from_bits(self.rms_db.load(Ordering::Relaxed)),
        }
    }
}

impl Default for SharedLevel {
    fn default() -> Self {
        Self::new()
    }
}
