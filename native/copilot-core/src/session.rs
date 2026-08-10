//! Running both lanes and turning them into a stream of events.
//!
//! Everything below this point has been written to be driven by someone else.
//! This is the piece that actually drives it, on its own thread, so a caller
//! only has to supply somewhere for events to go.
//!
//! The thread exists for a specific reason rather than for tidiness: a cpal
//! stream cannot be moved between threads on Windows, so the lanes have to be
//! opened on whichever thread will own them for their whole life. That in
//! turn means startup errors cannot simply be returned — they are sent back
//! over a channel, and [`Session::start`] waits for that before reporting
//! success.

use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::vad::frame_db;
use crate::capture::{Lane as CaptureLane, Source};
use crate::event::{Event, Lane};
use crate::stt::{Segmenter, SegmenterConfig, Transcriber, Utterance};

/// How often the lanes are drained. Well under the length of any utterance,
/// so a segment is never held up waiting to be noticed.
const POLL: Duration = Duration::from_millis(50);

/// How often level meters go out. Twenty a second looks smooth and costs
/// nothing; sending one per poll would be wasted traffic.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);

/// Anywhere events can go. `Sync` as well as `Send` because a UI toolkit will
/// typically want to hold onto this from more than one place.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

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
    pub fn start(transcriber: Box<dyn Transcriber>, sink: EventSink) -> Result<Session> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();

        let worker = thread::Builder::new()
            .name("copilot-session".into())
            .spawn({
                let stop = Arc::clone(&stop);
                let sink = Arc::clone(&sink);
                move || run(transcriber, sink, stop, ready_tx)
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
    fn poll(&mut self, sink: &EventSink, send_level: bool, out: &mut Vec<Utterance>) {
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
        if speaking != self.was_speaking {
            self.was_speaking = speaking;
            sink(Event::Speaking {
                lane: self.which,
                active: speaking,
            });
        }

        let dropped = self.lane.dropped();
        if dropped > self.reported_drops {
            self.reported_drops = dropped;
            sink(Event::Dropped {
                lane: self.which,
                samples: dropped,
            });
        }
    }
}

fn run(
    mut transcriber: Box<dyn Transcriber>,
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

    let mut utterances = Vec::new();
    let mut last_level = Instant::now() - LEVEL_INTERVAL;

    while !stop.load(Ordering::Relaxed) {
        let send_level = last_level.elapsed() >= LEVEL_INTERVAL;
        if send_level {
            last_level = Instant::now();
        }

        for worker in &mut lanes {
            utterances.clear();
            worker.poll(&sink, send_level, &mut utterances);
            transcribe_all(&mut transcriber, &sink, worker.which, &utterances);
        }

        thread::sleep(POLL);
    }

    // Whatever was still being said when the session ended.
    for worker in &mut lanes {
        utterances.clear();
        worker.segmenter.flush(&mut utterances);
        transcribe_all(&mut transcriber, &sink, worker.which, &utterances);
    }
}

fn open_lanes() -> Result<[LaneWorker; 2]> {
    Ok([
        LaneWorker::open(Source::Microphone)?,
        LaneWorker::open(Source::SystemOutput)?,
    ])
}

fn transcribe_all(
    transcriber: &mut Box<dyn Transcriber>,
    sink: &EventSink,
    lane: Lane,
    utterances: &[Utterance],
) {
    for utterance in utterances {
        let began = Instant::now();
        match transcriber.transcribe(&utterance.samples) {
            // Nothing worth keeping: silence, or text the filter rejected.
            Ok(None) => {}
            Ok(Some(text)) => sink(Event::Transcript {
                lane,
                id: utterance.id,
                text,
                start_ms: utterance.start_ms,
                end_ms: utterance.end_ms,
                transcribe_ms: began.elapsed().as_millis() as u64,
            }),
            Err(err) => sink(Event::Error {
                message: format!("{lane:?} lane: {err:#}"),
            }),
        }
    }
}
