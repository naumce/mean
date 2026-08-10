//! Opening a lane and pulling recognition-ready audio out of it.
//!
//! A *lane* is one side of the conversation. `Microphone` is you.
//! `SystemOutput` is everyone else — on Windows you get it by opening the
//! *render* endpoint for input, and WASAPI hands back the post-mix output
//! stream. No virtual cable, no driver, no elevation.
//!
//! The division of labour here is the important part. The capture callback
//! runs on a realtime thread, so it does exactly one thing: copy samples into
//! the ring. No filtering, no channel mixing, no allocation. Everything that
//! costs real time — downmixing, resampling — happens on whichever thread
//! calls [`Lane::read`], where being late costs nothing.

use anyhow::{anyhow, bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};

use crate::audio::convert::downmix_to_mono;
use crate::audio::resample::Decimator;
use crate::audio::ring::{ring, RingReader};
use crate::config::STT_SAMPLE_RATE;

/// Roughly two seconds of 48 kHz stereo. Sized for the worst stall the
/// consumer might hit, not the average one — if this overflows the transcript
/// gets holes, so headroom is cheap insurance.
const RING_CAPACITY: usize = 48_000 * 2 * 2;

/// How much the reader pulls out of the ring per pass.
const READ_CHUNK: usize = 4_096;

/// Number of filter taps. Enough for about 74 dB of stopband rejection with
/// the Blackman window, which is far more than speech needs.
const FILTER_TAPS: usize = 95;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Your voice.
    Microphone,
    /// Everything the machine is playing — the other side of the call.
    SystemOutput,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Microphone => "YOU",
            Source::SystemOutput => "THEM",
        }
    }
}

/// One side of the conversation, delivering 16 kHz mono.
pub struct Lane {
    pub source: Source,
    pub device_name: String,
    pub input_rate: u32,
    pub channels: u16,

    reader: RingReader,
    /// Interleaved samples pulled from the ring but not yet forming whole
    /// frames. Carried between calls — dropping a partial frame would shift
    /// the channel alignment permanently.
    pending: Vec<f32>,
    mono: Vec<f32>,
    decimator: Decimator,

    /// Dropping the stream stops capture, so it stays owned here.
    _stream: Stream,
}

impl Lane {
    pub fn open(source: Source) -> Result<Lane> {
        let host = cpal::default_host();

        let device = match source {
            Source::Microphone => host
                .default_input_device()
                .ok_or_else(|| anyhow!("no default input device"))?,
            Source::SystemOutput => host
                .default_output_device()
                .ok_or_else(|| anyhow!("no default output device"))?,
        };

        let device_name = device.name().unwrap_or_else(|_| "<unnamed>".into());
        let supported = supported_config(&device, source)
            .with_context(|| format!("no usable capture format on '{device_name}'"))?;

        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let input_rate = config.sample_rate.0;
        let channels = config.channels;

        // Integer decimation only. 48 kHz and 32 kHz divide into 16 kHz;
        // 44.1 kHz does not, and pretending otherwise would quietly play the
        // audio back at the wrong speed.
        if input_rate % STT_SAMPLE_RATE != 0 {
            bail!(
                "'{device_name}' runs at {input_rate} Hz, which is not a whole multiple \
                 of the {STT_SAMPLE_RATE} Hz speech recognition needs. Fractional \
                 resampling is not implemented yet."
            );
        }
        let factor = (input_rate / STT_SAMPLE_RATE) as usize;

        let (mut writer, reader) = ring(RING_CAPACITY);
        let on_error = |err| eprintln!("audio stream error: {err}");

        // The callback below is the realtime path. It copies and returns.
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    writer.write(data);
                },
                on_error,
                None,
            ),
            SampleFormat::I16 => {
                // Pre-allocated so the conversion never allocates while the
                // realtime deadline is running.
                let mut scratch = vec![0.0f32; RING_CAPACITY];
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let n = data.len().min(scratch.len());
                        for (out, &sample) in scratch[..n].iter_mut().zip(data) {
                            *out = sample as f32 / -(i16::MIN as f32);
                        }
                        writer.write(&scratch[..n]);
                    },
                    on_error,
                    None,
                )
            }
            other => bail!("unsupported sample format on '{device_name}': {other:?}"),
        }
        .with_context(|| format!("could not open capture stream on '{device_name}'"))?;

        stream.play().context("could not start capture stream")?;

        Ok(Lane {
            source,
            device_name,
            input_rate,
            channels,
            reader,
            pending: Vec::with_capacity(READ_CHUNK * 2),
            mono: Vec::with_capacity(READ_CHUNK),
            decimator: Decimator::new(factor, FILTER_TAPS),
            _stream: stream,
        })
    }

    /// Appends whatever 16 kHz mono audio has arrived since the last call and
    /// returns how many samples that was. Returns zero rather than waiting.
    pub fn read(&mut self, out: &mut Vec<f32>) -> usize {
        let before = out.len();
        let channels = self.channels as usize;

        let mut scratch = [0.0f32; READ_CHUNK];
        loop {
            let count = self.reader.read(&mut scratch);
            if count == 0 {
                break;
            }
            self.pending.extend_from_slice(&scratch[..count]);
        }

        // Only whole frames can be downmixed. Anything left over waits for
        // the rest of its frame to arrive.
        let whole = (self.pending.len() / channels) * channels;
        if whole > 0 {
            self.mono.clear();
            downmix_to_mono(&self.pending[..whole], self.channels, &mut self.mono);
            self.pending.drain(..whole);
            self.decimator.process(&self.mono, out);
        }

        out.len() - before
    }

    /// Samples the capture thread had to discard because this lane was not
    /// read often enough. Anything above zero means a hole in the audio.
    pub fn dropped(&self) -> u64 {
        self.reader.dropped()
    }
}

/// The microphone advertises input configs. A render endpoint being opened
/// for loopback advertises *output* configs, so we have to ask for the right
/// list or we get "no config" on a device that works fine.
fn supported_config(device: &Device, source: Source) -> Result<SupportedStreamConfig> {
    match source {
        Source::Microphone => device
            .default_input_config()
            .context("device reported no default input config"),
        Source::SystemOutput => device
            .default_output_config()
            .context("device reported no default output config"),
    }
}
