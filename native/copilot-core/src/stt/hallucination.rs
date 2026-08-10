//! Filtering out text whisper invented.
//!
//! Whisper was trained on a very large amount of subtitled video, and it
//! learned the furniture along with the speech. Hand it near-silence and it
//! does not return nothing — it returns the most likely thing to appear over
//! quiet footage. "Thank you." and "Thanks for watching!" are the usual ones,
//! along with translator credits and bracketed sound descriptions.
//!
//! This matters more here than in an offline transcriber. A hallucinated
//! sentence attributed to the other side of a call looks exactly like a real
//! one, and downstream it can trigger an answer to a question nobody asked.
//!
//! Two defences, and the first one does most of the work: never hand whisper
//! a segment the voice detector did not mark as speech. This module is the
//! second, for what slips through anyway.

/// Phrases whisper emits when there was nothing to transcribe.
///
/// Compared after normalizing case and stripping punctuation, so one entry
/// covers "Thank you.", "thank you", and "Thank you!".
const INVENTED: &[&str] = &[
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching and i'll see you in the next video",
    "i'll see you in the next video",
    "i will see you in the next video",
    "see you in the next video",
    "see you next time",
    "please subscribe",
    "please subscribe to my channel",
    "like and subscribe",
    "you",
    "bye",
    "bye bye",
    "okay",
    "so",
    "the end",
    "subtitles by the amara org community",
    "subtitles by the amaraorg community",
    "transcription by eso translated by",
    "amara org community",
];

/// Keeps `text` if it looks like something a person actually said.
///
/// Returns `None` for empty input, for known invented phrases, and for text
/// that is nothing but a bracketed sound description such as `[MUSIC]` or
/// `(silence)`.
pub fn keep(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || normalize(trimmed).is_empty() {
        return None;
    }
    if is_only_sound_description(trimmed) {
        return None;
    }

    // Filtered sentence by sentence rather than whole. Observed in a real
    // run: "Thank you for watching. I will see you in the next video." is two
    // stock phrases stuck together, and matching the whole utterance misses
    // it. Working per sentence also means a real sentence sitting next to an
    // invented one survives instead of being thrown out with it.
    let kept: Vec<&str> = sentences(trimmed)
        .into_iter()
        .filter(|sentence| {
            let normalized = normalize(sentence);
            !normalized.is_empty() && !INVENTED.contains(&normalized.as_str())
        })
        .collect();

    if kept.is_empty() {
        return None;
    }

    Some(kept.join(" "))
}

/// Splits on sentence terminators, keeping each terminator with the sentence
/// it ended.
///
/// A terminator only ends a sentence when whitespace or the end of the text
/// follows it. Without that check "Amara.org" becomes two sentences and
/// "THANK YOU!!!" becomes three, and neither matches anything.
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;

    for (at, character) in text.char_indices() {
        if !matches!(character, '.' | '!' | '?') {
            continue;
        }

        let end = at + character.len_utf8();
        let ends_here = text[end..]
            .chars()
            .next()
            .is_none_or(|next| next.is_whitespace());
        if !ends_here {
            continue;
        }

        let sentence = text[start..end].trim();
        if !sentence.is_empty() {
            out.push(sentence);
        }
        start = end;
    }

    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// Lowercases, strips punctuation, and collapses whitespace, so that
/// comparing against the list above does not depend on how whisper happened
/// to punctuate this particular guess.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at_gap = true;

    for character in text.chars() {
        // Apostrophes stay: "i'll" and "ill" are different words.
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

/// Whether the text is nothing but one bracketed description — `[MUSIC]`,
/// `(silence)`. A description sitting alongside real words is not this, and
/// dropping the line would take the speech with it.
fn is_only_sound_description(text: &str) -> bool {
    let inner = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .or_else(|| {
            text.strip_prefix('(')
                .and_then(|rest| rest.strip_suffix(')'))
        });

    match inner {
        // A closing bracket still inside means there was more than one group,
        // so this is not a single description and gets kept.
        Some(inner) => !inner.contains([']', ')', '[', '(']),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_speech_is_kept_verbatim() {
        assert_eq!(
            keep("So how would you design a rate limiter?").as_deref(),
            Some("So how would you design a rate limiter?")
        );
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(keep("  hello there  ").as_deref(), Some("hello there"));
    }

    #[test]
    fn empty_and_whitespace_only_input_is_dropped() {
        assert_eq!(keep(""), None);
        assert_eq!(keep("   \n\t "), None);
    }

    #[test]
    fn the_classic_silence_hallucinations_are_dropped() {
        assert_eq!(keep("Thank you."), None);
        assert_eq!(keep("Thanks for watching!"), None);
        assert_eq!(keep("thank you"), None);
        assert_eq!(keep("  Thank you!  "), None);
    }

    /// Observed in a real run. Two stock phrases stuck together match
    /// neither one on their own.
    #[test]
    fn stock_phrases_glued_together_are_dropped() {
        assert_eq!(
            keep("Thank you for watching. I will see you in the next video."),
            None
        );
        assert_eq!(keep("Thanks for watching! See you next time."), None);
    }

    /// The reason for filtering per sentence rather than dropping the line:
    /// real speech next to an invented phrase has to survive.
    #[test]
    fn real_speech_beside_an_invented_phrase_survives() {
        assert_eq!(
            keep("Thank you. So how would you shard that?").as_deref(),
            Some("So how would you shard that?")
        );
    }

    #[test]
    fn multiple_real_sentences_come_back_intact() {
        assert_eq!(
            keep("Yes. That works for reads.").as_deref(),
            Some("Yes. That works for reads.")
        );
    }

    #[test]
    fn subtitle_credits_are_dropped() {
        assert_eq!(keep("Subtitles by the Amara.org community"), None);
    }

    #[test]
    fn bare_sound_descriptions_are_dropped() {
        assert_eq!(keep("[BLANK_AUDIO]"), None);
        assert_eq!(keep("[Music]"), None);
        assert_eq!(keep("(silence)"), None);
        assert_eq!(keep("[ Silence ]"), None);
    }

    /// A description alongside real words is real content, and throwing the
    /// whole line away would lose the speech with it.
    #[test]
    fn a_description_next_to_real_speech_is_kept() {
        assert_eq!(
            keep("[Music] and that's the architecture").as_deref(),
            Some("[Music] and that's the architecture")
        );
    }

    /// "So" alone is a hallucination. "So, where were we?" is not.
    #[test]
    fn a_blocked_word_inside_a_real_sentence_does_not_block_it() {
        assert_eq!(
            keep("So, where were we?").as_deref(),
            Some("So, where were we?")
        );
        assert_eq!(
            keep("Thank you for explaining that").as_deref(),
            Some("Thank you for explaining that")
        );
    }

    #[test]
    fn matching_ignores_case_and_punctuation() {
        assert_eq!(keep("THANK YOU!!!"), None);
        assert_eq!(keep("Bye."), None);
    }
}
