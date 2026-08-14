# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-08-14

Maintenance release. No change to how the app plays; everything here is about
making it maintainable and safe to deploy.

### Added

- `APP_VERSION` in `js/app.js`, surfaced in the settings sheet, so the build a
  device is running is visible without guessing.
- Continuous integration on GitHub Actions: every push and pull request runs a
  dependency-free smoke test (`node tests/smoke.mjs`).
- Project documentation: a real README with screenshots, an architecture map,
  the research behind the scheduler, this changelog, an MIT `LICENSE`, and
  `.gitignore`.

### Changed

- Split the single-file app into a modular layout — `index.html` for markup,
  `css/styles.css` for the stylesheet, `js/data.js` for phrase content, and
  `js/app.js` for behaviour. Still zero build, zero dependencies.
- Service worker precaches the new asset paths; `CACHE_VERSION` bumped to
  `layover-v4` so installed phones pick the split files up cleanly.

## [1.2.0] — 2026-07-12

### Added

- **Spaced-repetition engine.** Every phrase now sits in a Leitner-style box
  with seven expanding review intervals (30s → 1m → 5m → 30m → 4h → 3d → 7d).
  A correct answer promotes it and pushes the next review out; a miss drops it
  to box 0 and returns it in about thirty seconds. Question selection prefers
  due phrases, introduces new ones only while fewer than six are in the
  learning phase, and otherwise serves whichever comes up soonest.
- Mastery redefined as recall across four widening gaps rather than four
  correct answers, with a distinct mastery chime and a ★ marker.
- **Word detail view**, reachable by tapping any browse row: pronunciation with
  the correct label per language (Pinyin / Romanization / Romaji), the memory
  hint, a formality-register note derived from Korean and Japanese politeness
  endings with hand-written overrides where the nuance matters, and per-phrase
  review state including the next review time.
- Hide and restore a phrase directly from the detail view.
- Language filter in Browse & compare — all three, or one at a time.
- Progress sheet now reports words mastered and how many are due right now.
- Migration for pre-SRS saves, so existing progress keeps its standing.

### Fixed

- Hidden (👎) phrases were only excluded within the module they were hidden
  from; phrases are now keyed by language, module, and native form, so hiding
  holds everywhere a phrase can appear — including as a distractor.

## [1.1.1] — 2026-07-07

### Fixed

- Installed PWAs never picked up new deploys. HTML is now served
  **network-first** — fresh page when online, cached fallback when offline —
  and the app checks for a new service worker at launch and each time it
  returns to the foreground, reloading once when one takes control.

## [1.1.0] — 2026-07-07

Refocused the app on the two things a traveller actually needs: hearing a
phrase and saying it.

### Added

- **🗣 Say it** mode — read the English, pick the correct written form, with a
  🔊 on every option so candidates can be heard before choosing.
- Auto-play toggle that speaks each new listening prompt, remembered between
  sessions.
- Production-effect echo: after every answer the phrase is replayed with a
  "repeat it aloud" prompt.
- 👎 to hide a phrase, with counts and one-tap restore in the settings sheet.
- **Browse & compare** — search every phrase across all three languages by
  English, native script, or romanization, and hear results back to back.

### Changed

- Reduced four quiz modes to two: **🎧 Listen** and **🗣 Say it**.
- The Speak button now says only the native phrase; the romanization no longer
  rides along, so what you hear is what you'd say.
- Speech rate lowered to 0.8 for mimicry, with per-language voice matching and
  iOS unlock, GC, and silent-failure handling.

### Removed

- The reading-only and typing quiz modes from 1.0.0.

## [1.0.0] — 2026-07-06

Initial release.

### Added

- Survival-phrase trainer for Chinese, Korean, and Japanese — roughly 70
  phrases per language across four modules: Essentials, Direction & Transit,
  Food & Dining, Numbers & Emergency.
- Four multiple-choice quiz modes, score with streak bonus, best-streak
  tracking, and synthesized Web Audio feedback tones.
- Keyword mnemonic for every phrase.
- Speech synthesis via the Web Speech API with per-language locales.
- Progress saved to `localStorage`, with an in-memory fallback when storage is
  unavailable, and a reset control.
- Installable offline PWA: service worker precaching, manifest, icons,
  standalone portrait display, iOS home-screen support.

[1.3.0]: https://github.com/daniels98it/layOver/releases/tag/v1.3.0
[1.2.0]: https://github.com/daniels98it/layOver/releases/tag/v1.2.0
[1.1.1]: https://github.com/daniels98it/layOver/releases/tag/v1.1.1
[1.1.0]: https://github.com/daniels98it/layOver/releases/tag/v1.1.0
[1.0.0]: https://github.com/daniels98it/layOver/releases/tag/v1.0.0
