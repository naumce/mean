//! A window around the engine.
//!
//! Everything hard lives in `copilot-core`. This opens a window, starts a
//! session, and forwards each event to the webview. That thinness is the
//! point — the shell is the part most likely to be replaced, so it should be
//! the part that holds the least.

// Stops a console window appearing behind the app in release builds, while
// leaving it in place during development where the output is wanted.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use copilot_core::session::{EventSink, Session};
use copilot_core::stt::whisper::WhisperTranscriber;
use copilot_core::Event;
use tauri::{AppHandle, Emitter, State};

/// The channel the webview listens on.
const CHANNEL: &str = "copilot";

/// Holds the running session so it lives as long as the window. Dropping it
/// stops capture and releases the devices.
#[derive(Default)]
struct Running(Mutex<Option<Session>>);

fn main() {
    tauri::Builder::default()
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![start])
        .run(tauri::generate_context!())
        .expect("could not start the window");
}

/// Starts listening. Called by the interface once it has attached its event
/// listener.
///
/// The interface asks rather than being told, because there is no moment
/// during setup when the webview is known to be listening yet — anything
/// emitted before then is silently dropped, including the failure that would
/// have explained why nothing happened.
#[tauri::command]
fn start(app: AppHandle, running: State<'_, Running>) -> Result<(), String> {
    let mut slot = running.0.lock().map_err(|_| "session lock poisoned")?;
    if slot.is_some() {
        return Ok(());
    }

    let sink: EventSink = Arc::new(move |event: Event| {
        #[cfg(debug_assertions)]
        eprintln!("{event:?}");

        // A failure here means the window has gone, which is not something
        // the audio thread can do anything about.
        let _ = app.emit(CHANNEL, event);
    });

    match open_session(Arc::clone(&sink)) {
        Ok(session) => {
            *slot = Some(session);
            Ok(())
        }
        Err(err) => {
            let message = format!("{err:#}");
            sink(Event::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

fn open_session(sink: EventSink) -> anyhow::Result<Session> {
    let model = find_model().ok_or_else(|| {
        anyhow::anyhow!(
            "could not find models/ggml-base.en.bin. Download it from \
             https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
        )
    })?;

    let transcriber = WhisperTranscriber::load(&model.to_string_lossy(), None)?;
    Session::start(Box::new(transcriber), sink)
}

/// Looks for the model beside the executable and above it, then from the
/// working directory, so the app runs the same under `cargo run` and from a
/// built binary.
fn find_model() -> Option<PathBuf> {
    let starts = [
        std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)),
        std::env::current_dir().ok(),
    ];

    for start in starts.into_iter().flatten() {
        let mut dir = start;
        loop {
            let candidate = dir.join("models").join("ggml-base.en.bin");
            if candidate.is_file() {
                return Some(candidate);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}
