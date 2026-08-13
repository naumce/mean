//! A window around the engine.
//!
//! Everything hard lives in `copilot-core`. This opens a window, exposes five
//! commands, and forwards each event to the webview. That thinness is the
//! point — the shell is the part most likely to be replaced, so it should hold
//! the least.

// Stops a console window appearing behind the app in release builds, while
// leaving it in place during development where the output is wanted.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use copilot_core::capture::screen;
use copilot_core::documents;
use copilot_core::llm::Brief;
use copilot_core::session::{EventSink, Session};
use copilot_core::stt::whisper::WhisperTranscriber;
use copilot_core::Event;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The channel the webview listens on.
const CHANNEL: &str = "copilot";

/// Used when the screenshot button is pressed with nothing typed. Vague on
/// purpose — the picture is the question.
const SCREENSHOT_PROMPT: &str =
    "Here is my screen. Answer whatever it is asking, or explain what I am looking at.";

/// Holds the running session so it lives as long as the window. Dropping it
/// stops capture and releases the devices.
#[derive(Default)]
struct Running {
    session: Mutex<Option<Session>>,
    /// The teardown of the previous session, still finishing.
    ///
    /// Shutting down joins three threads and can legitimately take a moment —
    /// a final whisper flush, an HTTP stream winding down. That wait cannot
    /// happen on the main thread without freezing the window, and it cannot be
    /// skipped either, or a quick Stop-then-Start would race the old session
    /// for the capture devices. So it waits here, and `start` collects it.
    teardown: Mutex<Option<JoinHandle<()>>>,
}

fn main() {
    tauri::Builder::default()
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![
            list_documents,
            monitors,
            start,
            stop,
            ask
        ])
        .run(tauri::generate_context!())
        .expect("could not start the window");
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    path: String,
    exists: bool,
    entries: Vec<documents::Entry>,
}

/// Everything in the documents folder, for the setup screen.
#[tauri::command]
fn list_documents() -> Folder {
    let path = documents::folder();
    Folder {
        exists: path.is_dir(),
        entries: documents::list(&path),
        path: path.display().to_string(),
    }
}

/// Starts listening.
///
/// Called by the interface once it has attached its event listener, because
/// there is no moment during setup when the webview is known to be listening —
/// anything emitted before then is silently dropped, including the failure
/// that would have explained why nothing happened.
#[tauri::command]
fn start(app: AppHandle, running: State<'_, Running>, brief: String) -> Result<(), String> {
    let mut slot = running.session.lock().map_err(|_| "session lock poisoned")?;
    if slot.is_some() {
        return Ok(());
    }

    // The previous session may still be releasing the microphone. Waiting here
    // rather than in `stop` puts the delay where one is already expected and
    // visible — the interface says "starting…" — instead of on a Stop button
    // that should feel instant.
    if let Some(teardown) = running
        .teardown
        .lock()
        .map_err(|_| "teardown lock poisoned")?
        .take()
    {
        let _ = teardown.join();
    }

    let sink: EventSink = Arc::new(move |event: Event| {
        #[cfg(debug_assertions)]
        eprintln!("{event:?}");

        // A failure here means the window has gone, which is not something
        // the audio thread can do anything about.
        let _ = app.emit(CHANNEL, event);
    });

    match open_session(brief, Arc::clone(&sink)) {
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

/// Stops listening and releases the microphone.
///
/// Returns as soon as the session has been handed off, rather than when it has
/// finished shutting down. Dropping it here would block Tauri's main thread
/// and freeze the window for as long as teardown took.
#[tauri::command]
fn stop(running: State<'_, Running>) -> Result<(), String> {
    let session = {
        let mut slot = running.session.lock().map_err(|_| "session lock poisoned")?;
        slot.take()
    };

    let Some(session) = session else {
        return Ok(());
    };

    // Dropping the session stops every thread and hands the capture devices
    // back to the OS, so the recording indicator actually goes away. `start`
    // waits for this before opening the devices again.
    let handle = thread::Builder::new()
        .name("copilot-teardown".into())
        .spawn(move || drop(session))
        .map_err(|err| format!("could not start teardown: {err}"))?;

    let mut pending = running.teardown.lock().map_err(|_| "teardown lock poisoned")?;
    // Any earlier teardown has been waited on by `start` already; if one is
    // somehow still here, let it finish in the background rather than leaking
    // the handle silently.
    *pending = Some(handle);
    Ok(())
}

/// Asks a question that was typed rather than spoken, optionally with the
/// screen attached.
#[tauri::command]
fn ask(
    running: State<'_, Running>,
    text: String,
    screenshot: bool,
    monitor: Option<usize>,
) -> Result<Option<String>, String> {
    let slot = running.session.lock().map_err(|_| "session lock poisoned")?;
    let session = slot.as_ref().ok_or("no session is running")?;

    // `None` means follow the window last in use, which is the default and
    // almost always what is wanted. An index pins it instead.
    let target = match monitor {
        Some(index) => screen::Target::Monitor(index),
        None => screen::Target::Active,
    };

    let shot = if screenshot {
        Some(screen::capture(target).map_err(|err| format!("{err:#}"))?)
    } else {
        None
    };

    let captured = shot.as_ref().map(|shot| shot.monitor.clone());
    let image = shot.map(|shot| shot.image);

    let text = text.trim();
    if text.is_empty() && image.is_none() {
        return Err("nothing to ask".into());
    }

    session.ask(
        if text.is_empty() { SCREENSHOT_PROMPT } else { text },
        image,
    );
    // Which screen was sent, so the interface can say so rather than leaving
    // you to infer it from an answer about the wrong thing.
    Ok(captured)
}

/// Every monitor, for the setup screen's override.
#[tauri::command]
fn monitors() -> Vec<screen::MonitorInfo> {
    screen::monitors()
}

fn open_session(brief_text: String, sink: EventSink) -> anyhow::Result<Session> {
    let model = find_model().ok_or_else(|| {
        anyhow::anyhow!(
            "could not find models/ggml-base.en.bin. Download it from \
             https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
        )
    })?;

    // Documents resolve before anything starts, so a brief that references a
    // renamed file fails here — on the setup screen, with the name in the
    // error — rather than silently answering without it.
    let folder = documents::folder();
    let documents = documents::resolve(&folder, &brief_text)?;

    let transcriber = WhisperTranscriber::load(&model.to_string_lossy(), None)?;

    // Answering is optional. Without a key the app is still a live transcript
    // with turn detection, which is worth having on its own and far better
    // than refusing to start over a missing setting.
    let responder = match copilot_core::llm::from_env() {
        Ok(responder) => Some(responder),
        Err(err) => {
            sink(Event::Error {
                message: format!("answers are off: {err:#}"),
            });
            None
        }
    };

    Session::start(
        Box::new(transcriber),
        responder,
        Brief {
            text: brief_text,
            documents,
        },
        sink,
    )
}

/// Looks for the model beside the executable and above it, then from the
/// working directory, so the app runs the same under `cargo run` and from a
/// built binary.
fn find_model() -> Option<PathBuf> {
    let starts = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from)),
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
