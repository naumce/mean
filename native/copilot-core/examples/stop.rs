//! Proves the Stop button lets go.
//!
//! The unit tests cover the answering loop in isolation, which is where the
//! deadlock lived. This covers the thing that actually froze the window: a
//! real `Session`, with real capture devices and all three threads running,
//! being told to stop.
//!
//! Recognition and answering are mocked so this needs no model, no key, and no
//! network — the shutdown path is identical either way, and the point is to
//! measure how long letting go takes rather than what was said.
//!
//!     cargo run --example stop --no-default-features
//!
//! Before the fix this never printed anything at all: `stop` joined a thread
//! that was waiting on a sender only `stop` could release.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use copilot_core::llm::mock::MockResponder;
use copilot_core::llm::Brief;
use copilot_core::session::{EventSink, Session};
use copilot_core::stt::mock::MockTranscriber;
use copilot_core::Event;

/// Long enough that stopping lands mid-answer rather than after it.
const REPLY: &str = "A rate limiter is the usual answer here, and the shape \
that matters is the one that degrades gracefully rather than the one that is \
cheapest to implement, because the failure you care about arrives in a burst \
and not in a steady stream of well behaved requests.";

/// How long a Stop is allowed to take before it counts as a hang rather than
/// a wait. Teardown joins three threads; tens of milliseconds is expected.
const PATIENCE: Duration = Duration::from_secs(5);

fn main() -> Result<()> {
    let sink: EventSink = Arc::new(|event: Event| {
        // Only the shape of the shutdown matters here, so the noisy events
        // stay out of the way.
        if let Event::Ready { you_device, them_device, .. } = &event {
            println!("  you       {you_device}");
            println!("  them      {them_device}");
        }
    });

    println!("\n  opening both lanes…");
    let mut session = Session::start(
        Box::new(MockTranscriber::new(Vec::<String>::new())),
        Some(Box::new(MockResponder::new(REPLY))),
        Brief::default(),
        sink,
    )?;

    // A question in flight is the state the old code could not leave: the
    // answering thread had work, and the sender that would have released it
    // was held by the session being dropped.
    session.ask("Ask something so the answering thread is busy.", None);
    thread::sleep(Duration::from_millis(300));

    println!("\n  stopping…");
    let began = Instant::now();
    session.stop();
    let took = began.elapsed();

    println!("  stopped in {} ms\n", took.as_millis());

    if took > PATIENCE {
        anyhow::bail!(
            "stop took {} ms — that is a hang, not a wait",
            took.as_millis()
        );
    }

    Ok(())
}
