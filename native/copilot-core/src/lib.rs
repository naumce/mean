//! The meeting copilot engine.
//!
//! Deliberately knows nothing about a window, an HTTP server, or Tauri. The
//! only thing that ever crosses out to a user interface is an event value, so
//! the shell on top stays replaceable.

pub mod audio;
pub mod capture;
pub mod config;
pub mod event;
pub mod llm;
pub mod secrets;
pub mod session;
pub mod stt;
pub mod turn;

pub use event::{Event, Lane};
pub use session::{EventSink, Session};
