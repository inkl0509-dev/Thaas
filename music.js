// THAAS background music: a gentle island tune made on the fly with the Web Audio API
// (no music files to download, nothing copyrighted). Marimba-like plucks on a pentatonic melody,
// a soft bass and a light shaker. Starts after the player's first tap (browsers require that).
let ctx = null, master = null, timer = null, playing = false, muted = false, step = 0, nextAt = 0, noiseBuf = null;
const BPM = 92, STEP = 60 / BPM / 2; // eighth notes
// chords (C, Am, F, G) and a melody that wanders around them (MIDI numbers, null = rest)
const CHORDS = [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]];
const MELODY = [
  [72, null, 76, 79, null, 76, 74, null], [72, null, 69, 72, null, 74, 76, null],
  [77, null, 76, 74, null, 72, 69, null], [74, null, 76, 74, 72, null, 67, null],
  [72, 74, 76, null, 79, null, 81, 79], [76, null, 72, null, 69, 72, null, null],
  [69, null, 72, 74, null, 72, 69, 67], [71, null, 74, null, 72, null, null, null],
];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function setup() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp); comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}
function pluck(m, t, vol = 0.2, len = 0.6) { // marimba-ish: a sine with a quick knock
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.value = hz(m);
  o2.type = "triangle"; o2.frequency.value = hz(m) * 4; // the wooden knock
  const g2 = ctx.createGain(); g2.gain.setValueAtTime(vol * 0.25, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g); o2.connect(g2); g.connect(master); g2.connect(master);
  o.start(t); o2.start(t); o.stop(t + len + 0.05); o2.stop(t + 0.08);
}
function bass(m, t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.value = hz(m - 12);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 1);
}
function shaker(t, vol) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = "highpass"; f.frequency.value = 6000;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.1);
}
function schedule() {
  while (nextAt < ctx.currentTime + 0.25) {
    const bar = Math.floor(step / 8) % MELODY.length, beat = step % 8;
    const chord = CHORDS[bar % CHORDS.length];
    const m = MELODY[bar][beat];
    if (m) pluck(m, nextAt, 0.16, 0.5);
    if (beat === 0 || beat === 4) bass(chord[0], nextAt);
    if (beat === 2 || beat === 6) chord.forEach((c, i) => pluck(c + 12, nextAt + i * 0.012, 0.05, 0.35));
    shaker(nextAt, beat % 2 ? 0.035 : 0.015);
    nextAt += STEP; step++;
  }
}
export function startMusic() {
  if (muted || !setup()) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  if (playing) return;
  playing = true;
  nextAt = ctx.currentTime + 0.1;
  timer = setInterval(schedule, 100);
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(0.32, ctx.currentTime, 1.2); // fade in
}
export function stopMusic() {
  if (!playing || !ctx) return;
  playing = false;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(0, ctx.currentTime, 0.4); // fade out
  const t = timer; timer = null;
  setTimeout(() => { if (!playing) clearInterval(t); else clearInterval(t); }, 1500);
}
export function setMuted(v) { muted = !!v; if (muted) stopMusic(); }
export const isMuted = () => muted;
export const isPlaying = () => playing;
// the browser only lets sound start after a tap: try again on every tap until it works
export function unlock() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }
