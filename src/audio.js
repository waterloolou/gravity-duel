// Procedural sound design via the Web Audio API -- every sound here is
// synthesized from oscillators/noise + gain envelopes, no external audio
// asset is ever fetched (same zero-external-asset ethos as the inline SVG
// favicon and the canvas-drawn nebula/disk textures in render.js).

let ctx = null;
let masterGain = null;
let thrustNode = null; // { source, gain } while thrust is held, else null

function ensureContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.55;
  masterGain.connect(ctx.destination);
  return ctx;
}

function noiseBuffer(duration) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createAudioSystem() {
  // Browsers block AudioContexts from producing sound until a real user
  // gesture occurs -- resume() is called from the canvas's own pointer-lock
  // click in main.js, an already-existing gesture, rather than adding a
  // separate "enable audio" prompt.
  function resume() {
    const c = ensureContext();
    if (c.state === "suspended") c.resume();
  }

  function fire() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.11);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  function explosion() {
    if (!ctx) return;
    const t = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(0.5);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(1800, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(120, t + 0.45);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    noise.connect(noiseFilter).connect(noiseGain).connect(masterGain);
    noise.start(t);

    const boom = ctx.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(120, t);
    boom.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(0.5, t);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    boom.connect(boomGain).connect(masterGain);
    boom.start(t);
    boom.stop(t + 0.5);
  }

  function pickup() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // A quick two-note upward chime -- distinct from fire()'s downward
    // sawtooth sweep and explosion()'s low boom, so a pickup reads as a
    // reward, not another combat sound.
    [660, 990].forEach((freq, i) => {
      const start = t + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(masterGain);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  }

  function uiClick() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(660, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  function countdownTick(isFinal) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(isFinal ? 880 : 520, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  function matchOverStinger(won) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = won ? [523.25, 659.25, 783.99, 1046.5] : [440, 392, 349.23, 293.66];
    notes.forEach((freq, i) => {
      const start = t + i * 0.13;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(masterGain);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  }

  function setThrusting(isThrusting) {
    if (!ctx) return;
    if (isThrusting && !thrustNode) {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(2);
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.15);
      source.connect(filter).connect(gain).connect(masterGain);
      source.start();
      thrustNode = { source, gain };
    } else if (!isThrusting && thrustNode) {
      const { source, gain } = thrustNode;
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.12);
      source.stop(t + 0.15);
      thrustNode = null;
    }
  }

  return { resume, fire, explosion, pickup, uiClick, countdownTick, matchOverStinger, setThrusting };
}
