// The interface. Deliberately plain: no framework, no build step, no
// dependencies. The whole contract with the engine is one channel carrying
// tagged JSON plus four commands, which is what keeps the shell swappable —
// this file would work almost unchanged against a WebSocket.

const el = (id) => document.getElementById(id);

const setup = el("setup");
const live = el("live");
const transcript = el("transcript");
const brief = el("brief");
const refs = el("refs");
const docsList = el("docs");

/* ------------------------------------------------------------------ *
 * Presets
 *
 * A blank box gets a vague brief, because nobody writes a good prompt
 * under time pressure. These fill real wording you then edit.
 * ------------------------------------------------------------------ */

const BRIEFS = {
  coding:
    "This is a standalone coding challenge. I'll share screenshots of the problem statement as we go.\n\n" +
    "Answer with complete, runnable code rather than advice — include imports and anything needed to actually run it. " +
    "If the problem is ambiguous, state your assumption in one line and solve it anyway rather than asking.",
  deep:
    "Technical discussion. Lead with the direct answer in one sentence, then at most three supporting points.\n\n" +
    "Prefer concrete specifics — names, numbers, tradeoffs — over general advice. If something is genuinely a judgment call, say which way you'd go and why.",
  notes:
    "Capture the conversation; don't answer questions unless I type one directly.\n\n" +
    "At the end I'll ask for a summary: decisions made, open questions, and who owns what.",
  custom: "",
};

brief.placeholder =
  "Describe the situation, and what a good answer looks like. Reference a document with @ — the second part matters more than it sounds.";
brief.value = BRIEFS.coding;

el("presets").addEventListener("click", (event) => {
  const button = event.target.closest(".preset");
  if (!button) return;

  for (const other of el("presets").querySelectorAll(".preset")) {
    other.setAttribute("aria-pressed", String(other === button));
  }

  // Keep any documents already referenced — switching preset changes the
  // answer contract, not which material the session draws on.
  const keep = mentionsIn(brief.value).map((name) => "@" + name);
  brief.value = BRIEFS[button.dataset.preset] + (keep.length ? "\n\n" + keep.join(" ") : "");
  renderRefs();
});

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

let available = [];

/// Mirrors the Rust parser: a mention needs an extension, and trailing
/// punctuation is not part of the filename because the brief is prose.
function mentionsIn(text) {
  const found = [];
  for (const match of text.matchAll(/@(\S+)/g)) {
    const name = match[1].replace(/[.,;:)\]}"'!?]+$/, "");
    if (name.includes(".") && !found.includes(name)) found.push(name);
  }
  return found;
}

function sizeOf(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function renderDocs() {
  docsList.textContent = "";

  if (available.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent =
      "Nothing here yet. Drop .md or .txt files into the folder above, then refresh.";
    docsList.append(none);
    return;
  }

  const used = mentionsIn(brief.value);

  for (const entry of available) {
    const row = document.createElement("div");
    row.className = entry.readable ? "doc" : "doc unsupported";

    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = entry.name;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = entry.readable ? sizeOf(entry.bytes) : entry.reason ?? "";

    const add = document.createElement("button");
    add.className = "add";
    add.type = "button";
    const inUse = used.includes(entry.name);
    add.disabled = !entry.readable || inUse;
    add.textContent = inUse ? "added" : "insert";
    add.addEventListener("click", () => insertMention(entry.name));

    row.append(name, meta, add);
    docsList.append(row);
  }
}

function insertMention(name) {
  brief.value = brief.value.trimEnd() + "\n\n@" + name;
  renderRefs();
  brief.focus();
}

function removeMention(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  brief.value = brief.value.replace(new RegExp("\\s*@" + escaped, "g"), "").trim();
  renderRefs();
}

/// The chips exist so you can see what actually resolved rather than trusting
/// that you typed the filename correctly. A mention with no matching file is
/// shown in red here, before the session starts.
function renderRefs() {
  refs.textContent = "";
  const used = mentionsIn(brief.value);

  if (used.length === 0) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "No documents referenced — insert one, or type @ in the brief.";
    refs.append(none);
    renderDocs();
    return;
  }

  let bytes = 0;
  let missing = false;

  for (const name of used) {
    const entry = available.find((candidate) => candidate.name === name);
    const known = Boolean(entry && entry.readable);
    if (known) bytes += entry.bytes;
    else missing = true;

    const chip = document.createElement("span");
    chip.className = known ? "chip" : "chip missing";
    chip.append("@" + name);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove " + name);
    remove.addEventListener("click", () => removeMention(name));

    chip.append(remove);
    refs.append(chip);
  }

  const budget = document.createElement("span");
  budget.className = "budget";
  // Four bytes per token is rough, which is why it is labelled with a tilde.
  // Its job is catching an order-of-magnitude mistake before it becomes a bill.
  budget.textContent = missing
    ? "one or more not found"
    : `~${Math.round(bytes / 4).toLocaleString()} tokens, cached`;
  refs.append(budget);

  renderDocs();
}

brief.addEventListener("input", renderRefs);

async function loadDocs() {
  try {
    const folder = await invoke("list_documents");
    available = folder.entries;
    el("docs-path").textContent = folder.path;
    el("docs-path").title = folder.path;
    if (!folder.exists) {
      say("setup-status", "the documents folder does not exist yet", false);
    }
  } catch (err) {
    available = [];
    say("setup-status", String(err), true);
  }
  renderRefs();
}

el("refresh").addEventListener("click", loadDocs);

/* Following the window you were last in is the default because it is right by
 * construction: it cannot be made stale by moving a window, and it is the only
 * rule that excludes this app — which is otherwise always in front the moment
 * the screenshot button is pressed. The list is for pinning it deliberately. */
async function loadMonitors() {
  const select = el("monitor");
  try {
    const found = await invoke("monitors");

    // Rebuild below the default rather than replacing it.
    while (select.options.length > 1) select.remove(1);

    for (const monitor of found) {
      const option = document.createElement("option");
      option.value = String(monitor.index);
      option.textContent =
        `${monitor.name} · ${monitor.width}×${monitor.height}` +
        (monitor.primary ? " · primary" : "");
      select.append(option);
    }

    // One screen means there is nothing to choose between.
    el("monitor").parentElement.hidden = found.length < 2;
  } catch (err) {
    say("setup-status", String(err), true);
  }
}

/* ------------------------------------------------------------------ *
 * Transcript rendering
 * ------------------------------------------------------------------ */

const pending = { you: null, them: null };
let lines = 0;

function atBottom() {
  // Within a couple of lines of the end. Scrolling up to read something must
  // not be undone by the next utterance arriving.
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
}

function follow(wasAtBottom) {
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

  const placeholder = pending[event.lane];
  const { line, body, text } = makeLine(event.lane);
  text.textContent = event.text;
  line.dataset.uid = `${event.lane}-${event.id}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    `${clock(event.startMs)} · ${((event.endMs - event.startMs) / 1000).toFixed(1)}s audio` +
    ` · ${event.transcribeMs}ms`;
  body.append(meta);

  if (placeholder && placeholder.isConnected) {
    placeholder.replaceWith(line);
    pending[event.lane] = null;
  } else {
    transcript.append(line);
  }

  lines += 1;
  follow(wasAtBottom);
}

function showSpeaking(event) {
  // The indicator is left in place when speech ends: the text for it is
  // moments away, and removing it would make the view flicker.
  if (!event.active || pending[event.lane]?.isConnected) return;

  const wasAtBottom = atBottom();
  el("empty")?.remove();

  const { line, text } = makeLine(event.lane, "pending");
  const pulse = document.createElement("span");
  pulse.className = "pulse";
  text.append(pulse, document.createTextNode("speaking…"));

  transcript.append(line);
  pending[event.lane] = line;
  follow(wasAtBottom);
}

/// Finds the answer block for a question, creating the line it hangs from if
/// there isn't one. A typed question has no transcript line of its own, so it
/// gets one built from the question text rather than being rendered nowhere.
function answerBlockFor(id, questionText) {
  let line = transcript.querySelector(`.line[data-uid="them-${id}"]`);

  if (!line && questionText !== undefined) {
    el("empty")?.remove();
    const made = makeLine("you");
    made.text.textContent = questionText;
    made.line.dataset.uid = `them-${id}`;
    transcript.append(made.line);
    line = made.line;
  }

  if (!line) return null;

  const body = line.lastElementChild;
  let answer = body.querySelector(".answer");
  if (!answer) {
    answer = document.createElement("div");
    answer.className = "answer";

    const text = document.createElement("div");
    text.className = "body";

    const foot = document.createElement("div");
    foot.className = "foot";

    answer.append(text, foot);
    body.append(answer);
  }
  return answer;
}

function startAnswer(event) {
  const wasAtBottom = atBottom();
  const answer = answerBlockFor(event.forId, event.question);
  if (!answer) return;

  answer.className = "answer waiting";
  answer.querySelector(".body").textContent = "thinking…";

  const foot = answer.querySelector(".foot");
  foot.textContent = event.model;

  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.textContent = "copy";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(answer.querySelector(".body").textContent);
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = "copy"), 1400);
  });
  foot.append(copy);

  follow(wasAtBottom);
}

function appendAnswer(event) {
  const answer = answerBlockFor(event.forId);
  if (!answer) return;

  const wasAtBottom = atBottom();
  const body = answer.querySelector(".body");

  if (answer.classList.contains("waiting")) {
    answer.classList.remove("waiting");
    body.textContent = "";
  }

  // Deltas are whatever size the model sends, often part of a word, so they
  // are appended as text rather than treated as lines.
  body.append(document.createTextNode(event.text));
  follow(wasAtBottom);
}

function endAnswer(event) {
  const answer = answerBlockFor(event.forId);
  if (!answer) return;

  const body = answer.querySelector(".body");
  answer.classList.remove("waiting");

  if (event.reason === "cancelled") {
    answer.classList.add("cancelled");
    if (!body.textContent) body.textContent = "superseded by a newer question";
  } else if (event.reason === "failed") {
    answer.classList.add("failed");
    if (!body.textContent) body.textContent = "could not answer — see the message below";
  }
}

/* ------------------------------------------------------------------ *
 * Levels, status, errors
 * ------------------------------------------------------------------ */

// Shown over this range: below the floor is silence, and speech sits well
// inside it, so the bar spends its travel where the detail is.
const FLOOR_DB = -60;
const CEIL_DB = -10;

function showLevel(event) {
  const fraction = Math.max(0, Math.min(1, (event.rmsDb - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
  const width = `${fraction * 100}%`;
  for (const id of [`level-${event.lane}`, `level-${event.lane}-live`]) {
    const bar = el(id);
    if (bar) bar.style.width = width;
  }
}

function say(where, message, bad) {
  const node = el(where);
  node.textContent = message;
  node.classList.toggle("bad", Boolean(bad));
}

let toastTimer = null;
function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 6000);
}

function handle(event) {
  switch (event.type) {
    case "ready":
      el("device-you").textContent = event.youDevice;
      el("device-them").textContent = event.themDevice;
      el("live-models").textContent = [
        event.model,
        event.answers ?? "no answers",
        event.documents ? `${event.documents} doc${event.documents === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
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
      // Samples the capture thread discarded, which means a hole in the audio
      // and therefore in the transcript. Worth saying out loud.
      say("live-status", `${event.lane.toUpperCase()} dropped ${event.samples} samples`, true);
      break;

    case "error":
      toast(event.message);
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

let ticking = null;

function showLive(show) {
  setup.hidden = show;
  live.hidden = !show;
}

async function startSession() {
  const missing = mentionsIn(brief.value).filter(
    (name) => !available.some((entry) => entry.name === name && entry.readable),
  );
  if (missing.length) {
    say("setup-status", `not found in the folder: ${missing.join(", ")}`, true);
    return;
  }

  el("start").disabled = true;
  say("setup-status", "loading the model…", false);

  try {
    await invoke("start", { brief: brief.value });
  } catch (err) {
    say("setup-status", String(err), true);
    el("start").disabled = false;
    return;
  }

  say("setup-status", "", false);
  el("start").disabled = false;

  transcript.textContent = "";
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.id = "empty";
  empty.textContent =
    "Listening. Lines appear a beat after each person stops talking — or type a question below.";
  transcript.append(empty);

  pending.you = null;
  pending.them = null;
  lines = 0;
  say("live-status", "", false);
  showLive(true);
  el("compose").focus();

  const began = Date.now();
  el("elapsed").textContent = "00:00";
  ticking = setInterval(() => {
    el("elapsed").textContent = clock(Date.now() - began);
  }, 1000);
}

async function stopSession() {
  clearInterval(ticking);
  ticking = null;
  try {
    await invoke("stop");
  } catch (err) {
    toast(String(err));
  }
  for (const id of ["level-you", "level-them", "level-you-live", "level-them-live"]) {
    const bar = el(id);
    if (bar) bar.style.width = "0";
  }
  showLive(false);
  loadDocs();
  // Monitors can be plugged in or unplugged between sessions.
  loadMonitors();
}

async function send(withScreenshot) {
  const input = el("compose");
  const text = input.value.trim();
  if (!text && !withScreenshot) return;

  input.value = "";
  el("send").disabled = true;
  el("shot").disabled = true;

  const pinned = el("monitor").value;

  try {
    // `null` follows the window last in use; an index pins a screen.
    const captured = await invoke("ask", {
      text,
      screenshot: withScreenshot,
      monitor: pinned === "" ? null : Number(pinned),
    });

    // Say which screen went out. Following the active window is a guess, and
    // an unseen guess cannot be corrected.
    if (captured) toast(`sent ${captured}`);
  } catch (err) {
    toast(String(err));
    input.value = text;
  } finally {
    el("send").disabled = false;
    el("shot").disabled = false;
    input.focus();
  }
}

el("start").addEventListener("click", startSession);
el("stop").addEventListener("click", stopSession);
el("send").addEventListener("click", () => send(false));
el("shot").addEventListener("click", () => send(true));

el("compose").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send(false);
  }
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

if (!tauri?.event?.listen || !invoke) {
  el("health").dataset.state = "error";
  say("setup-status", "not running inside the app window — no event channel", true);
} else {
  // Order matters. The listener has to exist before anything can be emitted to
  // it, so it is attached before any command is issued — otherwise the first
  // events, including a startup failure, are dropped before arrival.
  tauri.event
    .listen("copilot", (message) => handle(message.payload))
    .then(() => Promise.all([loadDocs(), loadMonitors()]))
    .catch((err) => {
      el("health").dataset.state = "error";
      say("setup-status", String(err), true);
    });
}
