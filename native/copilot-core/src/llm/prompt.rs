//! Turning a conversation into a request.
//!
//! Three constraints shape everything here.
//!
//! **The brief replaces the output contract, it does not add to it.** A live
//! conversation wants one sentence and three bullets; a coding challenge wants
//! fifty lines of runnable code. Those are contradictory, so the session's
//! brief substitutes for the default rather than being appended to it — the
//! same app cannot serve both otherwise.
//!
//! **Stable content goes first.** The documents and the brief do not change
//! for the life of a session; the transcript grows with every question. Put
//! the stable part at the front and a cache breakpoint sits in the right
//! place: the first question pays for the documents, every question after
//! reads them at a fraction of the price. Reverse the order and a CV is
//! re-billed on every single question.
//!
//! **Context is bounded.** The transcript grows all meeting; the request
//! cannot. A rolling window of recent lines keeps cost and time-to-first-token
//! flat instead of climbing all session.

use crate::event::Lane;

/// How many recent transcript lines travel with a question.
pub const CONTEXT_LINES: usize = 24;

/// Always true regardless of what the session is, so it is never overridden.
const PREAMBLE: &str = "\
You are helping someone during a live conversation. Your answer appears on
their screen while the conversation continues.

The transcript comes from automatic speech recognition and will contain
mistakes. Read through obvious mishearings rather than commenting on them. If
a question is genuinely ambiguous, answer the most likely reading and note
your assumption in a few words.";

/// Used when the session has no brief. Written for the conversational case:
/// the reader can spare about a second of eye contact.
const DEFAULT_CONTRACT: &str = "\
Lead with the answer itself in one short sentence. Then at most three brief
supporting points, only if they add something. Prefer concrete specifics over
general advice.

Never open with a preamble, never restate the question, never sign off. The
first line has to carry the answer on its own.";

/// A document the session was told to draw on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub name: String,
    pub body: String,
}

/// Everything the session was set up with. Fixed once it starts.
#[derive(Clone, Debug, Default)]
pub struct Brief {
    /// What the user wrote on the setup screen. Replaces the default answer
    /// contract when non-empty.
    pub text: String,
    /// Documents resolved from the brief's `@mentions`, in the order they
    /// were mentioned.
    pub documents: Vec<Document>,
}

impl Brief {
    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.documents.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextLine {
    pub lane: Lane,
    pub text: String,
}

/// A screenshot travelling with a question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub media_type: String,
    /// Base64, no data-URI prefix — every provider wants the bare payload.
    pub base64: String,
}

/// A question to answer, with the conversation leading up to it.
#[derive(Clone, Debug)]
pub struct Question {
    /// The utterance that completed it, so the answer can be attached to the
    /// right line in the interface.
    pub id: u64,
    pub text: String,
    pub context: Vec<ContextLine>,
    pub image: Option<Image>,
}

impl Question {
    /// A question typed rather than spoken. Not tied to any utterance, so it
    /// carries an id no transcript line will claim.
    pub fn typed(text: impl Into<String>, context: Vec<ContextLine>) -> Self {
        Self {
            id: u64::MAX,
            text: text.into(),
            context,
            image: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

/// A request, with the system prompt separated from the conversation.
///
/// Split rather than a flat message list because the two providers want it
/// differently: Anthropic takes a top-level `system` field, OpenAI takes a
/// message with `role: "system"`. Keeping them apart here means neither
/// client has to pick the system message back out of a list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub system: String,
    pub messages: Vec<Message>,
}

/// Builds the request for a question.
pub fn build(question: &Question, brief: &Brief) -> Request {
    let mut system = String::from(PREAMBLE);

    system.push_str("\n\n");
    if brief.text.trim().is_empty() {
        system.push_str(DEFAULT_CONTRACT);
    } else {
        system.push_str(brief.text.trim());
    }

    // Documents last in the system prompt, and unchanging for the session, so
    // a cache breakpoint after them covers the most expensive stable bytes.
    for document in &brief.documents {
        system.push_str("\n\n---\n");
        system.push_str("Document: ");
        system.push_str(&document.name);
        system.push('\n');
        system.push_str(document.body.trim_end());
    }

    let mut content = String::new();

    if !question.context.is_empty() {
        content.push_str("Conversation so far:\n");
        for line in &question.context {
            content.push_str(line.lane.label());
            content.push_str(": ");
            content.push_str(line.text.trim());
            content.push('\n');
        }
        content.push('\n');
    }

    // Repeated below the transcript on purpose. The question is the thing to
    // answer, and burying it as the last line of a wall of context invites an
    // answer to the conversation rather than to the question.
    content.push_str(if question.id == u64::MAX {
        "Answer this:\n"
    } else {
        "Answer what THEM just asked:\n"
    });
    content.push_str(question.text.trim());

    Request {
        system,
        messages: vec![Message {
            role: "user",
            content,
        }],
    }
}

/// Keeps only the most recent lines, so a request does not grow with the
/// length of the meeting.
pub fn recent(lines: &[ContextLine], limit: usize) -> Vec<ContextLine> {
    let start = lines.len().saturating_sub(limit);
    lines[start..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(lane: Lane, text: &str) -> ContextLine {
        ContextLine {
            lane,
            text: text.into(),
        }
    }

    fn question() -> Question {
        Question {
            id: 3,
            text: "How would you handle a thundering herd?".into(),
            context: vec![
                line(Lane::Them, "So how would you design a rate limiter?"),
                line(Lane::You, "I would start with a token bucket."),
            ],
            image: None,
        }
    }

    #[test]
    fn the_preamble_is_always_present() {
        let bare = build(&question(), &Brief::default());
        let briefed = build(
            &question(),
            &Brief {
                text: "Answer only in Haskell.".into(),
                ..Brief::default()
            },
        );

        assert!(bare.system.contains("automatic speech recognition"));
        assert!(briefed.system.contains("automatic speech recognition"));
    }

    #[test]
    fn without_a_brief_the_default_contract_applies() {
        let request = build(&question(), &Brief::default());
        assert!(request.system.contains("one short sentence"));
    }

    /// The decision this module exists for: a coding challenge wants runnable
    /// code, which directly contradicts "one sentence, three bullets".
    #[test]
    fn a_brief_replaces_the_answer_contract_rather_than_adding_to_it() {
        let request = build(
            &question(),
            &Brief {
                text: "Answer with complete, runnable code rather than advice.".into(),
                ..Brief::default()
            },
        );

        assert!(request.system.contains("complete, runnable code"));
        assert!(
            !request.system.contains("one short sentence"),
            "the default contract survived and now contradicts the brief"
        );
    }

    #[test]
    fn documents_are_included_and_named() {
        let request = build(
            &question(),
            &Brief {
                text: "Draw on my CV.".into(),
                documents: vec![Document {
                    name: "cv.md".into(),
                    body: "Naum — ten years of backend work.".into(),
                }],
            },
        );

        assert!(request.system.contains("Document: cv.md"));
        assert!(request.system.contains("ten years of backend work"));
    }

    /// Stable bytes first, so a cache breakpoint after the system prompt
    /// covers them and the growing transcript sits outside it.
    #[test]
    fn documents_live_in_the_system_prompt_not_the_conversation() {
        let request = build(
            &question(),
            &Brief {
                text: String::new(),
                documents: vec![Document {
                    name: "notes.md".into(),
                    body: "SECRET-MARKER".into(),
                }],
            },
        );

        assert!(request.system.contains("SECRET-MARKER"));
        assert!(
            !request.messages[0].content.contains("SECRET-MARKER"),
            "documents in the user turn would be re-billed every question"
        );
    }

    #[test]
    fn documents_appear_in_the_order_they_were_mentioned() {
        let request = build(
            &question(),
            &Brief {
                text: String::new(),
                documents: vec![
                    Document { name: "first.md".into(), body: "one".into() },
                    Document { name: "second.md".into(), body: "two".into() },
                ],
            },
        );

        let first = request.system.find("first.md").expect("missing first");
        let second = request.system.find("second.md").expect("missing second");
        assert!(first < second);
    }

    #[test]
    fn the_conversation_is_included_in_order_and_labelled_by_speaker() {
        let request = build(&question(), &Brief::default());
        let user = &request.messages[0].content;

        let them = user.find("THEM: So how would you design").expect("missing first line");
        let you = user.find("YOU: I would start").expect("missing second line");
        assert!(them < you, "context is out of order");
    }

    #[test]
    fn the_question_is_last_so_it_is_not_buried_in_the_context() {
        let request = build(&question(), &Brief::default());
        assert!(request.messages[0].content.trim_end().ends_with("thundering herd?"));
    }

    #[test]
    fn a_question_with_no_context_still_builds() {
        let bare = Question {
            id: 0,
            text: "Why?".into(),
            context: Vec::new(),
            image: None,
        };
        let request = build(&bare, &Brief::default());
        assert_eq!(request.messages.len(), 1);
        assert!(!request.messages[0].content.contains("Conversation so far"));
        assert!(request.messages[0].content.contains("Why?"));
    }

    /// A typed question was not asked by the other side, so telling the model
    /// it was would be a lie it might act on.
    #[test]
    fn a_typed_question_is_not_attributed_to_the_other_side() {
        let typed = Question::typed("What is a token bucket?", Vec::new());
        let request = build(&typed, &Brief::default());

        assert!(!request.messages[0].content.contains("THEM just asked"));
        assert!(request.messages[0].content.contains("Answer this:"));
    }

    /// The transcript grows all meeting; the request must not.
    #[test]
    fn only_the_most_recent_lines_are_kept() {
        let lines: Vec<ContextLine> = (0..100)
            .map(|n| line(Lane::Them, &format!("line {n}")))
            .collect();

        let kept = recent(&lines, 5);
        assert_eq!(kept.len(), 5);
        assert_eq!(kept[0].text, "line 95");
        assert_eq!(kept[4].text, "line 99");
    }

    #[test]
    fn asking_for_more_lines_than_exist_returns_what_there_is() {
        let lines = vec![line(Lane::You, "only one")];
        assert_eq!(recent(&lines, 50).len(), 1);
        assert!(recent(&[], 50).is_empty());
    }
}
