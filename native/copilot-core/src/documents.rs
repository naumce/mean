//! The watched folder of reference material.
//!
//! A folder rather than an upload dialog: drop a file in, it is there. Nothing
//! is copied, nothing leaves the machine except the files actually mentioned,
//! and the folder stays the user's to manage with the tools they already have.
//!
//! Only what the brief `@mentions` is ever read. A file sitting in the folder
//! costs nothing, which is what makes keeping a large notes file around
//! practical — it is available all session and paid for only when referenced.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::llm::prompt::Document;

/// Extensions read as text. Everything else is listed but cannot be used.
///
/// PDF and Word are deliberately absent: reading a PDF properly means either
/// sending it to a model that can parse one, or extracting text locally and
/// silently getting nothing back from a scanned document. Both are worth doing
/// later; neither is worth blocking on.
const READABLE: &[&str] = &[
    "md", "markdown", "txt", "text", "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "ini",
    "cfg", "conf", "env", "log", "xml", "html", "htm", "css", "scss", "sql", "sh", "bash", "ps1",
    "rs", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "go", "java", "kt", "cs", "c", "h", "cpp",
    "hpp", "rb", "php", "swift", "scala", "lua", "r", "dart", "vue", "svelte",
];

/// Largest file read into a request.
///
/// Not a technical limit — a guard against one oversized file quietly becoming
/// the most expensive thing in every question of the session.
pub const MAX_BYTES: u64 = 400 * 1024;

/// A file in the folder, as the interface needs to show it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub bytes: u64,
    /// Whether this can actually be read. `false` means listed but greyed out.
    pub readable: bool,
    /// Why not, when it cannot be. Shown beside the name.
    pub reason: Option<String>,
}

/// Where the folder lives: beside the executable, or above it, or from the
/// working directory — so it is found the same under `cargo run` and from a
/// built binary sitting next to it.
pub fn folder() -> PathBuf {
    let starts = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from)),
    ];

    for start in starts.into_iter().flatten() {
        let mut dir = start;
        loop {
            let candidate = dir.join("documents");
            if candidate.is_dir() {
                return candidate;
            }
            if !dir.pop() {
                break;
            }
        }
    }

    // Nothing found — name the place it should be, so the interface can say so
    // and creating it is obvious.
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("documents")
}

/// Everything in the folder, sorted by name, unreadable formats included so
/// the reason they are unusable is visible rather than mysterious.
pub fn list(dir: &Path) -> Vec<Entry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut out: Vec<Entry> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }

            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            let extension = extension_of(&name);

            let (readable, reason) = if !READABLE.contains(&extension.as_str()) {
                (false, Some("export to .md or .txt".to_string()))
            } else if bytes > MAX_BYTES {
                (false, Some(format!("over {} KB", MAX_BYTES / 1024)))
            } else {
                (true, None)
            };

            Some(Entry {
                name,
                bytes,
                readable,
                reason,
            })
        })
        .collect();

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Reads every document the brief mentions, in mention order.
///
/// Fails rather than warns. A brief referencing a file that was renamed or
/// deleted is a brief the user believes includes their CV — discovering that
/// on the setup screen beats discovering it from an answer that never saw it.
pub fn resolve(dir: &Path, brief: &str) -> Result<Vec<Document>> {
    mentions(brief)
        .into_iter()
        .map(|name| read(dir, &name))
        .collect()
}

fn read(dir: &Path, name: &str) -> Result<Document> {
    // The name comes from user-written text, so it must not be able to walk
    // out of the folder.
    if name.contains(['/', '\\']) || name.contains("..") {
        bail!("'{name}' is not a file in the documents folder");
    }

    let path = dir.join(name);
    if !path.is_file() {
        bail!("no document named '{name}' in {}", dir.display());
    }

    let bytes = path.metadata().map(|meta| meta.len()).unwrap_or(0);
    if bytes > MAX_BYTES {
        bail!(
            "'{name}' is {} KB, over the {} KB limit",
            bytes / 1024,
            MAX_BYTES / 1024
        );
    }

    if !READABLE.contains(&extension_of(name).as_str()) {
        bail!("'{name}' is not a text format - export it to .md or .txt");
    }

    let body = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read '{name}'"))?;

    Ok(Document {
        name: name.to_string(),
        body,
    })
}

/// Filenames mentioned with `@`, deduplicated, in the order they appear.
///
/// Trailing punctuation is dropped so "@cv.md," and "@cv.md." both work — the
/// brief is prose, and a mention will land next to a comma sooner or later.
pub fn mentions(brief: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = brief;

    while let Some(at) = rest.find('@') {
        rest = &rest[at + 1..];

        let end = rest
            .find(|c: char| c.is_whitespace())
            .unwrap_or(rest.len());
        let raw = &rest[..end];
        rest = &rest[end..];

        let name = raw.trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '"', '\'', '!', '?']);

        // A mention needs an extension. Without one it is an email address, a
        // handle, or a decoration — not a file.
        if name.is_empty() || !name.contains('.') {
            continue;
        }
        if !found.iter().any(|seen| seen == name) {
            found.push(name.to_string());
        }
    }

    found
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_lowercase())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_mention() {
        assert_eq!(mentions("draw on @cv.md please"), vec!["cv.md"]);
    }

    #[test]
    fn finds_several_in_order() {
        assert_eq!(
            mentions("compare @cv.md against @job-description.md"),
            vec!["cv.md", "job-description.md"]
        );
    }

    /// The brief is prose. A mention will end up beside punctuation.
    #[test]
    fn trailing_punctuation_is_not_part_of_the_name() {
        assert_eq!(mentions("see @cv.md, then @notes.md."), vec!["cv.md", "notes.md"]);
        assert_eq!(mentions("(@cv.md)"), vec!["cv.md"]);
    }

    #[test]
    fn the_same_document_mentioned_twice_is_sent_once() {
        assert_eq!(mentions("@cv.md and again @cv.md"), vec!["cv.md"]);
    }

    /// Without this, an email address in the brief becomes a missing-file error.
    #[test]
    fn something_without_an_extension_is_not_a_mention() {
        assert!(mentions("email me at naum@example").is_empty());
        assert!(mentions("ping @naum about it").is_empty());
    }

    #[test]
    fn an_email_address_does_not_become_a_document() {
        // The domain has a dot, so this is the case the parser is most likely
        // to get wrong.
        let found = mentions("write to naum@example.com");
        assert_eq!(found, vec!["example.com"]);
        // ...and it resolves to nothing, which surfaces as a clear error
        // rather than silently sending the wrong thing.
    }

    #[test]
    fn a_brief_with_no_mentions_resolves_to_nothing() {
        assert!(mentions("no documents here").is_empty());
        assert!(mentions("").is_empty());
    }

    #[test]
    fn mentions_at_the_very_end_are_found() {
        assert_eq!(mentions("use @cv.md"), vec!["cv.md"]);
    }

    #[test]
    fn extensions_are_compared_case_insensitively() {
        assert_eq!(extension_of("CV.MD"), "md");
        assert_eq!(extension_of("noextension"), "");
    }

    /// The name comes from user-written text and must not escape the folder.
    #[test]
    fn a_path_traversal_is_refused() {
        let dir = std::env::temp_dir();
        assert!(read(&dir, "../secrets.env").is_err());
        assert!(read(&dir, "..\\secrets.env").is_err());
        assert!(read(&dir, "sub/file.md").is_err());
    }

    #[test]
    fn a_missing_document_names_itself_in_the_error() {
        let error = read(&std::env::temp_dir(), "definitely-not-here.md")
            .unwrap_err()
            .to_string();
        assert!(error.contains("definitely-not-here.md"), "{error}");
    }
}
