//! Pointing the session at a codebase.
//!
//! Two separate things, with deliberately different lifetimes.
//!
//! **The tree** — every path in the repository — is fixed for the session, so
//! it travels in the system prompt behind the cache breakpoint, next to the
//! documents. It is what lets an answer say `src/audio/vad.rs` instead of
//! "wherever your VAD lives".
//!
//! **The open file** changes with every question, so it travels with the
//! question instead. Putting it in the system prompt would invalidate the
//! cache on every ask and re-bill the entire repository listing each time —
//! the exact mistake the documents ordering exists to avoid.
//!
//! Which file is open is read from the title bar of the window you were last
//! using. That needs no editor plugin and works with anything that names the
//! file it is showing, which is every editor worth using. It is a heuristic,
//! so it is a pure function with tests rather than a guess buried in I/O.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

use crate::capture::screen;
use crate::llm::{Repo, SourceFile};

/// How many paths travel in the tree.
///
/// Not a technical ceiling. The listing is cached, so it is paid for once, but
/// it is still paid for — and a tree long enough to bury the brief has stopped
/// being context and started being noise.
pub const MAX_FILES: usize = 600;

/// How much of one file travels with a question.
///
/// Generous for source, small enough that a checked-in bundle or minified
/// asset cannot quietly become the most expensive part of every question.
pub const MAX_BYTES: usize = 120 * 1024;

/// Editors put the file first and the project after it, separated by an em
/// dash, an en dash, or a hyphen depending on taste and platform.
const SEPARATORS: [&str; 3] = [" — ", " – ", " - "];

/// Marks an unsaved buffer in VS Code and several others.
const DIRTY: [char; 3] = ['●', '*', '•'];

/// What a window title claims is open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Open {
    /// The file name as the title gave it — usually a bare name, sometimes a
    /// partial path when the editor is disambiguating.
    pub name: String,
    /// The editor is showing unsaved changes, so what is on disk is not what
    /// is on screen.
    pub dirty: bool,
}

/// Opens a repository: everything tracked, ignored files skipped.
pub fn open(root: impl AsRef<Path>) -> Result<Repo> {
    let root = root.as_ref();
    if !root.is_dir() {
        bail!("{} is not a folder", root.display());
    }

    let mut files: Vec<String> = Vec::new();
    let mut total = 0usize;

    // `ignore` honours .gitignore and skips hidden entries, which is the
    // difference between listing a project and listing its node_modules.
    for entry in ignore::WalkBuilder::new(root).build().flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }

        total += 1;
        if files.len() < MAX_FILES {
            if let Ok(relative) = entry.path().strip_prefix(root) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    files.sort();

    Ok(Repo {
        root: root.display().to_string(),
        files,
        // Said out loud rather than silently truncated: a listing that stops
        // early looks exactly like a repository that ends there.
        total,
    })
}

/// Reads the file the editor in front is showing, if it belongs to the repo.
pub fn open_file(repo: &Repo) -> Option<SourceFile> {
    let open = from_title(&screen::active_title()?)?;
    let path = resolve(repo, &open.name)?;
    read(repo, &path, open.dirty).ok()
}

/// Pulls the file name out of a window title.
///
/// Returns `None` rather than guessing when the title does not name a file.
/// A browser tab called "React TS 2FA Exercise" must not be mistaken for
/// source, so a candidate has to carry an extension to count.
pub fn from_title(title: &str) -> Option<Open> {
    let head = SEPARATORS
        .iter()
        .filter_map(|separator| title.split(separator).next())
        .min_by_key(|part| part.len())
        .unwrap_or(title);

    let head = head.trim();
    let dirty = head.starts_with(DIRTY);
    let name = head.trim_start_matches(DIRTY).trim();

    // A name with no extension is a project, a window, or a browser tab. Only
    // a suffix distinguishes a file, and the suffix has to look like one:
    // "Untitled-1" and "3.5" are not files.
    let extension = name.rsplit_once('.')?.1;
    if extension.is_empty()
        || extension.len() > 12
        || !extension.chars().all(|c| c.is_ascii_alphanumeric())
        // A suffix of digits alone is a version number, not a file type —
        // "Claude 3.5" would otherwise be read as a file called "Claude 3".
        // One letter is enough, so "7z" and "mp4" still count.
        || !extension.chars().any(|c| c.is_ascii_alphabetic())
    {
        return None;
    }

    Some(Open {
        name: name.replace('\\', "/"),
        dirty,
    })
}

/// Every path in the tree that the title could be referring to.
///
/// Matched from the right so a title carrying a partial path — which editors
/// use to tell two files of the same name apart — narrows rather than misses.
pub fn candidates<'a>(files: &'a [String], name: &str) -> Vec<&'a String> {
    let needle = name.trim_start_matches('/');
    if needle.is_empty() {
        return Vec::new();
    }

    files
        .iter()
        .filter(|path| {
            path.as_str() == needle
                || path
                    .strip_suffix(needle)
                    .is_some_and(|before| before.ends_with('/'))
        })
        .collect()
}

/// Picks which candidate is meant, breaking ties by whichever was touched
/// last — with several `mod.rs` to choose from, the one being edited is the
/// one that changed most recently.
fn resolve(repo: &Repo, name: &str) -> Option<PathBuf> {
    let root = Path::new(&repo.root);
    let found = candidates(&repo.files, name);

    match found.as_slice() {
        [] => None,
        [only] => Some(root.join(only)),
        many => many
            .iter()
            .map(|relative| root.join(relative))
            .max_by_key(|path| {
                std::fs::metadata(path)
                    .and_then(|meta| meta.modified())
                    .ok()
            }),
    }
}

fn read(repo: &Repo, path: &Path, dirty: bool) -> Result<SourceFile> {
    let body = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;

    let body = if body.len() > MAX_BYTES {
        let mut cut = MAX_BYTES;
        while cut > 0 && !body.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n… truncated", &body[..cut])
    } else {
        body
    };

    let relative = path
        .strip_prefix(&repo.root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(SourceFile {
        path: relative,
        dirty,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_named(name: &str) -> Option<Open> {
        from_title(name)
    }

    #[test]
    fn a_vs_code_title_gives_up_the_file() {
        assert_eq!(
            open_named("Cargo.toml — meeting-copilot — Visual Studio Code"),
            Some(Open {
                name: "Cargo.toml".into(),
                dirty: false
            })
        );
    }

    /// The dot marks an unsaved buffer, which matters: what we read from disk
    /// is then not what is on screen, and the answer has to say so.
    #[test]
    fn an_unsaved_buffer_is_recognised_as_such() {
        let open = open_named("● app.js — meeting-copilot — Visual Studio Code")
            .expect("should find the file");

        assert_eq!(open.name, "app.js");
        assert!(open.dirty, "unsaved marker missed");
    }

    /// Editors disambiguate two files of the same name by showing more path.
    #[test]
    fn a_partial_path_survives_intact() {
        assert_eq!(
            open_named("audio/vad.rs — copilot-core — Visual Studio Code")
                .map(|open| open.name),
            Some("audio/vad.rs".into())
        );
    }

    #[test]
    fn a_hyphen_separated_title_works_too() {
        assert_eq!(
            open_named("main.rs - copilot-tauri - Sublime Text").map(|open| open.name),
            Some("main.rs".into())
        );
    }

    /// The case that would poison everything: a browser tab is not a file, and
    /// treating one as source would attach the wrong thing with total
    /// confidence.
    #[test]
    fn a_browser_tab_is_not_a_file() {
        assert_eq!(open_named("React TS 2FA Exercise - Google Chrome"), None);
        assert_eq!(open_named("meeting-copilot — Visual Studio Code"), None);
        assert_eq!(open_named("Slack | general"), None);
    }

    /// Things that contain a dot but are not files.
    #[test]
    fn a_dot_alone_does_not_make_a_file() {
        assert_eq!(open_named("Untitled-1 — Visual Studio Code"), None);
        assert_eq!(open_named("Claude 3.5 — Anthropic"), None);
        assert_eq!(open_named("v1.2.3 release notes"), None);
    }

    fn tree() -> Vec<String> {
        vec![
            "src/audio/mod.rs".into(),
            "src/audio/vad.rs".into(),
            "src/llm/mod.rs".into(),
            "src/main.rs".into(),
            "Cargo.toml".into(),
        ]
    }

    #[test]
    fn a_bare_name_finds_its_file() {
        assert_eq!(candidates(&tree(), "vad.rs"), vec!["src/audio/vad.rs"]);
        assert_eq!(candidates(&tree(), "Cargo.toml"), vec!["Cargo.toml"]);
    }

    /// Two `mod.rs` is the normal case in Rust, not an edge case. Both come
    /// back and the caller breaks the tie on modification time.
    #[test]
    fn an_ambiguous_name_returns_every_candidate() {
        assert_eq!(
            candidates(&tree(), "mod.rs"),
            vec!["src/audio/mod.rs", "src/llm/mod.rs"]
        );
    }

    /// The partial path an editor shows precisely to disambiguate must
    /// actually disambiguate.
    #[test]
    fn a_partial_path_narrows_to_one() {
        assert_eq!(candidates(&tree(), "audio/mod.rs"), vec!["src/audio/mod.rs"]);
    }

    /// A suffix has to land on a path boundary. Matching loosely would make
    /// `ad.rs` find `vad.rs`, which is the kind of wrong that looks right.
    #[test]
    fn a_partial_name_does_not_match_mid_segment() {
        assert!(candidates(&tree(), "ad.rs").is_empty());
        assert!(candidates(&tree(), "in.rs").is_empty());
    }

    #[test]
    fn a_file_that_is_not_in_the_repo_finds_nothing() {
        assert!(candidates(&tree(), "somewhere-else.rs").is_empty());
        assert!(candidates(&tree(), "").is_empty());
    }
}
