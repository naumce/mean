//! Deciding whether something said is worth answering.
//!
//! Cheap and textual on purpose. Asking a model whether a sentence is a
//! question would be more accurate and would also add a network round trip
//! to the one place in the system that cannot afford one — this runs before
//! the answer starts, so its latency is added to every answer.
//!
//! It errs toward silence. A missed question costs a beat, and the person can
//! simply be asked again; an answer to nothing appears on screen during a
//! conversation and has to be read and dismissed.

/// Openings that signal a request even without a question mark.
///
/// Speech recognition punctuates from prosody, and a question asked flatly
/// often arrives as a statement. These recover most of that.
const INTERROGATIVE: &[&str] = &[
    "what", "how", "why", "when", "where", "who", "which", "whose", "can you",
    "could you", "would you", "will you", "do you", "does", "did you", "is it",
    "is there", "are there", "are you", "have you", "should", "tell me",
    "walk me through", "explain", "describe", "give me", "talk me through",
    "let's say", "suppose", "imagine", "say you", "what's", "how's", "how'd",
    "what if",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerMode {
    /// Only answer things that look like questions. The default.
    Questions,
    /// Answer anything substantial. Useful when the other side is briefing
    /// rather than interviewing.
    Everything,
}

/// Words people start a sentence with before getting to the sentence.
///
/// "So, what would you do?" is a question. Without stripping the opener it
/// does not begin with anything in the list above, and the question is
/// missed — which is common enough in speech to matter.
const FILLER: &[&str] = &[
    "so", "and", "but", "ok", "okay", "um", "uh", "erm", "well", "now",
    "alright", "right", "yeah", "yes", "hmm", "mhm", "like", "just", "anyway",
];

/// Words that cannot end a finished sentence.
///
/// Someone who stops on one of these has not stopped, they have paused. This
/// catches the case a silence timer cannot: "and what I'm wondering is…"
/// opens like a question, reads like a question, and is half of one.
///
/// Deliberately excludes words that *can* end a real question — "what would
/// you do", "how did they", "where does it" — because suppressing a genuine
/// question is the more expensive mistake.
const DANGLING: &[&str] = &[
    "is", "are", "was", "were", "am", "be", "been", "being", "the", "a", "an",
    "to", "of", "in", "on", "at", "for", "with", "from", "into", "about", "by",
    "as", "and", "but", "or", "nor", "that", "which", "my", "your", "our",
    "their", "its", "his", "her", "than", "very", "more", "some", "any",
];

/// Whether `text` should trigger an answer.
pub fn worth_answering(text: &str, mode: AnswerMode, min_words: usize) -> bool {
    let normalized = normalize(text);
    let body = strip_filler(&normalized);

    if body.is_empty() {
        return false;
    }

    // A question mark outranks everything else: whoever punctuated it heard
    // the sentence finish.
    if text.trim_end().ends_with('?') {
        return true;
    }

    // Trailing on a dangling word means they are still talking. Waiting is
    // free here — the text is carried and folded into whatever comes next.
    if ends_mid_sentence(body) {
        return false;
    }

    if looks_like_a_question(text) {
        return true;
    }

    if body.split_whitespace().count() < min_words {
        return false;
    }

    mode == AnswerMode::Everything
}

/// Whether the text reads as a question or a request.
pub fn looks_like_a_question(text: &str) -> bool {
    if text.trim_end().ends_with('?') {
        return true;
    }

    let normalized = normalize(text);
    let body = strip_filler(&normalized);

    INTERROGATIVE
        .iter()
        .any(|opening| begins_with_word(body, opening))
}

/// Prefix match that respects word boundaries.
///
/// Without the boundary check, "whether we ship" matches "when" and "I know
/// how that works" matches "how", and the filter starts answering
/// statements.
fn begins_with_word(text: &str, prefix: &str) -> bool {
    text.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
}

/// Removes leading filler words, repeatedly — "so yeah okay, what about…"
/// takes several passes to get to the actual sentence.
fn strip_filler(text: &str) -> &str {
    let mut text = text.trim_start();
    'outer: loop {
        for filler in FILLER {
            if let Some(rest) = text.strip_prefix(filler) {
                if rest.starts_with(' ') {
                    text = rest.trim_start();
                    continue 'outer;
                }
            }
        }
        return text;
    }
}

/// Whether the text trails off on a word no finished sentence ends with.
pub fn ends_mid_sentence(text: &str) -> bool {
    let normalized = normalize(text);
    normalized
        .split_whitespace()
        .next_back()
        .is_some_and(|last| DANGLING.contains(&last))
}

/// Words in `text`, ignoring punctuation and filler.
pub fn word_count(text: &str) -> usize {
    let normalized = normalize(text);
    strip_filler(&normalized).split_whitespace().count()
}

/// Lowercased, with anything that is not a letter, digit, apostrophe or
/// space removed, so prefix matching does not depend on punctuation.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at_gap = true;

    for character in text.chars() {
        if character.is_alphanumeric() || character == '\'' {
            out.extend(character.to_lowercase());
            at_gap = false;
        } else if !at_gap {
            out.push(' ');
            at_gap = true;
        }
    }

    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: usize = 3;

    fn answerable(text: &str) -> bool {
        worth_answering(text, AnswerMode::Questions, MIN)
    }

    #[test]
    fn a_question_mark_is_enough() {
        assert!(answerable("So how would you design a rate limiter?"));
        assert!(answerable("What happens when the cache is cold?"));
    }

    /// Recognition punctuates from prosody, so a flatly-asked question often
    /// arrives with no question mark at all.
    #[test]
    fn an_interrogative_opening_counts_without_a_question_mark() {
        assert!(answerable("how would you handle a thundering herd"));
        assert!(answerable("What happens when the cache is cold"));
        assert!(answerable("why did you choose that database"));
    }

    #[test]
    fn a_request_is_answerable_even_though_it_is_not_a_question() {
        assert!(answerable("Walk me through your approach."));
        assert!(answerable("Tell me about a time you shipped something hard."));
        assert!(answerable("Explain how the retry logic works."));
    }

    /// The whole point of the word floor.
    #[test]
    fn backchannel_is_not_answerable() {
        for noise in ["mhm", "yeah", "right", "okay", "got it", "sure", "uh huh"] {
            assert!(!answerable(noise), "{noise:?} should not trigger an answer");
        }
    }

    #[test]
    fn a_plain_statement_is_not_answerable_by_default() {
        assert!(!answerable("So we shipped that last week and it went fine."));
        assert!(!answerable("I was at the office on Tuesday."));
    }

    #[test]
    fn everything_mode_answers_statements_but_still_not_backchannel() {
        assert!(worth_answering(
            "So we shipped that last week.",
            AnswerMode::Everything,
            MIN
        ));
        assert!(!worth_answering("mhm", AnswerMode::Everything, MIN));
    }

    /// A short question is still a question — the word floor must not
    /// override an explicit question mark.
    #[test]
    fn a_short_question_survives_the_word_floor() {
        assert!(answerable("Why?"));
        assert!(answerable("How come?"));
    }

    #[test]
    fn matching_ignores_case_and_leading_punctuation() {
        assert!(answerable("HOW WOULD YOU SCALE IT"));
        assert!(answerable("  ...so what would you do"));
    }

    /// Observed in a real run: "And what I am wondering is." opens like a
    /// question, reads like a question, and is half of one. A silence timer
    /// cannot tell the difference; the last word can.
    #[test]
    fn a_sentence_trailing_off_is_not_finished() {
        assert!(!answerable("And what I am wondering is"));
        assert!(!answerable("And what I am wondering is."));
        assert!(!answerable("So the thing I want to ask about is the"));
        assert!(!answerable("What I mean by that"));
    }

    /// The other half of that trade: a question that genuinely ends on one of
    /// those words must still get through when it is punctuated.
    #[test]
    fn a_question_mark_overrides_a_dangling_last_word() {
        assert!(answerable("And what I am wondering is?"));
        assert!(answerable("Compared to what?"));
    }

    /// Suppressing a real question is the more expensive mistake, so words
    /// that can legitimately end one are left out of the list.
    #[test]
    fn a_flat_question_ending_on_a_verb_still_counts() {
        assert!(answerable("so what would you do"));
        assert!(answerable("how did they handle it"));
    }

    #[test]
    fn empty_input_is_never_answerable() {
        assert!(!answerable(""));
        assert!(!answerable("   "));
        assert!(!worth_answering("", AnswerMode::Everything, MIN));
    }

    /// "How" opening a statement is not a request. Guarding against the
    /// prefix list being too eager.
    #[test]
    fn an_interrogative_word_mid_sentence_does_not_count() {
        assert!(!answerable("I know how that works and it was fine."));
        assert!(!answerable("That is what we ended up shipping."));
    }
}
