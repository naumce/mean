//! Streaming answers from the Anthropic Messages API.
//!
//! Rust has no official Anthropic SDK, so this is raw HTTP. Four things differ
//! from the OpenAI client in ways that fail quietly if carried across:
//!
//! - authentication is `x-api-key`, not `Authorization: Bearer`
//! - `anthropic-version` is required on every request
//! - the system prompt is a **top-level field**, not a message with a role
//! - the stream ends with a `message_stop` event; there is no `[DONE]` line
//!
//! Sampling parameters are deliberately absent. `temperature`, `top_p`, and
//! `top_k` are rejected outright on this model generation — steering happens
//! through the brief instead.

use anyhow::{bail, Context, Result};
use std::io::{BufRead, BufReader};
use std::time::Duration;

use super::{prompt, Brief, Ending, Question, Responder};

const DEFAULT_MODEL: &str = "claude-opus-5";
const DEFAULT_BASE: &str = "https://api.anthropic.com/v1";
const API_VERSION: &str = "2023-06-01";

/// Names accepted for the key, so the one already in someone's `.env` works.
const KEY_NAMES: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_KEY", "CLAUDE_API_KEY"];

/// Covers a whole streamed answer rather than one request. Time to *first*
/// token is the number that matters and is governed by the model, not this.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Ceiling on one answer. Generous because thinking counts against it on this
/// model generation, and a tight cap truncates mid-sentence rather than
/// producing a shorter answer.
const MAX_TOKENS: u32 = 8192;

pub struct AnthropicResponder {
    key: String,
    model: String,
    base: String,
    agent: ureq::Agent,
}

impl AnthropicResponder {
    /// Builds a responder if an Anthropic key is available, `None` if not.
    pub fn from_env() -> Result<Option<Self>> {
        let Some(key) = crate::secrets::find(KEY_NAMES) else {
            return Ok(None);
        };

        Ok(Some(Self::new(
            key,
            crate::secrets::setting("ANTHROPIC_MODEL"),
            crate::secrets::setting("ANTHROPIC_BASE_URL"),
        )))
    }

    pub fn new(key: String, model: Option<String>, base: Option<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_read(TIMEOUT)
            .timeout_write(Duration::from_secs(30))
            .build();

        Self {
            key,
            model: model.unwrap_or_else(|| DEFAULT_MODEL.into()),
            base: base
                .unwrap_or_else(|| DEFAULT_BASE.into())
                .trim_end_matches('/')
                .to_string(),
            agent,
        }
    }

    fn body(&self, question: &Question, brief: &Brief) -> String {
        let request = prompt::build(question, brief);

        // A screenshot goes ahead of the text: the model reads the image as
        // context for the question rather than the other way round.
        let mut parts: Vec<serde_json::Value> = Vec::new();
        if let Some(image) = &question.image {
            parts.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": image.base64,
                },
            }));
        }
        for message in &request.messages {
            parts.push(serde_json::json!({ "type": "text", "text": message.content }));
        }

        serde_json::json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            // Top-level, not a message. The stable bytes of the session live
            // here, which is also where a cache breakpoint belongs.
            "system": [{
                "type": "text",
                "text": request.system,
                "cache_control": { "type": "ephemeral" },
            }],
            "messages": [{ "role": "user", "content": parts }],
        })
        .to_string()
    }
}

impl Responder for AnthropicResponder {
    fn respond(
        &mut self,
        question: &Question,
        brief: &Brief,
        on_delta: &mut dyn FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Ending> {
        let response = self
            .agent
            .post(&format!("{}/messages", self.base))
            .set("x-api-key", &self.key)
            .set("anthropic-version", API_VERSION)
            .set("content-type", "application/json")
            .send_string(&self.body(question, brief));

        let response = match response {
            Ok(response) => response,
            // A non-2xx carries the reason in its body, and that reason is
            // almost always the actionable part: a bad key, an unknown model,
            // or no credit.
            Err(ureq::Error::Status(code, body)) => {
                let detail = body
                    .into_string()
                    .ok()
                    .and_then(|text| explain(&text))
                    .unwrap_or_else(|| "no detail returned".into());
                bail!("the model API returned {code}: {detail}");
            }
            Err(err) => return Err(err).context("could not reach the model API"),
        };

        let reader = BufReader::new(response.into_reader());
        let mut produced_anything = false;
        let mut refused = false;

        for line in reader.lines() {
            if cancelled() {
                return Ok(Ending::Cancelled);
            }

            let line = line.context("the answer stream broke partway through")?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };

            let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
                continue;
            };

            match value["type"].as_str() {
                Some("content_block_delta") => {
                    // Thinking deltas arrive on the same event with a
                    // different delta type; only text belongs on screen.
                    if value["delta"]["type"] == "text_delta" {
                        if let Some(text) = value["delta"]["text"].as_str() {
                            if !text.is_empty() {
                                produced_anything = true;
                                on_delta(text);
                            }
                        }
                    }
                }
                Some("message_delta") => {
                    if value["delta"]["stop_reason"] == "refusal" {
                        refused = true;
                    }
                }
                Some("message_stop") => break,
                // The stream can carry an error mid-flight, after a 200.
                Some("error") => {
                    let message = value["error"]["message"]
                        .as_str()
                        .unwrap_or("the model stopped with an error");
                    bail!("{message}");
                }
                _ => {}
            }
        }

        if refused {
            bail!("the model declined to answer this one");
        }
        if !produced_anything {
            bail!("the model returned an empty answer");
        }

        Ok(Ending::Complete)
    }

    fn name(&self) -> String {
        self.model.clone()
    }
}

/// Pulls the human-readable message out of an API error body, falling back to
/// the raw text when it is not shaped the way we expect.
fn explain(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = value["error"]["message"].as_str() {
            return Some(message.to_string());
        }
    }

    Some(trimmed.chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Lane;
    use crate::llm::{ContextLine, Image};

    fn responder() -> AnthropicResponder {
        AnthropicResponder::new("test-key".into(), None, None)
    }

    fn question() -> Question {
        Question {
            id: 1,
            text: "How would you handle a thundering herd?".into(),
            context: vec![ContextLine {
                lane: Lane::Them,
                text: "So how would you design a rate limiter?".into(),
            }],
            image: None,
            files: Vec::new(),
        }
    }

    fn body(question: &Question, brief: &Brief) -> serde_json::Value {
        serde_json::from_str(&responder().body(question, brief)).unwrap()
    }

    #[test]
    fn the_request_asks_for_a_stream() {
        assert_eq!(body(&question(), &Brief::default())["stream"], true);
    }

    /// The difference from OpenAI most likely to be carried across wrongly.
    #[test]
    fn the_system_prompt_is_top_level_not_a_message() {
        let body = body(&question(), &Brief::default());

        assert!(body["system"][0]["text"].as_str().unwrap().contains("live conversation"));
        for message in body["messages"].as_array().unwrap() {
            assert_ne!(message["role"], "system", "system sent as a message");
        }
    }

    /// Documents and brief do not change for the session; the transcript does.
    /// A breakpoint here is what stops a CV being re-billed every question.
    #[test]
    fn the_system_prompt_carries_a_cache_breakpoint() {
        let body = body(&question(), &Brief::default());
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn the_question_travels_in_the_user_turn() {
        let body = body(&question(), &Brief::default());
        let text = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("thundering herd"));
    }

    /// Sampling parameters are rejected outright on this model generation.
    #[test]
    fn no_sampling_parameters_are_sent() {
        let body = body(&question(), &Brief::default());
        for banned in ["temperature", "top_p", "top_k"] {
            assert!(body.get(banned).is_none(), "{banned} would be a 400");
        }
    }

    #[test]
    fn a_screenshot_is_sent_before_the_text() {
        let mut with_image = question();
        with_image.image = Some(Image {
            media_type: "image/jpeg".into(),
            base64: "AAAA".into(),
        });

        let body = body(&with_image, &Brief::default());
        let parts = body["messages"][0]["content"].as_array().unwrap();

        assert_eq!(parts[0]["type"], "image");
        assert_eq!(parts[0]["source"]["media_type"], "image/jpeg");
        assert_eq!(parts[1]["type"], "text");
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_does_not_double_up() {
        let responder =
            AnthropicResponder::new("k".into(), None, Some("https://example.test/v1/".into()));
        assert_eq!(responder.base, "https://example.test/v1");
    }

    #[test]
    fn the_model_can_be_overridden() {
        let responder = AnthropicResponder::new("k".into(), Some("claude-sonnet-5".into()), None);
        assert_eq!(responder.name(), "claude-sonnet-5");
    }

    #[test]
    fn an_api_error_body_is_reduced_to_its_message() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(explain(body).as_deref(), Some("invalid x-api-key"));
    }

    /// Not the shape we expect — a proxy, a gateway, an outage page. Showing
    /// the first part beats showing nothing, which is when it matters most.
    #[test]
    fn an_unrecognised_error_body_still_yields_something_to_show() {
        assert!(explain("upstream exploded").is_some());
        assert!(explain("   ").is_none());
    }
}
