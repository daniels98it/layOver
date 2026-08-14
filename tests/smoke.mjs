#!/usr/bin/env node
/* =====================================================================
   Layover smoke test — plain node + Playwright, no test framework.

   Drives the real app through the DOM only, so it stays valid however the
   source files are split up (index.html / css / js). Serves the repo over
   http so the service-worker path is exercised for real.

   Run:
     node tests/smoke.mjs
   Locally (sandbox with its own node_modules + browsers):
     CHROMIUM_PATH=/opt/pw-browsers/chromium \
     NODE_PATH=/opt/node22/lib/node_modules node tests/smoke.mjs

   Exit code 0 = all assertions passed, 1 = failure (summary printed).
===================================================================== */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARTIFACTS = path.join(HERE, "artifacts");
const HARD_LIMIT_MS = 55_000;

/* ---------------------------------------------------------------- utils */
const results = [];          // {name, ok, detail}
let currentStep = "startup";
const consoleErrors = [];    // {step, text}
const pageErrors = [];       // {step, text}

function pass(name, detail = "") { results.push({ name, ok: true, detail }); console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
function fail(name, detail = "") { results.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }

class Failure extends Error {}
function assert(cond, name, detail = "") {
  if (cond) { pass(name, detail); return; }
  fail(name, detail);
  throw new Failure(`${name}${detail ? ": " + detail : ""}`);
}

/* Resolve Playwright in every environment we care about:
   1. plain ESM import  (repo-local or globally linked node_modules)
   2. CJS resolution    (honours NODE_PATH — how the local sandbox is set up)
   3. `npm root -g`     (how CI gets it: npm install -g playwright)
   4. the known sandbox path                                             */
async function loadPlaywright() {
  const tried = [];
  const viaSpec = async (spec) => {
    const m = await import(spec);
    console.log(`  playwright: ${spec}`);
    return m.default ?? m;
  };

  try { return await viaSpec("playwright"); }
  catch (e) { tried.push(`import('playwright'): ${e.message.split("\n")[0]}`); }

  const req = createRequire(import.meta.url);
  try { return await viaSpec(pathToFileURL(req.resolve("playwright")).href); }
  catch (e) { tried.push(`require.resolve('playwright'): ${e.message.split("\n")[0]}`); }

  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const p = path.join(globalRoot, "playwright", "index.js");
    if (fs.existsSync(p)) return await viaSpec(pathToFileURL(p).href);
    tried.push(`npm root -g (${p}): not found`);
  } catch (e) { tried.push(`npm root -g: ${e.message.split("\n")[0]}`); }

  const sandbox = "/opt/node22/lib/node_modules/playwright/index.js";
  try { if (fs.existsSync(sandbox)) return await viaSpec(pathToFileURL(sandbox).href); tried.push(`${sandbox}: not found`); }
  catch (e) { tried.push(`${sandbox}: ${e.message.split("\n")[0]}`); }

  throw new Error("Could not load Playwright. Attempts:\n  - " + tried.join("\n  - "));
}

/* ------------------------------------------------------- static server */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { res.writeHead(400).end("bad url"); return; }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    if (urlPath === "/favicon.ico") urlPath = "/icon-192.png";

    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end("forbidden"); return; }

    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + urlPath); return; }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
        "service-worker-allowed": "/"
      }).end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/* -------------------------------------------------------------- the run */
let browser, server;

async function run() {
  const pw = await loadPlaywright();
  const started = await startServer();
  server = started.server;
  const base = started.base;
  console.log(`\nLayover smoke test\n  server : ${base}\n  root   : ${ROOT}`);

  const launchOpts = {
    headless: true,
    args: [
      // Let AudioContext start without a gesture: otherwise ctx.resume()
      // rejects and surfaces as an unhandled rejection / page error.
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ]
  };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  console.log(`  chromium: ${process.env.CHROMIUM_PATH || "(playwright bundled)"}\n`);

  browser = await pw.chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    consoleErrors.push({ step: currentStep, text: msg.text() });
  });
  page.on("pageerror", (err) => {
    pageErrors.push({ step: currentStep, text: String(err && err.stack || err) });
  });

  const step = (name) => { currentStep = name; };

  /* -- 1. page loads ---------------------------------------------------- */
  step("load");
  const resp = await page.goto(base, { waitUntil: "load", timeout: 20_000 });
  assert(resp && resp.ok(), "page loads over http", `status ${resp && resp.status()}`);
  await page.waitForSelector("#promptMain", { state: "visible" });
  await page.waitForFunction(() => {
    const m = document.getElementById("promptMain");
    return m && m.textContent.trim().length > 0 && m.textContent.trim() !== "…";
  });
  const promptText = (await page.textContent("#promptMain")).trim();
  assert(promptText.length > 0 && promptText !== "…", "#promptMain has text", JSON.stringify(promptText));

  await page.waitForFunction(() => document.querySelectorAll(".ans").length >= 2);
  const ansCount = await page.locator(".ans").count();
  assert(ansCount >= 2, "answer buttons rendered", `${ansCount} .ans buttons`);

  /* -- 2. correct answer ------------------------------------------------ */
  step("correct answer");
  // Click + read feedback inside one synchronous evaluate: the app overwrites
  // feedback ~700ms later when no TTS voice exists, so never round-trip here.
  const good = await page.evaluate(() => {
    if (typeof question === "undefined" || !question) return { error: "global `question` not found" };
    const want = question.word[question.answerField];
    const btn = [...document.querySelectorAll(".ans")].find((b) => b._val === want);
    if (!btn) return { error: "no .ans button with _val === " + JSON.stringify(want) };
    btn.click();
    return { feedback: document.getElementById("feedback").textContent, want };
  });
  assert(!good.error, "correct answer: found matching .ans button", good.error || `_val=${JSON.stringify(good.want)}`);
  assert(good.feedback.startsWith("✓"), "correct answer shows ✓ feedback", JSON.stringify(good.feedback.slice(0, 60)));

  const score = await page.textContent("#scoreVal");
  assert(Number(score) > 0, "score increases after a correct answer", `#scoreVal=${score}`);

  const stored = await page.evaluate(() => localStorage.getItem("layover_progress_v1"));
  assert(!!stored && stored.length > 2, "progress saved to localStorage", "key layover_progress_v1");

  /* -- 3. wrong answer -------------------------------------------------- */
  step("wrong answer");
  await page.waitForFunction(() => typeof locked !== "undefined" && locked === false, null, { timeout: 12_000 });
  const bad = await page.evaluate(() => {
    const want = question.word[question.answerField];
    const btn = [...document.querySelectorAll(".ans")].find((b) => b._val !== want);
    if (!btn) return { error: "no wrong .ans button available" };
    btn.click();
    return { feedback: document.getElementById("feedback").textContent };
  });
  assert(!bad.error, "wrong answer: found a distractor button", bad.error || "");
  assert(bad.feedback.startsWith("✗"), "wrong answer shows ✗ feedback", JSON.stringify(bad.feedback.slice(0, 60)));

  /* -- 4. mode tab 2 = Say-it ------------------------------------------ */
  step("mode switch");
  const modeTabs = page.locator(".mode-tab");
  assert((await modeTabs.count()) >= 2, "two mode tabs exist", `${await modeTabs.count()} .mode-tab`);
  const kindBefore = (await page.textContent("#promptKind")).trim();
  await modeTabs.nth(1).click();
  await page.waitForFunction(() => /Say it in/.test(document.getElementById("promptKind").textContent));
  const kindAfter = (await page.textContent("#promptKind")).trim();
  assert(/Say it in/.test(kindAfter), "mode tab 2 switches to Say-it mode", JSON.stringify(kindAfter));
  assert(kindAfter !== kindBefore, "prompt changed on mode switch", `${JSON.stringify(kindBefore)} -> ${JSON.stringify(kindAfter)}`);
  const activeMode = (await page.textContent(".mode-tab.active")).trim();
  assert(/Say it/.test(activeMode), "Say-it tab is marked active", JSON.stringify(activeMode));
  await page.waitForFunction(() => document.querySelectorAll(".ans .ans-speak").length >= 2);
  const speakCount = await page.locator(".ans .ans-speak").count();
  assert(speakCount >= 2, "Say-it answers carry per-option 🔊 buttons", `${speakCount} .ans-speak`);

  /* -- 5. language tab switch ------------------------------------------ */
  step("language switch");
  const langTabs = page.locator(".lang-tab");
  const langCount = await langTabs.count();
  assert(langCount >= 2, "language tabs exist", `${langCount} .lang-tab`);
  const langBefore = (await page.textContent(".lang-tab.active")).trim();
  const targetIdx = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".lang-tab")];
    return tabs.findIndex((t) => !t.classList.contains("active"));
  });
  await langTabs.nth(targetIdx).click();
  await page.waitForFunction(
    (prev) => document.querySelector(".lang-tab.active").textContent.trim() !== prev,
    langBefore
  );
  const langAfter = (await page.textContent(".lang-tab.active")).trim();
  assert(langAfter !== langBefore, "language tab switch changes active language", `${langBefore} -> ${langAfter}`);
  const promptAfterLang = (await page.textContent("#promptMain")).trim();
  assert(promptAfterLang.length > 0, "a question renders in the new language", JSON.stringify(promptAfterLang));

  /* -- 6. browse + search + detail ------------------------------------- */
  step("browse");
  await page.click("#browseBtn");
  await page.waitForSelector("#browseInput", { state: "visible" });
  assert(await page.locator("#browseVeil.open").count() === 1, "browse sheet opens", "");
  await page.fill("#browseInput", "water");
  await page.waitForFunction(() => document.querySelectorAll(".browse-row").length > 0);
  const rows = await page.locator(".browse-row").count();
  assert(rows > 0, 'search "water" yields rows', `${rows} .browse-row`);
  const firstRowText = (await page.locator(".browse-row .b-text").first().textContent()).trim();
  assert(firstRowText.length > 0, "result rows have text", JSON.stringify(firstRowText.slice(0, 40)));

  step("detail");
  await page.locator(".browse-row .b-text").first().click();
  await page.waitForSelector("#detailVeil.open", { state: "attached" });
  await page.waitForFunction(() => document.getElementById("dNative").textContent.trim().length > 0);
  const native = (await page.textContent("#dNative")).trim();
  assert(native.length > 0, "row click opens detail with non-empty #dNative", JSON.stringify(native));

  step("close sheets");
  await page.click("#closeDetail");
  await page.waitForFunction(() => !document.getElementById("detailVeil").classList.contains("open"));
  assert(await page.locator("#detailVeil.open").count() === 0, "detail sheet closes", "");
  await page.click("#closeBrowse");
  await page.waitForFunction(() => !document.getElementById("browseVeil").classList.contains("open"));
  assert(await page.locator("#browseVeil.open").count() === 0, "browse sheet closes", "");

  /* -- 7. settings sheet ----------------------------------------------- */
  step("settings");
  await page.click("#settingsBtn");
  await page.waitForFunction(() => document.getElementById("sheetVeil").classList.contains("open"));
  assert(await page.locator("#sheetVeil.open").count() === 1, "settings sheet opens", "");
  await page.click("#closeSheet");
  await page.waitForFunction(() => !document.getElementById("sheetVeil").classList.contains("open"));
  assert(await page.locator("#sheetVeil.open").count() === 0, "settings sheet closes", "");

  /* -- 8. extra controls exist and are clickable ----------------------- */
  step("controls");
  for (const id of ["#speakBtn", "#hintBtn", "#dislikeBtn", "#autoBtn"]) {
    const n = await page.locator(id).count();
    assert(n === 1, `control ${id} present`, "");
  }
  await page.click("#autoBtn");
  const pressed = await page.getAttribute("#autoBtn", "aria-pressed");
  assert(pressed === "false" || pressed === "true", "#autoBtn toggles without error", `aria-pressed=${pressed}`);

  /* -- 9. service worker ----------------------------------------------- */
  step("service worker");
  const sw = await page.evaluate(() => new Promise((resolve) => {
    if (!("serviceWorker" in navigator)) return resolve({ error: "no serviceWorker in navigator" });
    const bail = setTimeout(() => resolve({ error: "timed out waiting for navigator.serviceWorker.ready" }), 20_000);
    navigator.serviceWorker.ready.then((reg) => {
      clearTimeout(bail);
      const report = () => resolve({
        state: reg.active ? reg.active.state : null,
        scriptURL: reg.active ? reg.active.scriptURL : null,
        scope: reg.scope,
        controlling: !!navigator.serviceWorker.controller
      });
      if (navigator.serviceWorker.controller) return report();
      const iv = setInterval(() => {
        if (navigator.serviceWorker.controller) { clearInterval(iv); clearTimeout(give); report(); }
      }, 150);
      const give = setTimeout(() => { clearInterval(iv); report(); }, 12_000);
    }).catch((e) => { clearTimeout(bail); resolve({ error: String(e) }); });
  }));
  assert(!sw.error, "navigator.serviceWorker.ready resolves", sw.error || `scope ${sw.scope}`);
  assert(sw.state === "activated", "service worker is activated", `state=${sw.state} script=${sw.scriptURL}`);
  assert(sw.controlling === true, "service worker controls the page", `controller=${sw.controlling}`);

  /* -- 10. no console / page errors ------------------------------------ */
  step("error log");
  assert(pageErrors.length === 0, "no uncaught page errors",
    pageErrors.map((e) => `[${e.step}] ${e.text.split("\n")[0]}`).join(" | "));
  assert(consoleErrors.length === 0, "no console errors",
    consoleErrors.map((e) => `[${e.step}] ${e.text}`).join(" | "));

  return page;
}

/* ---------------------------------------------------------------- main */
const watchdog = setTimeout(() => {
  console.error(`\n✗ smoke test exceeded ${HARD_LIMIT_MS / 1000}s hard limit (stuck in step: ${currentStep})`);
  finish(1);
}, HARD_LIMIT_MS);
watchdog.unref?.();

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? "\n      " + f.detail : ""}`);
  }
  if (pageErrors.length) {
    console.log("\nPage errors:");
    for (const e of pageErrors) console.log(`  [${e.step}] ${e.text}`);
  }
  if (consoleErrors.length) {
    console.log("\nConsole errors:");
    for (const e of consoleErrors) console.log(`  [${e.step}] ${e.text}`);
  }
  console.log("─".repeat(60));
}

async function finish(code) {
  clearTimeout(watchdog);
  try { if (browser) await browser.close(); } catch {}
  try { if (server) server.close(); } catch {}
  summary();
  console.log(code === 0 ? "\n✓ SMOKE TEST PASSED\n" : "\n✗ SMOKE TEST FAILED\n");
  process.exit(code);
}

let page;
try {
  page = await run();
  const ok = results.every((r) => r.ok);
  await finish(ok ? 0 : 1);
} catch (err) {
  if (!(err instanceof Failure)) {
    console.log(`  FAIL ${currentStep} — ${err && err.message ? err.message : err}`);
    results.push({ name: `step "${currentStep}"`, ok: false, detail: String(err && err.stack || err) });
  }
  // Best-effort screenshot for CI artifact upload.
  try {
    if (browser) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages.length) {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        await pages[0].screenshot({ path: path.join(ARTIFACTS, "failure.png"), fullPage: true });
        console.log(`  (screenshot: ${path.join(ARTIFACTS, "failure.png")})`);
      }
    }
  } catch {}
  await finish(1);
}
