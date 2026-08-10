# meeting-copilot

Realtime meeting assistant, built bottom-up. Windows first.

A window showing a live transcript of both sides of a call, which answers
questions the other side asks. Local speech recognition, cloud LLM.

Educational project. The design and the reasoning behind each choice are in
[docs/superpowers/specs/2026-08-10-live-transcript-copilot-design.md](docs/superpowers/specs/2026-08-10-live-transcript-copilot-design.md).

## Status

Phase 3 of 5 complete: both sides of a conversation transcribed live, in a
window.

| Phase | | |
|---|---|---|
| 1 | Capture to clean 16 kHz mono | **done** |
| 2 | Whisper, transcript in a terminal | **done** |
| 3 | Tauri window and UI | **done** |
| 4 | Turn detection | next |
| 5 | Streaming answers from Claude | |

```
┌──────────────────────────────────────────────────────────┐
│ ● meeting copilot                            ggml-base.en│
│   YOU  ▁▃▅▂░░░░░░  Microphone (3- GXT 450 Gaming Headset) │
│   THEM ▁▁▁▁░░░░░░  27G2G5 (NVIDIA High Definition Audio)  │
├──────────────────────────────────────────────────────────┤
│  THEM   So, walk me through how you would design a rate  │
│         limiter.                                         │
│  THEM   What happens when the cache is cold?             │
├──────────────────────────────────────────────────────────┤
│  3 lines                                                 │
└──────────────────────────────────────────────────────────┘
```

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

**Recognition works on real audio.** Not just on scripted test sentences — a
YouTube video playing through the speakers came back transcribed verbatim
through the loopback lane, alongside synthesized speech, correctly separated
from the microphone lane.

```
[00:00] THEM  So, walk me through how you would design a rate limiter.   (4.0s audio, 364ms to transcribe)
[00:08] THEM  What happens when the cache is cold?                       (2.7s audio, 255ms to transcribe)
[00:11] THEM  Great, that makes sense to me.                             (3.9s audio, 266ms to transcribe)
```

Recognition latency, measured on this machine with `base.en`:

| | per utterance |
|---|---|
| CPU, Ryzen 3700X, 14 threads | ~960–1070 ms |
| CUDA, RTX 3090 | **~180–460 ms** |

## Running it

```sh
cd native

cargo run -p copilot-tauri                        # the app
cargo test -p copilot-core                        # 58 tests, no model needed
cargo run -p copilot-core --example live_transcript   # same thing, terminal
cargo run -p copilot-core --example dump_wav      # record 10 s of both lanes

cargo run -p audio-probe                          # the original level meters
```

Add `--release --features cuda` to run recognition on the GPU, which is worth
roughly a 4x cut in latency.

`cargo test --no-default-features` builds and tests the whole engine against
the mock transcriber, with no cmake, no LLVM, and no model file. Only the
recognition itself needs those.

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
    src/stt/
      mod.rs           the Transcriber seam
      segmenter.rs     where one utterance ends and the next begins
      whisper.rs       whisper.cpp, optional behind a feature
      hallucination.rs filtering text whisper invented
      mock.rs          a scripted transcriber, so tests need no model
    src/event.rs       the Event enum - the whole UI contract
    src/session.rs     runs both lanes on a thread, emits events
    examples/dump_wav.rs
    examples/live_transcript.rs
  copilot-tauri/     the window. ~100 lines of Rust plus plain HTML/CSS/JS.
    src/main.rs
    capabilities/    what the window is permitted to do
    ui/              no framework, no build step, no dependencies
```

The engine never learns that a UI exists. `Event` is the only thing that
crosses out of it, which is what keeps the shell replaceable — the same
`ui/` files would work unchanged against a WebSocket instead of Tauri.

Two things about Tauri worth knowing before the first run, because both fail
silently in ways that look like the audio is broken:

- **Nothing is permitted by default.** Without `capabilities/default.json`
  the interface cannot even subscribe to its own event channel, and the only
  sign is a permissions message where the transcript should be.
- **Events emitted during `setup()` are dropped**, because the webview has
  not attached a listener yet. So the interface calls `start` once it *is*
  listening, rather than the backend starting on its own and hoping. That
  also means a startup failure is visible instead of lost.

The capture callback runs on a realtime thread with a deadline of a few
milliseconds, so it does exactly one thing: copy samples into the ring. No
locking, no allocating, no filtering. Everything expensive happens on the
reader's thread, where being late costs nothing. When the reader falls behind,
the writer discards samples and counts them rather than blocking — a hole in
one lane beats a stall that damages every stream.

## Known gaps

- **Loopback captures everything.** Demonstrated rather than theoretical: a
  YouTube video playing in the background was transcribed into the THEM lane
  alongside the test speech. Correct behaviour for system audio, but it means
  a session picks up whatever else the machine is playing.
- **Continuous audio never ends an utterance.** Speech detection ends a
  segment on silence, so a video playing without pause produces 15-second
  chunks at the length cap rather than sentence-sized ones.
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

## Build prerequisites

Only needed for recognition. `--no-default-features` needs none of them.

- `winget install Kitware.CMake` — builds whisper.cpp.
- `winget install LLVM.LLVM` — bindgen needs `libclang.dll`, and Visual Studio
  does not ship one. Set `LIBCLANG_PATH=C:\Program Files\LLVM\bin`.
- The model: `models/ggml-base.en.bin`, 141 MB, from
  <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin>

For `--features cuda`, additionally:

- `winget install Nvidia.CUDA` — the driver alone is not enough, the toolkit
  is what supplies `nvcc`.
- `CUDA_PATH` **and** `CUDA_PATH_V13_3` must both be set. The MSBuild
  integration reads the versioned one, and without it the build fails with
  `The CUDA Toolkit directory '' does not exist`.
- At runtime, `CUDA\v13.3\bin\x64` must be on `PATH`. CUDA 13 moved the
  runtime DLLs there from `bin`; without it the binary exits immediately with
  `0xC0000135`, no message.

For phase 5, an Anthropic API key from console.anthropic.com. A Claude Code
subscription is **not** an API key — the API is billed separately.
