import { KeepAwake } from '@capacitor-community/keep-awake';

const A4 = 440;
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Guitar-ish band for open + fretted notes (Hz). Outside = reject as noise.
const MIN_FREQ_HZ = 70;
const MAX_FREQ_HZ = 1200;

// Larger window helps low E (~82 Hz needs several periods).
const buflen = 4096;
const buf = new Float32Array(buflen);

const DETECTOR_STORAGE_KEY = 'guitar-tuner-detector';
/** @type {'yin' | 'classic'} */
let detectorMode = loadDetectorMode();

let audioContext = null;
let analyser = null;
let mediaStreamSource = null;
let isTuning = false;
let animationId = null;

/** Shared stability pipeline (no hard E3→E2 fold — safe while tightening). */
const pitchStabilizer = createPitchStabilizer();

const startBtn = document.getElementById('start-btn');
const noteDisplay = document.getElementById('note-display');
const centsDisplay = document.getElementById('cents-display');
const frequencyDisplay = document.getElementById('frequency-display');
const needle = document.getElementById('needle');
const detectorYinBtn = document.getElementById('detector-yin');
const detectorClassicBtn = document.getElementById('detector-classic');
const detectorLabel = document.getElementById('detector-label');

startBtn.addEventListener('click', toggleTuning);
setupDetectorToggle();

// Release keep-awake if the page is hidden while tuning (app backgrounded / tab switch).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isTuning) {
    allowScreenSleep();
  } else if (!document.hidden && isTuning) {
    keepScreenAwake();
  }
});

async function keepScreenAwake() {
  try {
    await KeepAwake.keepAwake();
  } catch (err) {
    console.warn('KeepAwake.keepAwake failed:', err);
  }
}

async function allowScreenSleep() {
  try {
    await KeepAwake.allowSleep();
  } catch (err) {
    console.warn('KeepAwake.allowSleep failed:', err);
  }
}

async function toggleTuning() {
  if (isTuning) {
    await stopTuning();
  } else {
    await startTuning();
  }
}

/**
 * Prefer a "raw" mic path: disable DSP that warps pitch for tuners.
 * Falls back to default audio if the device rejects advanced constraints.
 */
async function openMicrophoneStream() {
  const preferred = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };

  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    console.warn('Preferred mic constraints rejected, falling back to default audio:', err);
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

function logMicTrackSettings(stream) {
  try {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const settings = track.getSettings ? track.getSettings() : {};
    console.log('Mic track settings:', {
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      label: track.label,
    });
  } catch (err) {
    console.warn('Could not read mic track settings:', err);
  }
}

async function startTuning() {
  try {
    const stream = await openMicrophoneStream();
    logMicTrackSettings(stream);

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = buflen;
    analyser.smoothingTimeConstant = 0;

    console.log('AudioContext sampleRate:', audioContext.sampleRate);

    mediaStreamSource = audioContext.createMediaStreamSource(stream);
    mediaStreamSource.connect(analyser);

    isTuning = true;
    startBtn.textContent = "Stop Tuning";
    startBtn.classList.add('active');
    pitchStabilizer.reset();

    await keepScreenAwake();

    updatePitch();
  } catch (err) {
    alert("Microphone access is required to use the tuner.");
    console.error(err);
  }
}

async function stopTuning() {
  isTuning = false;
  startBtn.textContent = "Start Tuning";
  startBtn.classList.remove('active');

  await allowScreenSleep();
  pitchStabilizer.reset();

  if (mediaStreamSource) {
    mediaStreamSource.mediaStream.getTracks().forEach(track => track.stop());
    mediaStreamSource.disconnect();
  }
  if (audioContext) {
    audioContext.close();
  }
  if (animationId) {
    cancelAnimationFrame(animationId);
  }

  clearTunerDisplay();
}

function clearTunerDisplay() {
  noteDisplay.textContent = "--";
  centsDisplay.textContent = "0 cents";
  frequencyDisplay.textContent = "0.0 Hz";
  needle.style.transform = `translateX(-50%) rotate(0deg)`;
  noteDisplay.className = "note-display";
  needle.className = "needle";
}

function updatePitch() {
  if (!isTuning) return;

  analyser.getFloatTimeDomainData(buf);
  const raw = detectPitch(buf, audioContext.sampleRate);
  const stable = pitchStabilizer.update(raw, performance.now());

  if (stable != null) {
    renderPitch(stable);
  }

  animationId = requestAnimationFrame(updatePitch);
}

function loadDetectorMode() {
  try {
    const saved = localStorage.getItem(DETECTOR_STORAGE_KEY);
    if (saved === 'classic' || saved === 'yin') return saved;
  } catch (_) { /* ignore */ }
  return 'yin';
}

function setupDetectorToggle() {
  if (!detectorYinBtn || !detectorClassicBtn) return;

  const applyUi = () => {
    detectorYinBtn.classList.toggle('active', detectorMode === 'yin');
    detectorClassicBtn.classList.toggle('active', detectorMode === 'classic');
    if (detectorLabel) {
      detectorLabel.textContent = detectorMode === 'yin' ? 'Enhanced (YIN)' : 'Classic (ACF)';
    }
  };

  const setMode = (mode) => {
    if (mode !== 'yin' && mode !== 'classic') return;
    detectorMode = mode;
    try {
      localStorage.setItem(DETECTOR_STORAGE_KEY, mode);
    } catch (_) { /* ignore */ }
    pitchStabilizer.reset();
    applyUi();
  };

  detectorYinBtn.addEventListener('click', () => setMode('yin'));
  detectorClassicBtn.addEventListener('click', () => setMode('classic'));
  applyUi();
}

/** @returns {number|null} Hz or null if no pitch */
function detectPitch(timeBuf, sampleRate) {
  if (detectorMode === 'classic') {
    const hz = autoCorrelate(timeBuf, sampleRate);
    return hz === -1 ? null : hz;
  }
  return detectPitchYin(timeBuf, sampleRate);
}

function renderPitch(pitch) {
  const note = noteFromPitch(pitch);
  const cents = centsOffFromPitch(pitch, note);
  const noteName = noteNames[note % 12];
  const octave = Math.floor(note / 12) - 1;

  frequencyDisplay.textContent = pitch.toFixed(1) + " Hz";
  noteDisplay.textContent = noteName + octave;
  centsDisplay.textContent = (cents > 0 ? "+" : "") + cents + " cents";

  let degrees = (cents / 50) * 45;
  if (degrees > 45) degrees = 45;
  if (degrees < -45) degrees = -45;
  needle.style.transform = `translateX(-50%) rotate(${degrees}deg)`;

  if (Math.abs(cents) < 5) {
    noteDisplay.className = "note-display perfect";
    needle.className = "needle perfect";
  } else if (cents < 0) {
    noteDisplay.className = "note-display flat";
    needle.className = "needle flat";
  } else {
    noteDisplay.className = "note-display sharp";
    needle.className = "needle sharp";
  }
}

/**
 * Temporal filter between raw detector and UI.
 * Does NOT hard-fold E3→E2 or reject gradual climbs: while you tighten,
 * displayed Hz must track the real string (safety). Soft continuity only.
 */
function createPitchStabilizer(options = {}) {
  const medianWindow = options.medianWindow ?? 7;
  const smoothAlpha = options.smoothAlpha ?? 0.28;
  const holdMs = options.holdMs ?? 250;
  const minHz = options.minHz ?? MIN_FREQ_HZ;
  const maxHz = options.maxHz ?? MAX_FREQ_HZ;

  let history = [];
  let smoothed = null;
  let lastGood = null;
  let lastGoodAt = 0;

  function reset() {
    history = [];
    smoothed = null;
    lastGood = null;
    lastGoodAt = 0;
  }

  function inBand(hz) {
    return hz >= minHz && hz <= maxHz && Number.isFinite(hz);
  }

  /** Soft continuity only — never clamp a progressive climb to a fixed note. */
  function softOctaveContinuity(hz) {
    if (lastGood == null) return hz;

    let best = hz;
    let bestRatio = Math.abs(Math.log2(hz / lastGood));
    for (const factor of [0.5, 2]) {
      const candidate = hz * factor;
      if (!inBand(candidate)) continue;
      const ratio = Math.abs(Math.log2(candidate / lastGood));
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = candidate;
      }
    }
    // Only re-map if we land very close to lastGood (~1.5 semitones).
    if (best !== hz && bestRatio < 0.12) return best;
    return hz;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function update(rawHz, nowMs) {
    if (rawHz != null && inBand(rawHz)) {
      const accepted = softOctaveContinuity(rawHz);
      history.push(accepted);
      if (history.length > medianWindow) history.shift();

      const med = median(history);
      if (smoothed == null) {
        smoothed = med;
      } else {
        const centsDelta = 1200 * Math.abs(Math.log2(med / smoothed));
        const alpha = centsDelta > 40 ? Math.min(0.55, smoothAlpha * 1.8) : smoothAlpha;
        smoothed = smoothed + alpha * (med - smoothed);
      }

      lastGood = smoothed;
      lastGoodAt = nowMs;
      return smoothed;
    }

    if (lastGood != null && nowMs - lastGoodAt <= holdMs) {
      return lastGood;
    }

    history = [];
    smoothed = null;
    lastGood = null;
    return null;
  }

  return { update, reset };
}

/**
 * YIN fundamental-frequency estimator (de Cheveigné & Kawahara).
 * Better at low-E fundamentals than naive ACF peak picking.
 * @returns {number|null} Hz
 */
function detectPitchYin(timeBuf, sampleRate, threshold = 0.13) {
  const half = Math.floor(timeBuf.length / 2);
  if (half < 4) return null;

  let rms = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = timeBuf[i];
    rms += v * v;
  }
  rms = Math.sqrt(rms / timeBuf.length);
  if (rms < 0.01) return null;

  const tauMin = Math.max(2, Math.floor(sampleRate / MAX_FREQ_HZ));
  const tauMax = Math.min(half - 1, Math.ceil(sampleRate / MIN_FREQ_HZ));
  if (tauMax <= tauMin + 2) return null;

  const yin = new Float32Array(tauMax + 1);

  // Difference function d(τ)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const delta = timeBuf[i] - timeBuf[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }

  // Cumulative mean normalized difference d'(τ)
  yin[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += yin[tau];
    yin[tau] = runningSum > 0 ? (yin[tau] * tau) / runningSum : 1;
  }

  // Absolute threshold: first valley below threshold
  let tauEstimate = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 < tauMax && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  // Fallback: global minimum if reasonably periodic
  if (tauEstimate === -1) {
    let minVal = 1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (yin[tau] < minVal) {
        minVal = yin[tau];
        tauEstimate = tau;
      }
    }
    if (minVal > 0.35 || tauEstimate < 0) return null;
  }

  // Parabolic interpolation around τ
  const t = tauEstimate;
  const x0 = t > 0 ? yin[t - 1] : yin[t];
  const x1 = yin[t];
  const x2 = t + 1 <= tauMax ? yin[t + 1] : yin[t];
  let betterTau = t;
  const denom = 2 * x1 - x2 - x0;
  if (Math.abs(denom) > 1e-12) {
    betterTau = t + (x2 - x0) / (2 * denom);
  }
  if (betterTau < 1) return null;

  const freq = sampleRate / betterTau;
  if (freq < MIN_FREQ_HZ || freq > MAX_FREQ_HZ || !Number.isFinite(freq)) return null;
  return freq;
}

function noteFromPitch(frequency) {
  const noteNum = 12 * (Math.log(frequency / A4) / Math.log(2));
  return Math.round(noteNum) + 69;
}

function frequencyFromNoteNumber(note) {
  return A4 * Math.pow(2, (note - 69) / 12);
}

function centsOffFromPitch(frequency, note) {
  // Round instead of floor to reduce ±1 cent flicker
  return Math.round(1200 * Math.log(frequency / frequencyFromNoteNumber(note)) / Math.log(2));
}

// Classic autocorrelation (kept for A/B). Lag search limited to guitar band for speed.
function autoCorrelate(buf, sampleRate) {
  let SIZE = buf.length;
  let rms = 0;

  for (let i = 0; i < SIZE; i++) {
    const val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

  const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ_HZ));
  const maxLag = Math.min(Math.floor(SIZE / 2), Math.ceil(sampleRate / MIN_FREQ_HZ));
  if (maxLag <= minLag + 2) return -1;

  const c = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = SIZE - lag;
    for (let j = 0; j < n; j++) {
      sum += buf[j] * buf[j + lag];
    }
    c[lag] = sum;
  }

  let maxval = -Infinity;
  let maxpos = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (c[lag] > maxval) {
      maxval = c[lag];
      maxpos = lag;
    }
  }

  let T0 = maxpos;
  if (T0 > minLag && T0 < maxLag) {
    const x1 = c[T0 - 1];
    const x2 = c[T0];
    const x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);
  }

  const freq = sampleRate / T0;
  if (!Number.isFinite(freq) || freq < MIN_FREQ_HZ || freq > MAX_FREQ_HZ) return -1;
  return freq;
}
