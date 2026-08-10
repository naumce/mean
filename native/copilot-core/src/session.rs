//! Running both lanes and turning them into a stream of events.
//!
//! Everything below this point has been written to be driven by someone else.
//! This is the piece that actually drives it, on its own thread, so a caller
//! only has to supply somewhere for events to go.
//!
//! There are two threads, and the split is not cosmetic.
//!
//! The **capture thread** drains both lanes and cuts them into utterances. It
//! must never do anything slow, because while it is busy the ring buffers
//! keep filling and eventually discard audio. It exists as a thread at all
//! because a cpal stream cannot be moved between threads on Windows, so the
//! lanes must be opened wherever they will live — which is also why startup
//! errors come back over a channel rather than being returned.
//!
//! The **recognition thread** does everything slow: whisper, then turn
//! detection. This was measured, not assumed. With recognition inline, the
//! first CUDA call took 1901 ms while the model warmed up, and the capture
//! side reported 3840 discarded samples — a real hole in the audio, caused
//! entirely by making the wrong thread wait.
//!
//! Speech transitions and finished utterances go down one channel together,
//! so turn detection sees them in the order they happened.

use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::vad::frame_db;
use crate::capture::{Lane as CaptureLane, Source};
use crate::event::{Ending, Event, Lane};
use crate::llm::{prompt, ContextLine, Question, Responder};
use crate::stt::{Segmenter, SegmenterConfig, Transcriber, Utterance};
use crate::turn::{Signal, TurnConfig, TurnDetector};

/// How often the lanes are drained. Well under the length of any utterance,
/// so a segment is never held up waiting to be noticed.
const POLL: Duration = Duration::from_millis(50);

/// How often level meters go out. Twenty a second looks smooth and costs
/// nothing; sending one per poll would be wasted traffic.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);

/// How often turn detection is re-checked when nothing else is happening.
/// Its deciding condition is elapsed time, so something has to ask.
const TURN_TICK: Duration = Duration::from_millis(50);

/// Anywhere events can go. `Sync` as well as `Send` because a UI toolkit will
/// typically want to hold onto this from more than one place.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

/// What the capture thread hands to the recognition thread.
///
/// One channel for both kinds, because turn detection cares about the order
/// they happened in — a speech transition arriving after the transcript it
/// preceded would look like the speaker resuming.
enum Work {
    Speech { lane: Lane, active: bool, at_ms: u64 },
    Utterance { lane: Lane, utterance: Utterance, at_ms: u64 },
}

/// How much transcript is kept for context. Bounded so a long meeting does
/// not grow the process; the request window is smaller again.
const HISTORY_LIMIT: usize = 200;

/// A question handed to the answering thread.
///
/// The generation is what makes cancellation work: the answerer compares the
/// one it started with against the current count, and stops as soon as a
/// newer question exists. On a live call a superseded answer is not merely
/// wasted, it is text on screen that is actively misleading.
struct Ask {
    generation: u64,
    question: Question,
}

pub struct Session {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Session {
    /// Opens both lanes and starts transcribing.
    ///
    /// The transcriber is supplied rather than constructed here, so this
    /// module never needs to know whether recognition is whisper, a mock, or
    /// something not written yet.
    pub fn start(
        transcriber: Box<dyn Transcriber>,
        responder: Option<Box<dyn Responder>>,
        sink: EventSink,
    ) -> Result<Session> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();

        let worker = thread::Builder::new()
            .name("copilot-session".into())
            .spawn({
                let stop = Arc::clone(&stop);
                let sink = Arc::clone(&sink);
                move || run(transcriber, responder, sink, stop, ready_tx)
            })
            .context("could not start the session thread")?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Session {
                stop,
                worker: Some(worker),
            }),
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => anyhow::bail!("the session thread stopped before it was ready"),
        }
    }

    /// Stops the session and waits for the thread to finish, so capture
    /// devices are released before this returns.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One lane, plus everything needed to turn it into utterances.
struct LaneWorker {
    lane: CaptureLane,
    segmenter: Segmenter,
    audio: Vec<f32>,
    which: Lane,
    was_speaking: bool,
    reported_drops: u64,
}

impl LaneWorker {
    fn open(source: Source) -> Result<LaneWorker> {
        Ok(LaneWorker {
            lane: CaptureLane::open(source)?,
            segmenter: Segmenter::new(SegmenterConfig::default()),
            audio: Vec::new(),
            which: source.into(),
            was_speaking: false,
            reported_drops: 0,
        })
    }

    /// Drains the lane, reporting level and speaking changes, and appending
    /// any completed utterances.
    ///
    /// Returns whether speech started or stopped on this pass, which turn
    /// detection needs and the interface has already been told about.
    fn poll(
        &mut self,
        sink: &EventSink,
        send_level: bool,
        out: &mut Vec<Utterance>,
    ) -> Option<bool> {
        self.audio.clear();
        let mut audio = std::mem::take(&mut self.audio);
        self.lane.read(&mut audio);

        if send_level && !audio.is_empty() {
            sink(Event::Level {
                lane: self.which,
                rms_db: frame_db(&audio),
            });
        }

        self.segmenter.push(&audio, out);
        self.audio = audio;

        let speaking = self.segmenter.is_speaking();
        let changed = if speaking != self.was_speaking {
            self.was_speaking = speaking;
            sink(Event::Speaking {
                lane: self.which,
                active: speaking,
            });
            Some(speaking)
        } else {
            None
        };

        let dropped = self.lane.dropped();
        if dropped > self.reported_drops {
            self.reported_drops = dropped;
            sink(Event::Dropped {
                lane: self.which,
                samples: dropped,
            });
        }

        changed
    }
}

fn run(
    transcriber: Box<dyn Transcriber>,
    responder: Option<Box<dyn Responder>>,
    sink: EventSink,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<()>>,
) {
    let mut lanes = match open_lanes() {
        Ok(lanes) => {
            sink(Event::Ready {
                model: transcriber.name(),
                you_device: lanes[0].lane.device_name.clone(),
                them_device: lanes[1].lane.device_name.clone(),
            });
            let _ = ready.send(Ok(()));
            lanes
        }
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };

    // Turn detection reasons about elapsed time, so everything it sees is
    // stamped against one clock that only moves forward.
    let started = Instant::now();
    let elapsed_ms = move || started.elapsed().as_millis() as u64;

    // Answering runs on a third thread of its own. A model can take seconds,
    // and neither capture nor recognition may wait on it.
    let (ask_tx, ask_rx) = mpsc::channel::<Ask>();
    let generation = Arc::new(AtomicU64::new(0));

    let answering = responder.map(|responder| {
        thread::Builder::new()
            .name("copilot-answers".into())
            .spawn({
                let sink = Arc::clone(&sink);
                let generation = Arc::clone(&generation);
                move || answer(responder, sink, ask_rx, generation)
            })
    });

    let answering = match answering {
        Some(Ok(handle)) => Some(handle),
        Some(Err(err)) => {
            sink(Event::Error {
                message: format!("could not start the answering thread: {err}"),
            });
            None
        }
        None => None,
    };

    let (work_tx, work_rx) = mpsc::channel::<Work>();
    let recognition = thread::Builder::new()
        .name("copilot-recognition".into())
        .spawn({
            let sink = Arc::clone(&sink);
            let generation = Arc::clone(&generation);
            move || recognize(transcriber, sink, work_rx, elapsed_ms, ask_tx, generation)
        });

    let recognition = match recognition {
        Ok(handle) => handle,
        Err(err) => {
            sink(Event::Error {
                message: format!("could not start the recognition thread: {err}"),
            });
            return;
        }
    };

    let mut utterances = Vec::new();
    let mut last_level = Instant::now() - LEVEL_INTERVAL;

    while !stop.load(Ordering::Relaxed) {
        let send_level = last_level.elapsed() >= LEVEL_INTERVAL;
        if send_level {
            last_level = Instant::now();
        }

        for worker in &mut lanes {
            utterances.clear();
            let changed = worker.poll(&sink, send_level, &mut utterances);
            let lane = worker.which;

            if let Some(active) = changed {
                let _ = work_tx.send(Work::Speech {
                    lane,
                    active,
                    at_ms: elapsed_ms(),
                });
            }

            for utterance in utterances.drain(..) {
                let _ = work_tx.send(Work::Utterance {
                    lane,
                    utterance,
                    at_ms: elapsed_ms(),
                });
            }
        }

        thread::sleep(POLL);
    }

    // Whatever was still being said when the session ended.
    for worker in &mut lanes {
        utterances.clear();
        worker.segmenter.flush(&mut utterances);
        let lane = worker.which;
        for utterance in utterances.drain(..) {
            let _ = work_tx.send(Work::Utterance {
                lane,
                utterance,
                at_ms: elapsed_ms(),
            });
        }
    }

    // Dropping the sender is what tells recognition there is no more work.
    // Recognition in turn drops its own sender, ending the answering thread.
    drop(work_tx);
    let _ = recognition.join();
    if let Some(answering) = answering {
        let _ = answering.join();
    }
}

/// Transcribes utterances and decides when a question has been finished.
///
/// Both live here because both are allowed to take their time — nothing on
/// this thread holds up audio capture.
fn recognize(
    mut transcriber: Box<dyn Transcriber>,
    sink: EventSink,
    work: mpsc::Receiver<Work>,
    elapsed_ms: impl Fn() -> u64,
    ask: mpsc::Sender<Ask>,
    generation: Arc<AtomicU64>,
) {
    let mut detector = TurnDetector::new(TurnConfig::default());

    // The conversation so far. Kept here because this is the thread that sees
    // every transcript, in order.
    let mut history: Vec<ContextLine> = Vec::new();

    loop {
        // A timeout rather than a plain receive: turn detection fires on
        // elapsed time, so it has to be asked even when nothing arrives.
        match work.recv_timeout(TURN_TICK) {
            Ok(Work::Speech {
                lane,
                active,
                at_ms,
            }) => {
                let signal = if active {
                    Signal::SpeechStarted { lane }
                } else {
                    Signal::SpeechEnded { lane }
                };
                detector.observe(signal, at_ms);
            }

            Ok(Work::Utterance {
                lane,
                utterance,
                at_ms,
            }) => {
                if let Some(text) = transcribe(&mut transcriber, &sink, lane, &utterance) {
                    history.push(ContextLine {
                        lane,
                        text: text.clone(),
                    });
                    if history.len() > HISTORY_LIMIT {
                        history.drain(..history.len() - HISTORY_LIMIT);
                    }

                    detector.observe(
                        Signal::Transcript {
                            lane,
                            id: utterance.id,
                            text,
                        },
                        at_ms,
                    );
                }
            }

            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        if let Some(turn) = detector.poll(elapsed_ms()) {
            sink(Event::Turn {
                id: turn.id,
                text: turn.text.clone(),
            });

            // Incremented before sending, so an answer already streaming sees
            // that it has been superseded and stops.
            let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = ask.send(Ask {
                generation: mine,
                question: Question {
                    id: turn.id,
                    text: turn.text,
                    context: prompt::recent(&history, prompt::CONTEXT_LINES),
                },
            });
        }
    }
}

/// Streams an answer for each question, abandoning one the moment a newer
/// question exists.
fn answer(
    mut responder: Box<dyn Responder>,
    sink: EventSink,
    asks: mpsc::Receiver<Ask>,
    generation: Arc<AtomicU64>,
) {
    let model = responder.name();

    while let Ok(Ask {
        generation: mine,
        question,
    }) = asks.recv()
    {
        // Already stale before it started — a faster conversation than this
        // model can keep up with.
        if generation.load(Ordering::SeqCst) != mine {
            continue;
        }

        let for_id = question.id;
        sink(Event::AnswerStart {
            for_id,
            model: model.clone(),
        });

        let superseded = || generation.load(Ordering::SeqCst) != mine;
        let mut on_delta = |text: &str| {
            sink(Event::AnswerDelta {
                for_id,
                text: text.to_string(),
            });
        };

        let reason = match responder.respond(&question, &mut on_delta, &superseded) {
            Ok(crate::llm::Ending::Complete) => Ending::Complete,
            Ok(crate::llm::Ending::Cancelled) => Ending::Cancelled,
            Err(err) => {
                sink(Event::Error {
                    message: format!("{err:#}"),
                });
                Ending::Failed
            }
        };

        sink(Event::AnswerEnd { for_id, reason });
    }
}

fn open_lanes() -> Result<[LaneWorker; 2]> {
    Ok([
        LaneWorker::open(Source::Microphone)?,
        LaneWorker::open(Source::SystemOutput)?,
    ])
}

/// Transcribes one utterance and emits it, returning the text so turn
/// detection sees exactly what the interface was just shown.
fn transcribe(
    transcriber: &mut Box<dyn Transcriber>,
    sink: &EventSink,
    lane: Lane,
    utterance: &Utterance,
) -> Option<String> {
    let began = Instant::now();

    match transcriber.transcribe(&utterance.samples) {
        // Nothing worth keeping: silence, or text the filter rejected.
        Ok(None) => None,
        Ok(Some(text)) => {
            sink(Event::Transcript {
                lane,
                id: utterance.id,
                text: text.clone(),
                start_ms: utterance.start_ms,
                end_ms: utterance.end_ms,
                transcribe_ms: began.elapsed().as_millis() as u64,
            });
            Some(text)
        }
        Err(err) => {
            sink(Event::Error {
                message: format!("{lane:?} lane: {err:#}"),
            });
            None
        }
    }
}
