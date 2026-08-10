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

function showTurn(event) {
  // The turn is tied to the utterance that completed the question, which may
  // not be the last line if the transcript kept moving. Falls back to the end
  // so the decision is always visible somewhere.
  const line =
    transcript.querySelector(`.line[data-uid="them-${event.id}"]`) ??
    transcript.lastElementChild;
  if (!line || !line.classList) return;

  const wasAtBottom = atBottom();
  line.classList.add("turn");

  const body = line.lastElementChild;
  if (!body.querySelector(".answer")) {
    const answer = document.createElement("div");
    answer.className = "answer";
    answer.textContent = "would answer this";
    body.append(answer);
  }
  scrollIfFollowing(wasAtBottom);
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
