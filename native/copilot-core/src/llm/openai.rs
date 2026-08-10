//! Streaming answers from an OpenAI-compatible chat completions endpoint.
//!
//! Server-sent events, read line by line off a blocking socket. Each `data:`
//! line carries a JSON fragment whose `delta.content` is the next few
//! characters of the answer; the stream ends with a literal `[DONE]`.
//!
//! Cancellation is checked between lines rather than only at the end. On a
//! live call an answer to a question that has already moved on is not merely
//! wasted tokens, it is text on screen that is actively misleading.

use anyhow::{anyhow, bail, Context, Result};
use std::io::{BufRead, BufReader};
use std::time::Duration;

use super::{prompt, Ending, Question, Responder};

const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_BASE: &str = "https://api.openai.com/v1";

/// Generous, because it covers a whole streamed answer rather than one
/// request. Time to *first* token is the number that matters, and that is
/// governed by the model, not by this.
const TIMEOUT: Duration = Duration::from_secs(120);

pub struct OpenAiResponder {
    key: String,
    model: String,
    base: String,
    agent: ureq::Agent,
}

impl OpenAiResponder {
    /// Builds a responder from the key and settings found in the environment
    /// or `.env`.
    pub fn from_env() -> Result<Self> {
        let key = crate::secrets::api_key().ok_or_else(|| {
            anyhow!(
                "no API key found. Set OPENAI_API_KEY, or put it in a .env file \
                 beside the project as OPENAI_API_KEY or CHAT_GPT."
            )
        })?;

        Ok(Self::new(
            key,
            crate::secrets::setting("OPENAI_MODEL"),
            crate::secrets::setting("OPENAI_BASE_URL"),
        ))
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

    fn body(&self, question: &Question) -> String {
        let messages: Vec<serde_json::Value> = prompt::build(question)
            .into_iter()
            .map(|message| {
                serde_json::json!({ "role": message.role, "content": message.content })
            })
            .collect();

        serde_json::json!({
            "model": self.model,
            "stream": true,
            "messages": messages,
        })
        .to_string()
    }
}

impl Responder for OpenAiResponder {
    fn respond(
        &mut self,
        question: &Question,
        on_delta: &mut dyn FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Ending> {
        let response = self
            .agent
            .post(&format!("{}/chat/completions", self.base))
            .set("Authorization", &format!("Bearer {}", self.key))
            .set("Content-Type", "application/json")
            .send_string(&self.body(question));

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

        for line in reader.lines() {
            if cancelled() {
                return Ok(Ending::Cancelled);
            }

            let line = line.context("the answer stream broke partway through")?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };

            let data = data.trim();
            if data == "[DONE]" {
                break;
            }

            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
                if !text.is_empty() {
                    produced_anything = true;
                    on_delta(text);
                }
            }
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

    // Not the shape we expected — a proxy, a gateway, an outage page. Showing
    // the first part of it beats showing nothing, which is the moment the
    // detail matters most.
    Some(trimmed.chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Lane;
    use crate::llm::ContextLine;

    fn responder() -> OpenAiResponder {
        OpenAiResponder::new("test-key".into(), None, None)
    }

    fn question() -> Question {
        Question {
            id: 1,
            text: "How would you handle a thundering herd?".into(),
            context: vec![ContextLine {
                lane: Lane::Them,
                text: "So how would you design a rate limiter?".into(),
            }],
        }
    }

    #[test]
    fn the_request_asks_for_a_stream() {
        let body: serde_json::Value =
            serde_json::from_str(&responder().body(&question())).unwrap();
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn the_request_carries_the_system_prompt_and_the_question() {
        let body: serde_json::Value =
            serde_json::from_str(&responder().body(&question())).unwrap();
        let messages = body["messages"].as_array().expect("messages");

        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("thundering herd"));
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_does_not_double_up() {
        let responder = OpenAiResponder::new(
            "k".into(),
            None,
            Some("https://example.test/v1/".into()),
        );
        assert_eq!(responder.base, "https://example.test/v1");
    }

    #[test]
    fn the_model_can_be_overridden() {
        let responder = OpenAiResponder::new("k".into(), Some("gpt-4o".into()), None);
        assert_eq!(responder.name(), "gpt-4o");
    }

    #[test]
    fn an_api_error_body_is_reduced_to_its_message() {
        let body = r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#;
        assert_eq!(explain(body).as_deref(), Some("Incorrect API key provided"));
    }

    #[test]
    fn an_unrecognised_error_body_still_yields_something_to_show() {
        assert!(explain("upstream exploded").is_some());
    }
}
