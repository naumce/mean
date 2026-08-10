//! Deciding when the other side has finished asking something.
//!
//! This is the hardest part of the product and the least like the rest of it.
//! Everything else is either signal processing with a correct answer or a
//! call to something that returns one. This is a judgement call under time
//! pressure: fire too early and the answer is to half a question, fire too
//! late and there is dead air on a live call while everyone waits.
//!
//! So it is built to be tuned rather than to be right first time. No audio,
//! no clock, no I/O — signals go in with a timestamp attached, decisions come
//! out. Every behaviour below is a unit test, which means the thresholds can
//! be moved and the consequences seen in a second rather than by holding a
//! conversation with a laptop.
//!
//! Four conditions have to hold together before an answer fires:
//!
//! 1. The other side has been quiet for the fire delay. Timed from when
//!    *speech* ended rather than when the transcript arrived, so recognition
//!    is spent inside the window instead of added to it.
//! 2. There is a finished transcript to answer.
//! 3. You are not talking. If you are, you are already answering.
//! 4. What they said is worth answering at all.
//!
//! And one behaviour matters as much as the four conditions: **resuming
//! cancels**. A pause in the middle of a sentence is the single most common
//! way a naive silence timer fails, and the fix is that speech starting again
//! withdraws the pending answer and folds what was already said into what
//! comes next.

pub mod question;

pub use question::AnswerMode;

use crate::config::{TURN_CARRY_TTL_MS, TURN_FIRE_DELAY_MS, TURN_MIN_WORDS};
use crate::event::Lane;

#[derive(Clone, Copy, Debug)]
pub struct TurnConfig {
    pub fire_delay_ms: u64,
    /// How long an unfinished fragment waits for the rest of its sentence.
    pub carry_ttl_ms: u64,
    pub min_words: usize,
    pub mode: AnswerMode,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            fire_delay_ms: TURN_FIRE_DELAY_MS,
            carry_ttl_ms: TURN_CARRY_TTL_MS,
            min_words: TURN_MIN_WORDS,
            mode: AnswerMode::Questions,
        }
    }
}

/// Something that happened on a lane. The detector's whole input.
#[derive(Clone, Debug)]
pub enum Signal {
    SpeechStarted { lane: Lane },
    SpeechEnded { lane: Lane },
    Transcript { lane: Lane, id: u64, text: String },
}

/// A question that should be answered now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    /// The utterance that triggered this, so an answer can be tied back to
    /// the line it belongs under.
    pub id: u64,
    pub text: String,
}

pub struct TurnDetector {
    config: TurnConfig,
    them_speaking: bool,
    you_speaking: bool,
    /// When the other side last stopped talking.
    them_ended_at: Option<u64>,
    /// A finished question waiting out the fire delay.
    pending: Option<Pending>,
    /// Text from a withdrawn answer, waiting to be folded into whatever they
    /// say next. This is what makes a mid-sentence pause harmless.
    carry: Option<Carry>,
}

struct Pending {
    id: u64,
    text: String,
    ended_at: u64,
}

struct Carry {
    text: String,
    /// When this was set aside.
    ///
    /// Age is judged when they *start talking again*, not when the next
    /// transcript arrives. Measured on a real run, the difference is the
    /// whole length of the second sentence — 2.4 seconds of someone speaking
    /// counted against a fragment that was only 600 ms old when they
    /// resumed, and the two halves failed to join.
    at: u64,
}

impl TurnDetector {
    pub fn new(config: TurnConfig) -> Self {
        Self {
            config,
            them_speaking: false,
            you_speaking: false,
            them_ended_at: None,
            pending: None,
            carry: None,
        }
    }

    /// Records something that happened, at `now_ms`.
    pub fn observe(&mut self, signal: Signal, now_ms: u64) {
        match signal {
            Signal::SpeechStarted { lane: Lane::Them } => {
                self.them_speaking = true;

                // The one moment where a fragment's age is the right
                // question: did they pick the sentence back up in time?
                self.expire_carry(now_ms);

                // They are not finished after all. Withdraw the answer and
                // keep what was said, to be folded into what comes next.
                if let Some(pending) = self.pending.take() {
                    let text = join(self.carry.take().map(|carry| carry.text), &pending.text);
                    self.carry = Some(Carry { text, at: now_ms });
                }
            }

            Signal::SpeechEnded { lane: Lane::Them } => {
                self.them_speaking = false;
                self.them_ended_at = Some(now_ms);
            }

            Signal::SpeechStarted { lane: Lane::You } => self.you_speaking = true,
            Signal::SpeechEnded { lane: Lane::You } => self.you_speaking = false,

            Signal::Transcript {
                lane: Lane::Them,
                id,
                text,
            } => {
                // No age check here: whether this fragment still belongs was
                // settled when they started talking again.
                let combined = join(self.carry.take().map(|carry| carry.text), &text);

                // Timed from when they stopped talking, not from now — this
                // transcript is already several hundred milliseconds old.
                let ended_at = self.them_ended_at.unwrap_or(now_ms);

                if question::worth_answering(&combined, self.config.mode, self.config.min_words) {
                    self.pending = Some(Pending {
                        id,
                        text: combined,
                        ended_at,
                    });
                } else {
                    // Not answerable on its own, but it may be the first half
                    // of something that is.
                    self.carry = Some(Carry {
                        text: combined,
                        at: ended_at,
                    });
                }
            }

            Signal::Transcript {
                lane: Lane::You,
                text,
                ..
            } => {
                // You said something real, so you have taken the question.
                // Anything short of that is a noise and only defers.
                if question::word_count(&text) >= self.config.min_words {
                    self.pending = None;
                    self.carry = None;
                }
            }
        }
    }

    /// Asks whether an answer should start now. Call it regularly — the
    /// deciding condition is elapsed time, so nothing else will announce it.
    pub fn poll(&mut self, now_ms: u64) -> Option<Turn> {
        if self.them_speaking || self.you_speaking {
            return None;
        }

        let Some(pending) = &self.pending else {
            // Deliberately does *not* expire the fragment. Elapsed time here
            // includes however long they have been talking since, and a
            // fragment they picked straight back up would be discarded
            // mid-sentence. Age is judged in one place only: when they start
            // talking again.
            return None;
        };

        if now_ms.saturating_sub(pending.ended_at) < self.config.fire_delay_ms {
            return None;
        }

        let pending = self.pending.take()?;
        Some(Turn {
            id: pending.id,
            text: pending.text,
        })
    }

    /// Whether an answer is waiting out the fire delay. For showing that
    /// something is about to happen.
    pub fn is_armed(&self) -> bool {
        self.pending.is_some()
    }

    /// Forgets a fragment nobody came back for.
    fn expire_carry(&mut self, now_ms: u64) {
        let stale = self
            .carry
            .as_ref()
            .is_some_and(|carry| now_ms.saturating_sub(carry.at) > self.config.carry_ttl_ms);
        if stale {
            self.carry = None;
        }
    }
}

/// Joins a carried fragment onto what was said next.
fn join(carry: Option<String>, next: &str) -> String {
    match carry {
        Some(prefix) if !prefix.trim().is_empty() => {
            format!("{} {}", prefix.trim_end(), next.trim_start())
        }
        _ => next.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector() -> TurnDetector {
        TurnDetector::new(TurnConfig::default())
    }

    /// The fire delay, so tests read in terms of the threshold rather than a
    /// magic number that has to be updated when it moves.
    const DELAY: u64 = TURN_FIRE_DELAY_MS;

    /// Advances the clock the way the session actually does — polling all the
    /// way, rather than only at the instant a decision is expected.
    ///
    /// This exists because two separate bugs hid in exactly that gap. Both
    /// were expiry that only ran inside `poll`, and both passed a test that
    /// jumped straight to the interesting moment. Anything that walks time
    /// forward must walk it the way the caller does.
    fn tick_to(d: &mut TurnDetector, from: u64, to: u64) -> Option<Turn> {
        let mut at = from;
        while at < to {
            if let Some(turn) = d.poll(at) {
                return Some(turn);
            }
            at += 50;
        }
        d.poll(to)
    }

    fn they_say(d: &mut TurnDetector, id: u64, text: &str, ended_at: u64) {
        d.observe(Signal::SpeechStarted { lane: Lane::Them }, ended_at - 500);
        d.observe(Signal::SpeechEnded { lane: Lane::Them }, ended_at);
        // Recognition takes a moment; the transcript always lands after the
        // speech that produced it.
        d.observe(
            Signal::Transcript {
                lane: Lane::Them,
                id,
                text: text.into(),
            },
            ended_at + 250,
        );
    }

    #[test]
    fn a_question_fires_once_the_delay_has_passed() {
        let mut d = detector();
        they_say(&mut d, 0, "How would you design a rate limiter?", 1000);

        assert_eq!(d.poll(1000 + DELAY - 1), None, "fired before the delay");
        let turn = d.poll(1000 + DELAY).expect("should have fired");
        assert_eq!(turn.id, 0);
        assert!(turn.text.contains("rate limiter"));
    }

    /// The delay is measured from the end of speech, so the time recognition
    /// took is spent inside the window rather than added to it.
    #[test]
    fn recognition_time_comes_out_of_the_delay_not_on_top_of_it() {
        let mut d = detector();
        d.observe(Signal::SpeechEnded { lane: Lane::Them }, 1000);
        // A slow transcription, arriving most of the way through the window.
        d.observe(
            Signal::Transcript {
                lane: Lane::Them,
                id: 0,
                text: "What happens when the cache is cold?".into(),
            },
            1000 + DELAY - 50,
        );

        assert!(d.poll(1000 + DELAY).is_some());
    }

    #[test]
    fn nothing_fires_while_they_are_still_talking() {
        let mut d = detector();
        they_say(&mut d, 0, "How would you design a rate limiter?", 1000);
        d.observe(Signal::SpeechStarted { lane: Lane::Them }, 1100);

        assert_eq!(d.poll(9000), None, "answered over the top of them");
    }

    /// The failure mode this module exists to prevent: "So… what would you
    /// do?" must be answered once, as one question.
    #[test]
    fn resuming_withdraws_the_answer_and_folds_the_text_together() {
        let mut d = detector();
        they_say(&mut d, 0, "So what I'm wondering is", 1000);

        // They pick up again before the delay elapses.
        d.observe(Signal::SpeechStarted { lane: Lane::Them }, 1400);
        assert_eq!(d.poll(1500), None);

        d.observe(Signal::SpeechEnded { lane: Lane::Them }, 2500);
        d.observe(
            Signal::Transcript {
                lane: Lane::Them,
                id: 1,
                text: "how would you handle retries?".into(),
            },
            2700,
        );

        let turn = d.poll(2500 + DELAY).expect("should have fired");
        assert_eq!(turn.id, 1, "should be tied to the utterance that completed it");
        assert!(turn.text.contains("wondering"), "lost the first half: {}", turn.text);
        assert!(turn.text.contains("retries"), "lost the second half: {}", turn.text);
    }

    #[test]
    fn backchannel_never_fires() {
        let mut d = detector();
        for (id, noise) in ["mhm", "right", "okay", "yeah"].iter().enumerate() {
            they_say(&mut d, id as u64, noise, 1000 + id as u64 * 5000);
        }
        assert_eq!(d.poll(60_000), None);
    }

    #[test]
    fn a_statement_does_not_fire_by_default() {
        let mut d = detector();
        they_say(&mut d, 0, "So we shipped that last week and it went fine.", 1000);
        assert_eq!(d.poll(1000 + DELAY), None);
    }

    /// If you are talking, you are already answering.
    #[test]
    fn it_waits_while_you_are_talking() {
        let mut d = detector();
        they_say(&mut d, 0, "How would you scale it?", 1000);
        d.observe(Signal::SpeechStarted { lane: Lane::You }, 1200);

        assert_eq!(d.poll(1000 + DELAY), None, "answered while you were talking");

        d.observe(Signal::SpeechEnded { lane: Lane::You }, 3000);
        assert!(d.poll(3100).is_some(), "should answer once you stop");
    }

    /// A brief noise from your side should only defer the answer, but
    /// actually saying something means you have taken the question.
    #[test]
    fn you_answering_it_yourself_cancels_it() {
        let mut d = detector();
        they_say(&mut d, 0, "How would you scale it?", 1000);

        d.observe(Signal::SpeechStarted { lane: Lane::You }, 1200);
        d.observe(Signal::SpeechEnded { lane: Lane::You }, 3000);
        d.observe(
            Signal::Transcript {
                lane: Lane::You,
                id: 0,
                text: "Sure, I would start with a token bucket.".into(),
            },
            3200,
        );

        assert_eq!(d.poll(9000), None, "answered a question you already answered");
    }

    #[test]
    fn each_question_fires_exactly_once() {
        let mut d = detector();
        they_say(&mut d, 0, "How would you design a rate limiter?", 1000);

        assert!(d.poll(1000 + DELAY).is_some());
        assert_eq!(d.poll(1000 + DELAY + 1), None, "fired twice");
        assert_eq!(d.poll(60_000), None, "fired again later");
    }

    /// A fragment only survives while they keep talking. Left alone past the
    /// delay it is forgotten, rather than lurking to be glued onto whatever
    /// gets said several minutes later.
    #[test]
    fn an_abandoned_fragment_is_forgotten_rather_than_carried_forever() {
        let mut d = detector();
        they_say(&mut d, 0, "So anyway", 1000);
        assert_eq!(tick_to(&mut d, 1000, 29_000), None);

        they_say(&mut d, 1, "How would you scale it?", 30_000);
        let turn = tick_to(&mut d, 30_000, 30_000 + DELAY).expect("should have fired");
        assert!(
            !turn.text.contains("anyway"),
            "stale fragment came back: {}",
            turn.text
        );
    }

    /// Only the other side gets answered. A question you ask is yours.
    #[test]
    fn your_own_questions_are_never_answered() {
        let mut d = detector();
        d.observe(Signal::SpeechEnded { lane: Lane::You }, 1000);
        d.observe(
            Signal::Transcript {
                lane: Lane::You,
                id: 0,
                text: "How would you design a rate limiter?".into(),
            },
            1200,
        );

        assert_eq!(d.poll(9000), None);
    }

    /// Observed in a real run. An unfinished fragment and the question that
    /// completed it were further apart than the fire delay once the detection
    /// hangover was counted, and the fragment was dropped. Holding a few
    /// words costs nothing, so a fragment outlives the delay.
    #[test]
    fn a_fragment_outlives_the_fire_delay_and_still_merges() {
        let mut d = detector();
        they_say(&mut d, 0, "And what I am wondering is", 1000);

        // Well past the fire delay, still inside the carry window.
        assert_eq!(tick_to(&mut d, 1000, 1000 + DELAY + 200), None);

        they_say(&mut d, 1, "how would you handle a thundering herd?", 2000);
        let turn = tick_to(&mut d, 2000, 2000 + DELAY).expect("should have fired");
        assert!(
            turn.text.contains("wondering"),
            "the fragment was dropped: {}",
            turn.text
        );
        assert!(turn.text.contains("thundering herd"), "{}", turn.text);
    }

    /// Why the age check sits at "they started talking again" rather than at
    /// "the next transcript arrived". Observed on a real run: the fragment
    /// was 600 ms old when they resumed, then they talked for another two and
    /// a half seconds, and judging its age on arrival threw away a fragment
    /// that had been picked straight back up.
    #[test]
    fn a_long_second_sentence_does_not_age_out_a_fresh_fragment() {
        let mut d = detector();
        d.observe(Signal::SpeechStarted { lane: Lane::Them }, 500);
        d.observe(Signal::SpeechEnded { lane: Lane::Them }, 1000);
        d.observe(
            Signal::Transcript {
                lane: Lane::Them,
                id: 0,
                text: "And what I am wondering is".into(),
            },
            1200,
        );

        // Polled throughout, as the session does. The bug this catches only
        // appeared here: elapsed time kept running while they talked, and an
        // expiry check inside poll threw the fragment away mid-sentence.
        assert_eq!(tick_to(&mut d, 1200, 1600), None);

        // Back within the window, then talking for far longer than it.
        d.observe(Signal::SpeechStarted { lane: Lane::Them }, 1600);
        assert_eq!(tick_to(&mut d, 1600, 6600), None);

        d.observe(Signal::SpeechEnded { lane: Lane::Them }, 6600);
        assert_eq!(tick_to(&mut d, 6600, 6900), None);

        d.observe(
            Signal::Transcript {
                lane: Lane::Them,
                id: 1,
                text: "how would you handle a thundering herd?".into(),
            },
            6900,
        );

        let turn = tick_to(&mut d, 6900, 6600 + DELAY + 200).expect("should have fired");
        assert!(
            turn.text.contains("wondering"),
            "the fragment was aged out by the length of the reply: {}",
            turn.text
        );
        assert!(turn.text.contains("thundering herd"), "{}", turn.text);
    }

    #[test]
    fn it_reports_when_an_answer_is_armed() {
        let mut d = detector();
        assert!(!d.is_armed());

        they_say(&mut d, 0, "How would you scale it?", 1000);
        assert!(d.is_armed(), "should be armed while waiting out the delay");

        d.poll(1000 + DELAY);
        assert!(!d.is_armed(), "should disarm once it has fired");
    }

    #[test]
    fn everything_mode_answers_statements_too() {
        let mut d = TurnDetector::new(TurnConfig {
            mode: AnswerMode::Everything,
            ..TurnConfig::default()
        });
        they_say(&mut d, 0, "So we shipped that last week and it went fine.", 1000);
        assert!(d.poll(1000 + DELAY).is_some());
    }
}
