//! Asks the model one question and streams the answer, with no audio at all.
//!
//! The answering path is the only part of the system that cannot be tested by
//! talking, because whether it works depends on a key, a network, and a
//! vendor. This isolates it: if `ask` works and the app does not, the problem
//! is upstream in audio or turn detection, and the other way round.
//!
//!     cargo run --example ask -- "how would you handle a thundering herd?"
//!     cargo run --example ask -- --brief "Answer only in Rust. @cv.md" "what should I emphasise?"
//!     cargo run --example ask -- --shot                 # capture the screen and solve what is on it

use anyhow::Result;
use copilot_core::capture::screen;
use copilot_core::documents;
use copilot_core::llm::{Brief, Question};
use std::io::Write;
use std::time::Instant;

/// Used with `--shot` and nothing typed. Vague on purpose — the picture is
/// the question.
const SCREENSHOT_PROMPT: &str =
    "Here is my screen. Answer whatever it is asking, or explain what I am looking at.";

fn main() -> Result<()> {
    let (brief_text, text) = parse_args();
    let shot = std::env::args().any(|arg| arg == "--shot");

    let text = if !text.trim().is_empty() {
        text
    } else if shot {
        SCREENSHOT_PROMPT.to_string()
    } else {
        "How would you handle a thundering herd?".to_string()
    };

    let folder = documents::folder();
    let documents = documents::resolve(&folder, &brief_text)?;

    let brief = Brief {
        text: brief_text,
        documents,
    };

    let mut responder = copilot_core::llm::from_env()?;

    println!("\n  model     {}", responder.name());
    if !brief.documents.is_empty() {
        let names: Vec<&str> = brief.documents.iter().map(|d| d.name.as_str()).collect();
        println!("  documents {} ({})", brief.documents.len(), names.join(", "));
    }
    println!("  question  {text}");

    let mut question = Question::typed(text, Vec::new());

    if shot {
        let began = Instant::now();
        let captured = screen::capture(screen::Target::Active)?;
        // Which screen, because following the active window is a guess about
        // intent and this is the only place it becomes visible. Base64 inflates
        // by four thirds, so the wire size is what this reports rather than the
        // encoder's output.
        println!(
            "  screen    {} — captured in {} ms, {} KB on the wire",
            captured.monitor,
            began.elapsed().as_millis(),
            captured.image.base64.len() / 1024
        );
        question.image = Some(captured.image);
    }
    println!();

    let began = Instant::now();
    let mut first_token = None;
    let mut stdout = std::io::stdout();

    let ending = responder.respond(
        &question,
        &brief,
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
    println!();
    Ok(())
}

/// Returns `(brief, question)`. Everything after `--brief` up to the next
/// argument is the brief; the rest is the question.
fn parse_args() -> (String, String) {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let args: Vec<String> = args.into_iter().filter(|arg| arg != "--shot").collect();

    match args.iter().position(|arg| arg == "--brief") {
        Some(at) => {
            let brief = args.get(at + 1).cloned().unwrap_or_default();
            let mut rest: Vec<String> = args[..at].to_vec();
            rest.extend_from_slice(&args[(at + 2).min(args.len())..]);
            (brief, rest.join(" ").trim().to_string())
        }
        None => (String::new(), args.join(" ").trim().to_string()),
    }
}
