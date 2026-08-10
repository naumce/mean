//! 48 kHz down to 16 kHz.
//!
//! The rates divide evenly, so this is decimation by three — keep every third
//! sample. The catch is that you cannot just keep every third sample. Halving
//! the rate to 16 kHz drops the Nyquist limit to 8 kHz, and anything above
//! that in the original signal does not disappear: it folds back down and
//! reappears as a lower tone that was never there. That is aliasing.
//!
//! It is easy to miss by ear on speech and it measurably hurts recognition
//! accuracy, so the fix is not optional: low-pass below the new Nyquist
//! first, then decimate.
//!
//! The filter is a windowed-sinc FIR. An ideal low-pass is a sinc function in
//! the time domain, but sinc runs forever, so it gets truncated to a finite
//! number of taps and multiplied by a window that tapers the ends smoothly.
//! Chopping it off squarely instead would ring badly in the frequency domain.

/// Stateful decimating low-pass filter.
///
/// Stateful matters. Audio arrives in chunks and a FIR needs the samples that
/// came before the current chunk to compute its first outputs. Without that
/// carried history every chunk boundary becomes a discontinuity — an audible
/// click, and one the recognizer sees too.
pub struct Decimator {
    factor: usize,
    taps: Vec<f32>,
    /// The last `taps.len() - 1` input samples, so the filter can reach back
    /// across the chunk boundary.
    history: Vec<f32>,
    /// How many inputs to skip before the next output. Carried across chunks
    /// so the output spacing stays exactly `factor` forever.
    phase: usize,
}

impl Decimator {
    /// A decimator reducing the sample rate by `factor`, using `taps` filter
    /// coefficients. More taps means a sharper cutoff and more work.
    pub fn new(factor: usize, taps: usize) -> Self {
        assert!(factor >= 1, "decimation factor must be at least 1");
        assert!(taps >= 3, "a filter needs at least a few taps");

        // An odd tap count makes the filter symmetric about a real sample,
        // which gives it a whole-sample delay instead of a half-sample one.
        let taps = if taps % 2 == 0 { taps + 1 } else { taps };

        // Cutoff as a fraction of the *input* sample rate. Decimating by
        // three drops Nyquist from half the input rate to a sixth of it, and
        // that sixth is exactly where the filter has to cut.
        let cutoff = 0.5 / factor as f32;

        Self {
            factor,
            taps: windowed_sinc(taps, cutoff),
            history: vec![0.0; taps - 1],
            phase: 0,
        }
    }

    /// The 48 kHz to 16 kHz case, which is the only one this project needs.
    pub fn to_16k_from_48k() -> Self {
        Self::new(3, 95)
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Filters and decimates `input`, appending the result to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }

        let width = self.taps.len();
        // `history` holds exactly `width - 1` samples on the way in, so
        // appending the chunk gives one contiguous run the filter can slide
        // across without a special case at the join.
        self.history.extend_from_slice(input);

        // `position` indexes the extended buffer; `phase` carried it over
        // from the previous chunk, which is what keeps the output spacing
        // exactly `factor` across a boundary rather than restarting at zero.
        let mut position = self.phase;
        while position + width <= self.history.len() {
            let window = &self.history[position..position + width];
            let sample = window
                .iter()
                .zip(&self.taps)
                .map(|(sample, tap)| sample * tap)
                .sum();
            out.push(sample);
            position += self.factor;
        }

        // Retire the samples this chunk contributed and carry the tail, so
        // the next call starts from the same state a continuous run would.
        self.history.drain(..input.len());
        self.phase = position - input.len();
    }
}

/// Coefficients for a low-pass FIR, by windowing an ideal sinc.
///
/// `cutoff` is in cycles per sample. The result is normalized to unity gain
/// at DC, so a constant signal comes through at its original amplitude and
/// the filter neither boosts nor attenuates overall level.
fn windowed_sinc(taps: usize, cutoff: f32) -> Vec<f32> {
    use std::f32::consts::{PI, TAU};

    let last = (taps - 1) as f32;
    let mut coefficients: Vec<f32> = (0..taps)
        .map(|i| {
            let t = i as f32 - last / 2.0;

            // The ideal low-pass impulse response, with its removable
            // singularity at t = 0 filled in by the limit.
            let ideal = if t.abs() < f32::EPSILON {
                2.0 * cutoff
            } else {
                (TAU * cutoff * t).sin() / (PI * t)
            };

            // Blackman window: truncating the sinc squarely would ring in the
            // frequency domain and leak the stopband back in. Blackman trades
            // a slightly wider transition for about 74 dB of rejection, which
            // is far more than enough here.
            let x = TAU * i as f32 / last;
            let window = 0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos();

            ideal * window
        })
        .collect();

    let dc_gain: f32 = coefficients.iter().sum();
    for coefficient in &mut coefficients {
        *coefficient /= dc_gain;
    }
    coefficients
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    const IN_RATE: f32 = 48_000.0;

    fn sine(freq: f32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|n| (TAU * freq * n as f32 / IN_RATE).sin())
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        if x.is_empty() {
            return 0.0;
        }
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    fn db(ratio: f32) -> f32 {
        20.0 * ratio.max(1e-12).log10()
    }

    /// Skips the filter's warm-up, where the history is still filling and the
    /// output is legitimately not yet at full amplitude.
    fn settled(x: &[f32]) -> &[f32] {
        &x[x.len() / 4..]
    }

    #[test]
    fn output_rate_is_a_third_of_the_input_rate() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        d.process(&sine(1_000.0, 4_800), &mut out);
        // One output per three inputs, give or take the filter's startup.
        assert!(
            (out.len() as i64 - 1_600).abs() <= 1,
            "expected about 1600 samples, got {}",
            out.len()
        );
    }

    #[test]
    fn speech_range_tone_survives_at_full_amplitude() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        let input = sine(1_000.0, 48_000);
        d.process(&input, &mut out);

        let loss = db(rms(settled(&out)) / rms(&input));
        assert!(
            loss.abs() < 0.5,
            "1 kHz should pass untouched, lost {loss:.2} dB"
        );
    }

    #[test]
    fn tone_just_below_the_new_nyquist_still_passes() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        let input = sine(6_000.0, 48_000);
        d.process(&input, &mut out);

        let loss = db(rms(settled(&out)) / rms(&input));
        assert!(
            loss > -3.0,
            "6 kHz is inside the passband, lost {loss:.2} dB"
        );
    }

    /// The test the whole module exists for. Without an anti-alias filter,
    /// 15 kHz folds down to 1 kHz and comes through at full strength.
    #[test]
    fn tone_above_the_new_nyquist_is_rejected_rather_than_folded_down() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        let input = sine(15_000.0, 48_000);
        d.process(&input, &mut out);

        let rejection = db(rms(settled(&out)) / rms(&input));
        assert!(
            rejection < -40.0,
            "15 kHz must be filtered out before decimating, only got {rejection:.1} dB \
             of rejection - it is aliasing down into the speech band"
        );
    }

    /// Real capture arrives in chunks whose size we do not control. Filtering
    /// them one at a time must give exactly what filtering the whole stream
    /// at once would, or every chunk boundary is a click.
    #[test]
    fn chunked_input_matches_processing_it_all_at_once() {
        let input = sine(1_000.0, 9_600);

        let mut whole = Vec::new();
        Decimator::to_16k_from_48k().process(&input, &mut whole);

        let mut chunked = Vec::new();
        let mut d = Decimator::to_16k_from_48k();
        // A deliberately awkward chunk size, not a multiple of the factor,
        // so a decimator that resets its phase each call gets caught.
        for chunk in input.chunks(137) {
            d.process(chunk, &mut chunked);
        }

        assert_eq!(whole.len(), chunked.len(), "chunking changed the length");
        for (i, (a, b)) in whole.iter().zip(&chunked).enumerate() {
            assert!(
                (a - b).abs() < 1e-5,
                "sample {i} differs: {a} whole vs {b} chunked"
            );
        }
    }

    #[test]
    fn silence_in_gives_silence_out() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        d.process(&vec![0.0; 4_800], &mut out);
        assert!(out.iter().all(|s| s.abs() < 1e-9));
    }

    #[test]
    fn an_empty_chunk_is_harmless() {
        let mut d = Decimator::to_16k_from_48k();
        let mut out = Vec::new();
        d.process(&[], &mut out);
        assert!(out.is_empty());
    }
}
