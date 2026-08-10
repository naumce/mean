//! Finding the API key, without it ever reaching the interface.
//!
//! The key lives in this process and nowhere else. Anything handed to the
//! webview ships to whoever has the app — which is exactly why a real product
//! has a backend mint short-lived tokens instead of embedding one.
//!
//! Looked for in the environment first, then in a gitignored `.env` beside
//! the project. Several names are accepted because the one already sitting in
//! a `.env` is rarely the one a library expects.

use std::collections::HashMap;
use std::path::PathBuf;

/// Names checked, in order. The first that holds something wins.
const KEY_NAMES: &[&str] = &[
    "OPENAI_API_KEY",
    "CHAT_GPT",
    "CHATGPT_TOKEN",
    "OPENAI_TOKEN",
];

/// The API key, from the environment or from `.env`.
pub fn api_key() -> Option<String> {
    for name in KEY_NAMES {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }

    let file = dotenv()?;
    KEY_NAMES
        .iter()
        .find_map(|name| file.get(*name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// A named setting from the environment or `.env`.
pub fn setting(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        if !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }
    dotenv()?.get(name).map(|value| value.trim().to_string())
}

/// Parses the nearest `.env`, searching upward from the working directory
/// and from beside the executable.
fn dotenv() -> Option<HashMap<String, String>> {
    let starts = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from)),
    ];

    for start in starts.into_iter().flatten() {
        let mut dir = start;
        loop {
            let candidate = dir.join(".env");
            if candidate.is_file() {
                if let Ok(text) = std::fs::read_to_string(&candidate) {
                    return Some(parse(&text));
                }
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

/// `KEY=VALUE` per line. Blank lines and `#` comments ignored, surrounding
/// quotes stripped.
fn parse(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // `export FOO=bar` is common in files shared with a shell.
        let line = line.strip_prefix("export ").unwrap_or(line);

        let Some((name, value)) = line.split_once('=') else {
            continue;
        };

        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|rest| rest.strip_suffix('\''))
            })
            .unwrap_or(value);

        out.insert(name.trim().to_string(), value.to_string());
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_pairs() {
        let env = parse("FOO=bar\nBAZ=qux\n");
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(env.get("BAZ").map(String::as_str), Some("qux"));
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let env = parse("# a comment\n\n  \nFOO=bar\n");
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn strips_surrounding_quotes() {
        let env = parse("A=\"quoted\"\nB='single'\n");
        assert_eq!(env.get("A").map(String::as_str), Some("quoted"));
        assert_eq!(env.get("B").map(String::as_str), Some("single"));
    }

    #[test]
    fn tolerates_export_and_surrounding_space() {
        let env = parse("export FOO = bar \n");
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
    }

    /// API keys contain characters that would break a naive split.
    #[test]
    fn keeps_the_rest_of_a_value_containing_equals() {
        let env = parse("TOKEN=sk-proj-aa==bb\n");
        assert_eq!(env.get("TOKEN").map(String::as_str), Some("sk-proj-aa==bb"));
    }

    #[test]
    fn a_line_with_no_equals_is_skipped_rather_than_panicking() {
        let env = parse("not a pair\nFOO=bar\n");
        assert_eq!(env.len(), 1);
    }
}
