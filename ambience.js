// THAAS table scenes: sounds made on the fly with the Web Audio API (no sound files, nothing copyrighted).
//   beach: waves rolling onto the sand, a soft fizz of foam, little birds and the odd seagull
//   rain:  steady rain, drips, and thunder now and then (onThunder lets the screen flash too)
let ctx = null, out = null, cur = null, live = [], timers = [], noiseBuf = null, brownBuf = null;
export let onThunder = null, onSwell = null;
export function setSwellHandler(fn) { onSwell = fn; }
export function setThunderHandler(fn) { onThunder = fn; }

function setup() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  out = ctx.createGain(); out.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  out.connect(comp); comp.connect(ctx.destination);
  const n = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  brownBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const w = noiseBuf.getChannelData(0), b = brownBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    w[i] = Math.random() * 2 - 1;
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; // brown: deep rumble
  }
  return true;
}
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
const rnd = (a, b) => a + Math.random() * (b - a);
function loop(buf) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(ctx.currentTime, Math.random() * 3);
  live.push(s); return s;
}
function filt(type, f, q = 0.7) { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; }
function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }

// ---------- beach ----------
function beach() {
  // the wave: deep noise that swells up and falls back, again and again
  const wave = gain(0.04), foam = gain(0.0);
  loop(noiseBuf).connect(filt("lowpass", 520)).connect(wave).connect(out);
  loop(noiseBuf).connect(filt("bandpass", 2600, 0.5)).connect(foam).connect(out);
  const swell = () => {
    if (cur !== "beach") return;
    const t = ctx.currentTime, up = rnd(2.2, 3.2), down = rnd(3.2, 4.6), peak = rnd(0.28, 0.42);
    try { onSwell?.(up, down); } catch {} // the picture's wave rushes in with the sound
    wave.gain.cancelScheduledValues(t);
    wave.gain.setValueAtTime(wave.gain.value, t);
    wave.gain.linearRampToValueAtTime(peak, t + up);
    wave.gain.linearRampToValueAtTime(0.05, t + up + down);
    foam.gain.cancelScheduledValues(t);
    foam.gain.setValueAtTime(0.0, t + up * 0.7);
    foam.gain.linearRampToValueAtTime(peak * 0.16, t + up + 0.3);   // the foam fizzing up the sand
    foam.gain.linearRampToValueAtTime(0.0, t + up + down * 0.9);
    later(swell, (up + down + rnd(0.2, 1.4)) * 1000);
  };
  swell();
  const birds = () => {
    if (cur !== "beach") return;
    if (Math.random() < 0.3) seagull(); else tweets();
    later(birds, rnd(2500, 7500));
  };
  later(birds, 1500);
}
function tweets() { // a little bird: a few quick rising chirps
  const n = 2 + Math.floor(Math.random() * 5), base = rnd(2600, 3800), t0 = ctx.currentTime + 0.05;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) { pan.pan.value = rnd(-0.8, 0.8); pan.connect(out); }
  for (let i = 0; i < n; i++) {
    const t = t0 + i * rnd(0.09, 0.16), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(base, t);
    o.frequency.exponentialRampToValueAtTime(base * rnd(1.25, 1.6), t + 0.05);
    o.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.08);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g); g.connect(pan || out); o.start(t); o.stop(t + 0.1);
  }
}
function seagull() { // two or three falling "kyaa" calls
  const n = 2 + Math.floor(Math.random() * 2), t0 = ctx.currentTime + 0.05;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * rnd(0.4, 0.55), o = ctx.createOscillator(), g = ctx.createGain(), vib = ctx.createOscillator(), vg = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(rnd(1250, 1450), t);
    o.frequency.exponentialRampToValueAtTime(rnd(820, 950), t + 0.32);
    vib.frequency.value = 28; vg.gain.value = 25; vib.connect(vg); vg.connect(o.frequency);
    const f = filt("bandpass", 1400, 1.2);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(f); f.connect(g); g.connect(out);
    o.start(t); vib.start(t); o.stop(t + 0.36); vib.stop(t + 0.36);
  }
}

// ---------- rain ----------
function rain() {
  const steady = gain(0.0);
  loop(noiseBuf).connect(filt("highpass", 900)).connect(filt("lowpass", 7000)).connect(steady).connect(out);
  steady.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 2);
  const low = gain(0.07); // heavier drops on the roof
  loop(brownBuf).connect(filt("lowpass", 400)).connect(low).connect(out);
  const drips = () => {
    if (cur !== "rain") return;
    for (let i = 0; i < 3; i++) if (Math.random() < 0.6) drip(i * 0.04);
    later(drips, rnd(80, 200));
  };
  drips();
  const thunder = () => {
    if (cur !== "rain") return;
    rumble();
    later(thunder, rnd(16000, 34000));
  };
  later(thunder, rnd(5000, 11000));
}
function drip(delay) {
  const t = ctx.currentTime + delay, s = ctx.createBufferSource(), g = ctx.createGain(), f = filt("bandpass", rnd(2500, 6000), 4);
  s.buffer = noiseBuf;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(rnd(0.03, 0.08), t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 3); s.stop(t + 0.05);
}
function rumble() {
  try { onThunder?.(); } catch {}
  const t = ctx.currentTime + rnd(0.3, 1.2), s = ctx.createBufferSource(), g = ctx.createGain(), f = filt("lowpass", rnd(120, 220));
  s.buffer = brownBuf;
  const len = rnd(3.5, 6);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(rnd(0.5, 0.8), t + rnd(0.15, 0.5));
  g.gain.exponentialRampToValueAtTime(0.25, t + len * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + len + 0.1);
}

// ---------- start / stop ----------
export function startAmbience(kind) {
  if (!kind) return stopAmbience();
  if (!setup()) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  if (cur === kind) return;
  stopAmbience(true);
  cur = kind;
  out.gain.cancelScheduledValues(ctx.currentTime);
  out.gain.setValueAtTime(0, ctx.currentTime);
  out.gain.linearRampToValueAtTime(kind === "rain" ? 0.9 : 0.8, ctx.currentTime + 2); // fade in
  if (kind === "beach") beach(); else if (kind === "rain") rain();
}
export function stopAmbience(now = false) {
  const old = live;
  cur = null; live = [];
  timers.forEach(clearTimeout); timers = [];
  if (!ctx) return;
  const stopAll = () => old.forEach((s) => { try { s.stop(); } catch {} try { s.disconnect(); } catch {} });
  if (now) return stopAll();
  out.gain.cancelScheduledValues(ctx.currentTime);
  out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
  out.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
  setTimeout(stopAll, 700);
}
export const ambienceOn = () => cur;
export function unlockAmbience() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }
