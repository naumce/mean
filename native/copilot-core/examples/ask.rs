//! Asks the model one question and streams the answer, with no audio at all.
//!
//! The answering path is the only part of the system that cannot be tested by
//! talking, because whether it works depends on a key, a network, and a
//! vendor. This isolates it: if `ask` works and the app does not, the problem
//! is upstream in audio or turn detection, and the other way round.
//!
//!     cargo run --example ask -- "how would you handle a thundering herd?"

use anyhow::Result;
use copilot_core::event::Lane;
use copilot_core::llm::openai::OpenAiResponder;
use copilot_core::llm::{ContextLine, Ending, Question, Responder};
use std::io::Write;
use std::time::Instant;

fn main() -> Result<()> {
    let text = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    let text = if text.is_empty() {
        "How would you handle a thundering herd?".to_string()
    } else {
        text
    };

    let mut responder = OpenAiResponder::from_env()?;
    println!("\n  model     {}", responder.name());
    println!("  question  {text}\n");

    let question = Question {
        id: 0,
        text,
        context: vec![ContextLine {
            lane: Lane::Them,
            text: "So walk me through how you would design a rate limiter.".into(),
        }],
    };

    let began = Instant::now();
    let mut first_token = None;
    let mut stdout = std::io::stdout();

    let ending = responder.respond(
        &question,
        &mut |delta| {
            // Time to *first* token is the number a person on a call feels.
            // Everything after it arrives while they are still reading.
            first_token.get_or_insert_with(|| began.elapsed());
            print!("{delta}");
            let _ = stdout.flush();
        },
        &|| false,
    )?;

    println!("\n");
    match first_token {
        Some(at) => println!(
            "  first token after {:.0} ms, complete in {:.1} s ({ending:?})",
            at.as_secs_f32() * 1000.0,
            began.elapsed().as_secs_f32()
        ),
        None => println!("  no answer produced ({ending:?})"),
    }

    if ending == Ending::Cancelled {
        println!("  (cancelled)");
    }
    println!();
    Ok(())
}
