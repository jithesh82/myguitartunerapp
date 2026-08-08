# Work so far — Guitar Tuner improvements

Living changelog of what we planned, built, and verified.  
Full plan: [`docs/IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md)

---

## Status overview

| Phase | Description | Status | Verified on device |
|-------|-------------|--------|--------------------|
| 1 | Keep screen awake while tuning | **Done** | Yes — does not dim while tuning |
| 2 | Audio capture hardening (mic DSP off) | **Done** | Yes — mic works with raw constraints |
| 3 | Shared pitch stability layer | **Done** | Yes — low E much smoother; residual E2→E3 octave slips |
| 4 | YIN detector + Classic toggle | Pending | — |
| 5 | Polish, build, verify, commit | Pending | — |

---

## Baseline (before this work)

- Capacitor 8 + Vite hybrid Android app (`com.myguitartuner.app`)
- Pitch detection: naive autocorrelation in `main.js` (buffer 2048)
- UI: note, cents, needle dial, start/stop
- Git remote: `git@github.com:jithesh82/myguitartunerapp.git`
- Initial commit on `master` with `.gitignore` (no `node_modules` / `dist` / build junk)

### Known issues (still open until later phases)

- Needle flicker, especially **low E** (~82 Hz)
- Octave / harmonic jumps from peak-picking ACF
- No smoothing / confidence / hold-last-good
- Mic AGC / noise suppression can warp pitch (Phase 2 target)

---

## Phase 1 — Keep screen awake ✅

**Goal:** Screen stays on while the app is tuning in the foreground.

### What we did

| Item | Detail |
|------|--------|
| Plugin | `@capacitor-community/keep-awake@8.0.1` |
| On Start Tuning | `KeepAwake.keepAwake()` |
| On Stop Tuning | `KeepAwake.allowSleep()` |
| Background / hide | `visibilitychange` → allow sleep when hidden; re-keep awake if still tuning when visible again |
| Android | `npx cap sync android` — plugin registered as `:capacitor-community-keep-awake` |

### Files touched

- `main.js` — import + keep-awake helpers + start/stop/visibility wiring
- `package.json` / `package-lock.json`
- Android sync artifacts under `android/`
- `android/gradle.properties` — **JDK fix** (see below)
- `docs/IMPROVEMENT_PLAN.md` — full plan copy

### Build fix (unblocked Android Studio)

| Problem | Cause | Fix |
|---------|--------|-----|
| `Unsupported class file major version 69` | System default **Java 25**; Gradle 8.14 / AGP 8.13 cannot run on it | `org.gradle.java.home=/usr/lib/jvm/java-21-openjdk-amd64` in `android/gradle.properties` |

CLI check: `./gradlew projects` → **BUILD SUCCESSFUL** (Java 21).  
If Studio still fails: **Settings → Gradle → Gradle JDK → 21**.

### Device result

- **Pass:** Screen does **not** dim while tuning.

---

## Phase 2 — Audio capture hardening ✅ (code)

**Goal:** Cleaner raw mic signal for any pitch algorithm (less AGC / NS warble).

### What we did

| Item | Detail |
|------|--------|
| Preferred constraints | `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `channelCount: 1` |
| Fallback | If device rejects constraints → `getUserMedia({ audio: true })` so mic still works |
| Debug logs | Once on start: track settings + `AudioContext.sampleRate` (logcat / remote console) |

### Files touched

- `main.js` — `openMicrophoneStream()`, `logMicTrackSettings()`, wired into `startTuning`
- Built + `npx cap sync android`

### How to test

1. Rebuild/run app on phone.
2. Start Tuning — mic should still work (permission same as before).
3. Optional: check logcat for `Mic track settings` / `AudioContext sampleRate`.
4. Quick pluck of a few strings — should still detect notes (no regression).  
   Flicker fix is **not** expected yet (Phase 3–4).

### Device result

- **Pass:** Mic works; Start Tuning fine with preferred constraints / fallback.

---

## Phase 3 — Stability layer ✅ (code)

**Goal:** Steadier needle/cents between raw detector and UI (especially low E spikes).

### What we did

| Feature | Detail |
|---------|--------|
| Band limit | Accept only ~70–1200 Hz |
| Octave correction | Prefer half/double near last good pitch |
| Median window | Last 7 accepted samples |
| Exp. smooth | α ≈ 0.28 (faster if jump &gt; 40 cents) |
| Hold last good | ~250 ms when detector drops out |
| Cents display | `Math.round` instead of `floor` |
| Reset | Stabilizer cleared on Stop Tuning |
| Needle CSS | Transition 0.10s → 0.18s |

### Files touched

- `main.js` — `createPitchStabilizer()`, `renderPitch()`, wired into `updatePitch` / `stopTuning`
- `style.css` — slightly longer needle ease

### How to test

1. Rebuild/run app.
2. Focus on **low E** and **A** — needle should thrash less than before.
3. Mid/high strings still responsive.
4. Stop Tuning clears display; restart is clean.

Note: residual flicker may remain until **Phase 4 (YIN)**; this phase only post-processes the classic detector.

### Device result

- **Pass (mostly):** Low E flicker much improved.
- **Follow-up:** Sometimes settled on **E3** instead of **E2** (octave/harmonic lock from classic ACF). Octave fold refined (see Phase 3.1).

---

## Phase 3.1 — Octave fold tweak ✅ (code)

**Goal:** Stop low open strings locking one octave high (E2→E3, etc.).

| Change | Detail |
|--------|--------|
| Fold 2× / 4× low opens | If reading ≈ 2× or 4× of E2/A2/D3 open, map down to fundamental |
| Trust drop | If new sample ≈ lastGood/2, accept lower (escape stuck E3) |
| Reject climb | If new sample ≈ lastGood×2, keep lastGood |
| Mild lower bias | When choosing among octaves, prefer not climbing |

### Device result

- Pending re-test after rebuild.

---

## Phase 4 — YIN + Classic toggle (upcoming)

New YIN detector as default; keep classic ACF; UI toggle + `localStorage`.

---

## Phase 5 — Polish & ship (upcoming)

Buffer 4096, needle polish, full string matrix test, commit when ready.

---

## How we work

- **One phase at a time** — implement → stop → user tests → next phase only when approved.
- Plan reference: `docs/IMPROVEMENT_PLAN.md`
- This file: update after each completed phase.

---

## Changelog

| Date | Note |
|------|------|
| 2026-08-07 | Initial commit to GitHub; plan written; Phase 1 implemented |
| 2026-08-07 | Gradle Java 25 → 21 fix |
| 2026-08-08 | Phase 1 device-verified (no dim while tuning); this tracker created |
| 2026-08-08 | Phase 2 implemented (raw mic constraints + fallback + logs); build/sync done |
| 2026-08-08 | Phase 2 device-verified; Phase 3 implemented; push Phases 2–3 + docs |
| 2026-08-08 | Phase 3 verified (low E smoother); E2→E3 residual; Phase 3.1 octave fold |
