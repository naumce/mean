//! Interleaved multi-channel audio down to mono.
//!
//! Capture delivers frames interleaved — `[L0, R0, L1, R1, ...]` — and speech
//! recognition wants a single channel. Averaging the channels is the right
//! move here rather than picking one: a headset mic may be wired to only one
//! side, and dropping the wrong channel silently yields silence.

/// Appends the mono downmix of `interleaved` to `out`.
///
/// Appends rather than replaces so a caller can accumulate across capture
/// callbacks without a copy. A trailing partial frame (fewer samples than
/// `channels`) is ignored — it is not a complete moment in time.
pub fn downmix_to_mono(interleaved: &[f32], channels: u16, out: &mut Vec<f32>) {
    let channels = channels.max(1) as usize;

    if channels == 1 {
        out.extend_from_slice(interleaved);
        return;
    }

    let divisor = channels as f32;
    out.extend(
        interleaved
            // `chunks_exact` is what discards the trailing partial frame.
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / divisor),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_passes_through_unchanged() {
        let mut out = Vec::new();
        downmix_to_mono(&[0.1, -0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn stereo_averages_the_two_channels() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 0.0, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.0]);
    }

    #[test]
    fn a_channel_of_silence_halves_rather_than_erases() {
        // The headset-wired-to-one-side case. The signal must survive.
        let mut out = Vec::new();
        downmix_to_mono(&[0.8, 0.0, 0.6, 0.0], 2, &mut out);
        assert_eq!(out, vec![0.4, 0.3]);
    }

    #[test]
    fn surround_averages_every_channel() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 6, &mut out);
        assert_eq!(out, vec![3.5]);
    }

    #[test]
    fn trailing_partial_frame_is_ignored() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 1.0, 0.5], 2, &mut out);
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn output_is_appended_not_replaced() {
        let mut out = vec![9.0];
        downmix_to_mono(&[1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![9.0, 1.0]);
    }
}
