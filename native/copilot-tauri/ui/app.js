// Renders the event stream coming out of the engine.
//
// Deliberately plain: no framework, no build step, no dependencies. The whole
// contract with the engine is one channel carrying tagged JSON, which is what
// keeps the shell swappable — this file would work unchanged against a
// WebSocket.

const el = (id) => document.getElementById(id);

const transcript = el("transcript");
const health = el("health");

// A lane's "speaking" indicator, before any text exists for it.
const pending = { you: null, them: null };

// Level meters are shown over this range. Below the floor is silence; speech
// sits well inside it, so the bar spends its travel where the detail is.
const FLOOR_DB = -60;
const CEIL_DB = -10;

let lineCount = 0;

/* ---------- rendering ---------- */

function atBottom() {
  // Within a couple of lines of the end. Scrolling up to read something must
  // not be undone by the next utterance arriving.
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
}

function scrollIfFollowing(wasAtBottom) {
  if (wasAtBottom) transcript.scrollTop = transcript.scrollHeight;
}

function clock(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function makeLine(lane, cls) {
  const line = document.createElement("div");
  line.className = cls ? `line ${cls}` : "line";
  line.dataset.lane = lane;

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = lane.toUpperCase();

  const body = document.createElement("div");
  const text = document.createElement("p");
  text.className = "text";
  body.append(text);

  line.append(who, body);
  return { line, body, text };
}

function showTranscript(event) {
  const wasAtBottom = atBottom();
  el("empty")?.remove();

  // The finished text replaces this lane's speaking indicator, so the line
  // does not jump position between appearing and being filled in.
  const placeholder = pending[event.lane];
  const { line, body, text } = makeLine(event.lane);
  text.textContent = event.text;
  // So a turn decision, which arrives later and separately, can find the
  // line it belongs to.
  line.dataset.uid = `${event.lane}-${event.id}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    `${clock(event.startMs)} · ${((event.endMs - event.startMs) / 1000).toFixed(1)}s audio` +
    ` · ${event.transcribeMs}ms to transcribe`;
  body.append(meta);

  if (placeholder && placeholder.isConnected) {
    placeholder.replaceWith(line);
    pending[event.lane] = null;
  } else {
    transcript.append(line);
  }

  lineCount += 1;
  el("status").textContent = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  scrollIfFollowing(wasAtBottom);
}

function showSpeaking(event) {
  if (!event.active) {
    // Left in place if it is the last thing on screen: the text for it is
    // moments away, and removing it would make the view flicker.
    return;
  }
  if (pending[event.lane]?.isConnected) return;

  const wasAtBottom = atBottom();
  el("empty")?.remove();

  const { line, text } = makeLine(event.lane, "pending");
  const pulse = document.createElement("span");
  pulse.className = "pulse";
  text.append(pulse, document.createTextNode("speaking…"));

  transcript.append(line);
  pending[event.lane] = line;
  scrollIfFollowing(wasAtBottom);
}

function showLevel(event) {
  const bar = el(`level-${event.lane}`);
  if (!bar) return;
  const fraction = (event.rmsDb - FLOOR_DB) / (CEIL_DB - FLOOR_DB);
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

/// Finds or creates the answer block belonging to a question.
///
/// The answer is attached to the utterance that completed the question, which
/// may not be the last line if the transcript kept moving while the model was
/// thinking. Falls back to the end so an answer is never rendered nowhere.
function answerBlockFor(id) {
  const line =
    transcript.querySelector(`.line[data-uid="them-${id}"]`) ??
    transcript.lastElementChild;
  if (!line || !line.classList) return null;

  line.classList.add("turn");

  const body = line.lastElementChild;
  let answer = body.querySelector(".answer");
  if (!answer) {
    answer = document.createElement("div");
    answer.className = "answer";
    body.append(answer);
  }
  return answer;
}

function showTurn(event) {
  const wasAtBottom = atBottom();
  const answer = answerBlockFor(event.id);
  if (answer && !answer.textContent) {
    answer.textContent = "thinking…";
    answer.classList.add("waiting");
  }
  scrollIfFollowing(wasAtBottom);
}

function startAnswer(event) {
  const wasAtBottom = atBottom();
  const answer = answerBlockFor(event.forId);
  if (!answer) return;

  answer.textContent = "";
  answer.classList.remove("waiting", "failed", "cancelled");
  answer.dataset.model = event.model;
  scrollIfFollowing(wasAtBottom);
}

function appendAnswer(event) {
  const answer = answerBlockFor(event.forId);
  if (!answer) return;

  const wasAtBottom = atBottom();
  answer.classList.remove("waiting");
  // Deltas are whatever size the model sends, often part of a word, so they
  // are appended as text rather than treated as lines.
  answer.append(document.createTextNode(event.text));
  scrollIfFollowing(wasAtBottom);
}

function endAnswer(event) {
  const answer = answerBlockFor(event.forId);
  if (!answer) return;

  answer.classList.remove("waiting");
  if (event.reason === "cancelled") {
    answer.classList.add("cancelled");
    if (!answer.textContent) answer.textContent = "superseded";
  } else if (event.reason === "failed") {
    answer.classList.add("failed");
    if (!answer.textContent) answer.textContent = "could not answer";
  } else if (answer.dataset.model) {
    const tag = document.createElement("span");
    tag.className = "by";
    tag.textContent = answer.dataset.model;
    answer.append(tag);
  }
}

function warn(message) {
  const warning = el("warning");
  warning.textContent = message;
  warning.hidden = false;
}

/* ---------- event dispatch ---------- */

function handle(event) {
  switch (event.type) {
    case "ready":
      health.dataset.state = "listening";
      el("model").textContent = event.model;
      el("device-you").textContent = event.youDevice;
      el("device-them").textContent = event.themDevice;
      el("status").textContent = "listening";
      break;

    case "level":
      showLevel(event);
      break;

    case "speaking":
      showSpeaking(event);
      break;

    case "transcript":
      showTranscript(event);
      break;

    case "turn":
      showTurn(event);
      break;

    case "answerStart":
      startAnswer(event);
      break;

    case "answerDelta":
      appendAnswer(event);
      break;

    case "answerEnd":
      endAnswer(event);
      break;

    case "dropped":
      // Samples the capture thread discarded, which means a hole in the
      // audio and therefore in the transcript. Worth saying out loud.
      warn(`${event.lane.toUpperCase()} dropped ${event.samples} samples`);
      break;

    case "error":
      health.dataset.state = "error";
      warn(event.message);
      break;
  }
}

/* ---------- wiring ---------- */

const tauri = window.__TAURI__;

if (!tauri?.event?.listen) {
  health.dataset.state = "error";
  warn("not running inside the app window — no event channel available");
} else {
  // Order matters. The listener has to exist before anything can be emitted
  // to it, so the engine is only started once it does — otherwise the first
  // events, including any startup failure, are dropped before arrival.
  tauri.event
    .listen("copilot", (message) => handle(message.payload))
    .then(() => tauri.core.invoke("start"))
    .catch((err) => {
      health.dataset.state = "error";
      warn(String(err));
    });
}
