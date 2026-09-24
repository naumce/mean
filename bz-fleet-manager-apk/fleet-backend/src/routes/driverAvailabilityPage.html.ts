// AI Dispatch Foundation (Task 10): the driver-facing availability page.
// A TypeScript string constant, not a static .html file — tsc does not copy
// non-.ts files into dist/, so a string keeps the build honest (the file
// would 404 in production if this lived as a sibling .html asset instead).
// Pattern/tone copied from night-shift/src/live/driverPage.html: no
// framework, no external scripts, a vanilla-JS IIFE, __PLACEHOLDER__-style
// substitution done by the caller (driverAvailabilityPage.ts) at request
// time — this file only owns the template text.
//
// The two toggles PATCH .../availability directly; a ping (real GPS via
// watchPosition, or the lab's hardcoded-city/manual-coordinate form) POSTs
// .../ping. Both are relative to `base`, built from __TOKEN__, so this page
// carries no other credential.
export const DRIVER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__NAME__ — Availability</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 17px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1422; color: #eef1f7; }
  main { max-width: 480px; margin: 0 auto; padding: 20px 16px 40px; display: grid; gap: 14px; }
  h1 { font-size: 19px; margin: 0; font-weight: 600; }
  .muted { color: #9aa4bd; font-size: 14px; }
  .chip { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 700; background: #1e2c4a; }
  .toggle { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-radius: 14px; background: #141b2e; border: 1px solid #232d47; }
  .toggle b { font-size: 14px; letter-spacing: .03em; }
  .toggle button { font: inherit; border: 0; border-radius: 999px; padding: 10px 18px; font-weight: 700; min-width: 76px; }
  .on { background: #1f8f5f; color: #fff; }
  .off { background: #3a4260; color: #cbd2e6; }
  button.primary { font: inherit; border: 0; border-radius: 12px; padding: 14px; background: #3b82f6; color: #fff; font-weight: 600; width: 100%; }
  button:disabled { opacity: .5; }
  fieldset { border: 1px solid #232d47; border-radius: 12px; padding: 12px; margin: 0; }
  legend { padding: 0 6px; font-size: 12px; color: #9aa4bd; }
  select, input { font: inherit; padding: 10px; border-radius: 10px; border: 1px solid #2a3450; background: #141b2e; color: inherit; width: 100%; box-sizing: border-box; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  #pingStatus { font-size: 13px; color: #9aa4bd; min-height: 18px; }
</style>
</head>
<body>
<main>
  <div>
    <h1>Hi __NAME__</h1>
    <div class="muted">Your availability for new loads</div>
  </div>
  <div><span id="statusChip" class="chip">…</span></div>
  <div class="muted" id="availLine">Loading…</div>

  <div class="toggle">
    <b>LOCATION SHARING</b>
    <button id="shareToggle" type="button">…</button>
  </div>
  <div class="toggle">
    <b>AVAILABLE FOR LOADS</b>
    <button id="loadsToggle" type="button">…</button>
  </div>

  <button id="sendPos" class="primary" type="button">Send my position</button>
  <div id="pingStatus"></div>

  <fieldset>
    <legend>Test position (lab only)</legend>
    <div class="muted">This form simulates location updates — pick a city or type coordinates, then send a ping the same way your phone's GPS would.</div>
    <select id="citySelect"><option value="">Choose a city…</option></select>
    <div class="row">
      <input id="latInput" type="number" step="0.0001" placeholder="Latitude" min="-90" max="90">
      <input id="lngInput" type="number" step="0.0001" placeholder="Longitude" min="-180" max="180">
    </div>
    <button id="sendTest" class="primary" type="button" style="margin-top:8px">Send test position</button>
  </fieldset>
</main>
<script>
(function () {
  var token = __TOKEN__, base = "/api/driver-page/" + token;
  var $ = function (id) { return document.getElementById(id); };
  var state = null, watchId = null, lastSentAt = 0;

  function post(path, body) {
    return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function patchAvailability(body) {
    return fetch(base + "/availability", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  function setToggle(id, on) {
    var b = $(id);
    b.textContent = on ? "ON" : "OFF";
    b.className = on ? "on" : "off";
  }

  function render() {
    if (!state) return;
    $("statusChip").textContent = state.status;
    var place = state.available && state.available.city
      ? state.available.city + (state.available.state ? ", " + state.available.state : "")
      : "an unknown location";
    var when = state.availableAt <= Date.now() ? "now" : new Date(state.availableAt).toLocaleString();
    $("availLine").textContent = "Projected available " + when + " near " + place;
    setToggle("shareToggle", state.locationSharingEnabled);
    setToggle("loadsToggle", state.acceptingLoads);
    $("sendPos").disabled = !state.locationSharingEnabled;
    if (state.locationSharingEnabled) startWatch(); else stopWatch();
  }

  function load() {
    fetch(base + "/availability").then(function (r) { return r.json(); }).then(function (j) { state = j; render(); });
  }

  $("shareToggle").onclick = function () {
    if (!state) return;
    patchAvailability({ locationSharingEnabled: !state.locationSharingEnabled }).then(function (j) { state = j; render(); });
  };
  $("loadsToggle").onclick = function () {
    if (!state) return;
    patchAvailability({ acceptingLoads: !state.acceptingLoads }).then(function (j) { state = j; render(); });
  };

  // Throttled to one POST per 30s, whatever the source (live GPS or the lab
  // form below) — a force-send (explicit button tap) resets the clock first.
  function sendPing(lat, lng) {
    var now = Date.now();
    if (now - lastSentAt < 30000) return;
    lastSentAt = now;
    post("/ping", { lat: lat, lng: lng }).then(function (r) {
      $("pingStatus").textContent = r.status === 204
        ? "Position sent · " + new Date(now).toLocaleTimeString()
        : "Not sent — location sharing is off";
    }).catch(function () { $("pingStatus").textContent = "Could not send position — will try again"; });
  }

  function startWatch() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      function (pos) { sendPing(pos.coords.latitude, pos.coords.longitude); },
      function () { $("pingStatus").textContent = "Location unavailable — check phone settings"; },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
    );
  }
  function stopWatch() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  $("sendPos").onclick = function () {
    if (!navigator.geolocation) { $("pingStatus").textContent = "This phone cannot share location."; return; }
    lastSentAt = 0;
    navigator.geolocation.getCurrentPosition(function (pos) { sendPing(pos.coords.latitude, pos.coords.longitude); });
    startWatch();
  };

  // ~12 Midwest hubs, hardcoded — the lab's "simulate location updates"
  // affordance, never a real geocoder call.
  var HUBS = [
    ["Chicago, IL", 41.8781, -87.6298], ["Indianapolis, IN", 39.7684, -86.1581],
    ["Columbus, OH", 39.9612, -82.9988], ["Detroit, MI", 42.3314, -83.0458],
    ["Milwaukee, WI", 43.0389, -87.9065], ["Minneapolis, MN", 44.9778, -93.2650],
    ["St. Louis, MO", 38.6270, -90.1994], ["Kansas City, MO", 39.0997, -94.5786],
    ["Omaha, NE", 41.2565, -95.9345], ["Des Moines, IA", 41.5868, -93.6250],
    ["Cincinnati, OH", 39.1031, -84.5120], ["Cleveland, OH", 41.4993, -81.6944]
  ];
  HUBS.forEach(function (h) {
    var o = document.createElement("option");
    o.value = h[1] + "," + h[2];
    o.textContent = h[0];
    $("citySelect").appendChild(o);
  });
  $("citySelect").onchange = function () {
    if (!this.value) return;
    var parts = this.value.split(",");
    $("latInput").value = parts[0];
    $("lngInput").value = parts[1];
  };
  $("sendTest").onclick = function () {
    var lat = parseFloat($("latInput").value), lng = parseFloat($("lngInput").value);
    if (isNaN(lat) || isNaN(lng)) { $("pingStatus").textContent = "Pick a city or enter both coordinates."; return; }
    lastSentAt = 0; // the lab control always sends, regardless of the 30s throttle above
    post("/ping", { lat: lat, lng: lng }).then(function (r) {
      $("pingStatus").textContent = r.status === 204
        ? "Test position sent · " + new Date().toLocaleTimeString()
        : "Not sent — location sharing is off";
    });
  };

  load();
})();
</script>
</body>
</html>
`;
