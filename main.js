import { KeepAwake } from '@capacitor-community/keep-awake';

const A4 = 440;
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Guitar-ish band for open + fretted notes (Hz). Outside = reject as noise.
const MIN_FREQ_HZ = 70;
const MAX_FREQ_HZ = 1200;

let audioContext = null;
let analyser = null;
let mediaStreamSource = null;
let isTuning = false;
let animationId = null;
const buflen = 2048;
const buf = new Float32Array(buflen);

/** Shared stability pipeline (works with classic ACF now; YIN later). */
const pitchStabilizer = createPitchStabilizer();

const startBtn = document.getElementById('start-btn');
const noteDisplay = document.getElementById('note-display');
const centsDisplay = document.getElementById('cents-display');
const frequencyDisplay = document.getElementById('frequency-display');
const needle = document.getElementById('needle');

startBtn.addEventListener('click', toggleTuning);

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
    analyser.fftSize = 2048;

    console.log('AudioContext sampleRate:', audioContext.sampleRate);

    mediaStreamSource = audioContext.createMediaStreamSource(stream);
    mediaStreamSource.connect(analyser);

    isTuning = true;
    startBtn.textContent = "Stop Tuning";
    startBtn.classList.add('active');

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
  const raw = autoCorrelate(buf, audioContext.sampleRate);
  const stable = pitchStabilizer.update(raw === -1 ? null : raw, performance.now());

  if (stable != null) {
    renderPitch(stable);
  }

  animationId = requestAnimationFrame(updatePitch);
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
 * Temporal filter between raw detector output and the UI.
 * - Band limit
 * - Octave jump correction vs recent pitch
 * - Median of recent samples (spike kill)
 * - Exponential smooth
 * - Hold last good briefly when detector drops out
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

  /** Prefer octave that matches recent stable pitch (fixes low-E harmonic jumps). */
  function correctOctave(hz) {
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
    // Only snap if we're clearly near half/double (within ~1.5 semitones of last good after correction)
    if (best !== hz && bestRatio < 0.15) return best;
    return hz;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * @param {number|null} rawHz detector output, or null if no pitch
   * @param {number} nowMs performance.now()
   * @returns {number|null} smoothed Hz to display, or null if nothing to show
   */
  function update(rawHz, nowMs) {
    let accepted = null;

    if (rawHz != null && inBand(rawHz)) {
      accepted = correctOctave(rawHz);
      history.push(accepted);
      if (history.length > medianWindow) history.shift();

      const med = median(history);
      if (smoothed == null) {
        smoothed = med;
      } else {
        // Slightly snappier when close (small alpha change); always blend toward median
        const centsDelta = 1200 * Math.abs(Math.log2(med / smoothed));
        const alpha = centsDelta > 40 ? Math.min(0.55, smoothAlpha * 1.8) : smoothAlpha;
        smoothed = smoothed + alpha * (med - smoothed);
      }

      lastGood = smoothed;
      lastGoodAt = nowMs;
      return smoothed;
    }

    // No valid sample this frame: hold briefly, then clear
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

// Autocorrelation algorithm for pitch detection
function autoCorrelate(buf, sampleRate) {
  let SIZE = buf.length;
  let rms = 0;

  for (let i = 0; i < SIZE; i++) {
    let val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // Not enough signal

  let r1 = 0, r2 = SIZE - 1, thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++)
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++)
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }

  buf = buf.slice(r1, r2);
  SIZE = buf.length;

  let c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++)
    for (let j = 0; j < SIZE - i; j++)
      c[i] = c[i] + buf[j] * buf[j + i];

  let d = 0; while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;
  
  // Interpolation
  let x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  let a = (x1 + x3 - 2 * x2) / 2;
  let b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}
