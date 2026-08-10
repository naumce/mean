//! A transcriber that returns a script instead of listening.
//!
//! Everything downstream of recognition — turn detection, prompting, the
//! event stream, the UI — needs transcripts to work against, and none of it
//! should need a 141 MB model, a C++ build, or a person willing to talk into
//! a microphone on demand. This supplies the transcripts.

use anyhow::Result;

use super::Transcriber;

pub struct MockTranscriber {
    lines: Vec<String>,
    next: usize,
    /// What to return once the script runs out. Repeating the last line
    /// would look like a stuck recognizer, so the default is nothing.
    pub repeat: bool,
}

impl MockTranscriber {
    pub fn new<S: Into<String>>(lines: impl IntoIterator<Item = S>) -> Self {
        Self {
            lines: lines.into_iter().map(Into::into).collect(),
            next: 0,
            repeat: false,
        }
    }

    /// How many lines have been handed out so far.
    pub fn spoken(&self) -> usize {
        self.next
    }
}

impl Transcriber for MockTranscriber {
    fn transcribe(&mut self, _samples: &[f32]) -> Result<Option<String>> {
        if self.lines.is_empty() {
            return Ok(None);
        }

        let line = if self.next < self.lines.len() {
            Some(self.lines[self.next].clone())
        } else if self.repeat {
            Some(self.lines[self.lines.len() - 1].clone())
        } else {
            None
        };

        self.next += 1;
        Ok(line)
    }

    fn name(&self) -> String {
        "mock".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_out_the_script_in_order() {
        let mut t = MockTranscriber::new(["first", "second"]);
        assert_eq!(t.transcribe(&[]).unwrap().as_deref(), Some("first"));
        assert_eq!(t.transcribe(&[]).unwrap().as_deref(), Some("second"));
    }

    #[test]
    fn falls_silent_once_the_script_runs_out() {
        let mut t = MockTranscriber::new(["only"]);
        t.transcribe(&[]).unwrap();
        assert_eq!(t.transcribe(&[]).unwrap(), None);
    }

    #[test]
    fn can_repeat_the_last_line_instead() {
        let mut t = MockTranscriber::new(["again"]);
        t.repeat = true;
        t.transcribe(&[]).unwrap();
        assert_eq!(t.transcribe(&[]).unwrap().as_deref(), Some("again"));
    }

    #[test]
    fn an_empty_script_transcribes_to_nothing() {
        let mut t = MockTranscriber::new(Vec::<String>::new());
        assert_eq!(t.transcribe(&[]).unwrap(), None);
        assert_eq!(t.spoken(), 0);
    }
}
