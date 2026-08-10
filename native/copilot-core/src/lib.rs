//! The meeting copilot engine.
//!
//! Deliberately knows nothing about a window, an HTTP server, or Tauri. The
//! only thing that ever crosses out to a user interface is an event value, so
//! the shell on top stays replaceable.

pub mod audio;
pub mod capture;
pub mod config;
