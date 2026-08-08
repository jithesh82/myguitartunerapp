# Plan: Keep Screen Awake + Stable Pitch Detection

**Status:** Approved (2026-08-07)  
**Delivery rule:** **Phase-by-phase** — implement one phase, stop for review, then continue only when the user says go.  
**Reference copy:** save to project as `docs/IMPROVEMENT_PLAN.md` for future reference.

## Progress

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Keep screen awake | **done** (device-verified) |
| 2 | Audio capture hardening | **done** (device-verified) |
| 3 | Shared stability layer | **done** (device-verified) |
| 3.1 | Hard octave fold | **reverted** (unsafe while tightening) |
| 4 | YIN + Classic toggle | done (code; await device test) |
| 5 | Polish, build, verify | pending |

Progress tracker: [`docs/WORK_SO_FAR.md`](./WORK_SO_FAR.md)

## Context

The app is a Capacitor 8 + Vite guitar tuner. Core logic lives in `main.js` (naive autocorrelation), UI in `index.html` / `style.css`, Android shell with `RECORD_AUDIO` already declared.

Two goals:
1. **Screen stay awake** while the app is actively used in the foreground (especially while tuning).
2. **Reduce needle flicker**, worst on low E (~82 Hz), by fixing capture/algorithm/post-processing — optionally with a toggle between old and new detector.

---

## Diagnosis: why the needle flickers (especially low E)

This is mostly **algorithm + signal processing**, not only “mic noise.” Commercial tuners feel stable because they combine a better detector **and** heavy post-smoothing.

### Bugs / weaknesses in current `autoCorrelate`

| Issue | What the code does | Effect |
|--------|-------------------|--------|
| **Weak fundamental peak picking** | After skipping the initial ACF drop, takes the **global max** lag | Guitar harmonics often win → octave jumps (e.g. ~165 Hz instead of ~82 Hz on low E) → needle thrash |
| **No frequency band limits** | Lags searched across almost the whole buffer | Noise peaks outside guitar range accepted |
| **Short analysis window** | `buflen = 2048` (~43 ms @ 48 kHz) | Low E period ≈ 12 ms → only ~3–4 periods; ACF unstable / noisy |
| **No temporal smoothing** | Every `requestAnimationFrame` writes raw pitch → cents → needle | Frame-to-frame jitter shows as flicker |
| **`Math.floor` on cents** | Integer quantize each frame | Extra ±1 cent flicker |
| **Weak silence gate only** | RMS &lt; 0.01 reject; otherwise always update UI | Low-confidence junk still moves needle |
| **No continuity / octave lock** | No history | Instant jumps between octaves or unrelated notes |
| **Mic processing defaults** | `getUserMedia({ audio: true })` | Android often enables AGC / noise suppression / echo cancel → warbles pitch |
| **Odd edge trim** | Fixed `thres = 0.2` slice of buffer | Can shorten/corrupt frames depending on waveform phase |
| **Heavy O(N²) ACF** | Full double loop every frame | Fine at 2048 on most phones; worse if we grow buffer without optimizing |

Low E is hardest because: long period, strong overtones, poorer SNR on phone mics, and short windows give coarse lag resolution (`Δf ≈ f²/sr` per sample error grows at low f without interpolation + averaging).

### Research takeaway (algorithms)

| Algorithm | Pros | Cons | Fit |
|-----------|------|------|-----|
| **Current naive ACF** | Simple | Octave errors, noise | Keep as “Classic” for A/B |
| **YIN** (de Cheveigné & Kawahara) | Strong on speech/music; CMNDF reduces octave errors; well documented | Slightly more code; needs good threshold | Excellent default |
| **MPM / McLeod (NSDF)** | Built for instruments; good peak picking; often praised for guitar | Similar cost to YIN | Strong alternative |
| **FFT / HPS alone** | Fast | Needs large windows for low-E resolution; harmonic errors | Not primary choice |

**Recommendation:** implement **YIN** as the new default detector (clear, efficient, widely used in tuners), keep current ACF as **Classic**, and put a **shared stability pipeline** in front of the UI so *both* modes benefit. If YIN still struggles on your guitar/mic after tuning, MPM is a small swap later.

Stability tricks commercial apps use (we should copy these regardless of detector):
- Constrain pitch search to ~**70–500 Hz** for open-string standard tuning (or ~70–1200 Hz if fretted notes matter)
- Larger buffer for low notes (**4096** samples, or dual-size)
- **Confidence** gate (YIN threshold / NSDF clarity)
- **Median** of last N pitches + **exponential smooth** on displayed Hz/cents
- **Hold last good** reading when confidence drops briefly
- Reject **octave jumps** vs recent stable pitch
- Disable mic DSP: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`
- Slightly longer CSS transition on the needle (already 0.1s; can tune)

---

## Plan of actions (for your review)

### Phase 1 — Keep screen awake (small, independent)

**Approach:** `@capacitor-community/keep-awake` (official community plugin: `keepAwake()` / `allowSleep()`).

**Behavior:**
- Call `KeepAwake.keepAwake()` when **Start Tuning** succeeds.
- Call `KeepAwake.allowSleep()` when **Stop Tuning**, and on page hide / app pause if easy (so we never leave the screen forced on).
- Optional fallback: browser `navigator.wakeLock` for desktop/web preview (nice-to-have, not required for Android APK).

**Steps:**
1. `npm install @capacitor-community/keep-awake`
2. Wire keep-awake into `startTuning` / `stopTuning` in `main.js`
3. `npx cap sync android`

**Files:** `package.json`, `main.js`, Android sync artifacts.

**Risk:** low. No UI change required.

---

### Phase 2 — Audio capture hardening (helps any algorithm)

In `getUserMedia`, request:

```js
{
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // channelCount: 1 if supported
  }
}
```

Optionally log actual `sampleRate` once (helps verify buffer math).

**Risk:** low. Some devices ignore constraints; still best-effort.

---

### Phase 3 — Shared stability layer (biggest UX win)

Introduce a small `PitchStabilizer` (same file or `pitch.js`) that sits between detector and UI:

1. **Accept** only estimates with confidence above threshold and in allowed Hz range.
2. **Median filter** over last ~5–9 accepted pitches (kills spikes).
3. **Exponential smoothing** on frequency (e.g. `smoothed += α * (raw - smoothed)`, α higher when close to previous).
4. **Hold** last good pitch for ~150–300 ms when detector returns “no pitch” so needle doesn’t reset every gap.
5. **Octave correction:** if new pitch ≈ 2× or ½× recent stable pitch, prefer the one near the recent note (or near nearest open-string frequency if we add string bias later).
6. Drive needle/cents from **smoothed** frequency; use `Math.round` or 1-decimal cents instead of floor-only jitter.

UI still updates on animation frames, but values change smoothly.

**Risk:** medium-low. Over-smoothing can feel laggy; tune α and median length on device.

---

### Phase 4 — New detector: YIN + Classic toggle

**Refactor structure:**

```
main.js
  - audio I/O, UI, keep-awake, stabilizer
  - detectPitch(buffer, sampleRate) → { frequency, confidence } | null

// either inline modules or separate files:
pitch-classic.js  // current autoCorrelate (cleaned slightly)
pitch-yin.js      // YIN implementation
```

**YIN implementation outline:**
1. Difference function `d(τ)` for τ in [τ_min, τ_max] for guitar band.
2. Cumulative mean normalized difference `d'(τ)`.
3. Absolute threshold (start ~0.1–0.15); first valley below threshold.
4. Parabolic interpolation around best τ.
5. Return `sampleRate / τ` + confidence `1 - d'(τ)`.

**Buffer size:** raise analyser / time-domain buffer to **4096** (better low-E), keep guitar lag window so work stays O(N × lagMax) not full N².

**UI toggle (as you requested):**
- Small control: **Detector: Enhanced (YIN) | Classic**
- Default: **Enhanced**
- Preference in `localStorage` so choice sticks across sessions
- Optional subtle label of active mode near frequency readout

**Why toggle first:** lets you A/B on the same phone/guitar against your commercial app without a rebuild.

**Risk:** medium. YIN needs threshold tuning; wrong τ_max/τ_min can miss notes.

---

### Phase 5 — Polish, build, verify

1. Needle CSS: slightly longer ease if still twitchy after stabilizer.
2. Ensure stop path clears stabilizer state + allows sleep.
3. `npm run build && npx cap sync android`
4. Manual test matrix on device:
   - All 6 open strings, especially low E and A
   - Quiet room vs light ambient noise
   - Start/stop keep-awake (screen should stay on while tuning, sleep normally after)
   - Toggle Classic vs Enhanced and compare flicker
5. Commit when you are happy.

---

## Out of scope (unless you want them later)

- Chromatic vs “string select” mode (locking to E2/A2/D3/G3/B3/E4 further stabilizes commercial apps)
- Calibration (A4 = 440 vs 432)
- Visual spectrum / confidence meter
- Full MPM swap (easy follow-up if YIN is not enough)
- iOS project (Android-only today)

---

## Implementation order (phase-by-phase — stop after each)

```
Phase 1. Keep-awake plugin + start/stop wiring     → STOP for user test
Phase 2. getUserMedia constraints                  → STOP
Phase 3. Stability pipeline + UI wired to it       → STOP
Phase 4. Extract Classic detector; add YIN + toggle → STOP
Phase 5. Buffer 4096 + polish + build/sync/verify  → STOP / commit
```

Do **not** start the next phase until the user confirms the previous one.

---

## Files expected to change

| File | Change |
|------|--------|
| `package.json` / lock | add `@capacitor-community/keep-awake` |
| `main.js` | keep-awake, constraints, stabilizer, detector dispatch, toggle |
| `index.html` | detector toggle control |
| `style.css` | toggle styling; optional needle transition tweak |
| Optional `pitch-yin.js` / `pitch-classic.js` | split for clarity |
| Android | via `npx cap sync` after plugin install |

---

## Success criteria

1. Screen does **not** dim/sleep while tuning in foreground; resumes normal timeout after stop.
2. Low E needle is **visibly steadier** than today (no constant thrashing between notes/octaves).
3. High E and mid strings remain accurate and responsive.
4. User can switch **Enhanced ↔ Classic** and compare.
5. No new crashes; mic permission path unchanged.

---

## Decisions (approved)

**Default detector:** Enhanced (YIN).  
**Toggle:** yes (Classic ↔ Enhanced).  
**String-lock mode:** not in this pass (optional Phase 6 later).  
**Delivery:** one phase at a time; stop after each for user review.

---

## Phase 1 checklist (current)

- [x] Install `@capacitor-community/keep-awake`
- [x] Import and call `keepAwake()` on successful Start Tuning
- [x] Call `allowSleep()` on Stop Tuning (and page hide if easy)
- [x] `npx cap sync android`
- [x] Save this plan to `docs/IMPROVEMENT_PLAN.md`
- [ ] Stop — user tests screen-on while tuning
