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

/// A codebase the session can see, as a listing rather than contents.
///
/// Paths only. The point is orientation — knowing that `src/audio/vad.rs`
/// exists is what lets an answer name it instead of describing where it might
/// be — and paths cost almost nothing next to the files themselves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repo {
    pub root: String,
    pub files: Vec<String>,
    /// How many files there actually are, which is more than `files.len()`
    /// once the listing has been capped. Reported rather than hidden: a
    /// truncated tree is indistinguishable from a small repository.
    pub total: usize,
}

/// A file travelling with one question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFile {
    pub path: String,
    /// The editor had unsaved changes, so this is the file as last saved and
    /// not what is on screen. Said out loud in the prompt, because a model
    /// reading a stale file confidently explains a bug that is already fixed.
    pub dirty: bool,
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
    /// The codebase, if one was pointed at.
    pub repo: Option<Repo>,
}

impl Brief {
    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.documents.is_empty() && self.repo.is_none()
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
    /// Source travelling with this question — normally the file open in the
    /// editor at the moment it was asked.
    ///
    /// Per-question rather than part of the brief, because it changes between
    /// questions. In the system prompt it would invalidate the cache on every
    /// ask and re-bill the whole repository listing along with it.
    pub files: Vec<SourceFile>,
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
            files: Vec::new(),
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

    // Documents and the repository listing last in the system prompt, and
    // unchanging for the session, so a cache breakpoint after them covers the
    // most expensive stable bytes.
    for document in &brief.documents {
        system.push_str("\n\n---\n");
        system.push_str("Document: ");
        system.push_str(&document.name);
        system.push('\n');
        system.push_str(document.body.trim_end());
    }

    if let Some(repo) = &brief.repo {
        system.push_str("\n\n---\nThe project you are working in, file by file.\n");
        system.push_str("Refer to real paths from this list rather than inventing plausible ones.\n\n");
        for path in &repo.files {
            system.push_str(path);
            system.push('\n');
        }
        // A capped listing looks exactly like a small repository unless it
        // says otherwise, and a model that thinks it has seen everything will
        // confidently say a file does not exist.
        if repo.total > repo.files.len() {
            system.push_str(&format!(
                "\n… {} of {} files listed. The rest exist but are not shown.\n",
                repo.files.len(),
                repo.total
            ));
        }
    }

    let mut content = String::new();

    // Ahead of the transcript and the question both: the file is what the
    // question is about, and a model reads what came before the ask as
    // material rather than as an afterthought.
    for file in &question.files {
        content.push_str("Open in my editor: ");
        content.push_str(&file.path);
        if file.dirty {
            content.push_str("\n(unsaved changes — this is the file as last saved, \
                              so it may not match what is on my screen)");
        }
        content.push('\n');
        content.push_str(&file.body);
        if !file.body.ends_with('\n') {
            content.push('\n');
        }
        content.push('\n');
    }

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
            files: Vec::new(),
        }
    }

    fn repo() -> Repo {
        Repo {
            root: "E:/project".into(),
            files: vec!["src/main.rs".into(), "src/audio/vad.rs".into()],
            total: 2,
        }
    }

    fn source(path: &str, dirty: bool) -> SourceFile {
        SourceFile {
            path: path.into(),
            dirty,
            body: "fn main() {}".into(),
        }
    }

    /// The listing is fixed for the session, so it belongs with the documents
    /// in the cached half. In the message it would be re-billed every ask.
    #[test]
    fn the_repository_listing_lives_in_the_system_prompt() {
        let brief = Brief {
            repo: Some(repo()),
            ..Brief::default()
        };
        let request = build(&question(), &brief);

        assert!(request.system.contains("src/audio/vad.rs"));
        assert!(!request.messages[0].content.contains("src/audio/vad.rs"));
    }

    /// The mirror image, and the more expensive mistake of the two. The open
    /// file changes with every question; in the system prompt it would
    /// invalidate the cache each time and drag the whole listing with it.
    #[test]
    fn the_open_file_travels_with_the_question_not_the_brief() {
        let mut asked = question();
        asked.files = vec![source("src/main.rs", false)];

        let brief = Brief {
            repo: Some(repo()),
            ..Brief::default()
        };
        let request = build(&asked, &brief);

        assert!(request.messages[0].content.contains("fn main() {}"));
        assert!(!request.system.contains("fn main() {}"));
    }

    /// A truncated tree looks exactly like a small repository, and a model
    /// that believes it has seen everything will state that a file is missing.
    #[test]
    fn a_capped_listing_says_how_much_it_left_out() {
        let brief = Brief {
            repo: Some(Repo {
                total: 4210,
                ..repo()
            }),
            ..Brief::default()
        };

        assert!(build(&question(), &brief).system.contains("4210"));
    }

    #[test]
    fn a_complete_listing_does_not_apologise_for_itself() {
        let brief = Brief {
            repo: Some(repo()),
            ..Brief::default()
        };

        assert!(!build(&question(), &brief).system.contains("not shown"));
    }

    /// Reading a stale file silently is how you get a confident explanation of
    /// a bug that was fixed thirty seconds ago.
    #[test]
    fn an_unsaved_file_is_flagged_as_stale() {
        let mut asked = question();
        asked.files = vec![source("src/main.rs", true)];

        let content = build(&asked, &Brief::default()).messages[0].content.clone();
        assert!(content.contains("unsaved changes"), "no staleness warning");
    }

    #[test]
    fn a_saved_file_carries_no_warning() {
        let mut asked = question();
        asked.files = vec![source("src/main.rs", false)];

        let content = build(&asked, &Brief::default()).messages[0].content.clone();
        assert!(!content.contains("unsaved changes"));
    }

    /// The file has to arrive before the question, or it reads as an
    /// afterthought appended to an ask that has already been made.
    #[test]
    fn the_file_comes_before_the_question() {
        let mut asked = question();
        asked.files = vec![source("src/main.rs", false)];

        let content = build(&asked, &Brief::default()).messages[0].content.clone();
        let file_at = content.find("Open in my editor").expect("file missing");
        let question_at = content.find("thundering herd").expect("question missing");

        assert!(file_at < question_at, "the question came before the file");
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
                repo: None,
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
                repo: None,
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
                repo: None,
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
            files: Vec::new(),
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
