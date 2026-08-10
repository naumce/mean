# Live transcript copilot — design

Date: 2026-08-10
Status: approved, not yet implemented

## Goal

A desktop window showing a live transcript of both sides of a call, which
automatically answers questions the other side asks.

Educational project. Windows first. Local speech recognition, cloud LLM.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Speech recognition | Local, whisper.cpp via `whisper-rs` | No account, no per-minute billing, audio never leaves the machine. An RTX 3090 is present but the CUDA Toolkit is not, so **CPU first** — a Ryzen 3700X runs `base.en` on a few seconds of audio in a few hundred ms. CUDA is a later feature flag, not a redesign. |
| LLM | Cloud, Anthropic Messages API | Transcript text is tiny and cheap to send; raw audio is not. Pay the cloud only where the cloud is better. |
| Shell | Tauri v2 | Rust backend natively — no napi module, no FFI boundary, no second package manager. ~10 MB binary. WebView2 ships with Windows 11. |
| Scope | Transcript **and** automatic answers | Chosen deliberately over transcript-only. Turn detection is isolated as a pure function so it can be tuned against unit tests rather than by talking at a laptop. |

## Architecture

Three crates. The engine never knows a UI exists.

```
native/
  audio-probe/     the existing spike — left alone, the "known good" reference
  copilot-core/    lib crate. all the hard parts. no window, no HTTP, no Tauri.
  copilot-tauri/   bin crate. window + ui/ + a thin bridge to core.
```

Two **lanes** run as independent, identical pipelines:

```
  YOU (mic)                          THEM (loopback)
     │                                     │
  48k stereo f32                     48k stereo f32
     ↓ convert.rs   downmix to mono        ↓
     ↓ resample.rs  low-pass → 16k         ↓
     ↓ ring.rs      hand off               ↓   ← nothing below here runs
     ↓ vad.rs       voiced? / silent?      ↓     on the audio thread
     ↓ segmenter.rs cut into utterances    ↓
     ↓ whisper.rs   utterance → text       ↓
     └──────────────┬──────────────────────┘
                    ↓
              turn/heuristic.rs   ← watches BOTH lanes
                    ↓
              llm/anthropic.rs    ← streams tokens back
                    ↓
              event.rs  →  JSON  →  webview
```

Because `Event` is the only thing crossing into the UI, replacing Tauri with a
plain WebSocket server later changes the transport and nothing else.

### Modules

| File | Job |
|---|---|
| `event.rs` | The `Event` enum, serde-serialized. The UI contract. |
| `config.rs` | Every tunable in one place — VAD threshold, hangover, fire delay, model path, context window. No magic numbers elsewhere. |
| `capture/mod.rs` | Promoted from the spike. |
| `capture/device.rs` | Device selection and default-device following. |
| `audio/ring.rs` | Lock-free SPSC ring. The audio callback never blocks, allocates, or locks. |
| `audio/convert.rs` | Interleaved stereo f32 → mono f32. |
| `audio/resample.rs` | 48k → 16k. Low-pass, then decimate by 3. |
| `audio/vad.rs` | Energy + hangover voice-activity detection. |
| `stt/mod.rs` | `trait Transcriber` — the seam that lets tests run with no model file. |
| `stt/segmenter.rs` | VAD stream → utterance boundaries. |
| `stt/whisper.rs` | `whisper-rs` implementation. |
| `stt/mock.rs` | Scripted transcriber for tests. |
| `turn/mod.rs` | `TurnState` and the pure `decide()` function. |
| `turn/heuristic.rs` | The default policy. |
| `llm/mod.rs` | `trait Responder`. |
| `llm/prompt.rs` | Transcript window → request messages. |
| `llm/anthropic.rs` | SSE streaming client. |
| `llm/mock.rs` | Canned streaming for tests. |
| `session.rs` | Wires the lanes together, fans out events. |

Three seams — `Transcriber`, `TurnPolicy`, `Responder` — each with a real
implementation and a mock. This is what makes the hard logic testable without a
microphone, a GPU, or an API key.

## Resampling

48 kHz → 16 kHz is a clean integer decimation by 3, but only after low-passing
below the new 8 kHz Nyquist. Skipping the filter folds everything above 8 kHz
back down as aliasing, which is inaudible to a casual listen and measurably
degrades recognition accuracy.

Implementation: a windowed-sinc FIR, then take every third sample. `rubato` is
the alternative if the hand-rolled filter proves fiddly.

## Voice activity detection

Energy-based with hysteresis and a hangover:

- Enter *voiced* when short-term RMS crosses `vad_enter_db`.
- Leave *voiced* only after `vad_hangover_ms` continuously below `vad_exit_db`.

Two thresholds rather than one prevents chattering at the boundary. The
hangover prevents cutting a word in half at a natural pause.

This is deliberately cheap. A neural VAD (Silero) is better in noise, but the
two lanes are already physically separated, which removes most of the problem
a neural VAD exists to solve.

## Segmentation and whisper

The segmenter accumulates voiced audio and emits an utterance when the lane
goes silent past the hangover, or when the buffer exceeds `max_utterance_ms`
(a hard cap so a monologue still produces text).

**Transcript appears at utterance end, not word by word.** Whisper is not a
streaming model. Getting live partials means re-running it on the growing
buffer every few hundred ms and replacing the text as it firms up — a known
technique, but it multiplies compute and adds flicker. First version is
finals-only; sliding partials are a later enhancement with the `Partial` event
already reserved in the protocol.

**Hallucination guard.** Whisper reliably invents text on near-silent input —
"Thank you.", "Thanks for watching!", subtitle credits. Two mitigations: never
feed it a segment the VAD did not mark voiced, and filter finals against a
known-hallucination blocklist.

## Turn detection

The hard part, and the reason it is a pure function over an event log with no
I/O of its own.

Fire an answer for a THEM utterance when **all** hold:

1. The THEM lane has been silent for at least `fire_delay_ms` (default 700).
2. The utterance is finalized — real text, not a partial.
3. The YOU lane is not currently voiced. If you are already talking, you are
   already answering; suppress.
4. The utterance passes the worth-answering filter.

**Worth-answering filter**
- Ends with `?` → fire.
- Opens with an interrogative (what / how / why / when / where / who / which /
  can / could / would / do / does / did / is / are / tell me / walk me
  through / explain) → fire.
- Under `min_answer_words` (default 3) with no `?` → suppress. This kills
  backchannel: "mhm", "right", "okay", "got it".
- Otherwise → governed by `answer_mode`: `Questions` (default) or `Everything`.

**Cancellation.** If THEM resumes speaking before the fire delay elapses, the
pending fire is cancelled and the new utterance merges into the previous one.
Thinking pauses mid-sentence are the single most common failure mode of naive
silence timers, and this is the fix.

**Speculative mode** (`speculative: bool`, default off). Fire at 300 ms and
abort the in-flight request if THEM resumes. Buys roughly 400 ms of perceived
latency at the cost of some wasted tokens.

### Tests this makes possible

- Fires on a question after silence.
- Does *not* fire during a mid-sentence pause: "So… what would you do?"
- Does *not* fire while YOU are speaking.
- Does *not* fire on backchannel.
- Cancels a pending fire when THEM resumes.
- Fires exactly once per utterance.

## LLM layer

`trait Responder` returning a stream of text deltas.

- Anthropic Messages API with `stream: true`; parse `content_block_delta` /
  `text_delta` from the SSE stream.
- Default model configurable. Sonnet for quality, Haiku for latency.
- Context is a **rolling window** of the last `context_utterances` (default 30),
  not the whole meeting — bounded cost, bounded latency.
- A new turn firing while a response is streaming aborts the previous request.

**Key handling.** `ANTHROPIC_API_KEY` is read from the environment or a
gitignored `.env`, lives only in the Rust process, and is never sent to the
webview. Anything reaching the renderer ships to whoever has the app.

## UI

One page, two regions, plus a status strip.

```
┌──────────────────────────────────┬─────────────────────┐
│ TRANSCRIPT                       │ ANSWER              │
│                                  │                     │
│ THEM  So walk me through how     │ ▍streaming tokens   │
│       you'd design a rate        │  appear here as     │
│       limiter.                   │  they arrive        │
│ YOU   Sure — the first thing…    │                     │
│                                  │                     │
├──────────────────────────────────┴─────────────────────┤
│ ▁▃▅▂ YOU   ▁▁▁▁ THEM     base.en · GXT 450 · 27G2G5    │
└────────────────────────────────────────────────────────┘
```

A single chronological transcript with lane-labelled entries, because that is
how a conversation reads. Level meters carry over from the spike and stay —
they answer "is audio even arriving?" at a glance, which is the first question
whenever something looks broken.

### Event protocol

```rust
enum Event {
    Status      { stt: SttStatus, you_device: String, them_device: String },
    Level       { lane: Lane, rms_db: f32, peak_db: f32 },
    Partial     { lane: Lane, id: u64, text: String },
    Final       { lane: Lane, id: u64, text: String, start_ms: u64, end_ms: u64 },
    TurnEnd     { lane: Lane, id: u64 },
    AnswerStart { for_id: u64 },
    AnswerDelta { text: String },
    AnswerEnd   { reason: EndReason },   // Complete | Cancelled | Error
    Error       { message: String },
}
```

## Latency budget

End of question → first answer token:

| Stage | CPU / Sonnet | CUDA / Haiku |
|---|---|---|
| VAD hangover | 300 ms | 300 ms |
| Whisper on the utterance | 400–800 ms | 80–150 ms |
| Turn fire delay (partly overlapping) | 700 ms | 700 ms |
| Model time to first token | 500–900 ms | 300–500 ms |
| **Total** | **~1.6–2.4 s** | **~1.0–1.4 s** |

## Risks

1. **Speaker bleed — the concrete one on this machine.** The default output is
   the monitor over HDMI, not the headset. Audio played through monitor
   speakers is picked up by the headset mic, so both lanes transcribe the same
   words and the copilot answers its own echo. Mitigation for now: wear
   headphones. Lane-gating by relative level is the real fix, later.
2. **Loopback captures everything** the machine plays, including notification
   sounds and any audio the app itself produces.
3. **Clock drift.** The mic and render endpoints run on independent hardware
   clocks; over a long session the lanes drift apart. Needs buffer timestamps
   and resampling to a shared timeline.
4. **Device changes kill the stream.** Both lanes bind to whatever is default
   at startup. Addressed by `capture/device.rs`.
5. **Whisper hallucinates on silence.** Handled by the VAD gate and blocklist
   described above.

## Testing

Target 80% on everything except capture.

| Module | Approach |
|---|---|
| `resample.rs` | 1 kHz sine survives; 15 kHz sine attenuated by >40 dB. That single assertion proves the anti-alias filter actually exists. |
| `ring.rs` | Push/pop, wraparound, overflow policy under a producer/consumer pair. |
| `vad.rs` | Synthetic envelopes; assert transition points. |
| `segmenter.rs` | VAD event stream → expected utterance boundaries. |
| `turn/` | The suite listed above. Pure functions, no fixtures. |
| `llm/prompt.rs` | Transcript window → expected message shape. |
| `llm/anthropic.rs` | Mock SSE server; assert delta parsing and abort behaviour. |
| `capture/` | Not unit-testable — needs real hardware. Kept deliberately thin; covered by the existing `audio-probe`. |

## Implementation phases

Each phase ends in something observable. No phase depends on the next existing.

**Phase 1 — audio to clean PCM.** Promote capture into `copilot-core`; add
`convert`, `resample`, `ring`, `vad` with tests. *Observable:* dump 10 s of each
lane to WAV at 16 kHz mono and listen — clean, correct speed, no aliasing.

**Phase 2 — text in a terminal.** `segmenter` + `whisper.rs`. Requires cmake
and a model download. *Observable:* talk, see your words print.

**Phase 3 — the window.** Tauri shell, `ui/`, `event.rs` bridge. *Observable:*
the transcript appears in a real window with live meters.

**Phase 4 — turn detection.** `turn/`, tests first. *Observable:* a `TurnEnd`
marker lands in the UI at the right moment, before any LLM is wired up.

**Phase 5 — answers.** `llm/`. Requires an API key. *Observable:* ask a
question out loud, watch the answer stream in.

## Prerequisites not yet met

- `cmake` — `winget install Kitware.CMake` (needed at Phase 2).
- A whisper model file, `ggml-base.en.bin`, ~150 MB (Phase 2).
- An Anthropic API key from console.anthropic.com. **A Claude Code
  subscription is not an API key** — API access is billed separately (Phase 5).
- CUDA Toolkit — optional, only if CPU latency proves annoying.
