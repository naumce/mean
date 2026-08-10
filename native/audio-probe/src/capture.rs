//! Opening the two capture streams we care about: the microphone, and a
//! loopback of whatever the system is playing.
//!
//! On Windows both go through WASAPI. The microphone is an ordinary capture
//! endpoint. System audio is the interesting one: you open the *render*
//! endpoint for input, and WASAPI hands back the post-mix output stream.
//! No virtual cable, no driver, no admin rights.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use std::sync::Arc;

use crate::level::{Level, SharedLevel};

/// Which of the two streams to open.
#[derive(Clone, Copy, Debug)]
pub enum Source {
    /// Your voice.
    Microphone,
    /// Everything the machine is playing — the other side of the call.
    SystemOutput,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Microphone => "MIC",
            Source::SystemOutput => "SYSTEM",
        }
    }
}

/// A running capture stream and the most recent level measured from it.
pub struct Capture {
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: SampleFormat,
    shared: Arc<SharedLevel>,
    /// Dropping the stream stops capture, so it stays owned here.
    _stream: Stream,
}

impl Capture {
    pub fn open(source: Source) -> Result<Capture> {
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
        let shared = Arc::new(SharedLevel::new());

        let stream = build_stream(&device, &config, sample_format, Arc::clone(&shared))
            .with_context(|| format!("could not open capture stream on '{device_name}'"))?;
        stream.play().context("could not start capture stream")?;

        Ok(Capture {
            device_name,
            sample_rate: config.sample_rate.0,
            channels: config.channels,
            sample_format,
            shared,
            _stream: stream,
        })
    }

    pub fn level(&self) -> Level {
        self.shared.load()
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

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    shared: Arc<SharedLevel>,
) -> Result<Stream> {
    let on_error = |err| eprintln!("\naudio stream error: {err}");

    // Each arm moves `shared` into its own closure. Only one arm ever runs,
    // so the moves don't conflict.
    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| shared.store(Level::from_iter(data.iter().copied())),
            on_error,
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                shared.store(Level::from_iter(
                    data.iter().map(|&s| s as f32 / -(i16::MIN as f32)),
                ))
            },
            on_error,
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                shared.store(Level::from_iter(
                    data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0),
                ))
            },
            on_error,
            None,
        )?,
        other => return Err(anyhow!("unsupported sample format: {other:?}")),
    };

    Ok(stream)
}
