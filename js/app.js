"use strict";
const APP_VERSION = "1.3.0";

/* =====================================================================
   PERSISTENCE — localStorage with a safe in-memory fallback, so the
   game still runs even if storage is blocked (e.g. some sandboxed
   previews). On an iPhone opened as a real file, progress persists.
===================================================================== */
const STORE_KEY = "layover_progress_v1";
const memStore = {};
const storage = {
  get(){
    try{
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return memStore.data || null; }
  },
  set(data){
    try{ localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch(e){ /* storage blocked */ }
    memStore.data = data;
  },
  clear(){
    try{ localStorage.removeItem(STORE_KEY); }catch(e){}
    delete memStore.data;
  }
};

const DEFAULT_PROGRESS = () => ({
  score:0, streak:0, bestStreak:0, answered:0,
  correctCounts:{},   // "zh|ess|你好" -> times answered correctly
  mastered:{},        // same key -> true once recalled at MASTER_BOX spacing
  disliked:{},        // same key -> true when the user hides a phrase
  srs:{},             // same key -> {b: box 0-6, d: next-review timestamp}
  autoplay:true,      // auto-speak the prompt on listening questions
  mode:"listen"       // "listen" or "pronounce"
});
let P = Object.assign(DEFAULT_PROGRESS(), storage.get() || {});
P.correctCounts = P.correctCounts || {};
P.mastered = P.mastered || {};
P.disliked = P.disliked || {};
P.srs = P.srs || {};
if(typeof P.autoplay !== "boolean") P.autoplay = true;
const save = () => storage.set(P);

/* =====================================================================
   SPACED REPETITION — expanding-interval scheduler (Leitner / Pimsleur
   style). Retrieving a word at gradually widening gaps is the single
   best-evidenced way to fix vocabulary in long-term memory (Pimsleur
   1967; Karpicke & Bauernschmidt 2011). Correct → the word climbs a box
   and its next review moves further out; wrong → it drops back and
   returns within a minute for relearning.
===================================================================== */
const INTERVALS = [30e3, 60e3, 5*60e3, 30*60e3, 4*3600e3, 3*86400e3, 7*86400e3]; // per box 0-6
const MASTER_BOX = 4;   // mastered = recalled across four widening gaps
const FOCUS_SIZE = 6;   // learn in small sets — retention drops sharply past ~6-8 new items

// Migrate pre-SRS progress: words already answered keep their standing.
(function migrateSrs(){
  const now = Date.now();
  for(const key in P.correctCounts){
    if(P.srs[key]) continue;
    const b = P.mastered[key] ? MASTER_BOX : Math.min(P.correctCounts[key], 3);
    P.srs[key] = { b, d: now + (P.mastered[key] ? INTERVALS[MASTER_BOX] : 0) };
  }
})();

/* =====================================================================
   AUDIO — synthesized beeps via Web Audio API (no files needed)
===================================================================== */
let audioCtx = null;
function getCtx(){
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(AC) audioCtx = new AC();
  }
  if(audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function tone(freq, start, dur, type, vol){
  const ctx = getCtx(); if(!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.05);
}
const sfxCorrect = () => { tone(660,0,.12,"sine",.18); tone(880,.11,.16,"sine",.18); };
const sfxWrong   = () => { tone(220,0,.18,"square",.09); tone(165,.14,.22,"square",.09); };
const sfxMaster  = () => { tone(660,0,.1,"sine",.16); tone(880,.09,.1,"sine",.16); tone(1175,.18,.22,"sine",.18); };

/* =====================================================================
   SPEECH — Web Speech API with correct locales.
   Voices load asynchronously on iOS, so we refresh the list on change.
===================================================================== */
let voices = [];
let currentUtterance = null;   // held globally — Safari silently drops utterances
                               // that get garbage-collected mid-speech
let speechUnlocked = false;

function loadVoices(){ try{ voices = speechSynthesis.getVoices() || []; }catch(e){ voices = []; } }
if("speechSynthesis" in window){
  loadVoices();
  if(typeof speechSynthesis.onvoiceschanged !== "undefined"){
    speechSynthesis.onvoiceschanged = loadVoices;
  }
}

function findVoice(locale){
  const norm = v => (v.lang || "").replace("_","-").toLowerCase();
  return voices.find(v => norm(v) === locale.toLowerCase())
      || voices.find(v => norm(v).startsWith(locale.toLowerCase()))
      || voices.find(v => norm(v).startsWith(locale.slice(0,2).toLowerCase()))
      || null;
}

/* iOS unlocks speechSynthesis only after a speak() call made directly
   inside a user gesture — fire a silent utterance once on first tap. */
function unlockSpeech(){
  if(speechUnlocked || !("speechSynthesis" in window)) return;
  try{
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechUnlocked = true;
  }catch(e){}
}

function speak(text, locale){
  if(!("speechSynthesis" in window)){
    setFeedback("Speech isn't supported in this browser — open the file in Safari or Chrome.", "bad");
    return;
  }
  try{
    loadVoices(); // voices arrive async on iOS; refresh right before speaking

    // Cancel any speech already in flight, but never cancel-and-speak in the
    // same tick unless something was actually playing (Safari race bug).
    if(speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    u.rate = 0.8;
    u.volume = 1;
    u.pitch = 1;
    const match = findVoice(locale);
    if(match) u.voice = match;

    const btn = document.getElementById("speakBtn");
    btn.classList.add("speaking");
    u.onend = () => { btn.classList.remove("speaking"); currentUtterance = null; };
    u.onerror = () => {
      btn.classList.remove("speaking");
      currentUtterance = null;
      setFeedback("Speech failed to play — check the ring/silent switch and volume.", "bad");
    };

    currentUtterance = u;          // keep a live reference (GC workaround)
    speechSynthesis.speak(u);

    // Detect silent failure: if nothing is speaking or queued shortly after,
    // the platform likely has no voice installed for this language.
    setTimeout(() => {
      if(currentUtterance === u && !speechSynthesis.speaking && !speechSynthesis.pending){
        btn.classList.remove("speaking");
        const L = langInfo();
        setFeedback("No " + L.name + " voice found on this device — see the ⚙︎ menu for how to add one.", "bad");
      }
    }, 700);
  }catch(e){
    setFeedback("Speech couldn't start on this device.", "bad");
  }
}

/* =====================================================================
   GAME STATE + LOGIC
===================================================================== */
let curLang = "zh";
let curModule = "ess";
let curMode = (P.mode === "pronounce") ? "pronounce" : "listen";
let question = null;      // {word, mode, options[], answerText}
let lastWordKey = null;
let locked = false;

/* Two speaking/listening game modes:
   listen    : hear + read the native script -> pick the English meaning
   pronounce : read the English -> pick the correct written form
               (each option carries its own 🔊 to hear it first)          */
const MODES = [
  {id:"listen",    label:"🎧 Listen"},
  {id:"pronounce", label:"🗣 Say it"}
];

// Tag every word with its module once, so keys are correct no matter which
// module a word was pulled from (distractors can come from anywhere).
LANGS.forEach(L => MODULES.forEach(m => DICT[L.id][m.id].forEach(w => { w._mod = m.id; })));

const keyOf = (w, langId) => (langId || curLang) + "|" + w._mod + "|" + w.native;
const rand = arr => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
const langInfo = () => LANGS.find(l => l.id === curLang);
const isDisliked = (w, langId) => !!P.disliked[keyOf(w, langId)];

// Pools exclude phrases the user hid — but never fall to fewer than what a
// question needs, so a heavily-pruned module still plays.
const rawPool = () => DICT[curLang][curModule];
const rawFullPool = () => MODULES.flatMap(m => DICT[curLang][m.id]);
function pool(){
  const kept = rawPool().filter(w => !isDisliked(w));
  return kept.length >= 4 ? kept : rawPool();
}
function fullPool(){
  const kept = rawFullPool().filter(w => !isDisliked(w));
  return kept.length >= 4 ? kept : rawFullPool();
}

/* Pick the next word the way the spacing research says to:
   1. a word whose review is due — retrieval right around the point of
      forgetting is where the memory gain happens;
   2. otherwise a NEW word, but only while few words are still in
      the learning phase (small sets beat flooding);
   3. otherwise the word whose review comes up soonest (slightly early
      beats idling — and keeps play continuous). */
function chooseWord(){
  const now = Date.now();
  let p = pool().filter(w => keyOf(w) !== lastWordKey);
  if(!p.length) p = pool();
  const st = w => P.srs[keyOf(w)];

  const due = p.filter(w => st(w) && st(w).d <= now);
  if(due.length) return rand(due);

  const unseen = p.filter(w => !st(w));
  const learning = p.filter(w => st(w) && !P.mastered[keyOf(w)]);
  if(unseen.length && learning.length < FOCUS_SIZE) return rand(unseen);

  const seen = p.filter(w => st(w));
  if(seen.length) return seen.sort((a,b) => st(a).d - st(b).d)[0];
  return rand(p);
}

function pickDistractors(word, field, count){
  const seen = new Set([word[field]]);
  const out = [];
  const tryAdd = w => {
    if(!seen.has(w[field])){ seen.add(w[field]); out.push(w); }
  };
  // prefer same module, then anywhere in the language
  shuffle(pool()).forEach(w => { if(out.length < count) tryAdd(w); });
  if(out.length < count) shuffle(fullPool()).forEach(w => { if(out.length < count) tryAdd(w); });
  return out;
}

function newQuestion(){
  locked = false;
  const word = chooseWord();
  const isNew = !P.srs[keyOf(word)];
  lastWordKey = keyOf(word);

  // In "listen" the answer is the English meaning; in "pronounce" it's the
  // written native form, and every option can be heard before choosing.
  const answerField = (curMode === "listen") ? "en" : "native";
  const distractors = pickDistractors(word, answerField, 3);
  const options = shuffle([word, ...distractors]);

  question = {word, mode:curMode, answerField, options, isNew};
  renderQuestion();
}

function renderQuestion(){
  const {word, mode, answerField, options, isNew} = question;
  const L = langInfo();
  const kind = document.getElementById("promptKind");
  const main = document.getElementById("promptMain");
  const sub  = document.getElementById("promptSub");
  const speakBtn = document.getElementById("speakBtn");
  const badge = isNew ? "🆕 New word · " : "";

  main.classList.remove("native");
  if(mode === "listen"){
    // Hear + read the native script; choose what it means.
    kind.textContent = badge + "What does this mean?";
    main.textContent = word.native;
    main.classList.add("native");
    sub.textContent = "Listen, then tap the meaning";
    speakBtn.hidden = false;
  }else{ // pronounce
    // Read the English; pick the correct written form (hear each first).
    kind.textContent = badge + "Say it in " + L.name;
    main.textContent = word.en;
    sub.textContent = "Tap 🔊 to hear each, then choose";
    speakBtn.hidden = true;   // prompt is English — nothing to pronounce yet
  }

  // First encounter is a STUDY trial, not a test: show the memory hint
  // right away (keyword mnemonics work best at first exposure — Atkinson
  // & Raugh 1975). Later encounters hide it so the user retrieves first.
  const mn = document.getElementById("mnemo");
  mn.hidden = !isNew;
  mn.textContent = isNew ? word.mn : "";
  document.getElementById("hintBtn").hidden = isNew;
  document.getElementById("echoLine").hidden = true;
  document.getElementById("dislikeBtn").hidden = false;

  const grid = document.getElementById("answers");
  grid.innerHTML = "";
  const speakable = (answerField === "native");
  options.forEach(opt => {
    const b = document.createElement("button");
    b.className = "ans" + (speakable ? " native-text has-speak" : "");
    b._val = opt[answerField];   // match key (button text may include the 🔊)
    const label = document.createElement("span");
    label.textContent = opt[answerField];
    b.appendChild(label);
    if(speakable){
      const sp = document.createElement("span");
      sp.className = "ans-speak";
      sp.textContent = "🔊";
      sp.setAttribute("role","button");
      sp.setAttribute("aria-label","Hear this option");
      sp.addEventListener("click", e => {
        e.stopPropagation();
        speak(opt.native, L.locale);
      });
      b.appendChild(sp);
    }
    b.addEventListener("click", () => answer(b, opt));
    grid.appendChild(b);
  });

  setFeedback(mode === "listen" ? "Tap the correct meaning below"
                                : "Tap the correct one below", "");

  // Auto-play the prompt audio on listening questions, so the user hears it
  // without tapping Speak every time (once speech is unlocked by a first tap).
  if(mode === "listen" && P.autoplay && speechUnlocked){
    speak(word.native, L.locale);
  }
}

function answer(btn, chosen){
  if(locked) return;
  locked = true;
  const {word, answerField} = question;
  const correct = chosen[answerField] === word[answerField];
  const buttons = [...document.querySelectorAll(".ans")];
  buttons.forEach(b => { b.disabled = true; if(b !== btn) b.classList.add("dim"); });
  const rightBtn = buttons.find(b => b._val === word[answerField]);

  P.answered++;

  // Spaced-repetition bookkeeping: climb a box on success (next review
  // further out), drop back on a miss (retry within a minute).
  const key = lastWordKey;
  const now = Date.now();
  const s = P.srs[key] || {b:0, d:0};

  if(correct){
    btn.classList.add("correct");
    P.streak++;
    if(P.streak > P.bestStreak) P.bestStreak = P.streak;
    const bonus = Math.min(P.streak, 5);
    P.score += 10 + bonus;

    P.correctCounts[key] = (P.correctCounts[key] || 0) + 1;
    s.b = Math.min(s.b + 1, INTERVALS.length - 1);
    s.d = now + INTERVALS[s.b];

    let mastered = false;
    if(s.b >= MASTER_BOX && !P.mastered[key]){
      P.mastered[key] = true;
      mastered = true;
    }
    if(mastered){
      sfxMaster();
      setFeedback("✓ +"+(10+bonus)+" · Word mastered! ★ " + word.native + " — " + word.roman, "good", true);
    }else{
      sfxCorrect();
      setFeedback("✓ +"+(10+bonus)+" · " + word.native + " — " + word.roman + " — " + word.en, "good");
    }
  }else{
    btn.classList.add("wrong","shake");
    btn.classList.remove("dim");
    if(rightBtn){ rightBtn.classList.add("correct"); rightBtn.classList.remove("dim"); }
    P.streak = 0;
    s.b = 0;
    s.d = now + INTERVALS[0];   // back in ~30 s for relearning
    sfxWrong();
    setFeedback("✗ It's " + word.native + " — " + word.roman + " — " + word.en + " · it'll come right back", "bad");
  }
  P.srs[key] = s;

  save();
  updateHeader();
  renderModuleChips();

  // Reveal the memory bridge and give time to read it
  const mn = document.getElementById("mnemo");
  mn.textContent = word.mn;
  mn.hidden = false;
  document.getElementById("hintBtn").hidden = true;

  // Production effect: hearing AND saying a word beats reading it — echo
  // the audio and nudge the user to repeat it out loud.
  const echo = document.getElementById("echoLine");
  echo.textContent = "🗣 Repeat it aloud: " + word.roman;
  echo.hidden = false;
  if(P.autoplay && speechUnlocked) speak(word.native, langInfo().locale);

  setTimeout(newQuestion, correct ? 2600 : 3800);
}

function setFeedback(msg, cls, star){
  const f = document.getElementById("feedback");
  f.className = "feedback" + (cls ? " " + cls : "");
  f.innerHTML = "";
  if(star){
    const s = document.createElement("span");
    s.className = "master"; s.textContent = "★";
    f.appendChild(s);
  }
  f.appendChild(document.createTextNode(msg));
}

/* =====================================================================
   RENDERING — header, tabs, chips
===================================================================== */
function updateHeader(){
  document.getElementById("scoreVal").textContent = P.score;
  document.getElementById("streakVal").textContent = P.streak;
  document.getElementById("streakPill").classList.toggle("hot", P.streak >= 3);
}

function applyAccent(){
  const L = langInfo();
  document.documentElement.style.setProperty("--accent", L.accent);
  // derive a soft translucent version of the accent
  const hex = L.accent.replace("#","");
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  document.documentElement.style.setProperty("--accent-soft", "rgba("+r+","+g+","+b+",.14)");
}

function renderLangTabs(){
  const wrap = document.getElementById("langTabs");
  wrap.innerHTML = "";
  LANGS.forEach(L => {
    const b = document.createElement("button");
    b.className = "lang-tab" + (L.id === curLang ? " active" : "");
    b.innerHTML = '<span class="glyph">'+L.glyph+'</span><span class="name">'+L.name+'</span>';
    b.addEventListener("click", () => {
      if(curLang === L.id) return;
      curLang = L.id;
      applyAccent();
      renderLangTabs();
      renderModuleChips();
      newQuestion();
    });
    wrap.appendChild(b);
  });
}

function renderModeTabs(){
  const wrap = document.getElementById("modeTabs");
  wrap.innerHTML = "";
  MODES.forEach(m => {
    const b = document.createElement("button");
    b.className = "mode-tab" + (m.id === curMode ? " active" : "");
    b.textContent = m.label;
    b.addEventListener("click", () => {
      if(curMode === m.id) return;
      curMode = m.id;
      P.mode = m.id;
      save();
      renderModeTabs();
      newQuestion();
    });
    wrap.appendChild(b);
  });
}

function masteredInModule(langId, modId){
  return DICT[langId][modId].filter(w => P.mastered[langId+"|"+modId+"|"+w.native]).length;
}

function renderModuleChips(){
  const wrap = document.getElementById("moduleChips");
  wrap.innerHTML = "";
  MODULES.forEach(m => {
    const total = DICT[curLang][m.id].length;
    const done = masteredInModule(curLang, m.id);
    const b = document.createElement("button");
    b.className = "mod-chip" + (m.id === curModule ? " active" : "");
    b.innerHTML = m.label + ' <span class="count">'+done+'/'+total+'</span>';
    b.addEventListener("click", () => {
      if(curModule === m.id) return;
      curModule = m.id;
      renderModuleChips();
      newQuestion();
    });
    wrap.appendChild(b);
  });
}

/* =====================================================================
   SETTINGS SHEET + RESET
===================================================================== */
const veil = document.getElementById("sheetVeil");
function openSheet(){
  document.getElementById("stScore").textContent = P.score;
  document.getElementById("stBest").textContent = P.bestStreak;
  document.getElementById("stMastered").textContent = Object.keys(P.mastered).length;
  const now = Date.now();
  document.getElementById("stDue").textContent =
    Object.values(P.srs).filter(s => s.d <= now).length;
  document.getElementById("stAnswered").textContent = P.answered;
  const dislikedCount = Object.keys(P.disliked).length;
  document.getElementById("stDisliked").textContent = dislikedCount;
  document.getElementById("restoreBtn").hidden = dislikedCount === 0;
  veil.classList.add("open");
}
document.getElementById("settingsBtn").addEventListener("click", openSheet);
document.getElementById("closeSheet").addEventListener("click", () => veil.classList.remove("open"));
document.getElementById("restoreBtn").addEventListener("click", () => {
  P.disliked = {};
  save();
  renderModuleChips();
  openSheet();          // refresh the counts + hide the button
  setFeedback("Hidden phrases restored — they're back in rotation.", "");
  newQuestion();
});
veil.addEventListener("click", e => { if(e.target === veil) veil.classList.remove("open"); });
document.getElementById("resetBtn").addEventListener("click", () => {
  if(confirm("Reset all progress? Score, streaks, and mastered words will be cleared.")){
    storage.clear();
    P = DEFAULT_PROGRESS();
    save();
    curMode = P.mode;
    updateHeader();
    renderModeTabs();
    syncAutoBtn();
    renderModuleChips();
    veil.classList.remove("open");
    setFeedback("Progress cleared — fresh start!", "");
    newQuestion();
  }
});

/* =====================================================================
   SPEAK BUTTON + BOOT
===================================================================== */
document.getElementById("speakBtn").addEventListener("click", () => {
  getCtx();                       // unlock Web Audio on first tap (iOS)
  unlockSpeech();                 // unlock speech synthesis on first tap (iOS)
  if(question) speak(question.word.native, langInfo().locale);
});

/* Auto-play toggle — remembers the choice and, when turned on, immediately
   plays the current listening prompt so the change is audible right away. */
function syncAutoBtn(){
  const b = document.getElementById("autoBtn");
  b.setAttribute("aria-pressed", P.autoplay ? "true" : "false");
  b.textContent = P.autoplay ? "🔁 Auto" : "🔇 Auto";
}
document.getElementById("autoBtn").addEventListener("click", () => {
  getCtx(); unlockSpeech();
  P.autoplay = !P.autoplay;
  save();
  syncAutoBtn();
  if(P.autoplay && question && question.mode === "listen"){
    speak(question.word.native, langInfo().locale);
  }
});

/* Dislike — hide a phrase this user won't need, then move on. */
document.getElementById("dislikeBtn").addEventListener("click", () => {
  if(!question) return;
  P.disliked[keyOf(question.word)] = true;
  save();
  renderModuleChips();
  setFeedback("Hidden 👎 — you can restore it in ⚙︎", "");
  locked = true;                  // ignore any pending answer taps
  setTimeout(newQuestion, 500);
});

document.getElementById("hintBtn").addEventListener("click", () => {
  if(!question) return;
  const mn = document.getElementById("mnemo");
  if(mn.hidden){
    mn.textContent = question.word.mn;
    mn.hidden = false;
  }else{
    mn.hidden = true;
  }
});

/* =====================================================================
   OCCASION / REGISTER — when a phrase is appropriate (formal/informal).
   Korean and Japanese encode politeness grammatically, so most entries
   can be classified from their endings; a small override map covers the
   phrases where the register is worth calling out specifically.
===================================================================== */
const OCCASION_OVERRIDES = {
  "zh|你好":"Standard polite greeting — works with anyone; friends often just say 'hāi'.",
  "zh|不好意思":"Casual-polite — the everyday 'excuse me' for getting attention or squeezing past; lighter than 对不起.",
  "zh|对不起":"A genuine apology — stronger than 不好意思; use it when you've actually caused trouble.",
  "zh|买单":"Casual — the normal way to call for the bill in any restaurant.",
  "ko|네":"Polite — the all-purpose yes; safe with everyone.",
  "ja|ありがとう":"Casual-friendly — add ございます (gozaimasu) to make it fully polite for staff and strangers.",
  "ja|さようなら":"Neutral but a little formal and final — friends usually say じゃね (ja ne).",
  "ja|ごめんなさい":"Sincere everyday apology — for bumps and mix-ups; すみません also works.",
  "ja|はい":"Polite — fine in every situation.",
  "ja|いいえ":"Polite — fine in every situation."
};
function occasionFor(langId, w){
  const o = OCCASION_OVERRIDES[langId + "|" + w.native];
  if(o) return o;
  if(langId === "ko"){
    if(/니다[?？!！.]?\s*$/.test(w.native) || w.native.includes("습니다"))
      return "Formal-polite (-hamnida) — the safest register: staff, elders, strangers.";
    if(/요[?？!！.]?\s*$/.test(w.native))
      return "Polite everyday (-yo) — the standard traveler register, fine with everyone.";
    return "Neutral — fine in any situation.";
  }
  if(langId === "ja"){
    if(/(です|ます|ません|ました|ください)/.test(w.native))
      return "Polite (desu/masu) — appropriate with anyone, from shopkeepers to officials.";
    return "Neutral — fine in most travel situations.";
  }
  return "Neutral — Mandarin doesn't conjugate for politeness; fine with anyone.";
}

/* =====================================================================
   BROWSE / SEARCH — look up any phrase, filter by language, hear entries
   back-to-back, and tap a row for the full detail view.
===================================================================== */
const browseVeil = document.getElementById("browseVeil");
const browseInput = document.getElementById("browseInput");
const browseResults = document.getElementById("browseResults");
let browseLang = "all";

function allEntries(){
  const out = [];
  LANGS.forEach(L => MODULES.forEach(m => {
    (DICT[L.id][m.id] || []).forEach(w => out.push({L, w}));
  }));
  return out;
}
function renderBrowseFilters(){
  const wrap = document.getElementById("browseFilters");
  wrap.innerHTML = "";
  [{id:"all", label:"All"}, ...LANGS.map(L => ({id:L.id, label:L.glyph + " " + L.name}))].forEach(f => {
    const b = document.createElement("button");
    b.className = "b-filter" + (browseLang === f.id ? " active" : "");
    b.textContent = f.label;
    b.addEventListener("click", () => {
      browseLang = f.id;
      renderBrowseFilters();
      renderBrowse(browseInput.value);
    });
    wrap.appendChild(b);
  });
}
function renderBrowse(query){
  const q = (query || "").trim().toLowerCase();
  browseResults.innerHTML = "";
  let entries = allEntries();
  if(browseLang !== "all") entries = entries.filter(({L}) => L.id === browseLang);
  if(q){
    entries = entries.filter(({w}) =>
      w.en.toLowerCase().includes(q) ||
      w.native.toLowerCase().includes(q) ||
      w.roman.toLowerCase().includes(q));
  }
  if(!entries.length){
    const e = document.createElement("div");
    e.className = "browse-empty";
    e.textContent = "No matches — try another word.";
    browseResults.appendChild(e);
    return;
  }
  entries.slice(0, 100).forEach(({L, w}) => {
    const row = document.createElement("div");
    row.className = "browse-row";
    row.innerHTML =
      '<div class="b-glyph">'+L.glyph+'</div>'+
      '<div class="b-text"><div class="b-native"></div>'+
      '<div class="b-sub"><span class="b-en"></span> · <span class="b-roman"></span></div></div>';
    row.querySelector(".b-native").textContent = w.native;
    row.querySelector(".b-en").textContent = w.en;
    row.querySelector(".b-roman").textContent = w.roman;
    row.addEventListener("click", () => openDetail(L, w));
    const sp = document.createElement("button");
    sp.className = "b-speak";
    sp.textContent = "🔊";
    sp.setAttribute("aria-label", "Hear " + w.en + " in " + L.name);
    sp.addEventListener("click", e => { e.stopPropagation(); getCtx(); unlockSpeech(); speak(w.native, L.locale); });
    row.appendChild(sp);
    browseResults.appendChild(row);
  });
}
function openBrowse(){
  getCtx(); unlockSpeech();
  browseInput.value = "";
  renderBrowseFilters();
  renderBrowse("");
  browseVeil.classList.add("open");
}
document.getElementById("browseBtn").addEventListener("click", openBrowse);
document.getElementById("closeBrowse").addEventListener("click", () => browseVeil.classList.remove("open"));
browseVeil.addEventListener("click", e => { if(e.target === browseVeil) browseVeil.classList.remove("open"); });
browseInput.addEventListener("input", () => renderBrowse(browseInput.value));

/* =====================================================================
   WORD DETAIL VIEW — hint, pronunciation, occasion, progress, actions.
   Opens on top of Browse; Back returns to the list.
===================================================================== */
const detailVeil = document.getElementById("detailVeil");
let detailEntry = null;   // {L, w}

function humanizeDelta(ms){
  if(ms <= 0) return "due now";
  const min = Math.round(ms / 60e3);
  if(min < 60) return "in " + Math.max(1, min) + " min";
  const h = Math.round(min / 60);
  if(h < 48) return "in " + h + " h";
  return "in " + Math.round(h / 24) + " days";
}
function renderDetail(){
  const {L, w} = detailEntry;
  const key = keyOf(w, L.id);
  document.getElementById("dNative").textContent = w.native;
  document.getElementById("dRoman").textContent = w.roman + " · " + L.romanLabel;
  document.getElementById("dEn").textContent = w.en + " — " + L.name;
  document.getElementById("dHint").textContent = w.mn;
  document.getElementById("dOccasion").textContent = occasionFor(L.id, w);

  const s = P.srs[key];
  let prog;
  if(P.mastered[key])      prog = "★ Mastered — maintenance review " + humanizeDelta(s ? s.d - Date.now() : 0) + ".";
  else if(s)               prog = "Learning — stage " + s.b + " of " + MASTER_BOX + ", next review " + humanizeDelta(s.d - Date.now()) + ".";
  else                     prog = "Not seen yet — it'll show up in the game.";
  document.getElementById("dProgress").textContent = prog;

  const hideBtn = document.getElementById("dHide");
  hideBtn.textContent = P.disliked[key] ? "↩︎ Restore" : "👎 Hide";
}
function openDetail(L, w){
  detailEntry = {L, w};
  renderDetail();
  detailVeil.classList.add("open");
}
document.getElementById("dSpeak").addEventListener("click", () => {
  if(!detailEntry) return;
  getCtx(); unlockSpeech();
  speak(detailEntry.w.native, detailEntry.L.locale);
});
document.getElementById("dHide").addEventListener("click", () => {
  if(!detailEntry) return;
  const key = keyOf(detailEntry.w, detailEntry.L.id);
  if(P.disliked[key]) delete P.disliked[key];
  else P.disliked[key] = true;
  save();
  renderModuleChips();
  renderDetail();
});
document.getElementById("closeDetail").addEventListener("click", () => detailVeil.classList.remove("open"));
detailVeil.addEventListener("click", e => { if(e.target === detailVeil) detailVeil.classList.remove("open"); });

// Any first touch anywhere also unlocks both audio systems, so the very
// first Speak tap plays immediately instead of only unlocking.
document.body.addEventListener("touchstart", () => { getCtx(); unlockSpeech(); }, {once:true, passive:true});
document.body.addEventListener("mousedown",  () => { getCtx(); unlockSpeech(); }, {once:true});

// Version lives only in APP_VERSION — the settings sheet reads it from there.
document.getElementById("appVersion").textContent = "Layover v" + APP_VERSION;

applyAccent();
renderLangTabs();
renderModeTabs();
syncAutoBtn();
renderModuleChips();
updateHeader();
newQuestion();

/* =====================================================================
   PWA — register the service worker for full offline support.
   Only possible over http(s); silently skipped if opened as a raw file,
   so this same index.html still works standalone.
===================================================================== */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  // If this page is already controlled by a service worker, a controller
  // change means a NEW version just activated — reload once to show it.
  // (Skipped on the very first install, where there's no prior controller,
  // so we never reload the page the user just opened.)
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Proactively check for a fresh sw.js each launch and whenever the
      // app returns to the foreground (how iOS standalone PWAs resume).
      reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
