//! Answering the question.
//!
//! The interface is a blocking, callback-driven stream rather than an async
//! one. It would cost an async runtime the project does not otherwise need and
//! buy nothing: this runs on its own thread, and the only thing waiting on it
//! is the answer that has not been written yet.
//!
//! Deltas arrive as they come because time to *first* token is what a person
//! on a call actually feels. Waiting for a complete answer would add seconds
//! of silence to something already the slowest link in the chain.

pub mod anthropic;
pub mod mock;
pub mod openai;
pub mod prompt;

pub use mock::MockResponder;
pub use prompt::{Brief, ContextLine, Document, Image, Question, Repo, Request, SourceFile};

use anyhow::{anyhow, Result};

/// Why an answer stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// The model finished.
    Complete,
    /// Something newer came along and this was abandoned.
    Cancelled,
}

/// Anything that can answer a question, a piece at a time.
pub trait Responder: Send {
    /// Streams an answer, handing each fragment to `on_delta` as it arrives.
    ///
    /// `cancelled` is checked between fragments. A responder must return
    /// [`Ending::Cancelled`] promptly once it goes true — on a live call a
    /// superseded answer is not merely wasted, it is actively in the way.
    fn respond(
        &mut self,
        question: &Question,
        brief: &Brief,
        on_delta: &mut dyn FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Ending>;

    /// The model in use, for display.
    fn name(&self) -> String;
}

/// Picks a provider from whatever key is available.
///
/// Anthropic first, because it is the one this project targets; OpenAI is the
/// fallback so an existing key keeps working. Failing names both, since "no
/// key" is the most common reason answers are off and the fix is obvious once
/// the variable names are in front of you.
pub fn from_env() -> Result<Box<dyn Responder>> {
    if let Some(responder) = anthropic::AnthropicResponder::from_env()? {
        return Ok(Box::new(responder));
    }
    if let Some(responder) = openai::OpenAiResponder::from_env()? {
        return Ok(Box::new(responder));
    }

    Err(anyhow!(
        "no API key found. Put one in a .env file beside the project as \
         ANTHROPIC_API_KEY (or OPENAI_API_KEY), or set it in the environment."
    ))
}
