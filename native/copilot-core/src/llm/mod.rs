//! Answering the question.
//!
//! The interface is a blocking, callback-driven stream rather than an async
//! one. It costs an async runtime the project does not otherwise need, and it
//! buys nothing: this runs on its own thread, and the only thing waiting on
//! it is the answer that has not been written yet.
//!
//! Deltas arrive as they do because time to *first* token is what a person on
//! a call actually feels. Waiting for a complete answer would add seconds of
//! silence to something already the slowest link in the chain.

pub mod mock;
pub mod openai;
pub mod prompt;

pub use mock::MockResponder;
pub use prompt::{ContextLine, Question};

use anyhow::Result;

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
        on_delta: &mut dyn FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Ending>;

    /// The model in use, for display.
    fn name(&self) -> String;
}
