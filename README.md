# meeting-copilot

Realtime meeting assistant, built bottom-up. Windows first.

## Status

Spike stage. Exactly one thing is built and proven: dual audio capture.

## What's proven

`native/audio-probe` opens both capture streams at once and reports live levels.

Verified on Windows 11 (Rust 1.89):

```
MIC     ok    Microphone (3- GXT 450 Gaming Headset) — 48000 Hz, 2 ch, F32
SYSTEM  ok    27G2G5 (NVIDIA High Definition Audio) — 48000 Hz, 2 ch, F32

Loudest seen:
  MIC      -57.0 dB peak  — received audio
  SYSTEM   -25.8 dB peak  — received audio
```

The `SYSTEM` reading is the one that mattered: it sits at the -90 dB silence
floor with nothing playing and jumps to -25.8 dB when audio starts, which
proves WASAPI loopback is delivering real samples rather than just opening a
stream successfully.

### Why loopback is the interesting half

`MIC` is an ordinary WASAPI capture endpoint — nothing notable. `SYSTEM` is
the far side of a call, and on Windows you get it by opening the *render*
endpoint for input; WASAPI then hands back the post-mix output stream. No
virtual audio cable, no kernel driver, no elevation. This is the piece that
costs real effort on macOS (Core Audio process taps on 14.4+, or
ScreenCaptureKit) and is nearly free here.

## Running it

```sh
cd native/audio-probe

cargo run                          # live meters, Ctrl+C to stop
cargo run -- --seconds 5           # live meters, then exit
cargo run -- --seconds 5 --quiet   # no meters, just a loudest-seen summary
```

Talk to move `MIC`. Play anything to move `SYSTEM`.

## Layout

```
native/audio-probe/
  src/main.rs      CLI, render loop, summary reporting
  src/capture.rs   WASAPI stream setup for both sources
  src/level.rs     sample blocks -> dBFS, and the lock-free handoff
  src/meter.rs     terminal bar rendering
```

`level.rs` uses atomics rather than a mutex to move readings off the audio
thread. That's overkill for a level meter, but it's the pattern the real
capture path needs — the audio callback must never block — so it's set up
correctly from the start.

## Known gaps

Things this spike deliberately does not handle yet:

- **Device following.** Both streams bind to whatever is default at startup.
  Unplug a headset mid-session and the stream dies rather than migrating.
- **Clock drift.** The mic and render endpoints run on independent hardware
  clocks. Over a long session the two streams drift apart, so anything that
  correlates them needs buffer timestamps and resampling to a shared timeline.
- **Format conversion.** Capture is 48 kHz stereo f32; speech recognition
  wants 16 kHz mono PCM. Downmix and resample aren't written yet.
- **Self-capture.** Loopback picks up *everything* the machine plays,
  including notification sounds and our own audio.
- **Per-process capture.** Capturing one application by PID needs
  `ActivateAudioInterfaceAsync` with `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`
  (Win10 20H1+), which cpal doesn't expose. That's a direct-to-WASAPI change.

## Next

Direction not chosen yet. The capture layer above is common to any of them.
