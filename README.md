# meeting-copilot

Realtime meeting assistant, built bottom-up. Windows first.

A window showing a live transcript of both sides of a call, which answers
questions the other side asks. Local speech recognition, cloud LLM.

Educational project. The design and the reasoning behind each choice are in
[docs/superpowers/specs/2026-08-10-live-transcript-copilot-design.md](docs/superpowers/specs/2026-08-10-live-transcript-copilot-design.md).

## Status

Phase 1 of 5 complete: audio capture through to recognition-ready PCM.

| Phase | | |
|---|---|---|
| 1 | Capture to clean 16 kHz mono | **done** |
| 2 | Whisper, transcript in a terminal | next |
| 3 | Tauri window and UI | |
| 4 | Turn detection | |
| 5 | Streaming answers from Claude | |

## What's proven

**Both lanes capture at once.** The microphone is you; a WASAPI loopback of
the render endpoint is everyone else. No virtual cable, no driver, no
elevation. This is the piece that costs real effort on macOS and is nearly
free on Windows.

**The conversion to 16 kHz mono is correct.** Verified two ways:

*By measurement* — a 1000 Hz tone played at 48 kHz stereo comes back out of
the pipeline at 1000 Hz, 16 kHz mono. Pitch preserved exactly, so the rate
conversion is right.

```
E:\meeting-copilot\them.wav
   rate        16000 Hz, 1 ch, 6.02 s
   peak        -22.0 dB
   dominant    1000 Hz          <- played 1000 Hz
```

*By unit test* — 30 tests over the audio modules. The one that matters most:

```
tone_above_the_new_nyquist_is_rejected_rather_than_folded_down
```

Decimating 48 kHz to 16 kHz drops the Nyquist limit to 8 kHz, and anything
above it does not vanish — it folds back down as a tone that was never there.
That is inaudible enough to miss by ear and it measurably degrades recognition
accuracy. The test asserts a 15 kHz tone is attenuated by more than 40 dB
before decimation, which fails outright if the anti-alias filter is missing.

## Running it

```sh
cd native

cargo test -p copilot-core                        # the audio pipeline
cargo run -p copilot-core --example dump_wav      # record 10 s of both lanes

cargo run -p audio-probe                          # the original level meters
```

`dump_wav` writes `you.wav` and `them.wav` at 16 kHz mono, prints where the
voice detector fired, and reports whether any samples were dropped. Play the
files — your voice should sound normal. Wrong speed, a metallic edge, or
crackling at regular intervals each point at a different bug.

## Layout

```
native/
  audio-probe/       the original spike. left alone as a known-good reference.
  copilot-core/      the engine. no window, no HTTP, no Tauri.
    src/config.rs      every tunable, with the reasoning attached
    src/capture/       WASAPI lanes; the callback only copies
    src/audio/
      convert.rs       interleaved stereo -> mono
      resample.rs      48k -> 16k, windowed-sinc low-pass then decimate
      ring.rs          lock-free handoff off the audio thread
      vad.rs           energy + hysteresis + hangover
    examples/dump_wav.rs
```

The capture callback runs on a realtime thread with a deadline of a few
milliseconds, so it does exactly one thing: copy samples into the ring. No
locking, no allocating, no filtering. Everything expensive happens on the
reader's thread, where being late costs nothing. When the reader falls behind,
the writer discards samples and counts them rather than blocking — a hole in
one lane beats a stall that damages every stream.

## Known gaps

- **Speaker bleed.** If the far side plays through speakers rather than
  headphones, the microphone picks it up and both lanes transcribe the same
  words. Use headphones. Lane-gating by relative level is the real fix.
- **Only whole-number rate conversion.** 48 kHz and 32 kHz divide into 16 kHz.
  44.1 kHz does not, and a device running at it is rejected with a clear error
  rather than played back at the wrong speed. Fractional resampling is not
  written yet.
- **Device following.** Both lanes bind to whatever is default at startup.
  Unplug a headset mid-session and the stream dies rather than migrating.
- **Clock drift.** The two endpoints run on independent hardware clocks, so
  over a long session the lanes drift apart. Correlating them needs buffer
  timestamps and resampling to a shared timeline.
- **Self-capture.** Loopback picks up everything the machine plays, including
  notification sounds.
- **Per-process capture.** Capturing one application by PID needs
  `ActivateAudioInterfaceAsync` with `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`
  (Win10 20H1+), which cpal does not expose.

## Prerequisites for later phases

- `cmake` — `winget install Kitware.CMake`. Needed to build whisper.cpp at
  phase 2.
- A whisper model, `ggml-base.en.bin`, about 150 MB. Phase 2.
- An Anthropic API key from console.anthropic.com. A Claude Code subscription
  is **not** an API key; the API is billed separately. Phase 5.
- CUDA Toolkit — optional. Only if CPU recognition latency proves annoying.
