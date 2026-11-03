// Blockfall — effets sonores synthétisés (aucun fichier audio). Les navigateurs exigent un geste utilisateur : unlock().
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('blockfall.muted') === '1'; } catch { /* ignoré */ }

export function unlock() {
  if (ctx || typeof AudioContext === 'undefined') {
    if (ctx?.state === 'suspended') ctx.resume();
    return;
  }
  ctx = new AudioContext();
}

export const isMuted = () => muted;

export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('blockfall.muted', m ? '1' : '0'); } catch { /* ignoré */ }
}

function tone(freq, dur, { type = 'square', gain = 0.08, slide = 0, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur, gain = 0.12, delay = 0) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}

export function play(name, n = 1) {
  switch (name) {
    case 'move': tone(520, 0.03, { gain: 0.03 }); break;
    case 'rotate': tone(700, 0.05, { gain: 0.04, slide: 200 }); break;
    case 'lock': tone(150, 0.08, { type: 'triangle', gain: 0.12, slide: -60 }); break;
    case 'drop': noise(0.1, 0.12); tone(110, 0.1, { type: 'triangle', gain: 0.14, slide: -50 }); break;
    case 'hold': tone(440, 0.06, { gain: 0.05 }); tone(660, 0.06, { gain: 0.05, delay: 0.05 }); break;
    case 'clear': [0, 1, 2, 3].slice(0, n).forEach((i) => tone(520 + i * 130, 0.12, { gain: 0.07, delay: i * 0.05 })); break;
    case 'tetris': [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, { gain: 0.08, delay: i * 0.06 })); break;
    case 'attack': tone(300, 0.2, { type: 'sawtooth', gain: 0.07, slide: 500 }); break;
    case 'garbage': noise(0.25, 0.16); tone(90, 0.25, { type: 'sawtooth', gain: 0.12, slide: -40 }); break;
    case 'count': tone(660, 0.12, { gain: 0.08 }); break;
    case 'go': tone(990, 0.35, { gain: 0.1 }); break;
    case 'click': tone(660, 0.05, { gain: 0.06 }); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { gain: 0.09, delay: i * 0.13 })); break;
    case 'lose': [392, 330, 262, 196].forEach((f, i) => tone(f, 0.24, { gain: 0.09, delay: i * 0.17 })); break;
    default: break;
  }
}
