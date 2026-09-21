// "The 6 A.M. Problem" — the directed sales film for Dispatch Control Tower.
// Six acts, a camera that points (spotlight + zoom), a real on-screen
// stopwatch, and voiceover-ready narration exported to demo/narration.md.
// Plan: docs/DEMO-PITCH-PLAN.md
//
//   1. Seed the story (stack on :8080, from repo root):
//        JWT_ACCESS_SECRET=compose-access JWT_REFRESH_SECRET=compose-refresh \
//          docker compose exec backend sh -c "node seed-control-tower.mjs && node seed-demo.mjs"
//   2. Play (from fleet-portal/):
//        node demo/pitch.mjs                  # headed premiere
//        DEMO_HEADLESS=1 node demo/pitch.mjs  # just produce the video
//        DEMO_PACE=1.4 node demo/pitch.mjs    # slower narration
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.DEMO_URL ?? "http://localhost:8080";
const HEADLESS = process.env.DEMO_HEADLESS === "1";
const PACE = Number(process.env.DEMO_PACE ?? 1);

mkdirSync("demo/video", { recursive: true });
mkdirSync("demo/shots", { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
let shot = 0;
const voLines = [];

// ── The stage: injected styles, narrator, ghost cursor. SPA navigation keeps
// the DOM alive, so one injection after login survives the whole film. ─────
async function stage(page) {
  await page.evaluate(() => {
    if (document.getElementById("demo-stage")) return;
    const css = document.createElement("style");
    css.id = "demo-stage";
    css.textContent = `
      #demo-narrator{position:fixed;left:18px;right:18px;bottom:18px;z-index:99997;
        background:rgba(13,17,26,.95);color:#fff;padding:16px 24px;border-radius:14px;
        font:600 18px/1.45 system-ui,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.4);
        pointer-events:none;border-left:6px solid #2563eb;transition:opacity .3s}
      #demo-narrator .act{display:block;font:700 11px/1 ui-monospace,monospace;
        letter-spacing:.14em;color:#7ea6ff;margin-bottom:6px;text-transform:uppercase}
      #demo-spot{position:fixed;z-index:99990;border:3px solid #3b82f6;border-radius:12px;
        box-shadow:0 0 0 9999px rgba(8,11,18,.55),0 0 24px rgba(59,130,246,.55);
        pointer-events:none;transition:all .55s cubic-bezier(.4,0,.2,1);display:none}
      #demo-cursor{position:fixed;z-index:99999;width:26px;height:26px;border-radius:50%;
        background:rgba(37,99,235,.30);border:2.5px solid #2563eb;pointer-events:none;
        transform:translate(-50%,-50%);transition:left .1s linear,top .1s linear;
        box-shadow:0 0 12px rgba(37,99,235,.5)}
      #demo-title{position:fixed;inset:0;z-index:99998;display:flex;flex-direction:column;
        align-items:center;justify-content:center;background:rgba(9,12,19,.94);color:#fff;
        opacity:0;transition:opacity .6s ease;pointer-events:none;text-align:center}
      #demo-title .no{font:italic 700 30px/1 Georgia,serif;color:#7ea6ff;margin-bottom:14px}
      #demo-title .tt{font:700 54px/1.15 Georgia,serif;max-width:22ch}
      #demo-title .sub{font:400 18px/1.5 system-ui,sans-serif;color:#aeb6c6;margin-top:14px}
      #demo-stat{position:fixed;left:50%;top:44%;transform:translate(-50%,-50%);z-index:99996;
        background:rgba(13,17,26,.96);border:1px solid #2f3a52;border-radius:16px;
        padding:26px 40px;color:#fff;opacity:0;transition:opacity .4s;pointer-events:none;
        box-shadow:0 18px 60px rgba(0,0,0,.5);text-align:center}
      #demo-stat div{font:700 26px/1.7 ui-monospace,monospace;color:#facc15}
      #demo-timer{position:fixed;top:14px;right:16px;z-index:99996;display:none;
        background:rgba(13,17,26,.95);color:#facc15;border-radius:10px;padding:8px 16px;
        font:700 20px/1 ui-monospace,monospace;box-shadow:0 4px 18px rgba(0,0,0,.35)}
      #app{transition:transform .65s cubic-bezier(.4,0,.2,1)}
    `;
    document.head.appendChild(css);
    const cur = document.createElement("div");
    cur.id = "demo-cursor";
    document.body.appendChild(cur);
    window.addEventListener("mousemove", (e) => {
      cur.style.left = `${e.clientX}px`;
      cur.style.top = `${e.clientY}px`;
    }, true);
  });
}

async function narrate(page, act, text, holdMs = 4600) {
  voLines.push({ act, text });
  await page.evaluate(({ act, text }) => {
    let bar = document.getElementById("demo-narrator");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "demo-narrator";
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span class="act"></span>`;
    bar.querySelector(".act").textContent = act;
    bar.appendChild(document.createTextNode(text));
  }, { act, text });
  await wait(holdMs);
}

async function titleCard(page, no, title, sub = "") {
  await page.evaluate(({ no, title, sub }) => {
    let t = document.getElementById("demo-title");
    if (!t) {
      t = document.createElement("div");
      t.id = "demo-title";
      t.innerHTML = `<div class="no"></div><div class="tt"></div><div class="sub"></div>`;
      document.body.appendChild(t);
    }
    t.querySelector(".no").textContent = no;
    t.querySelector(".tt").textContent = title;
    t.querySelector(".sub").textContent = sub;
    t.style.opacity = "1";
  }, { no, title, sub });
  await wait(2800);
  await page.evaluate(() => { const t = document.getElementById("demo-title"); if (t) t.style.opacity = "0"; });
  await wait(700);
}

async function spotlight(page, locator, pad = 10) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(({ box, pad }) => {
    let s = document.getElementById("demo-spot");
    if (!s) {
      s = document.createElement("div");
      s.id = "demo-spot";
      document.body.appendChild(s);
    }
    s.style.display = "block";
    s.style.left = `${box.x - pad}px`;
    s.style.top = `${box.y - pad}px`;
    s.style.width = `${box.width + pad * 2}px`;
    s.style.height = `${box.height + pad * 2}px`;
  }, { box, pad });
}

async function clearSpot(page) {
  await page.evaluate(() => { const s = document.getElementById("demo-spot"); if (s) s.style.display = "none"; });
}

async function zoomTo(page, locator, scale = 1.6) {
  await clearSpot(page); // the spotlight doesn't track the transform — zoom isolates attention on its own
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(({ cx, cy, scale }) => {
    const app = document.getElementById("app");
    if (!app) return;
    app.style.transformOrigin = `${cx}px ${cy}px`;
    app.style.transform = `scale(${scale})`;
  }, { cx: box.x + box.width / 2, cy: box.y + box.height / 2, scale });
  await wait(750);
}

async function zoomOut(page) {
  await page.evaluate(() => { const app = document.getElementById("app"); if (app) app.style.transform = ""; });
  await wait(700);
}

async function statCard(page, lines, holdMs = 4600) {
  await page.evaluate((lines) => {
    let c = document.getElementById("demo-stat");
    if (!c) {
      c = document.createElement("div");
      c.id = "demo-stat";
      document.body.appendChild(c);
    }
    c.innerHTML = lines.map((l) => `<div></div>`).join("");
    [...c.children].forEach((el, i) => (el.textContent = lines[i]));
    c.style.opacity = "1";
  }, lines);
  await wait(holdMs);
  await page.evaluate(() => { const c = document.getElementById("demo-stat"); if (c) c.style.opacity = "0"; });
  await wait(400);
}

async function timerStart(page) {
  await page.evaluate(() => {
    let t = document.getElementById("demo-timer");
    if (!t) {
      t = document.createElement("div");
      t.id = "demo-timer";
      document.body.appendChild(t);
    }
    t.style.display = "block";
    t.style.color = "#facc15";
    window.__demoT0 = performance.now();
    window.__demoTick = setInterval(() => {
      t.textContent = `⏱ ${((performance.now() - window.__demoT0) / 1000).toFixed(1)}s`;
    }, 100);
  });
}

async function timerStop(page) {
  return page.evaluate(() => {
    clearInterval(window.__demoTick);
    const secs = (performance.now() - window.__demoT0) / 1000;
    const t = document.getElementById("demo-timer");
    if (t) { t.textContent = `⏱ ${secs.toFixed(1)}s`; t.style.color = "#4ade80"; }
    return Math.round(secs);
  });
}

async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `demo/shots/${String(shot).padStart(2, "0")}-${name}.png` });
}

async function goNav(page, label) {
  await clearSpot(page);
  await zoomOut(page);
  await page.getByRole("link", { name: label, exact: true }).click();
  await wait(800);
}

const browser = await chromium.launch({ headless: HEADLESS, slowMo: 90 });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "demo/video", size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

try {
  // ═══ ACT I · THE 6 A.M. PROBLEM ═══════════════════════════════════════════
  await page.goto(`${BASE}/login`);
  await page.locator("#email").pressSequentially("d@fleet.com", { delay: 35 });
  await page.locator("#password").pressSequentially("pass123", { delay: 35 });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByTestId("kpi-bar").waitFor({ timeout: 20000 });
  await stage(page);

  await titleCard(page, "ACT I", "The 6 A.M. Problem", "Dispatch Control Tower");
  await narrate(page, "Act I · The 6 A.M. Problem",
    "6 a.m. Five loads uncovered. One truck running late. A driver asking what's next.", 4200);
  await spotlight(page, page.getByTestId("load-backlog"));
  await narrate(page, "Act I · The 6 A.M. Problem",
    "Yesterday, this was three phone calls, two spreadsheets, and a prayer.", 3600);
  await spotlight(page, page.locator("[data-lane] [data-load]").first());
  await narrate(page, "Act I · The 6 A.M. Problem", "Today it's one screen.", 2800);
  await clearSpot(page);
  await snap(page, "cold-open");

  // ═══ ACT II · ONE SCREEN ═════════════════════════════════════════════════
  await titleCard(page, "ACT II", "One Screen", "The board and the whole cockpit — pointed at, piece by piece");

  // Beat 1 — KPI bar (+ a tooltip opened on camera)
  await spotlight(page, page.getByTestId("kpi-bar"));
  await page.locator('[data-testid="kpi-saved"] [data-testid="info-tip"]').hover();
  await narrate(page, "Act II · One Screen",
    "Your money, live. Revenue, margin, empty miles — not month-end accounting. Right now. And every number explains itself.", 5200);
  await snap(page, "kpi-tooltip");

  // Beat 2 — a lane: HOS gauge + STALE honesty
  const staleLane = page.locator("[data-lane]", { has: page.getByTestId("lane-hos-stale") }).first();
  await spotlight(page, staleLane.locator("div").first());
  await zoomTo(page, staleLane.getByTestId("lane-hos-stale"), 1.7);
  await narrate(page, "Act II · One Screen",
    "Every driver: legal hours as a fuel gauge. Booked time. Revenue. And when the clock data is three days old — the board says STALE. It never pretends to know more than it does.", 6000);
  await snap(page, "lane-stale");
  await zoomOut(page);

  // Beat 3 — the cockpit sweep
  await spotlight(page, page.getByTestId("board-search"));
  await narrate(page, "Act II · One Screen", "Up top, the cockpit. Search anything — a load, a city, a driver.", 2600);
  await spotlight(page, page.getByTestId("equip-filter"));
  await narrate(page, "Act II · One Screen", "Filter by trailer type.", 1900);
  await spotlight(page, page.locator('[data-chip="in_progress"]'));
  await page.locator('[data-chip="in_progress"]').click();
  await narrate(page, "Act II · One Screen", "One-click views: what's rolling right now…", 2300);
  await page.locator('[data-chip="all"]').click();
  await spotlight(page, page.getByTestId("zoom-slider"));
  await page.getByTestId("zoom-slider").evaluate((el) => {
    el.value = "118"; el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await narrate(page, "Act II · One Screen", "Stretch time in for precision…", 2100);
  await page.getByTestId("zoom-slider").evaluate((el) => {
    el.value = "60"; el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await spotlight(page, page.getByTestId("span-5"));
  await page.getByTestId("span-5").click();
  await narrate(page, "Act II · One Screen", "…or flip to the week for the big picture. It's your board — shape it.", 2800);
  await page.getByTestId("span-1").click();
  await wait(600);
  await snap(page, "cockpit");

  // Beat 4 — the brick, decoded
  const deadheadBrick = page.locator("[data-lane] [data-load]", { has: page.getByTestId("deadhead-strip") }).first();
  if (await deadheadBrick.count()) {
    await spotlight(page, deadheadBrick);
    await zoomTo(page, deadheadBrick, 1.8);
    await narrate(page, "Act II · One Screen",
      "Every brick tells its whole trip. The hatched lead-in? Empty miles to reach the pickup — you SEE waste before you accept it. And the three little buttons run the trip: start it, deliver it, undo it.", 6200);
    await snap(page, "brick-decoded");
    await zoomOut(page);
  }

  // Beat 5 — the Yard
  await clearSpot(page);
  await page.locator("h2", { hasText: "Yard" }).scrollIntoViewIfNeeded();
  await spotlight(page, page.locator("h2", { hasText: "Yard" }).locator(".."));
  await narrate(page, "Act II · One Screen",
    "Below the board, the Yard: every truck, trailer, and driver that's free at this exact minute — live. “What can I dispatch right now?” That question answers itself.", 4800);
  await snap(page, "yard");

  // Beat 6 — backlog urgency
  await page.getByTestId("load-backlog").scrollIntoViewIfNeeded();
  await spotlight(page, page.locator("[data-urgency]").first());
  await narrate(page, "Act II · One Screen",
    "And uncovered freight sorts itself by which pickup window burns first. Nobody keeps that list in their head anymore.", 4200);
  await snap(page, "urgency");
  await clearSpot(page);

  // ═══ ACT III · 22 SECONDS TO DISPATCH ════════════════════════════════════
  await titleCard(page, "ACT III", "Seconds to Dispatch", "One load, end to end — with the clock running");

  await goNav(page, "Messages");
  await page.locator("[data-conversation-row]").first().click();
  await wait(800);
  await narrate(page, "Act III · Seconds to Dispatch",
    "Jake just emptied out in Kansas City. He wants miles. Watch how fast he gets them.", 3600);
  await snap(page, "inbox");
  await timerStart(page);
  await page.locator("#message-composer").pressSequentially("Got you covered — assigning you now.", { delay: 16 });
  await page.getByRole("button", { name: "Send" }).click();
  await narrate(page, "Act III · Seconds to Dispatch", "“Got you covered.” Now let's mean it.", 2000);

  await goNav(page, "Control Tower");
  await page.getByTestId("load-backlog").scrollIntoViewIfNeeded();
  await page.locator('[data-testid="load-backlog"] [data-suggest]').first().click();
  await page.getByTestId("suggest-panel").waitFor();
  await spotlight(page, page.getByTestId("suggest-panel"));
  await narrate(page, "Act III · Seconds to Dispatch",
    "One click. The engine scores the whole fleet — empty miles, margin, legal hours, who's run this lane before.", 3800);
  const blockedRow = page.locator("[data-suggest-row]", { hasText: "✗" }).first();
  if (await blockedRow.count()) {
    await zoomTo(page, blockedRow, 1.7);
    await narrate(page, "Act III · Seconds to Dispatch",
      "And Dale? Blocked — not enough legal hours. That little ✗ is an FMCSA violation that never happened.", 3600);
    await zoomOut(page);
  }
  await snap(page, "suggest");

  await clearSpot(page);
  await page.locator('[data-testid="suggest-panel"] button:has-text("Assign")').first().click();
  await page.getByTestId("assign-modal").waitFor();
  await zoomTo(page, page.getByTestId("economics"), 1.5);
  const marginText = await page.getByTestId("economics").innerText().catch(() => "");
  await narrate(page, "Act III · Seconds to Dispatch",
    "Before anything commits: every check passed — and the load is priced. YOUR fuel burn. YOUR driver pay. You know the margin while the broker is still on the phone.", 5200);
  await snap(page, "assign-modal");
  await zoomOut(page);
  await page.getByTestId("assign-btn").click();
  await page.getByTestId("assign-modal").waitFor({ state: "hidden", timeout: 15000 });
  const secs = await timerStop(page);
  const marginLine = /Margin\s*\$?([\d,.-]+)/.exec(marginText.replace(/\n/g, " "))?.[1];
  await narrate(page, "Act III · Seconds to Dispatch",
    "Done. Brick on the lane. Hours booked. Jake's phone buzzing over the live connection.", 3200);
  await snap(page, "dispatched");
  await statCard(page, [
    `${secs} seconds — message to committed dispatch`,
    "0 phone calls",
    marginLine ? `$${marginLine} margin locked before commit` : "margin locked before commit",
  ]);
  await page.evaluate(() => { const t = document.getElementById("demo-timer"); if (t) t.style.display = "none"; });

  // Beat 5 — the drag
  const dragCard = page.locator('[data-testid="load-backlog"] [data-load]').first();
  const mariaTrack = page.locator("[data-lane-track]").nth(2);
  if (await dragCard.count()) {
    await narrate(page, "Act III · Seconds to Dispatch",
      "Prefer your hands on the board? Drag it. Same checks. Same pricing.", 2400);
    try {
      await dragCard.dragTo(mariaTrack, { targetPosition: { x: 620, y: 30 } });
      await page.getByTestId("assign-modal").waitFor({ timeout: 8000 });
      await snap(page, "drag-preview");
      await wait(1600);
      await page.locator('[data-testid="assign-modal"] button:has-text("Cancel")').click();
    } catch {
      // drag is garnish — never let it break the film
    }
  }

  // ═══ ACT IV · PROBLEMS FIND YOU ══════════════════════════════════════════
  await titleCard(page, "ACT IV", "Problems Find You", "The board watches when you can't");
  const risk = page.getByTestId("risk-feed");
  await risk.waitFor({ timeout: 20000 }).catch(() => {});
  if (await risk.count()) {
    await risk.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 180);
    await wait(500);
    await spotlight(page, risk);
    await narrate(page, "Act IV · Problems Find You",
      "Meanwhile — the board found a problem before you did. Tyrone is 444 miles from a window that closes in an hour. Even a perfect run misses it.", 4800);
    await zoomTo(page, risk.locator("[data-risk-row]").first(), 1.5);
    await narrate(page, "Act IV · Problems Find You",
      "You get to call the broker FIRST. That's the difference between an apology and a chargeback.", 3800);
    await snap(page, "late-risk");
    await zoomOut(page);
  }
  await clearSpot(page);

  // The paperwork watches itself: the compliance digest, then a live block.
  const digest = page.getByTestId("compliance-digest");
  if (await digest.count()) {
    await digest.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 160);
    await wait(500);
    await spotlight(page, digest);
    await narrate(page, "Act IV · Problems Find You",
      "And it's not just today's trips. The board tracks the paperwork: an expired trailer registration, a medical certificate running out, a truck overdue for service — thirty days ahead, worst first.", 5400);
    await snap(page, "compliance-digest");
    await clearSpot(page);
  }

  const flatbedCard = page.locator('[data-testid="load-backlog"] [data-load]', { hasText: "L-88012" });
  if (await flatbedCard.count()) {
    await flatbedCard.scrollIntoViewIfNeeded();
    await flatbedCard.locator("[data-suggest]").click();
    await page.getByTestId("suggest-panel").waitFor();
    await spotlight(page, page.getByTestId("suggest-panel"));
    await narrate(page, "Act IV · Problems Find You",
      "Try to cover that Flatbed load? Every single driver — blocked. Not because of the drivers: the only Flatbed in the yard has EXPIRED registration. One glance says “fix the trailer”, not “find another driver”. That's a roadside out-of-service that never happened.", 6400);
    await snap(page, "compliance-block");
    await clearSpot(page);
    await page.locator('[data-testid="suggest-panel"] button:has-text("✕")').click().catch(() => {});
  }

  // ═══ ACT V · WHERE THE MONEY GOES ════════════════════════════════════════
  await titleCard(page, "ACT V", "Where the Money Goes", "The owner's reason to buy");
  await goNav(page, "Money");
  await page.getByTestId("cost-model").waitFor();
  await spotlight(page, page.getByTestId("cost-model"));
  await narrate(page, "Act V · Where the Money Goes",
    "This is where fleets bleed: freight that never paid. Diesel jumped this morning? Change it —", 3200);
  await page.getByTestId("cost-diesel").fill("4.60");
  await page.getByTestId("cost-save").click();
  await page.getByTestId("cost-saved").waitFor({ timeout: 8000 }).catch(() => {});
  await narrate(page, "Act V · Where the Money Goes",
    "— and every future dispatch reprices at YOUR numbers. Not an average. Yours.", 3200);
  await snap(page, "cost-model");
  await page.getByTestId("cost-diesel").fill("4.00");
  await page.getByTestId("cost-save").click();
  await wait(400);

  const loserRow = page.locator("[data-money-row]").first();
  await loserRow.scrollIntoViewIfNeeded();
  await spotlight(page, loserRow);
  await zoomTo(page, loserRow, 1.4);
  await narrate(page, "Act V · Where the Money Goes",
    "And that red row? That load LOST $140. You found out the same week — not at tax time.", 4400);
  await snap(page, "money-loser");
  await zoomOut(page);
  await clearSpot(page);

  await goNav(page, "Analytics");
  await page.getByTestId("settlements-card").waitFor();
  await spotlight(page, page.getByTestId("brokers-table"));
  await narrate(page, "Act V · Where the Money Goes", "Which brokers actually pay. Which lanes repeat.", 3000);
  await page.getByTestId("settlements-card").scrollIntoViewIfNeeded();
  await spotlight(page, page.getByTestId("settlements-card"));
  await narrate(page, "Act V · Where the Money Goes",
    "Friday's driver settlements — one click, straight to CSV.", 3000);
  await snap(page, "analytics");
  await clearSpot(page);

  // The headline number — read LIVE off the KPI bar so the math is honest.
  await goNav(page, "Control Tower");
  await page.getByTestId("kpi-bar").waitFor();
  const savedText = await page.getByTestId("kpi-saved").innerText();
  const savedMi = Number(/([\d,]+)\s*mi/.exec(savedText)?.[1]?.replace(/,/g, "") ?? 0);
  const dollars = Math.round((savedMi * 167) / 100);
  await spotlight(page, page.getByTestId("kpi-saved"));
  await zoomTo(page, page.getByTestId("kpi-saved"), 1.6);
  await narrate(page, "Act V · Where the Money Goes",
    `And the number that pays for the software: ${savedMi} empty miles avoided. At your all-in dollar-sixty-seven a mile — that's about $${dollars} that stayed in the business.`, 5200);
  await zoomOut(page);
  await statCard(page, [
    `${savedMi} empty miles avoided`,
    `× $1.67 all-in per mile`,
    `≈ $${dollars} kept in the business`,
  ]);
  await snap(page, "roi");
  await clearSpot(page);

  // ═══ ACT VI · THE CLOSE ══════════════════════════════════════════════════
  await narrate(page, "Act VI · The Close",
    "One screen. Every truck. Every dollar. Every deadline. The problems find you — before they find your customers.", 4600);
  await titleCard(page, "DISPATCH CONTROL TOWER", "The 6 A.M. Problem — solved.",
    "Ask for the demo login — run it on your own freight.");
  await snap(page, "finale");
} finally {
  await context.close();
  await browser.close();
}

// Voiceover script export — recording a human/AI voice becomes a 10-minute job.
const vo = [
  "# The 6 A.M. Problem — voiceover script", "",
  ...voLines.map((l) => `**[${l.act}]**\n${l.text}\n`),
].join("\n");
writeFileSync("demo/narration.md", vo);

console.log(`\nfilm complete — ${shot} frames in demo/shots/, VO script in demo/narration.md`);
console.log("video in demo/video/ (webm)");
