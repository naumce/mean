//! Turning a conversation into a request.
//!
//! Two constraints shape everything here, and both come from the answer being
//! read during a live call rather than afterwards.
//!
//! **It has to be readable at a glance.** Someone mid-conversation can spare
//! about a second of eye contact. An answer that opens with "Great question!
//! There are several factors to consider…" is useless before it is wrong.
//!
//! **Context is bounded.** The transcript grows for the length of the
//! meeting; the request cannot. A rolling window of recent lines keeps both
//! cost and time-to-first-token flat instead of climbing all session.

use crate::event::Lane;

/// How many recent transcript lines travel with a question.
pub const CONTEXT_LINES: usize = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextLine {
    pub lane: Lane,
    pub text: String,
}

/// A question to answer, with the conversation leading up to it.
#[derive(Clone, Debug)]
pub struct Question {
    /// The utterance that completed it, so the answer can be attached to the
    /// right line in the interface.
    pub id: u64,
    pub text: String,
    pub context: Vec<ContextLine>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

pub const SYSTEM: &str = "\
You are helping someone during a live conversation. The other person has just \
asked something, and your answer appears on screen while the conversation \
continues.

Lead with the answer itself in one short sentence. Then at most three brief \
supporting points, only if they add something. Prefer concrete specifics over \
general advice.

Never open with a preamble, never restate the question, never sign off. The \
reader can spare about a second of eye contact, so the first line has to carry \
the answer on its own.

The transcript comes from automatic speech recognition and will contain \
mistakes. Read through obvious mishearings rather than commenting on them. If \
the question is genuinely ambiguous, answer the most likely reading and note \
your assumption in a few words.";

/// Builds the request messages for a question.
pub fn build(question: &Question) -> Vec<Message> {
    let mut messages = vec![Message {
        role: "system",
        content: SYSTEM.to_string(),
    }];

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
    content.push_str("Answer what THEM just asked:\n");
    content.push_str(question.text.trim());

    messages.push(Message {
        role: "user",
        content,
    });

    messages
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
        }
    }

    #[test]
    fn the_system_message_comes_first() {
        let messages = build(&question());
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, SYSTEM);
    }

    #[test]
    fn the_conversation_is_included_in_order_and_labelled_by_speaker() {
        let messages = build(&question());
        let user = &messages[1].content;

        let them = user.find("THEM: So how would you design").expect("missing first line");
        let you = user.find("YOU: I would start").expect("missing second line");
        assert!(them < you, "context is out of order");
    }

    #[test]
    fn the_question_is_last_so_it_is_not_buried_in_the_context() {
        let messages = build(&question());
        assert!(
            messages[1].content.trim_end().ends_with("thundering herd?"),
            "question should be the final thing in the request"
        );
    }

    #[test]
    fn a_question_with_no_context_still_builds() {
        let bare = Question {
            id: 0,
            text: "Why?".into(),
            context: Vec::new(),
        };
        let messages = build(&bare);
        assert_eq!(messages.len(), 2);
        assert!(!messages[1].content.contains("Conversation so far"));
        assert!(messages[1].content.contains("Why?"));
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
