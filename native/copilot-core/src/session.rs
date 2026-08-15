//! Running both lanes and turning them into a stream of events.
//!
//! Everything below this point has been written to be driven by someone else.
//! This is the piece that actually drives it, and the thread split is not
//! cosmetic.
//!
//! The **capture thread** drains both lanes and cuts them into utterances. It
//! must never do anything slow, because while it is busy the ring buffers keep
//! filling and eventually discard audio. It exists as a thread at all because
//! a cpal stream cannot be moved between threads on Windows, so the lanes must
//! be opened wherever they will live — which is also why startup errors come
//! back over a channel rather than being returned.
//!
//! The **recognition thread** does whisper, then turn detection. This was
//! measured, not assumed: with recognition inline, the first CUDA call took
//! 1901 ms while the model warmed up and the capture side discarded 3840
//! samples — a real hole in the audio, caused entirely by making the wrong
//! thread wait.
//!
//! The **answering thread** talks to the model, which can take seconds.
//! Neither of the other two may wait on it.

use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::vad::frame_db;
use crate::capture::{Lane as CaptureLane, Source};
use crate::event::{Ending, Event, Lane};
use crate::llm::{prompt, Brief, ContextLine, Image, Question, Responder};
use crate::stt::{Segmenter, SegmenterConfig, Transcriber, Utterance};
use crate::turn::{Signal, TurnConfig, TurnDetector};

/// How often the lanes are drained. Well under the length of any utterance,
/// so a segment is never held up waiting to be noticed.
const POLL: Duration = Duration::from_millis(50);

/// How often level meters go out. Twenty a second looks smooth; one per poll
/// would be wasted traffic.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);

/// How often turn detection is re-checked when nothing else is happening. Its
/// deciding condition is elapsed time, so something has to ask.
const TURN_TICK: Duration = Duration::from_millis(50);

/// How often the answering thread looks up from its channel to ask whether the
/// session is over.
///
/// It is otherwise blocked waiting for a question, and shutdown must not depend
/// on one arriving — see the note on `answer`.
const SHUTDOWN_TICK: Duration = Duration::from_millis(50);

/// How much transcript is kept for context. Bounded so a long meeting does not
/// grow the process; the request window is smaller again.
const HISTORY_LIMIT: usize = 200;

/// Anywhere events can go. `Sync` as well as `Send` because a UI toolkit will
/// typically want to hold onto this from more than one place.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

/// The conversation so far, shared because two threads need it: recognition
/// writes to it, and a typed question reads it for context.
type History = Arc<Mutex<Vec<ContextLine>>>;

/// What the capture thread hands to the recognition thread.
///
/// One channel for both kinds, because turn detection cares about the order
/// they happened in — a speech transition arriving after the transcript it
/// preceded would look like the speaker resuming.
enum Work {
    Speech { lane: Lane, active: bool, at_ms: u64 },
    Utterance { lane: Lane, utterance: Utterance, at_ms: u64 },
}

/// A question handed to the answering thread.
///
/// The generation is what makes cancellation work: the answerer compares the
/// one it started with against the current count and stops as soon as a newer
/// question exists. On a live call a superseded answer is not merely wasted,
/// it is text on screen that is actively misleading.
struct Ask {
    generation: u64,
    question: Question,
}

pub struct Session {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    /// Held so a typed question can be injected from outside the threads, and
    /// released before they are joined.
    ///
    /// Optional purely so `stop` can drop it while the session itself is still
    /// alive. A sender living here is a sender the answering thread is waiting
    /// on, and shutdown cannot wait for something only shutdown can release.
    ask: Option<mpsc::Sender<Ask>>,
    generation: Arc<AtomicU64>,
    history: History,
}

impl Session {
    /// Opens both lanes and starts transcribing.
    ///
    /// The transcriber and responder are supplied rather than constructed
    /// here, so this module never needs to know whether recognition is whisper
    /// or a mock, or whether answers come from Anthropic, OpenAI, or nothing.
    pub fn start(
        transcriber: Box<dyn Transcriber>,
        responder: Option<Box<dyn Responder>>,
        brief: Brief,
        sink: EventSink,
    ) -> Result<Session> {
        let stop = Arc::new(AtomicBool::new(false));
        let generation = Arc::new(AtomicU64::new(0));
        let history: History = Arc::new(Mutex::new(Vec::new()));
        let (ask_tx, ask_rx) = mpsc::channel::<Ask>();
        let (ready_tx, ready_rx) = mpsc::channel();

        let worker = thread::Builder::new()
            .name("copilot-session".into())
            .spawn({
                let stop = Arc::clone(&stop);
                let sink = Arc::clone(&sink);
                let generation = Arc::clone(&generation);
                let history = Arc::clone(&history);
                let ask_tx = ask_tx.clone();
                move || {
                    run(
                        transcriber,
                        responder,
                        brief,
                        sink,
                        stop,
                        ready_tx,
                        ask_tx,
                        ask_rx,
                        generation,
                        history,
                    )
                }
            })
            .context("could not start the session thread")?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Session {
                stop,
                worker: Some(worker),
                ask: Some(ask_tx),
                generation,
                history,
            }),
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => anyhow::bail!("the session thread stopped before it was ready"),
        }
    }

    /// Asks a question that was typed rather than spoken, optionally with a
    /// screenshot attached.
    ///
    /// Goes down the same path as a detected turn, so it supersedes anything
    /// already streaming — asking a new question while the last answer is
    /// still arriving means you want the new one.
    pub fn ask(&self, text: impl Into<String>, image: Option<Image>) {
        let context = self
            .history
            .lock()
            .map(|history| prompt::recent(&history, prompt::CONTEXT_LINES))
            .unwrap_or_default();

        let mut question = Question::typed(text, context);
        question.image = image;

        let mine = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(ask) = &self.ask {
            let _ = ask.send(Ask {
                generation: mine,
                question,
            });
        }
    }

    /// Stops the session and waits for the thread to finish, so capture
    /// devices are released before this returns.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);

        // Before joining, not after. The answering thread ends when every
        // sender is gone, and this is one of them — keeping it here would mean
        // waiting for a sender that only this function can release.
        self.ask.take();

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

#[allow(clippy::too_many_arguments)]
fn run(
    transcriber: Box<dyn Transcriber>,
    responder: Option<Box<dyn Responder>>,
    brief: Brief,
    sink: EventSink,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<()>>,
    ask_tx: mpsc::Sender<Ask>,
    ask_rx: mpsc::Receiver<Ask>,
    generation: Arc<AtomicU64>,
    history: History,
) {
    let mut lanes = match open_lanes() {
        Ok(lanes) => {
            sink(Event::Ready {
                model: transcriber.name(),
                answers: responder.as_ref().map(|r| r.name()),
                documents: brief.documents.len(),
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

    let answering = responder.map(|responder| {
        thread::Builder::new()
            .name("copilot-answers".into())
            .spawn({
                let sink = Arc::clone(&sink);
                let generation = Arc::clone(&generation);
                let stop = Arc::clone(&stop);
                move || answer(responder, brief, sink, ask_rx, generation, stop)
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
            move || {
                recognize(
                    transcriber,
                    sink,
                    work_rx,
                    elapsed_ms,
                    ask_tx,
                    generation,
                    history,
                )
            }
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

    // Dropping the sender tells recognition there is no more work; it in turn
    // drops its own, which ends the answering thread.
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
    history: History,
) {
    let mut detector = TurnDetector::new(TurnConfig::default());

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
                    if let Ok(mut history) = history.lock() {
                        history.push(ContextLine {
                            lane,
                            text: text.clone(),
                        });
                        if history.len() > HISTORY_LIMIT {
                            let excess = history.len() - HISTORY_LIMIT;
                            history.drain(..excess);
                        }
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

            let context = history
                .lock()
                .map(|history| prompt::recent(&history, prompt::CONTEXT_LINES))
                .unwrap_or_default();

            // Incremented before sending, so an answer already streaming sees
            // that it has been superseded and stops.
            let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = ask.send(Ask {
                generation: mine,
                question: Question {
                    id: turn.id,
                    text: turn.text,
                    context,
                    image: None,
                    // Nothing attaches source yet. The repo module exists but
                    // no caller populates it; this stays empty until it does.
                    files: Vec::new(),
                },
            });
        }
    }
}

/// Streams an answer for each question, abandoning one the moment a newer
/// question exists or the session ends.
///
/// The stop flag is checked as well as the channel, and that is load-bearing
/// rather than belt-and-braces. Waiting purely for every sender to drop once
/// froze the whole window: `Session` holds a sender of its own, so shutdown
/// blocked on a sender that only shutdown could release. Ending on the flag
/// means no future sender, held anywhere by anyone, can reintroduce that.
fn answer(
    mut responder: Box<dyn Responder>,
    brief: Brief,
    sink: EventSink,
    asks: mpsc::Receiver<Ask>,
    generation: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) {
    let model = responder.name();

    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }

        let Ask {
            generation: mine,
            question,
        } = match asks.recv_timeout(SHUTDOWN_TICK) {
            Ok(ask) => ask,
            // Nothing asked yet; go back and re-check the flag.
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };

        // Already stale before it started — a faster conversation than this
        // model can keep up with.
        if generation.load(Ordering::SeqCst) != mine {
            continue;
        }

        let for_id = question.id;
        sink(Event::AnswerStart {
            for_id,
            model: model.clone(),
            question: question.text.clone(),
        });

        // Stop counts as superseded. Otherwise ending a session while an
        // answer is streaming waits for the whole response to arrive before
        // anything shuts down — a Stop button that works, eventually.
        let superseded = || {
            generation.load(Ordering::SeqCst) != mine || stop.load(Ordering::Relaxed)
        };
        let mut on_delta = |text: &str| {
            sink(Event::AnswerDelta {
                for_id,
                text: text.to_string(),
            });
        };

        let reason = match responder.respond(&question, &brief, &mut on_delta, &superseded) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::mock::MockResponder;

    /// How long a shutdown is allowed to take before the test calls it a hang.
    /// Generous: the thread should leave within one `SHUTDOWN_TICK`.
    const PATIENCE: Duration = Duration::from_secs(2);

    fn nowhere() -> EventSink {
        Arc::new(|_| {})
    }

    /// The bug this exists to prevent froze the entire window.
    ///
    /// Pressing Stop joined the answering thread, which was parked in `recv()`
    /// waiting for every sender to drop — while `Session` still held one, and
    /// could only release it after the join it was blocking. A sender is alive
    /// for the whole of this test on purpose; that is the condition that used
    /// to hang, so the test is worthless without it.
    #[test]
    fn the_answering_thread_leaves_even_while_a_sender_is_still_alive() {
        let stop = Arc::new(AtomicBool::new(false));
        let (ask_tx, ask_rx) = mpsc::channel::<Ask>();

        let answering = thread::spawn({
            let stop = Arc::clone(&stop);
            move || {
                answer(
                    Box::new(MockResponder::new("anything")),
                    Brief::default(),
                    nowhere(),
                    ask_rx,
                    Arc::new(AtomicU64::new(0)),
                    stop,
                )
            }
        });

        stop.store(true, Ordering::Relaxed);

        let deadline = Instant::now() + PATIENCE;
        while !answering.is_finished() {
            assert!(
                Instant::now() < deadline,
                "the answering thread never noticed the session had stopped"
            );
            thread::sleep(Duration::from_millis(10));
        }

        answering.join().expect("answering thread panicked");
        drop(ask_tx);
    }

    /// Stopping mid-answer must abandon it rather than politely wait for the
    /// model to finish talking. Deterministic rather than timing-based: the
    /// sink presses Stop the instant the first delta arrives, and the mock
    /// checks for cancellation between chunks.
    #[test]
    fn pressing_stop_abandons_an_answer_that_is_still_streaming() {
        let stop = Arc::new(AtomicBool::new(false));
        let endings: Arc<Mutex<Vec<Ending>>> = Arc::new(Mutex::new(Vec::new()));
        let (ask_tx, ask_rx) = mpsc::channel::<Ask>();

        let sink: EventSink = Arc::new({
            let stop = Arc::clone(&stop);
            let endings = Arc::clone(&endings);
            move |event| match event {
                Event::AnswerDelta { .. } => stop.store(true, Ordering::Relaxed),
                Event::AnswerEnd { reason, .. } => {
                    endings.lock().expect("endings lock").push(reason)
                }
                _ => {}
            }
        });

        ask_tx
            .send(Ask {
                generation: 1,
                question: Question::typed("Why?", Vec::new()),
            })
            .expect("should queue the question");
        drop(ask_tx);

        answer(
            Box::new(MockResponder::new("one two three four five six seven")),
            Brief::default(),
            sink,
            ask_rx,
            Arc::new(AtomicU64::new(1)),
            stop,
        );

        assert_eq!(
            endings.lock().expect("endings lock").as_slice(),
            &[Ending::Cancelled],
            "kept streaming after the session was stopped"
        );
    }
}
