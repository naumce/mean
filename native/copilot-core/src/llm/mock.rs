//! A responder that answers from a script.
//!
//! Everything around answering — the event stream, cancellation, the pane in
//! the interface — can be built and tested against this, with no key, no
//! network, and no cost per run.

use anyhow::Result;

use super::{Brief, Ending, Question, Responder};

pub struct MockResponder {
    reply: String,
    /// Deltas are emitted a word at a time, so anything downstream that
    /// assumes whole sentences arrive at once gets caught here rather than
    /// against a real model.
    pub chunk_words: usize,
}

impl MockResponder {
    pub fn new(reply: impl Into<String>) -> Self {
        Self {
            reply: reply.into(),
            chunk_words: 1,
        }
    }
}

impl Responder for MockResponder {
    fn respond(
        &mut self,
        _question: &Question,
        _brief: &Brief,
        on_delta: &mut dyn FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Ending> {
        let words: Vec<&str> = self.reply.split_inclusive(' ').collect();

        for chunk in words.chunks(self.chunk_words.max(1)) {
            if cancelled() {
                return Ok(Ending::Cancelled);
            }
            on_delta(&chunk.concat());
        }

        Ok(Ending::Complete)
    }

    fn name(&self) -> String {
        "mock".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question() -> Question {
        Question::typed("Why?", Vec::new())
    }

    fn collect(responder: &mut MockResponder, cancelled: &dyn Fn() -> bool) -> (String, Ending) {
        let mut got = String::new();
        let ending = responder
            .respond(
                &question(),
                &Brief::default(),
                &mut |delta| got.push_str(delta),
                cancelled,
            )
            .unwrap();
        (got, ending)
    }

    #[test]
    fn the_deltas_reassemble_into_the_whole_answer() {
        let mut responder = MockResponder::new("Use a token bucket per client.");
        let (got, ending) = collect(&mut responder, &|| false);

        assert_eq!(got, "Use a token bucket per client.");
        assert_eq!(ending, Ending::Complete);
    }

    #[test]
    fn it_arrives_in_pieces_rather_than_all_at_once() {
        let mut responder = MockResponder::new("one two three four");
        let mut pieces = 0;
        responder
            .respond(
                &question(),
                &Brief::default(),
                &mut |_| pieces += 1,
                &|| false,
            )
            .unwrap();

        assert!(pieces > 1, "answer arrived as a single lump");
    }

    #[test]
    fn cancelling_stops_it_early() {
        let mut responder = MockResponder::new("one two three four five six");
        let (got, ending) = collect(&mut responder, &|| true);

        assert_eq!(got, "", "kept talking after being cancelled");
        assert_eq!(ending, Ending::Cancelled);
    }
}
