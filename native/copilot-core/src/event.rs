//! The only thing that crosses out of the engine.
//!
//! Everything a user interface needs to know arrives as one of these. That is
//! deliberate: as long as this is the whole contract, the shell on top is
//! replaceable. Tauri today, a WebSocket or a terminal tomorrow, without the
//! engine noticing.
//!
//! Serialized with a `type` tag so the JavaScript side can switch on it
//! directly, and camelCase because that is what reads naturally there.

use serde::Serialize;

use crate::capture::Source;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    /// The microphone. You.
    You,
    /// System output loopback. Everyone else.
    Them,
}

impl From<Source> for Lane {
    fn from(source: Source) -> Self {
        match source {
            Source::Microphone => Lane::You,
            Source::SystemOutput => Lane::Them,
        }
    }
}

impl Lane {
    pub fn label(self) -> &'static str {
        match self {
            Lane::You => "YOU",
            Lane::Them => "THEM",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// Once at startup, so the interface can show what it is actually using.
    #[serde(rename_all = "camelCase")]
    Ready {
        model: String,
        you_device: String,
        them_device: String,
    },

    /// Level meters. Frequent and lossy by nature — a dropped one is
    /// invisible, so nothing downstream should depend on receiving them all.
    #[serde(rename_all = "camelCase")]
    Level { lane: Lane, rms_db: f32 },

    /// Someone started or stopped talking. Arrives well before the text does,
    /// which is what lets the interface show that something is coming.
    #[serde(rename_all = "camelCase")]
    Speaking { lane: Lane, active: bool },

    /// A finished utterance, transcribed.
    #[serde(rename_all = "camelCase")]
    Transcript {
        lane: Lane,
        id: u64,
        text: String,
        start_ms: u64,
        end_ms: u64,
        /// How long recognition took. Worth surfacing — it is the part of
        /// the latency budget most likely to degrade.
        transcribe_ms: u64,
    },

    /// The other side finished asking something worth answering.
    ///
    /// Emitted on its own rather than folded into `Transcript`, because the
    /// decision is separate from the text and lands later — the delay that
    /// confirms they have actually stopped has to pass first.
    #[serde(rename_all = "camelCase")]
    Turn {
        /// The utterance that completed the question, so an answer can be
        /// attached to the right line.
        id: u64,
        /// The question, including anything folded in from before a pause.
        text: String,
    },

    /// Samples the capture thread had to discard. Nonzero means a hole in the
    /// audio, and therefore in the transcript.
    #[serde(rename_all = "camelCase")]
    Dropped { lane: Lane, samples: u64 },

    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(event: &Event) -> String {
        serde_json::to_string(event).expect("event should serialize")
    }

    #[test]
    fn events_carry_a_type_tag_the_interface_can_switch_on() {
        let event = Event::Speaking {
            lane: Lane::Them,
            active: true,
        };
        assert_eq!(json(&event), r#"{"type":"speaking","lane":"them","active":true}"#);
    }

    #[test]
    fn field_names_are_camel_case_on_the_wire() {
        let event = Event::Transcript {
            lane: Lane::You,
            id: 7,
            text: "hello".into(),
            start_ms: 1000,
            end_ms: 2000,
            transcribe_ms: 250,
        };
        let encoded = json(&event);
        assert!(encoded.contains(r#""startMs":1000"#), "{encoded}");
        assert!(encoded.contains(r#""transcribeMs":250"#), "{encoded}");
        assert!(!encoded.contains("start_ms"), "{encoded}");
    }

    #[test]
    fn lanes_map_from_the_capture_source_they_came_from() {
        assert_eq!(Lane::from(Source::Microphone), Lane::You);
        assert_eq!(Lane::from(Source::SystemOutput), Lane::Them);
    }
}
