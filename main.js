const A4 = 440;
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let audioContext = null;
let analyser = null;
let mediaStreamSource = null;
let isTuning = false;
let animationId = null;
const buflen = 2048;
const buf = new Float32Array(buflen);

const startBtn = document.getElementById('start-btn');
const noteDisplay = document.getElementById('note-display');
const centsDisplay = document.getElementById('cents-display');
const frequencyDisplay = document.getElementById('frequency-display');
const needle = document.getElementById('needle');

startBtn.addEventListener('click', toggleTuning);

async function toggleTuning() {
  if (isTuning) {
    stopTuning();
  } else {
    await startTuning();
  }
}

async function startTuning() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    
    mediaStreamSource = audioContext.createMediaStreamSource(stream);
    mediaStreamSource.connect(analyser);
    
    isTuning = true;
    startBtn.textContent = "Stop Tuning";
    startBtn.classList.add('active');
    
    updatePitch();
  } catch (err) {
    alert("Microphone access is required to use the tuner.");
    console.error(err);
  }
}

function stopTuning() {
  isTuning = false;
  startBtn.textContent = "Start Tuning";
  startBtn.classList.remove('active');
  
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
  let ac = autoCorrelate(buf, audioContext.sampleRate);
  
  if (ac !== -1) {
    let pitch = ac;
    frequencyDisplay.textContent = pitch.toFixed(1) + " Hz";
    
    let note = noteFromPitch(pitch);
    let cents = centsOffFromPitch(pitch, note);
    let noteName = noteNames[note % 12];
    let octave = Math.floor(note / 12) - 1;
    
    noteDisplay.textContent = noteName + octave;
    centsDisplay.textContent = cents > 0 ? "+" + cents + " cents" : cents + " cents";
    
    // Update needle (limit to -50 to +50 cents)
    let degrees = (cents / 50) * 45; // 45 degrees max in either direction
    if (degrees > 45) degrees = 45;
    if (degrees < -45) degrees = -45;
    
    needle.style.transform = `translateX(-50%) rotate(${degrees}deg)`;
    
    // Update colors based on tuning accuracy (threshold: 5 cents)
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
  
  animationId = requestAnimationFrame(updatePitch);
}

function noteFromPitch(frequency) {
  let noteNum = 12 * (Math.log(frequency / A4) / Math.log(2));
  return Math.round(noteNum) + 69;
}

function frequencyFromNoteNumber(note) {
  return A4 * Math.pow(2, (note - 69) / 12);
}

function centsOffFromPitch(frequency, note) {
  return Math.floor(1200 * Math.log(frequency / frequencyFromNoteNumber(note)) / Math.log(2));
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
