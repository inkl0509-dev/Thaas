import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut, updateProfile,
  EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, runTransaction,
  collection, getDocs, writeBatch, serverTimestamp, increment, query, where, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./firebase-config.js";
import * as C from "./cards.js";
import * as P from "./profile.js";

const { firebaseConfig } = CFG;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Local cache: the game reloads instantly and your own moves show before the server confirms them.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const TURN_MS = 50_000;   // each player gets 50 seconds
const GRACE_MS = 4_000;   // others wait a little longer before skipping someone who has gone offline
const RESULTS_DELAY = 2600; // time to watch the DIGU card flip before the scores appear
const HEAP_SIZE = 7;      // how many thrown cards are visible on the table

// Reactions and how many games you must play to unlock each one.
const REACTIONS = [
  ["😂", 0], ["👍", 0], ["😮", 0], ["Quick!", 0], ["Oh man!", 0], ["Hurry up!", 0],
  ["😭", 2], ["So close!", 2],
  ["🔥", 3], ["Nice one!", 3],
  ["😎", 5], ["Haha", 5],
  ["😡", 8], ["Not again!", 8],
  ["🤞", 10], ["Good game", 10],
  ["👑", 15], ["Too easy!", 15],
];
const SORT_UNLOCK = 5;      // "Sort by suit" / "Sort by number" unlock after this many games
const TARGET_CHOICES = [300, 500, 1000];
const DEFAULT_TARGET = 500;
// Lobby tables (listed on the home screen): up to 4 players, 4 rounds, highest total wins.
// Private tables (code only): 2–6 players, play to a target score.
const LOBBY_MAX = 4;
const LOBBY_ROUNDS = 4;
const isLobbyRoom = (r) => r?.public !== false;
// Two games: DIGU (sets, highest total wins) and CALL (low count, lowest total wins).
const gameOf = (r) => (r?.game === "call" ? "call" : "digu");
const isCall = () => gameOf(room) === "call";
const GAME_NAME = { digu: "DIGU", call: "CALL" };
const LOBBY_SEATS = { digu: 4, call: 6 };       // lobby tables: DIGU 2–4 players, CALL 2–6 players
const CALL_TARGETS = [50, 100, 200];
const CALL_DEFAULT_TARGET = 100;

// ---------- state ----------
let uid = null;
let roomId = null;
let room = null;           // latest room document
let hand = [];             // my cards, in my own display order
let selected = null;       // card id I tapped
let lastDrawn = null;      // highlight the card I just picked up
let unsubRoom = null, unsubHand = null;
let resultsRound = 0;      // which round's results are on screen
let resultsTimer = null;
let actedKey = null;       // stops double moves from fast double taps
let turnKey = null, turnSeenAt = 0, timeoutFired = null;
let drag = null;
let lastReactionId;        // undefined until the first room snapshot
let heapKey = null, heapTop = null;
let lastReactAt = 0;
let gamesPlayed = null;    // from my users/{uid} document; null until loaded
let lastRows = null;       // this round's score breakdown, shown on the results screen
let profile = {};          // my users/{uid} document (stats, name, avatar, style choices)
const oneAwayCache = { key: null, value: false, pending: false };
const callSel = new Set();   // CALL: cards picked to throw together (same number)

const $ = (id) => document.getElementById(id);
const roomRef = () => doc(db, "rooms", roomId);
const handRef = (u = uid) => doc(db, "rooms", roomId, "hands", u);

function store(key, val) { try { localStorage.setItem(key, val); } catch {} }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}
const errMsg = (e) => {
  if (typeof e === "string") return e;
  if (e?.code === "permission-denied") return amBlocked
    ? "Your account has been blocked by an admin"
    : "Firebase blocked this. Republish firestore.rules in the Firebase console.";
  return e?.message || "Something went wrong";
};

// ---------- lobby ----------
function myName() {
  if (isRegistered() && profile.name) return profile.name;
  const n = $("name").value.trim().slice(0, 16);
  if (!n) { toast("Enter your name first"); $("name").focus(); return null; }
  store("digu-name", n);
  return n;
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function createRoom({ isPublic = true, game = "digu" } = {}) {
  if (blockedCheck()) return;
  if (!isPublic && !isRegistered()) return toast("🔒 Register to create your own lounge");
  const name = myName();
  if (!name) return;
  let code;
  do { code = randomCode(); } while ((await getDoc(doc(db, "rooms", code))).exists());
  await setDoc(doc(db, "rooms", code), {
    host: uid,
    status: "lobby",
    players: [myEntry(name)],
    playerIds: [uid],
    scores: { [uid]: 0 },
    round: 0,
    moveId: 0,
    game,                         // "digu" or "call"
    target: game === "call" ? CALL_DEFAULT_TARGET : DEFAULT_TARGET,
    maxPlayers: isPublic ? LOBBY_SEATS[game] : 6,
    gameRound: 0,                 // rounds played in this game (lobby games stop after 4)
    public: isPublic,             // true = lobby table on the home screen; false = a registered player's lounge
    endMode: "points",            // lounges: "points" (first to target) or "rounds" (fixed number)
    roundsLimit: DEFAULT_LOUNGE_ROUNDS,
    heartbeat: serverTimestamp(), // host keeps this fresh so abandoned rooms drop off the list
    log: isPublic ? `${name} opened a ${GAME_NAME[game]} table` : `${name} opened their lounge`,
    createdAt: serverTimestamp(),
  });
  enterRoom(code);
}

async function joinRoom(code, { quiet = false } = {}) {
  if (blockedCheck()) return false;
  const name = myName();
  if (!name) return false;
  code = code.trim().toUpperCase();
  if (!code) { toast("Enter a room code"); return false; }
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw "Room not found";
      const r = snap.data();
      if (r.playerIds.includes(uid)) return; // already in (e.g. page reload)
      if (r.status !== "lobby") throw "That game has already started";
      if (r.playerIds.length >= (r.maxPlayers || 6)) throw `Room is full (${r.maxPlayers || 6} players max)`;
      tx.update(ref, {
        players: [...r.players, myEntry(name)],
        playerIds: [...r.playerIds, uid],
        [`scores.${uid}`]: 0,
        log: `${name} joined`,
      });
    });
    enterRoom(code);
    sendNotify("join", code);
    return true;
  } catch (e) { if (!quiet) toast(errMsg(e)); return false; }
}

// ---------- the lobby: fixed tables, seats and players walking around ----------
// The lobby is its own screen (address …/#lobby). It always has the same tables: DIGU 1–4 and CALL 1–4.
// Nobody owns a table. Walk in, sit at any free seat, and once 2 or more are seated anyone at the
// table can press Play. You can get up and wander while waiting; your seat is kept.
const LOBBY_TABLES = [
  ...[1, 2, 3, 4].map((no) => ({ id: `DIGU${no}`, game: "digu", no })),
  ...[1, 2, 3, 4].map((no) => ({ id: `CALL${no}`, game: "call", no })),
];
const FRESH_MS = 90_000;     // a table nobody has kept alive for this long is treated as empty
const PRESENCE_MS = 60_000;  // a player not seen for this long has left the lobby
const WALK_SPEED = 150;      // px per second
const MAX_WALK_S = 2.2;      // long walks speed up so nobody waits more than ~2 seconds
const walkTime = (distPx) => Math.min(MAX_WALK_S, Math.max(0.3, distPx / WALK_SPEED));
let openRooms = [], unsubOpen = null;
let presence = new Map(), unsubPresence = null;
let me = { x: 50, y: 92, seated: false }; // my spot on the floor, in % of the floor
let floorLayout = { W: 1, H: 1, tables: new Map() };
let sitTimer = null;
const walkerEls = new Map();

// Phones' clocks can be minutes off, so time checks use the server's clock, learned from my own
// check-ins (the server stamps them). Until it's known, tables are assumed to be in use.
let serverOffset = 0, serverTimeKnown = false;
const serverNow = () => Date.now() + serverOffset;
const roomFresh = (r) => {
  const t = r.heartbeat?.toMillis?.() ?? (r.heartbeat?.seconds ? r.heartbeat.seconds * 1000 : 0);
  return !t || !serverTimeKnown || serverNow() - t < FRESH_MS; // brand-new rooms have no server time yet
};
const seatsOf = (r) => (isLobbyRoom(r) ? LOBBY_SEATS[gameOf(r)] : r.maxPlayers || 6);
const lobbyQuery = () => query(collection(db, "rooms"), where("public", "==", true), where("status", "in", ["lobby", "playing", "ended"]));
const inLobbyView = () => !$("lobbyScreen").hidden;
const myLobbyTable = () => (room && roomId && isLobbyRoom(room) && room.status === "lobby" ? roomId : null);
const tableName = (t) => `${GAME_NAME[t.game || gameOf(t)]} table ${t.no || String(t.id).slice(-1)}`;
// A player counts as "in the lobby" if my device heard from them recently (they check in every
// 20 seconds and on every move). Using the time my device received it avoids problems when
// phones' clocks disagree.
const presenceFresh = (p) => !!p && Date.now() - (p._seen || 0) < PRESENCE_MS;
let presenceLoaded = false, presenceWarned = false;

// Which chair each player is in. Players keep the chair they picked (p.seat);
// older entries without one just fill the first free chairs.
function seatMap(r) {
  const seats = seatsOf(r), map = new Map();
  for (const p of r.players || []) {
    let s = Number.isInteger(p.seat) && p.seat >= 0 && p.seat < seats && !map.has(p.seat) ? p.seat : -1;
    if (s < 0) for (let k = 0; k < seats; k++) if (!map.has(k)) { s = k; break; }
    if (s >= 0) map.set(s, p);
  }
  return map;
}
const mySeat = (r) => [...seatMap(r)].find(([, p]) => p.uid === uid)?.[0] ?? -1;

// A fixed table plus whatever is happening at it right now.
function tableState(t) {
  const r = openRooms.find((x) => x.id === t.id);
  const live = r && r.status !== "closed" && roomFresh(r) && r.playerIds?.length;
  return live
    ? { ...r, id: t.id, game: t.game, no: t.no, public: true }
    : { id: t.id, game: t.game, no: t.no, public: true, status: "lobby", players: [], playerIds: [] };
}

function watchOpenRooms() {
  unsubOpen?.();
  unsubOpen = onSnapshot(lobbyQuery(), (snap) => {
    openRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFloor();
  }, () => { $("floorTables").innerHTML = '<p class="muted floor-msg">Couldn\'t load the lobby.</p>'; });
  unsubPresence?.();
  presenceLoaded = false;
  unsubPresence = onSnapshot(collection(db, "presence"), (snap) => {
    const now = Date.now();
    const changed = new Set(snap.docChanges().filter((c) => c.type !== "removed").map((c) => c.doc.id));
    const at = (data) => data.at?.toMillis?.() ?? (data.at?.seconds ? data.at.seconds * 1000 : 0);
    // On first load, compare check-in times with each other (all from the server's clock),
    // never with this phone's clock, which may be wrong.
    const newest = Math.max(0, ...snap.docs.map((d) => at(d.data())));
    const mine = snap.docs.find((d) => d.id === uid);
    if (mine && changed.has(uid) && at(mine.data())) { // the server just stamped my check-in
      serverOffset = at(mine.data()) - now;
      serverTimeKnown = true;
    }
    const next = new Map();
    for (const d of snap.docs) {
      const data = d.data();
      let seen = presence.get(d.id)?._seen || 0;
      if (changed.has(d.id)) {
        if (presenceLoaded) seen = now; // a live update: they're here right now
        else { const t = at(data); seen = !t || newest - t < 120_000 ? now : 0; }
      }
      next.set(d.id, { ...data, _seen: seen });
    }
    if (!snap.metadata?.fromCache) presenceLoaded = true;
    presence = next;
    renderFloor();
  }, (e) => warnPresence(e));
}

// ----- my presence (where I am on the floor) -----
const presenceRef = (u = uid) => doc(db, "presence", u);
function writePresence() {
  if (!uid || amBlocked || !inLobbyView()) return;
  const e = myEntry(isRegistered() ? profile.name || "Player" : ($("name").value.trim() || "Guest").slice(0, 16));
  setDoc(presenceRef(), {
    name: e.name, avatar: e.avatar, photoV: e.photoV ?? null, rank: e.rank ?? null,
    x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10,
    seated: !!(me.seated && myLobbyTable()), roomId: myLobbyTable(),
    at: serverTimestamp(),
  }).catch(warnPresence);
}

// If other players can't see me (or I can't see them), say why instead of failing silently.
function warnPresence(e) {
  if (presenceWarned) return;
  presenceWarned = true;
  toast(e?.code === "permission-denied"
    ? "Other players can't see you moving: republish firestore.rules in the Firebase console"
    : "Live movement isn't connecting right now");
  console.warn("Lobby presence:", e);
}
function clearPresence() {
  if (uid) deleteDoc(presenceRef()).catch(() => {});
}
setInterval(() => { if (inLobbyView()) writePresence(); }, 20_000);
addEventListener("pagehide", clearPresence);

// ----- layout: tables in a grid, open floor below -----
// Everyone gets the same layout (it just scales to the screen), so a player standing next to a
// table on your phone is standing next to that table on everyone else's screen too.
// Left column: the DIGU tables. Right column: the CALL tables.
function layoutFloor(tables) {
  const floor = $("lobbyFloor");
  const W = floor.clientWidth || 360;
  const cell = W / 2;
  const head = cell * 0.22;                // room for the DIGU / CALL signs
  const rowH = cell * 0.9;
  const rows = 4;
  const H = Math.round(head + rows * rowH + cell * 0.42); // + open floor and entrance
  floor.style.height = H + "px";
  floor.style.setProperty("--u", (W / 100) + "px");       // 1% of the floor width, for sizing
  const map = new Map();
  tables.forEach((r) => {
    const col = r.game === "call" ? 1 : 0, row = (r.no || 1) - 1;
    const cx = (col + 0.5) * cell, cy = head + row * rowH + rowH * 0.5;
    const size = cell * 0.76;
    const seats = seatsOf(r);
    const seatPos = [];
    for (let k = 0; k < seats; k++) {
      const ang = Math.PI / 2 + (k * 2 * Math.PI) / seats; // first seat at the bottom
      seatPos.push({ x: ((cx + size * 0.4 * Math.cos(ang)) / W) * 100, y: ((cy + size * 0.4 * Math.sin(ang)) / H) * 100 });
    }
    map.set(r.id, { cx: (cx / W) * 100, cy: (cy / H) * 100, size, seatPos });
  });
  floorLayout = { W, H, tables: map };
}

function renderFloor() {
  if (!$("lobbyFloor") || $("lobbyScreen").hidden) return;
  const tables = LOBBY_TABLES.map(tableState);
  const inLobby = [...presence.values()].filter(presenceFresh).length;
  const playing = tables.filter((r) => r.status !== "lobby").reduce((n, r) => n + r.playerIds.length, 0);
  $("openCount").textContent = `${inLobby} in the lobby${playing ? ` · ${playing} playing` : ""}`;
  layoutFloor(tables);
  const box = $("floorTables");
  box.innerHTML = "";
  for (const [game, x] of [["digu", 25], ["call", 75]]) { // a sign over each column
    const sign = document.createElement("div");
    sign.className = "zone-sign g-" + game;
    sign.style.left = x + "%";
    sign.innerHTML = `<b>${GAME_NAME[game]}</b><small>${game === "call" ? "2–6 players · lowest wins" : "2–4 players · highest wins"}</small>`;
    box.append(sign);
  }
  for (const r of tables) box.append(lobbyTable(r));
  renderSeatBar();
  renderWalkers();
}

function lobbyTable(r) {
  const L = floorLayout.tables.get(r.id);
  const waiting = r.status === "lobby";
  const mine = r.playerIds.includes(uid);
  const seats = seatsOf(r);
  const n = r.playerIds.length;
  const t = document.createElement("div");
  t.className = "ltable" + (waiting ? "" : " in-play") + (mine ? " mine" : "") + (n ? "" : " empty-table");
  t.style.left = L.cx + "%";
  t.style.top = L.cy + "%";
  t.style.width = t.style.height = L.size + "px";

  const felt = document.createElement("div");
  felt.className = "ltable-felt g-" + r.game;
  const title = document.createElement("strong");
  title.className = "table-game";
  title.textContent = GAME_NAME[r.game];
  const no = Object.assign(document.createElement("small"), { className: "table-no", textContent: `Table ${r.no}` });
  felt.append(title, no);
  if (!waiting) {
    felt.append(Object.assign(document.createElement("small"), { textContent: `Playing · ${Math.max(1, r.gameRound || 1)}/${LOBBY_ROUNDS}` }));
  } else if (mine) {
    // anyone sitting at the table can start once 2 or more are seated
    const play = document.createElement("button");
    play.className = "table-play" + (n >= 2 ? "" : " wait");
    play.textContent = "Start";
    play.title = n >= 2 ? `Start with ${n} players` : "Needs at least 2 players";
    play.onclick = (e) => { e.stopPropagation(); startTable(); };
    felt.append(play);
  } else {
    felt.append(Object.assign(document.createElement("small"), {
      textContent: n === 0 ? `${seats} seats` : n === 1 ? "1 waiting" : `${n} ready`,
    }));
  }
  t.append(felt);

  const chairs = seatMap(r);
  for (let i = 0; i < seats; i++) {
    const p = chairs.get(i);
    const seat = document.createElement(p ? "div" : "button");
    seat.className = "seat" + (p ? " taken" : " empty");
    seat.style.left = `${50 + 40 * Math.cos(Math.PI / 2 + (i * 2 * Math.PI) / seats)}%`;
    seat.style.top = `${50 + 40 * Math.sin(Math.PI / 2 + (i * 2 * Math.PI) / seats)}%`;
    if (p) {
      // a chair is reserved for whoever sits in it; it only shows "away" if their app has closed
      const pr = presence.get(p.uid);
      const away = waiting && p.uid !== uid && !presenceFresh(pr);
      seat.classList.toggle("away", !!away);
      seat.append(avatarEl(p, "avatar"));
      const nm = document.createElement("span");
      nm.className = "seat-name";
      nm.textContent = away ? "away" : p.name;
      seat.append(nm);
      seat.title = p.uid === uid ? "Your chair · walk away to stand up" : `${p.name}'s chair`;
      if (p.uid === uid && waiting) {
        seat.classList.add("my-seat");
        seat.title = "Your chair · tap to stand up";
        seat.onclick = (e) => { e.stopPropagation(); standUpAndStep(); };
      }
    } else if (waiting) {
      seat.textContent = "+";
      seat.title = `Sit at ${tableName(r)}`;
      seat.onclick = (e) => { e.stopPropagation(); takeSeat(r, i); };
    }
    t.append(seat);
  }
  return t;
}

// ----- characters -----
function walkerEl(id) {
  let el = walkerEls.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "walker";
    el.innerHTML = '<div class="walker-body"><span class="walker-head avatar"></span><span class="torso"></span><span class="legs"><i></i><i></i></span></div><span class="walker-name"></span>';
    $("floorWalkers").append(el);
    walkerEls.set(id, el);
  }
  return el;
}

function colorFor(id) {
  return `hsl(${hash(id) % 360} 55% 45%)`;
}

function placeWalker(el, id, info, x, y) {
  const px = (x / 100) * floorLayout.W, py = (y / 100) * floorLayout.H;
  const old = el._pos;
  el.querySelector(".torso").style.background = colorFor(id);
  fillAvatar(el.querySelector(".walker-head"), info);
  el.querySelector(".walker-name").textContent = info.name || "Player";
  if (!old) { // first appearance: no walking animation
    el.style.transition = "none";
    el.style.left = px + "px";
    el.style.top = py + "px";
    void el.offsetWidth;
  } else if (Math.abs(old.px - px) > 0.5 || Math.abs(old.py - py) > 0.5) {
    const dur = walkTime(Math.hypot(px - old.px, py - old.py));
    el.style.transition = `left ${dur}s linear, top ${dur}s linear`;
    el.style.left = px + "px";
    el.style.top = py + "px";
    el.classList.add("walking");
    el.classList.toggle("face-left", px < old.px);
    clearTimeout(el._stop);
    el._stop = setTimeout(() => el.classList.remove("walking"), dur * 1000);
  }
  el._pos = { px, py };
}

function renderWalkers() {
  if (!$("floorWalkers") || !inLobbyView()) return;
  const shown = new Set();
  if (uid && !(me.seated && myLobbyTable())) {
    const el = walkerEl(uid);
    el.classList.add("me");
    placeWalker(el, uid, myEntry(isRegistered() ? profile.name || "Player" : ($("name").value.trim() || "Guest")), me.x, me.y);
    shown.add(uid);
  }
  for (const [id, p] of presence) {
    if (id === uid || !presenceFresh(p)) continue;
    const table = p.roomId && openRooms.find((r) => r.id === p.roomId && r.status === "lobby" && r.playerIds.includes(id));
    if (p.seated && table) continue; // drawn in their seat instead
    placeWalker(walkerEl(id), id, { uid: id, ...p }, p.x ?? 50, p.y ?? 92);
    shown.add(id);
  }
  for (const [id, el] of walkerEls) {
    if (!shown.has(id)) { el.remove(); walkerEls.delete(id); }
  }
  $("lobbyFloor").classList.toggle("alone", shown.size <= 1);
}

// Others who are standing still shuffle about a little, so the room feels alive.
setInterval(() => {
  for (const [id, el] of walkerEls) {
    if (id === uid || el.classList.contains("walking") || Math.random() < 0.5) continue;
    const dx = (Math.random() - 0.5) * 22, dy = (Math.random() - 0.5) * 10;
    el.querySelector(".walker-body").style.transform = `translate(${dx}px, ${dy}px)`;
    el.classList.toggle("face-left", dx < 0);
    el.classList.add("shuffling");
    setTimeout(() => el.classList.remove("shuffling"), 1400);
  }
}, 3500);

// ----- moving myself -----
// Standing up frees your chair for someone else. While you're sitting you belong to that table,
// so you can only leave it by standing up (before the game starts).
function standUp() {
  const wasAtTable = me.seated && myLobbyTable();
  me.seated = false;
  if (wasAtTable) { exitRoom(); toast("You stood up · your chair is free again"); }
}

function standUpAndStep() {
  if (!myLobbyTable()) return;
  standUp();
  walkTo({ x: me.x, y: Math.min(96, me.y + 7) }); // step away from the table
}

const seatedHint = () => toast("You're sitting at a table · tap Stand up first to leave it");

function walkTo(pos, then, { keepSeat = false } = {}) {
  const dur = walkTime(Math.hypot(((pos.x - me.x) / 100) * floorLayout.W, ((pos.y - me.y) / 100) * floorLayout.H));
  if (me.seated) {
    if (keepSeat) me.seated = false; // moving to another chair at the same table
    else standUp();
    renderFloor();
  }
  me.x = Math.min(97, Math.max(3, pos.x));
  me.y = Math.min(97, Math.max(3, pos.y));
  renderWalkers();
  writePresence();
  clearTimeout(sitTimer);
  if (then) sitTimer = setTimeout(then, Math.max(250, dur * 1000));
}

function onFloorTap(e) {
  if (e.target.closest(".seat, .ltable-felt, button")) return;
  if (me.seated && myLobbyTable()) return seatedHint();
  const r = $("lobbyFloor").getBoundingClientRect();
  walkTo({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
}

// Sit at a fixed table. An empty (or abandoned) table is simply set up again with me in it.
async function sitAt(t, seatIndex) {
  const name = myName();
  if (!name) return false;
  const entry = { ...myEntry(name), seat: seatIndex };
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", t.id);
      const snap = await tx.get(ref);
      const r = snap.data();
      const live = r && r.status !== "closed" && roomFresh(r) && r.playerIds?.length;
      if (!live) {
        tx.set(ref, {
          host: uid, status: "lobby", game: t.game, public: true, tableNo: t.no,
          players: [entry], playerIds: [uid], scores: { [uid]: 0 },
          round: r?.round || 0, moveId: 0, gameRound: 0, maxPlayers: LOBBY_SEATS[t.game],
          target: t.game === "call" ? CALL_DEFAULT_TARGET : DEFAULT_TARGET,
          endMode: "rounds", roundsLimit: LOBBY_ROUNDS, almost: {},
          heartbeat: serverTimestamp(), createdAt: serverTimestamp(),
          log: `${name} sat down`,
        });
        return;
      }
      if (r.status !== "lobby") throw "This table is playing right now";
      const taken = seatMap(r).get(seatIndex);
      if (taken && taken.uid !== uid) throw `${taken.name} is sitting in that chair`;
      if (r.playerIds.includes(uid)) { // moving to another chair at the same table
        tx.update(ref, { players: r.players.map((p) => (p.uid === uid ? { ...p, seat: seatIndex } : p)) });
        return;
      }
      if (r.playerIds.length >= seatsOf(r)) throw "This table is full";
      tx.update(ref, {
        players: [...r.players, entry], playerIds: [...r.playerIds, uid],
        [`scores.${uid}`]: 0, log: `${name} sat down`,
      });
    });
    enterRoom(t.id);
    sendNotify("sit", t.id);
    return true;
  } catch (e) { toast(errMsg(e)); return false; }
}

// Walk to the chair I tapped and sit in it. If I was sitting somewhere else, I stand up first
// (that chair is freed); moving to another chair at the same table just changes chairs.
async function takeSeat(t, seatIndex) {
  if (blockedCheck() || !myName()) return;
  const pos = floorLayout.tables.get(t.id)?.seatPos[seatIndex];
  if (!pos) return;
  if (me.seated && myLobbyTable() && myLobbyTable() !== t.id) return seatedHint();
  const sameTable = myLobbyTable() === t.id;
  walkTo(pos, async () => {
    if (await sitAt(t, seatIndex)) { me.seated = true; writePresence(); renderFloor(); }
    else if (sameTable) { me.seated = true; renderFloor(); }
  }, { keepSeat: sameTable });
}

// Quick seat: the fullest table of that game with a free seat, otherwise an empty one.
function findSeat(game) {
  if (blockedCheck() || !myName()) return;
  if (myLobbyTable()) return toast("You're already at a table");
  const options = LOBBY_TABLES.filter((t) => t.game === game).map(tableState)
    .filter((r) => r.status === "lobby" && r.playerIds.length < seatsOf(r))
    .sort((a, b) => b.playerIds.length - a.playerIds.length);
  if (!options.length) return toast(`All ${GAME_NAME[game]} tables are busy right now`);
  const chairs = seatMap(options[0]);
  let free = 0;
  while (chairs.has(free)) free++;
  takeSeat(options[0], free);
}

// Play: anyone at the table can start once 2 or more are seated.
function startTable() {
  if (!myLobbyTable()) return;
  if (room.players.length < 2) return toast("Wait for at least one more player to sit down");
  dealRound();
}

// ----- my table bar (while waiting at a lobby table) -----
function renderSeatBar() {
  const bar = $("seatBar");
  const code = myLobbyTable();
  bar.hidden = !code;
  if (!code) return;
  const n = room.players.length;
  const name = tableName({ id: roomId, game: gameOf(room), no: room.tableNo });
  $("seatText").textContent = n < 2
    ? `You're at ${name} · waiting for another player to sit down…`
    : `You're at ${name} · ${n}/${seatsOf(room)} seated · anyone here can press Start`;
  $("seatStart").disabled = n < 2;
  $("seatStart").textContent = n < 2 ? "Start (needs 2)" : `Start (${n} players)`;
}

// Keep my table "alive" so it isn't treated as abandoned, and refresh the room.
setInterval(() => {
  if (room && roomId && room.host === uid && room.status !== "closed") {
    updateDoc(roomRef(), { heartbeat: serverTimestamp() }).catch(() => {});
  }
  renderFloor();
}, 25_000);

// Leaving a table frees the seat.
async function exitRoom() {
  const code = roomId, wasLobby = room?.status === "lobby";
  leaveRoom();
  if (!code || !wasLobby) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const r = (await tx.get(ref)).data();
      if (!r || r.status !== "lobby" || !r.playerIds.includes(uid)) return;
      const players = r.players.filter((p) => p.uid !== uid);
      const upd = {
        players, playerIds: r.playerIds.filter((id) => id !== uid),
        log: `${r.players.find((p) => p.uid === uid)?.name || "Someone"} left`,
      };
      if (!players.length) upd.status = "closed";
      else if (r.host === uid) { upd.host = players[0].uid; upd.heartbeat = serverTimestamp(); }
      tx.update(ref, upd);
    });
  } catch {}
}

// ----- three screens: home, lobby (…/#lobby), and the card table -----
let lobbyOpen = false;
function updateView() {
  const atGame = room && !(isLobbyRoom(room) && room.status === "lobby");
  const atLobby = !atGame && (lobbyOpen || (room && isLobbyRoom(room)));
  const wasLobby = inLobbyView();
  $("lobby").hidden = atGame || atLobby;
  $("lobbyScreen").hidden = !atLobby;
  $("game").hidden = !atGame;
  if (atLobby && !wasLobby) {
    walkerEls.forEach((el) => el.remove()); walkerEls.clear();
    if (room && me.seated) {
      layoutFloor(LOBBY_TABLES.map(tableState));
      const L = floorLayout.tables.get(roomId), i = mySeat(room);
      if (L?.seatPos[i]) { me.x = L.seatPos[i].x; me.y = L.seatPos[i].y; }
    }
    renderFloor();
    writePresence();
  }
  if (!atLobby && wasLobby) clearPresence();
  renderSeatBar();
}

function openLobby() {
  if (blockedCheck() || !myName()) return;
  lobbyOpen = true;
  me = { x: 44 + Math.random() * 12, y: 92, seated: false }; // walk in through the entrance
  if (location.hash !== "#lobby") history.pushState(null, "", "#lobby");
  updateView();
  scrollTo(0, 0);
}

async function closeLobby() {
  if (myLobbyTable()) await exitRoom();
  lobbyOpen = false;
  if (location.hash) history.pushState(null, "", location.pathname);
  updateView();
}

addEventListener("popstate", () => {
  if (location.hash === "#lobby" && !lobbyOpen) openLobby();
  else if (!location.hash && lobbyOpen && !room) { lobbyOpen = false; updateView(); }
  else if (!location.hash && myLobbyTable()) closeLobby();
});

// ---------- lounges (registered players' own tables) ----------
const LOUNGE_ROUND_CHOICES = [3, 5, 8, 10];
const DEFAULT_LOUNGE_ROUNDS = 5;

function createLounge() {
  if (!isRegistered()) return toast("🔒 Register to create your own lounge. Anyone can join one with a code.");
  createRoom({ isPublic: false }).catch((e) => toast(errMsg(e)));
}

function setGame(game) {
  if (room.host !== uid || room.status !== "lobby" || isLobbyRoom(room) || gameOf(room) === game) return;
  updateDoc(roomRef(), { game, target: game === "call" ? CALL_DEFAULT_TARGET : DEFAULT_TARGET }).catch((e) => toast(errMsg(e)));
}

function setEndMode(mode) {
  if (room.host !== uid || room.status !== "lobby" || isLobbyRoom(room)) return;
  updateDoc(roomRef(), { endMode: mode }).catch((e) => toast(errMsg(e)));
}

function setRoundsLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 50) return toast("Pick between 1 and 50 rounds");
  if (room.host !== uid || room.status !== "lobby") return;
  updateDoc(roomRef(), { roundsLimit: n }).catch((e) => toast(errMsg(e)));
}

// When does this game end? Lobby: 4 rounds. Lounge: the owner's choice of points or rounds.
function gameFinished(r, totals) {
  if (isLobbyRoom(r)) return (r.gameRound || 0) >= LOBBY_ROUNDS;
  if (r.endMode === "rounds") return (r.gameRound || 0) >= (r.roundsLimit || DEFAULT_LOUNGE_ROUNDS);
  return Object.values(totals).some((t) => t >= (r.target || DEFAULT_TARGET));
}
function roundsTotal(r) {
  if (isLobbyRoom(r)) return LOBBY_ROUNDS;
  return r.endMode === "rounds" ? r.roundsLimit || DEFAULT_LOUNGE_ROUNDS : null;
}

function enterRoom(code) {
  roomId = code;
  if (LOBBY_TABLES.some((t) => t.id === code)) { lobbyOpen = true; me.seated = true; }
  location.hash = code;
  $("roomCode").textContent = code;
  unsubRoom?.(); unsubHand?.();
  lastReactionId = undefined;
  heapKey = null;
  unsubRoom = onSnapshot(roomRef(), (snap) => {
    if (!snap.exists()) { toast("Room was deleted"); return leaveRoom(); }
    const prev = room;
    room = snap.data();
    if (!room.playerIds.includes(uid)) { toast("You're not in this room"); return leaveRoom(); }
    const sameRound = prev && prev.round === room.round;

    if (sameRound && (room.reshuffles || 0) > (prev.reshuffles || 0)) {
      toast("Middle pile ran out: discards shuffled into a new pile");
      const d = $("deck");
      d.classList.remove("shuffling"); void d.offsetWidth; d.classList.add("shuffling");
    }
    // reactions (skip the one already there when I open the room)
    const rx = room.reaction;
    if (lastReactionId !== undefined && rx && rx.id !== lastReactionId) showBubble(rx.uid, rx.text);
    lastReactionId = rx?.id ?? null;
    // someone just said they're one card from DIGU
    if (sameRound && room.status === "playing") {
      for (const p of room.playerIds) {
        if (room.almost?.[p] && !prev.almost?.[p]) {
          showBubble(p, "1 card to DIGU! 🔥", true);
          if (p !== uid) toast(`${nameOf(p)} is 1 card from DIGU!`);
        }
      }
    }

    updateView();
    render();
    afterUpdate();
    renderFloor();
    if (!prev && inLobbyView()) writePresence(); // now that the table has loaded, show me sitting in it
    // a full lobby table starts by itself
    if (isLobbyRoom(room) && room.status === "lobby" && room.host === uid
        && room.players.length >= seatsOf(room) && enterRoom.autoStarted !== `${roomId}-${room.round}`) {
      enterRoom.autoStarted = `${roomId}-${room.round}`;
      dealRound();
    }
    if (room.status === "ended" && resultsRound !== room.round) {
      resultsRound = room.round;
      clearTimeout(resultsTimer);
      // let everyone watch the DIGU card flip first (no wait if I just opened the page)
      resultsTimer = setTimeout(showResults, prev ? RESULTS_DELAY : 0);
    }
    if (room.status === "ended") {
      if (!$("results").hidden) renderResults(); // totals / game-over update when the host saves scores
    }
    if (room.status !== "ended") { resultsRound = 0; clearTimeout(resultsTimer); $("results").hidden = true; }
  }, (e) => toast(errMsg(e)));
  unsubHand = onSnapshot(handRef(), (snap) => {
    const cards = snap.exists() ? snap.data().cards : [];
    // keep my own arrangement: existing cards stay in place, new ones go on the end
    hand = [...hand.filter((c) => cards.includes(c)), ...cards.filter((c) => !hand.includes(c))];
    if (!hand.includes(selected)) selected = null;
    render();
    afterUpdate();
  });
}

function leaveRoom() {
  unsubRoom?.(); unsubHand?.();
  unsubRoom = unsubHand = null;
  clearTimeout(resultsTimer);
  roomId = null; room = null; hand = [];
  me.seated = false;
  history.replaceState(null, "", lobbyOpen ? "#lobby" : location.pathname);
  $("results").hidden = true;
  updateView();
  renderFloor();
}

// ---------- host actions ----------
function setTarget(value) {
  const t = Math.round(Number(value));
  if (!Number.isFinite(t) || t < 50 || t > 100000) return toast("Pick a target between 50 and 100000");
  if (room.host !== uid || room.status !== "lobby") return;
  updateDoc(roomRef(), { target: t }).catch((e) => toast(errMsg(e)));
}

function setMaxPlayers(n) {
  if (room.host !== uid || room.status !== "lobby") return;
  if (n < room.players.length) return toast(`${room.players.length} players are already in`);
  if (isLobbyRoom(room) && n > LOBBY_MAX) return toast(`Lobby tables seat up to ${LOBBY_MAX}`);
  updateDoc(roomRef(), { maxPlayers: n }).catch((e) => toast(errMsg(e)));
}

// Game over: back to the lobby with everyone at 0, so the host can pick a new target.
function playAgain() {
  if (room.host !== uid && !isLobbyRoom(room)) return;
  const scores = Object.fromEntries(room.playerIds.map((p) => [p, 0]));
  updateDoc(roomRef(), {
    status: "lobby", scores, gameOver: false, champions: null, gameRound: 0,
    lastChampions: room.champions || null, almost: {},
    log: isLobbyRoom(room) ? "Back in the lobby: press Play to go again" : "New game: pick the settings and deal",
  }).catch((e) => toast(errMsg(e)));
}

async function dealRound() {
  if (room.gameOver) return;
  // at a lobby table, anyone who has left the lobby since sitting down is let go before dealing
  if (isLobbyRoom(room) && room.status === "lobby") {
    const here = room.players.filter((p) => p.uid === uid || (presenceFresh(presence.get(p.uid)) && presence.get(p.uid).roomId === roomId));
    if (here.length !== room.players.length) {
      if (here.length < 2) return toast("Wait for at least one more player to sit down");
      await updateDoc(roomRef(), {
        players: here, playerIds: here.map((p) => p.uid),
        scores: Object.fromEntries(here.map((p) => [p.uid, room.scores?.[p.uid] || 0])),
      }).catch(() => {});
      room = { ...room, players: here, playerIds: here.map((p) => p.uid) };
    }
  }
  const n = room.playerIds.length;
  if (n < 2) return toast("Need at least 2 players");
  // DIGU: 10 cards each (two decks for 5–6 players). CALL: 5 cards each, one deck is enough.
  const call = gameOf(room) === "call";
  const handSize = call ? C.CALL_HAND_SIZE : C.HAND_SIZE;
  const deck = C.shuffle(C.buildDeck(!call && n >= 5 ? 2 : 1));
  const batch = writeBatch(db);
  for (const p of room.playerIds) {
    batch.set(handRef(p), { cards: deck.splice(0, handSize) });
  }
  const round = (room.round || 0) + 1;
  batch.update(roomRef(), {
    status: "playing",
    host: uid, // whoever presses Play runs this game (deals rounds, saves scores)
    deck,
    discard: [],                   // the thrown pile starts empty in both games
    turn: (round - 1) % n, // starting player rotates each round
    phase: call ? "throw" : "draw", // CALL: throw first, then take; DIGU: take first, then throw
    lastThrow: null, pickable: null, thrownNow: null,
    moveId: 0,
    reshuffles: 0,
    almost: {},
    winner: null,
    winnerSets: null,
    diguCard: null,
    scored: false,
    round,
    gameRound: (room.gameRound || 0) + 1,
    log: roundsTotal(room) ? `Round ${(room.gameRound || 0) + 1} of ${roundsTotal(room)}` : `Round ${round} dealt`,
  });
  try { await batch.commit(); sendNotify(room?.gameRound > 1 ? "round" : "start"); } catch (e) { toast(errMsg(e)); }
}

// ---------- turn actions ----------
// Moves are written straight from the local copy of the game (no server round trip first),
// so they show on your screen instantly.
const nameOf = (u) => room.players.find((p) => p.uid === u)?.name || "?";
const isMyTurn = () => room?.status === "playing" && room.playerIds[room.turn] === uid;
// DIGU turn: take a card ("draw"), then throw one ("discard").
// CALL turn: throw first ("throw"), then take a card ("draw") — the previous player's last thrown
// card (room.pickable) or the top of the middle pile.
const canDraw = () => isMyTurn() && room.phase === "draw" && (isCall() || hand.length <= C.HAND_SIZE);
const canThrow = () => isMyTurn() && room.phase === (isCall() ? "throw" : "discard");
const mustThrowFirst = () => isCall() && isMyTurn() && room.phase === "throw";

function claimAction() {
  const key = `${room.round}-${room.moveId || 0}-${room.phase}`;
  if (actedKey === key) return false;
  actedKey = key;
  return true;
}

// Save a move. Once the server has it, optionally tell the other players' phones (push).
function commit(batch, notifyKind = null) {
  const code = roomId;
  batch.commit()
    .then(() => { if (notifyKind) sendNotify(notifyKind, code); })
    .catch((e) => { actedKey = null; toast(errMsg(e)); });
}

function nextTurn(log) {
  return {
    turn: (room.turn + 1) % room.playerIds.length,
    phase: isCall() ? "throw" : "draw",
    moveId: (room.moveId || 0) + 1,
    log,
  };
}

function draw(from) {
  if (mustThrowFirst()) return toast("Throw a card first");
  if (!canDraw()) return;
  if (isCall()) return callDraw(from);
  let deck = [...room.deck], discard = [...room.discard], card, reshuffled = false;
  if (from === "discard") {
    if (!discard.length) return toast("Nothing has been thrown yet · take from the middle pile");
    card = discard.pop();
  } else {
    if (!deck.length) { // safety net; normally reshuffled already when the pile ran out
      if (discard.length <= 1) return toast("No cards left to draw");
      ({ deck, discard } = C.reshuffleDiscard(discard));
      reshuffled = true;
    }
    card = deck.pop();
  }
  if (!claimAction()) return;
  const b = writeBatch(db);
  b.update(roomRef(), {
    deck, discard, phase: "discard",
    log: `${nameOf(uid)} took ${from === "discard" ? "the discard" : "from the pile"}`,
    ...(reshuffled ? { reshuffles: (room.reshuffles || 0) + 1 } : {}),
  });
  b.update(handRef(), { cards: [...hand, card] });
  lastDrawn = card;
  selected = null;
  callSel.clear();
  commit(b);
}

// CALL, second half of the turn: take the previous player's last thrown card, or one from the
// middle pile. That ends the turn.
function callDraw(from) {
  let deck = [...room.deck], discard = [...room.discard], card;
  if (from === "discard") {
    const i = room.pickable ? discard.lastIndexOf(room.pickable) : -1;
    if (i < 0) return toast("There's no card from the last player to take · take from the middle pile");
    card = discard.splice(i, 1)[0];
  } else {
    if (!deck.length) return toast("No cards left to draw");
    card = deck.pop();
  }
  if (!claimAction()) return;
  const b = writeBatch(db);
  b.update(roomRef(), {
    deck, discard, lastThrow: room.thrownNow || null, pickable: null, thrownNow: null,
    ...nextTurn(`${nameOf(uid)} took ${from === "discard" ? "the last thrown card" : "from the pile"}`),
  });
  b.update(handRef(), { cards: [...hand, card] });
  lastDrawn = card;
  selected = null;
  callSel.clear();
  commit(b, "turn");
}

// CALL, first half of the turn: throw one card, or several of the same number together.
// The previous player's last thrown card stays available to take (it's under mine).
function callThrow(ids, timedOut) {
  if (!claimAction()) return;
  const rest = hand.filter((c) => !ids.includes(c));
  const prevLast = room.lastThrow?.length ? room.lastThrow[room.lastThrow.length - 1] : null;
  const pickable = prevLast && room.discard.includes(prevLast) ? prevLast : null;
  const what = ids.length > 1 ? `${ids.length} × ${C.label(C.parse(ids[0]).r)}` : "a card";
  const upd = {
    discard: [...room.discard, ...ids], phase: "draw", pickable, thrownNow: ids,
    log: timedOut ? `${nameOf(uid)} ran out of time` : `${nameOf(uid)} threw ${what}`,
  };
  // middle pile is empty: shuffle the older thrown cards into a new pile (keep the takeable one)
  if (!room.deck.length) {
    const pool = room.discard.filter((c) => c !== pickable);
    if (pool.length) {
      upd.deck = C.shuffle(pool);
      upd.discard = [...(pickable ? [pickable] : []), ...ids];
      upd.log += " · thrown cards shuffled into a new middle pile";
      upd.reshuffles = (room.reshuffles || 0) + 1;
    }
  }
  const b = writeBatch(db);
  b.update(handRef(), { cards: rest });
  b.update(roomRef(), upd);
  selected = null;
  callSel.clear();
  lastDrawn = null;
  commit(b);
}

// DIGU: throw one card; a throw that leaves a winning hand calls DIGU automatically.
// CALL: throw one card, or several cards of the same number together.
function throwCard(cardIds, timedOut = false) {
  const ids = Array.isArray(cardIds) ? cardIds : [cardIds];
  if (!canThrow() || !ids.length || !ids.every((c) => hand.includes(c))) return;
  const call = isCall();
  if (call ? !C.canThrowTogether(ids) : ids.length !== 1) return toast("Only cards of the same number can be thrown together");
  if (call) return callThrow(ids, timedOut);
  const rest = hand.filter((c) => !ids.includes(c));
  const sets = call ? null : C.findWinningLayout(rest);
  if (!claimAction()) return;
  const upd = { discard: [...room.discard, ...ids] };
  const what = ids.length > 1 ? `${ids.length} × ${C.label(C.parse(ids[0]).r)}` : "a card";
  Object.assign(upd, sets
    ? endUpdate(sets, ids[0])
    : nextTurn(timedOut ? `${nameOf(uid)} ran out of time` : `${nameOf(uid)} threw ${what}`));
  // Middle pile is empty: shuffle the discards into a new pile right away, in a new order.
  if (!sets && !room.deck.length && upd.discard.length > 1) {
    Object.assign(upd, C.reshuffleDiscard(upd.discard));
    upd.log += " · discard pile shuffled into a new middle pile";
    upd.reshuffles = (room.reshuffles || 0) + 1;
  }
  // I said "1 card to DIGU" but this throw broke it: take the badge down
  if (!call && !sets && room.almost?.[uid] && !isOneAway(rest)) upd[`almost.${uid}`] = false;
  const b = writeBatch(db);
  b.update(handRef(), { cards: rest });
  b.update(roomRef(), upd);
  selected = null;
  callSel.clear();
  lastDrawn = null;
  commit(b, sets ? "ended" : "turn");
}

// CALL: at the start of your turn, with a count of 7 or less, end the round.
const canCall = () => isCall() && isMyTurn() && room.phase === "throw" && hand.length > 0 && C.handValue(hand) <= C.CALL_LIMIT;
function onCall() {
  if (!isCall() || !isMyTurn()) return;
  if (room.phase !== "throw") return toast("You can only CALL at the start of your turn, before throwing");
  const v = C.handValue(hand);
  if (v > C.CALL_LIMIT) return toast(`You can CALL with ${C.CALL_LIMIT} or less. Your count is ${v}.`);
  if (!claimAction()) return;
  const b = writeBatch(db);
  b.update(roomRef(), {
    status: "ended", winner: uid, diguCard: null, winnerSets: null,
    diguStyle: { font: myPrefs().font, color: myPrefs().color },
    log: `${nameOf(uid)} called CALL with ${v}!`,
  });
  commit(b, "ended");
}

// Which card to throw for a DIGU right now (the tapped card first), or null.
function diguThrow() {
  if (!canThrow()) return null;
  const order = selected ? [selected, ...hand.filter((c) => c !== selected)] : hand;
  return order.find((c) => C.findWinningLayout(hand.filter((x) => x !== c))) || null;
}

function onDigu() {
  if (!isMyTurn()) return;
  if (room.phase === "draw") {
    const sets = C.findWinningLayout(hand);
    if (!sets) return toast("Your hand isn't 3 + 3 + 4 sets yet");
    if (!claimAction()) return;
    const b = writeBatch(db);
    b.update(roomRef(), endUpdate(sets, null));
    return commit(b, "ended");
  }
  const c = diguThrow();
  if (!c) return toast("Not a DIGU yet");
  throwCard(c);
}

function endUpdate(sets, cardId) {
  // Firestore can't store arrays inside arrays, so each set is a comma-joined string
  return {
    status: "ended", winner: uid, diguCard: cardId,
    diguStyle: { font: myPrefs().font, color: myPrefs().color }, // everyone sees the winner's shout style
    winnerSets: sets.map((s) => s.join(",")), log: `${nameOf(uid)} called DIGU!`,
  };
}

// ---------- "1 card to DIGU" ----------
function isOneAway(cards) {
  const key = [...cards].sort().join();
  if (oneAwayCache.key === key) return oneAwayCache.value;
  const value = C.oneAway(cards);
  Object.assign(oneAwayCache, { key, value });
  return value;
}

// The check takes a moment, so it runs just after the screen updates, not during it.
function oneAwayNow() {
  if (hand.length !== C.HAND_SIZE) return false;
  const key = [...hand].sort().join();
  if (oneAwayCache.key === key) return oneAwayCache.value;
  if (!oneAwayCache.pending) {
    oneAwayCache.pending = true;
    setTimeout(() => { oneAwayCache.pending = false; isOneAway(hand); render(); }, 30);
  }
  return false;
}

function announceAlmost() {
  if (!room || room.status !== "playing" || room.almost?.[uid] || !oneAwayNow()) return;
  updateDoc(roomRef(), { [`almost.${uid}`]: true }).catch((e) => toast(errMsg(e)));
}

// ---------- reactions ----------
function sendReaction(text) {
  if (!roomId) return;
  const now = Date.now();
  if (now - lastReactAt < 1200) return toast("Slow down 🙂");
  lastReactAt = now;
  $("reactTray").hidden = true;
  updateDoc(roomRef(), {
    reaction: { uid, text, id: Math.random().toString(36).slice(2) },
  }).catch((e) => toast(errMsg(e)));
}

function showBubble(fromUid, text, special = false) {
  const b = document.createElement("div");
  b.className = "bubble" + (special ? " special" : "") + (/^\p{Extended_Pictographic}+$/u.test(text) ? " emoji" : "");
  const who = document.createElement("small");
  const pl = room?.players.find((p) => p.uid === fromUid);
  who.textContent = (pl?.avatar ? pl.avatar + " " : "") + nameOf(fromUid);
  b.append(who, document.createTextNode(text));
  const chip = document.querySelector(`.player[data-uid="${CSS.escape(fromUid)}"]`);
  const r = chip?.getBoundingClientRect();
  if (r && r.width) {
    b.style.left = Math.min(Math.max(r.left + r.width / 2, 70), innerWidth - 70) + "px";
    b.style.top = r.bottom + 8 + "px";
  } else { b.style.left = "50%"; b.style.top = "70px"; }
  document.body.append(b);
  setTimeout(() => b.remove(), 3200);
}

// ---------- 50-second timer ----------
// Your own screen plays for you when your time runs out: if you haven't drawn, your turn is passed;
// if you have, the card you just picked up (or your worst card) is thrown away.
// If a player's device is offline, the others skip them a few seconds later.
function autoPlay() {
  if (isCall()) { // out of time: throw the highest card if not thrown yet, then take from the middle pile
    if (room.phase === "throw") {
      throwCard([hand.reduce((a, b) => (C.callValue(b) > C.callValue(a) ? b : a))], true);
      setTimeout(() => { if (canDraw()) draw("deck"); }, 600);
    } else draw("deck");
    return;
  }
  if (room.phase === "draw") {
    if (!claimAction()) return;
    const b = writeBatch(db);
    b.update(roomRef(), nextTurn(`${nameOf(uid)} ran out of time`));
    return commit(b, "turn");
  }
  if (isCall()) { // throw the highest card
    return throwCard([hand.reduce((a, b) => (C.callValue(b) > C.callValue(a) ? b : a))], true);
  }
  let card = diguThrow();
  if (!card) card = hand.includes(lastDrawn) ? lastDrawn : worstCard();
  throwCard(card, true);
}

function worstCard() {
  const { leftover } = C.bestLayout(hand);
  const pool = leftover.length ? leftover : hand;
  return pool.reduce((a, b) => (C.points(b) > C.points(a) ? b : a));
}

async function skipOfflinePlayer() {
  const { round } = room, moveId = room.moveId || 0;
  try {
    let skipped = false;
    await runTransaction(db, async (tx) => {
      const r = (await tx.get(roomRef())).data();
      if (r.status !== "playing" || r.round !== round || (r.moveId || 0) !== moveId) return; // already moved on
      const call = r.game === "call";
      tx.update(roomRef(), {
        turn: (r.turn + 1) % r.playerIds.length,
        phase: call ? "throw" : "draw",
        ...(call && r.phase === "draw" ? { lastThrow: r.thrownNow || null, pickable: null, thrownNow: null } : {}),
        moveId: moveId + 1,
        log: `${nameOf(r.playerIds[r.turn])} ran out of time`,
      });
      skipped = true;
    });
    if (skipped) sendNotify("turn");
  } catch { /* someone else skipped first */ }
}

function tick() {
  const box = $("timer");
  if (!room || room.status !== "playing") { box.hidden = true; turnKey = null; return; }
  const key = `${room.round}-${room.moveId || 0}`;
  if (key !== turnKey) { turnKey = key; turnSeenAt = Date.now(); }
  const left = TURN_MS - (Date.now() - turnSeenAt);
  const secs = Math.max(0, Math.ceil(left / 1000));
  box.hidden = false;
  $("timerText").textContent = isMyTurn() ? `${secs}s left` : `${nameOf(room.playerIds[room.turn])} · ${secs}s`;
  $("timerBar").style.transform = `scaleX(${Math.max(0, left / TURN_MS)})`;
  box.classList.toggle("low", secs <= 10);
  box.classList.toggle("mine", isMyTurn());
  const chipTime = document.querySelector(".player.active .ptime");
  if (chipTime) chipTime.textContent = `${secs}s`;

  if (timeoutFired === key) return;
  if (isMyTurn() && left <= 0) { timeoutFired = key; autoPlay(); }
  else if (!isMyTurn() && left <= -GRACE_MS) { timeoutFired = key; skipOfflinePlayer(); }
}
setInterval(tick, 200);

// If I was skipped after drawing, I still hold 11 cards: go straight to throwing one away.
function afterUpdate() {
  if (!isCall() && isMyTurn() && room.phase === "draw" && hand.length > C.HAND_SIZE && claimAction()) {
    const b = writeBatch(db);
    b.update(roomRef(), { phase: "discard" });
    commit(b);
  }
}

// ---------- results & scoring ----------
// DIGU caller: +100 bonus + their card values. Others: cards in sets minus leftover cards,
// or -100 if they have no set at all. First to the target ends the game; highest total wins.
async function showResults() {
  if (!room || room.status !== "ended") return;
  let snaps;
  try { snaps = await getDocs(collection(db, "rooms", roomId, "hands")); }
  catch (e) { return toast(errMsg(e)); }
  const hands = {};
  snaps.forEach((s) => (hands[s.id] = s.data().cards));

  if (gameOf(room) === "call") {
    const cs = C.callScores(Object.fromEntries(room.players.map((p) => [p.uid, hands[p.uid] || []])), room.winner);
    lastRows = room.players.map((p) => ({
      ...p, ...cs.result[p.uid], call: true, sets: hands[p.uid]?.length ? [C.sortByRank(hands[p.uid])] : [], leftover: [],
    }));
    lastRows.caught = cs.caught;
    lastRows.catchers = cs.catchers;
  } else {
    lastRows = room.players.map((p) => {
      const winnerSets = p.uid === room.winner ? room.winnerSets.map((s) => s.split(",")) : null;
      return { ...p, ...C.roundScore(hands[p.uid] || [], winnerSets) };
    });
  }
  const rows = lastRows;
  recordRound(rows.find((r) => r.uid === uid));

  // host adds this round's points to the running totals, once, and checks for game over
  if (room.host === uid && !room.scored) {
    try {
      await runTransaction(db, async (tx) => {
        const r = (await tx.get(roomRef())).data();
        if (r.scored || r.round !== resultsRound) return;
        const upd = { scored: true };
        const totals = {};
        rows.forEach((row) => {
          upd[`scores.${row.uid}`] = increment(row.pts);
          totals[row.uid] = (r.scores?.[row.uid] || 0) + row.pts;
        });
        if (gameFinished(r, totals)) {
          const top = (gameOf(r) === "call" ? Math.min : Math.max)(...Object.values(totals)); // CALL: lowest wins
          upd.gameOver = true;
          upd.champions = Object.keys(totals).filter((u) => totals[u] === top);
        }
        tx.update(roomRef(), upd);
      });
    } catch (e) { toast(errMsg(e)); }
  }
  renderResults();
  $("results").hidden = false;
}

function renderResults() {
  if (!lastRows || !room) return;
  const target = room.target || DEFAULT_TARGET;
  // until the host has saved this round, show totals with this round added
  const totalOf = (u) => (room.scores?.[u] || 0) + (room.scored ? 0 : lastRows.find((r) => r.uid === u)?.pts || 0);
  const totals = Object.fromEntries(lastRows.map((r) => [r.uid, totalOf(r.uid)]));
  const low = gameOf(room) === "call";
  const top = (low ? Math.min : Math.max)(...Object.values(totals));
  const rounds = roundsTotal(room);
  const over = room.gameOver || gameFinished(room, totals);
  const champs = room.champions || Object.keys(totals).filter((u) => totals[u] === top);
  if (room.gameOver) recordWin();

  const list = $("resultsList");
  list.innerHTML = "";
  [...lastRows].sort((a, b) => (low ? a.pts - b.pts : b.pts - a.pts)).forEach((row) => {
    const div = document.createElement("div");
    const good = low ? row.pts === 0 : row.uid === room.winner;
    const bad = low ? row.how === "caught" : row.pts < 0;
    div.className = "result-row" + (good ? " winner" : "") + (bad ? " negative" : "");
    const head = document.createElement("div");
    head.className = "result-head";
    const name = document.createElement("strong");
    name.textContent = row.name + (row.uid === uid ? " (you)" : "") + (row.digu ? " · DIGU" : "")
      + (row.how === "won" || row.how === "caught" ? " · CALL" : "");
    const pts = document.createElement("span");
    pts.className = "round-pts";
    pts.textContent = (row.pts > 0 ? "+" : "") + row.pts;
    const who = room.players.find((p) => p.uid === row.uid) || row;
    head.append(avatarEl(who, "avatar small"), name, pts);
    const how = document.createElement("div");
    how.className = "breakdown";
    how.textContent = row.call
      ? ({ won: `Called with ${row.count} · lowest`, caught: `Called with ${row.count} · caught! +${C.CALL_PENALTY}`,
           "caught-caller": `Count ${row.count} · caught the CALL`, count: `Count ${row.count}` })[row.how]
      : row.digu
      ? `DIGU bonus +${C.DIGU_BONUS} · cards +${row.setPts}`
      : row.noSets
        ? `No sets: ${C.NO_SET_PENALTY}`
        : `Sets +${row.setPts} · leftover −${row.leftPts}`;
    how.append(Object.assign(document.createElement("b"), { textContent: `Total ${totals[row.uid]}` }));
    div.append(head, how);

    const cardsWrap = document.createElement("div");
    cardsWrap.className = "result-cards";
    row.sets.forEach((s) => {
      const g = document.createElement("div");
      g.className = "set";
      s.forEach((c) => g.append(cardEl(c, { small: true })));
      cardsWrap.append(g);
    });
    if (row.leftover.length) {
      const g = document.createElement("div");
      g.className = "set leftover";
      row.leftover.forEach((c) => g.append(cardEl(c, { small: true })));
      cardsWrap.append(g);
    }
    div.append(cardsWrap);
    list.append(div);
  });

  $("resultsTitle").textContent = over
    ? `🏆 ${champs.map(nameOf).join(" & ")} ${champs.length > 1 ? "win" : "wins"} the game!`
    : low
      ? (lastRows.caught
        ? `${nameOf(room.winner)} called CALL, but ${lastRows.catchers.map(nameOf).join(" & ")} had less!`
        : `${nameOf(room.winner)} called CALL and won the round!`)
      : `${nameOf(room.winner)} called DIGU!`;
  $("resultsSub").textContent = rounds
    ? (over ? `Final score ${top} after ${rounds} rounds` : `Round ${room.gameRound || 1} of ${rounds} · leader has ${top}${low ? " (lowest wins)" : ""}`)
    : (over ? `Final score ${top} · playing to ${target}` : `Playing to ${target} · leader has ${top}`);
  $("results").classList.toggle("game-over", over);
  const host = room.host === uid;
  $("nextRoundBtn").hidden = !host || over;
  const lobbyTable = isLobbyRoom(room);
  $("playAgainBtn").hidden = !over || (!host && !lobbyTable);
  $("playAgainBtn").textContent = lobbyTable ? "Back to the lobby" : "New game";
  $("waitNext").hidden = host || (over && lobbyTable);
  $("waitNext").textContent = over ? "Waiting for the host to start a new game…" : "Waiting for the host to deal the next round…";
}

// ---------- games played, career points & badges ----------
// Every finished round counts toward unlocks for everyone (guests too).
// Registered players also add the round's points to their career total, which sets their rank.
function recordRound(myRow) {
  if (!uid || !roomId || !myRow) return;
  const key = `${roomId}-${room.round}`;
  if (recordRound.done === key) return;
  recordRound.done = key;
  const reg = isRegistered();
  runTransaction(db, async (tx) => {
    const ref = doc(db, "users", uid);
    const d = (await tx.get(ref)).data() || {};
    if (d.lastCounted === key) return;
    const upd = { gamesPlayed: (d.gamesPlayed || 0) + 1, lastCounted: key };
    if (reg) {
      // CALL is lowest-wins, so it earns career points for a low score: 0 pts = +50, 50 pts or more = 0
      const earned = myRow.call ? Math.max(0, C.CALL_PENALTY - myRow.pts) : myRow.pts;
      upd.careerPoints = (d.careerPoints || 0) + earned;
      if (!myRow.call) upd.bestRound = Math.max(d.bestRound || 0, myRow.pts);
      if (myRow.digu) upd.digus = (d.digus || 0) + 1;
    }
    tx.set(ref, upd, { merge: true });
  }).catch(() => { recordRound.done = null; });
}

function recordWin() {
  if (!uid || !isRegistered() || !room?.champions?.includes(uid)) return;
  const key = `${roomId}-${room.round}-win`;
  if (recordWin.done === key) return;
  recordWin.done = key;
  runTransaction(db, async (tx) => {
    const ref = doc(db, "users", uid);
    const d = (await tx.get(ref)).data() || {};
    if (d.lastWin === key) return;
    tx.set(ref, { gameWins: (d.gameWins || 0) + 1, lastWin: key }, { merge: true });
  }).catch(() => { recordWin.done = null; });
}

// ---------- accounts ----------
const isRegistered = () => !!auth.currentUser && !auth.currentUser.isAnonymous;
const myRank = () => (isRegistered() ? P.rankIndex(profile.careerPoints || 0) : 0);
const myPrefs = () => P.allowedPrefs(profile.prefs, myRank(), isRegistered());

// What other players see about me in the room.
function myEntry(name) {
  const reg = isRegistered();
  return {
    uid, name,
    avatar: reg ? profile.avatar || P.AVATARS[0] : null,
    rank: reg ? myRank() : null,
    badges: reg ? P.earnedBadges(profile).length : 0,
    photoV: reg && hasPhoto() ? profile.photoV : null, // others load the picture from my profile
  };
}
const hasPhoto = () => !!(profile.usePhoto && profile.photo);

// Keep my name / avatar / rank in the room up to date (e.g. after ranking up).
function syncMyEntry() {
  if (!roomId || !room) return;
  const cur = room.players.find((p) => p.uid === uid);
  if (!cur) return;
  const want = myEntry(isRegistered() ? profile.name || cur.name : cur.name);
  const same = ["name", "avatar", "rank", "badges", "photoV"].every((k) => (cur[k] ?? null) === (want[k] ?? null));
  if (same) return;
  runTransaction(db, async (tx) => {
    const r = (await tx.get(roomRef())).data();
    tx.update(roomRef(), { players: r.players.map((p) => (p.uid === uid ? { ...want, seat: p.seat ?? null } : p)) });
  }).catch(() => {});
}

let unsubUser = null;
function watchMyStats() {
  unsubUser?.();
  gamesPlayed = null;
  unsubUser = onSnapshot(doc(db, "users", uid), (snap) => {
    const d = snap.data() || {};
    const before = profile;
    profile = d;
    if (snap.metadata?.fromCache === false || !snap.metadata) {
      ensureProfile(d, snap.exists());
      if (snap.exists() && watchMyStats.seen !== uid && !amBlocked) { // "last seen" for the admin list
        watchMyStats.seen = uid;
        setDoc(doc(db, "users", uid), { lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
      }
    }
    const n = d.gamesPlayed || 0;
    if (gamesPlayed !== null && n > gamesPlayed) {
      const fresh = REACTIONS.filter(([, at]) => at > gamesPlayed && at <= n).map(([t]) => t);
      if (SORT_UNLOCK > gamesPlayed && SORT_UNLOCK <= n) fresh.push("Sort by suit & number");
      const newBadges = P.earnedBadges(d).filter((b) => !b.test(before));
      fresh.push(...newBadges.map((b) => `${b.icon} ${b.name}`));
      const r0 = P.rankIndex(before.careerPoints || 0), r1 = P.rankIndex(d.careerPoints || 0);
      if (isRegistered() && r1 > r0) fresh.push(`${P.RANKS[r1].icon} ${P.RANKS[r1].name} rank`);
      if (fresh.length) setTimeout(() => toast(`🔓 Unlocked: ${fresh.join("  ")}`), RESULTS_DELAY + 400);
    }
    gamesPlayed = n;
    $("gamesPlayed").textContent = `Games played: ${n}`;
    applyLook();
    renderAccount();
    renderTray();
    if (!$("profileModal").hidden) renderProfile();
    if (room) { syncMyEntry(); render(); }
  });
}

// A registered account must have a profile document. If sign-up didn't manage to create it
// (e.g. the rules weren't published yet), create it now so saving a name or picture works.
function ensureProfile(d, exists) {
  if (!isRegistered() || (exists && d.registered) || amBlocked) return;
  if (ensureProfile.busy === uid) return;
  ensureProfile.busy = uid;
  setDoc(doc(db, "users", uid), {
    registered: true,
    name: d.name || auth.currentUser.displayName || load("digu-name") || "Player",
    avatar: d.avatar || P.AVATARS[0],
    prefs: d.prefs || P.DEFAULT_PREFS,
  }, { merge: true })
    .then(() => { ensureProfile.busy = null; })
    .catch((e) => { ensureProfile.busy = null; toast(errMsg(e)); });
}

// My table and card-back colours (my own screen only).
function applyLook() {
  const prefs = myPrefs();
  const t = P.byId(P.TABLES, prefs.table);
  const s = document.documentElement.style;
  s.setProperty("--felt-light", t.c[0]);
  s.setProperty("--felt", t.c[1]);
  s.setProperty("--felt-dark", t.c[2]);
  s.setProperty("--back", P.byId(P.DECKS, prefs.deck).bg);
}

// Profile pictures live in each player's profile; rooms only carry a version number,
// so the (small) picture is downloaded once per player and cached.
const photoCache = new Map(); // uid -> { v, url, loading }
function photoFor(p) {
  if (!p.photoV) return null;
  if (p.uid === uid) return hasPhoto() ? profile.photo : null;
  const c = photoCache.get(p.uid);
  if (c?.v === p.photoV) return c.url;
  if (!c?.loading) {
    photoCache.set(p.uid, { v: c?.v, url: c?.url, loading: true });
    getDoc(doc(db, "users", p.uid)).then((snap) => {
      photoCache.set(p.uid, { v: p.photoV, url: snap.data()?.photo || null });
      if (room) render();
    }).catch(() => photoCache.set(p.uid, { v: p.photoV, url: null }));
  }
  return c?.url || null;
}

function fillAvatar(a, p) {
  const url = photoFor(p);
  a.textContent = "";
  a.classList.toggle("guest", !p.avatar && !url);
  a.classList.toggle("photo", !!url);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    a.append(img);
  } else a.textContent = p.avatar || (p.name || "?").trim().charAt(0).toUpperCase();
}

function avatarEl(p, cls = "avatar") {
  const a = document.createElement("span");
  a.className = cls;
  fillAvatar(a, p);
  return a;
}

const meForAvatar = () => ({ uid, name: profile.name, avatar: profile.avatar || P.AVATARS[0], photoV: hasPhoto() ? profile.photoV || 1 : null });

// Upload: crop to a square and shrink to 160px so it stays small (about 10 KB).
async function uploadPhoto(file) {
  if (!file) return;
  if (!isRegistered()) return toast("Register to add a profile picture");
  if (!file.type.startsWith("image/")) return toast("That isn't a picture");
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Couldn't read that picture. Try a JPG or PNG."));
      i.src = url;
    });
    const size = 160, side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    canvas.getContext("2d").drawImage(img,
      (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    URL.revokeObjectURL(url);
    let quality = 0.85, data = canvas.toDataURL("image/jpeg", quality);
    while (data.length > 60000 && quality > 0.4) { quality -= 0.15; data = canvas.toDataURL("image/jpeg", quality); }
    await savePrefs({ photo: data, photoV: Date.now(), usePhoto: true });
    toast("Profile picture saved");
  } catch (e) { toast(errMsg(e)); }
}

function removePhoto() {
  savePrefs({ photo: null, photoV: null, usePhoto: false });
}

// Lobby account bar: guest or registered player.
function renderAccount() {
  const reg = isRegistered();
  $("accountGuest").hidden = reg;
  $("loungeLock").hidden = reg;
  $("createLoungeBtn").classList.toggle("locked-btn", !reg);
  $("createLoungeBtn").textContent = reg ? "Create my lounge" : "🔒 Create my lounge";
  $("accountUser").hidden = !reg;
  $("name").disabled = reg;
  if (reg) {
    const prog = P.rankProgress(profile.careerPoints || 0);
    const rk = P.RANKS[prog.i];
    fillAvatar($("acctAvatar"), meForAvatar());
    $("acctName").textContent = profile.name || "Player";
    $("acctRank").textContent = `${rk.icon} ${rk.name} · ${profile.careerPoints || 0} pts`;
    $("name").value = profile.name || "";
  } else {
    if (!$("name").value.trim()) $("name").value = load("digu-name") || ""; // never overwrite what the player typed
  }
}

// Register = turn this guest into a real account (keeps games played), with a name and avatar.
let pickedAvatar = P.AVATARS[0];
function openAuth(mode) {
  $("authModal").hidden = false;
  $("authModal").dataset.mode = mode;
  $("authTitle").textContent = mode === "register" ? "Create your account" : "Sign in";
  $("authSubmit").textContent = mode === "register" ? "Register" : "Sign in";
  $("authNameRow").hidden = mode !== "register";
  $("authAvatarRow").hidden = mode !== "register";
  $("authSwitch").textContent = mode === "register" ? "Already registered? Sign in" : "New here? Register";
  $("authError").textContent = "";
  if (mode === "register") {
    $("authName").value = $("name").value.trim();
    renderAvatarPicker($("authAvatars"), pickedAvatar, (a) => { pickedAvatar = a; });
  }
}

function renderAvatarPicker(box, current, onPick) {
  box.innerHTML = "";
  for (const a of P.AVATARS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-pick" + (a === current ? " on" : "");
    b.textContent = a;
    b.onclick = () => {
      box.querySelectorAll(".on").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onPick(a);
    };
    box.append(b);
  }
}

const AUTH_ERRORS = {
  "auth/email-already-in-use": "That email is already registered. Try signing in.",
  "auth/credential-already-in-use": "That email is already registered. Try signing in.",
  "auth/invalid-email": "That email doesn't look right.",
  "auth/weak-password": "Password needs at least 6 characters.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/wrong-password": "Wrong email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/operation-not-allowed": "Email sign-in isn't turned on in Firebase yet (Authentication → Sign-in method → Email/Password).",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
};

async function submitAuth(e) {
  e.preventDefault();
  const mode = $("authModal").dataset.mode;
  const email = $("authEmail").value.trim();
  const pw = $("authPassword").value;
  $("authError").textContent = "";
  $("authSubmit").disabled = true;
  try {
    if (mode === "register") {
      const name = $("authName").value.trim().slice(0, 16);
      if (!name) throw { code: "x", message: "Choose a name" };
      const cred = EmailAuthProvider.credential(email, pw);
      const res = await linkWithCredential(auth.currentUser, cred); // same uid: guest progress is kept
      await updateProfile(res.user, { displayName: name });
      await setDoc(doc(db, "users", res.user.uid), {
        name, avatar: pickedAvatar, registered: true, prefs: P.DEFAULT_PREFS,
        careerPoints: 0, digus: 0, gameWins: 0, bestRound: 0, createdAt: serverTimestamp(),
      }, { merge: true });
      store("digu-name", name);
      toast(`Welcome, ${name}! ${pickedAvatar}`);
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
      toast("Signed in");
    }
    $("authModal").hidden = true;
    $("authPassword").value = "";
    renderAccount();
  } catch (err) {
    $("authError").textContent = AUTH_ERRORS[err.code] || err.message || "Something went wrong";
  } finally {
    $("authSubmit").disabled = false;
  }
}

async function logOut() {
  if (roomId) return toast("Leave the room first");
  await signOut(auth);
  profile = {};
  await signInAnonymously(auth); // back to playing as a guest
  toast("Signed out. Playing as guest.");
}

// ---------- admin & blocked players ----------
// You're an admin if the Firebase console has a document admins/{your player ID}.
let amAdmin = false, amBlocked = false, unsubBlocked = null;
let adminUsers = [], adminBanned = new Set(), adminFilter = "all";

function watchRoles() {
  amAdmin = false;
  $("adminBtn").hidden = true;
  getDoc(doc(db, "admins", uid)).then((s) => {
    amAdmin = s.exists();
    $("adminBtn").hidden = !amAdmin;
  }).catch(() => {});
  unsubBlocked?.();
  unsubBlocked = onSnapshot(doc(db, "banned", uid), (s) => {
    amBlocked = s.exists();
    $("blockedNote").hidden = !amBlocked;
    $("lobbyActions").classList.toggle("blocked", amBlocked);
  }, () => {});
}

function blockedCheck() {
  if (amBlocked) { toast("Your account has been blocked by an admin"); return true; }
  return false;
}

async function openAdmin() {
  if (!amAdmin) return;
  $("adminModal").hidden = false;
  $("adminList").innerHTML = '<p class="muted">Loading players…</p>';
  try {
    const [users, banned] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "banned")),
    ]);
    adminBanned = new Set(banned.docs.map((d) => d.id));
    adminUsers = users.docs.map((d) => ({ id: d.id, ...d.data() }));
    // players who were blocked after their profile was deleted still show up
    for (const id of adminBanned) if (!adminUsers.some((u) => u.id === id)) adminUsers.push({ id, deleted: true });
    renderAdmin();
  } catch (e) {
    $("adminList").innerHTML = "";
    toast(errMsg(e));
  }
}

function renderAdmin() {
  const q = $("adminSearch").value.trim().toLowerCase();
  const list = adminUsers
    .filter((u) => adminFilter === "all"
      || (adminFilter === "registered" && u.registered)
      || (adminFilter === "guests" && !u.registered && !u.deleted)
      || (adminFilter === "blocked" && adminBanned.has(u.id)))
    .filter((u) => !q || (u.name || "").toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    .sort((a, b) => (b.careerPoints || 0) - (a.careerPoints || 0) || (b.gamesPlayed || 0) - (a.gamesPlayed || 0));

  const reg = adminUsers.filter((u) => u.registered).length;
  $("adminCount").textContent = `${adminUsers.length} players · ${reg} registered · ${adminBanned.size} blocked`;
  const box = $("adminList");
  box.innerHTML = "";
  if (!list.length) box.innerHTML = '<p class="muted">No players match.</p>';
  for (const u of list) {
    const row = document.createElement("div");
    row.className = "admin-row" + (adminBanned.has(u.id) ? " is-blocked" : "");
    const who = { uid: u.id, name: u.name || (u.registered ? "Player" : "Guest"), avatar: u.registered ? u.avatar : null,
      photoV: u.usePhoto && u.photo ? u.photoV || 1 : null };
    if (who.photoV) photoCache.set(u.id, { v: who.photoV, url: u.photo });
    row.append(avatarEl(who, "avatar"));
    const info = document.createElement("div");
    info.className = "admin-info";
    const rk = P.RANKS[P.rankIndex(u.careerPoints || 0)];
    const name = document.createElement("strong");
    name.textContent = u.deleted ? "(profile deleted)" : who.name;
    const meta = document.createElement("small");
    meta.textContent = u.deleted ? `ID ${u.id}`
      : `${u.registered ? `${rk.icon} ${rk.name} · ${u.careerPoints || 0} pts` : "Guest"} · ${u.gamesPlayed || 0} rounds`
        + (u.lastSeen?.toDate ? ` · seen ${u.lastSeen.toDate().toLocaleDateString()}` : "") + ` · ID ${u.id.slice(0, 8)}…`;
    info.append(name, meta);
    if (adminBanned.has(u.id)) info.append(Object.assign(document.createElement("span"), { className: "tag-blocked", textContent: "BLOCKED" }));
    if (u.id === uid) info.append(Object.assign(document.createElement("span"), { className: "tag-you", textContent: "YOU" }));
    row.append(info);

    const btns = document.createElement("div");
    btns.className = "admin-btns";
    if (u.id !== uid) {
      const ban = document.createElement("button");
      ban.className = "ghost small";
      ban.textContent = adminBanned.has(u.id) ? "Unblock" : "Block";
      ban.onclick = () => toggleBlock(u);
      btns.append(ban);
    }
    if (!u.deleted) {
      const del = document.createElement("button");
      del.className = "danger small";
      del.textContent = "Delete";
      del.onclick = () => deleteUser(u);
      btns.append(del);
    }
    row.append(btns);
    box.append(row);
  }
}

async function deleteUser(u) {
  const label = u.name || "this player";
  const msg = u.id === uid
    ? "Delete YOUR OWN profile? Your stats, rank and picture will be wiped."
    : `Delete ${label}'s profile?\n\nTheir name, avatar, picture, points, rank and badges will be wiped. `
      + "This can't be undone. They can still sign in and start again unless you also block them.";
  if (!confirm(msg)) return;
  try {
    await deleteDoc(doc(db, "users", u.id));
    adminUsers = adminBanned.has(u.id)
      ? adminUsers.map((x) => (x.id === u.id ? { id: x.id, deleted: true } : x))
      : adminUsers.filter((x) => x.id !== u.id);
    renderAdmin();
    toast(`Deleted ${label}`);
  } catch (e) { toast(errMsg(e)); }
}

async function toggleBlock(u) {
  const label = u.name || "this player";
  const blocked = adminBanned.has(u.id);
  if (!blocked && !confirm(`Block ${label}? They won't be able to create or join rooms or save anything.`)) return;
  try {
    if (blocked) {
      await deleteDoc(doc(db, "banned", u.id));
      adminBanned.delete(u.id);
      adminUsers = adminUsers.filter((x) => !(x.id === u.id && x.deleted));
    } else {
      await setDoc(doc(db, "banned", u.id), { by: uid, name: u.name || null, at: serverTimestamp() });
      adminBanned.add(u.id);
    }
    renderAdmin();
    toast(blocked ? `Unblocked ${label}` : `Blocked ${label}`);
  } catch (e) { toast(errMsg(e)); }
}

// ---------- profile: rank, badges, avatar, table / deck / DIGU style ----------
function renderProfile() {
  const reg = isRegistered();
  const pts = profile.careerPoints || 0;
  const prog = P.rankProgress(pts);
  const rk = P.RANKS[prog.i];
  fillAvatar($("profAvatar"), meForAvatar());
  $("photoThumb").innerHTML = "";
  if (profile.photo) {
    const img = document.createElement("img");
    img.src = profile.photo;
    img.alt = "Your picture";
    $("photoThumb").append(img);
  } else $("photoThumb").textContent = "📷";
  $("photoThumb").classList.toggle("on", hasPhoto());
  $("photoRemove").hidden = !profile.photo;
  $("photoUploadLabel").textContent = profile.photo ? "Change picture" : "Upload picture";
  $("profName").value = profile.name || "";
  $("profRank").textContent = `${rk.icon} ${rk.name}`;
  $("profBar").style.transform = `scaleX(${prog.pct})`;
  $("profNext").textContent = prog.next
    ? `${pts} career points · ${prog.toNext} more to ${prog.next.icon} ${prog.next.name}`
    : `${pts} career points · top rank!`;
  $("profStats").innerHTML = "";
  [["Rounds", profile.gamesPlayed || 0], ["DIGUs", profile.digus || 0],
   ["Games won", profile.gameWins || 0], ["Best round", profile.bestRound || 0]].forEach(([k, v]) => {
    const d = document.createElement("div");
    d.innerHTML = `<b></b><small></small>`;
    d.querySelector("b").textContent = v;
    d.querySelector("small").textContent = k;
    $("profStats").append(d);
  });

  const badges = $("profBadges");
  badges.innerHTML = "";
  for (const b of P.BADGES) {
    const has = b.test(profile);
    const el = document.createElement("div");
    el.className = "badge" + (has ? "" : " locked");
    el.title = b.desc;
    el.innerHTML = `<span></span><small></small>`;
    el.firstChild.textContent = has ? b.icon : "🔒";
    el.lastChild.textContent = b.name;
    badges.append(el);
  }

  renderAvatarPicker($("profAvatars"), hasPhoto() ? null : profile.avatar, (a) => savePrefs({ avatar: a, usePhoto: false }));
  const prefs = myPrefs();
  renderStylePicker("profTables", P.TABLES, prefs.table, "table",
    (o) => `background: radial-gradient(circle at 40% 30%, ${o.c[0]}, ${o.c[2]})`);
  renderStylePicker("profDecks", P.DECKS, prefs.deck, "deck", (o) => `background: ${o.bg}`);
  renderStylePicker("profFonts", P.SHOUT_FONTS, prefs.font, "font",
    (o) => `font-family: ${o.css}; font-size: ${o.small ? 9 : 15}px`, "DIGU!");
  renderStylePicker("profColors", P.SHOUT_COLORS, prefs.color, "color",
    (o) => (o.css === "rainbow" ? "" : `color: ${o.css}`), "DIGU!");
  $("profPreview").innerHTML = "";
  $("profPreview").append(shoutEl({ font: prefs.font, color: prefs.color }));
  $("profId").textContent = uid;
  $("profileModal").querySelectorAll(".reg-only").forEach((x) => (x.hidden = !reg));
}

function renderStylePicker(boxId, list, current, key, styleFor, label = "") {
  const box = $(boxId);
  box.innerHTML = "";
  const rank = myRank();
  for (const o of list) {
    const ok = isRegistered() && o.rank <= rank;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "style-pick" + (o.id === current ? " on" : "") + (ok ? "" : " locked");
    b.setAttribute("style", styleFor(o));
    if (key === "color" && o.css === "rainbow") {
      b.innerHTML = '<span class="rainbow-text"></span>';
      b.firstChild.textContent = label;
    } else b.textContent = label;
    b.title = ok ? o.name : `${o.name} · unlocks at ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name}`;
    if (!ok) b.dataset.lock = P.RANKS[o.rank].icon;
    b.onclick = () => ok
      ? savePrefs({ prefs: { [key]: o.id } })
      : toast(`🔒 ${o.name} unlocks at ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name} rank (${P.RANKS[o.rank].at} career points)`);
    box.append(b);
  }
}

// set + merge (not update): works even if the profile document doesn't exist yet
function savePrefs(upd) {
  if (!isRegistered()) return toast("Register to customise");
  return setDoc(doc(db, "users", uid), { registered: true, ...upd }, { merge: true })
    .catch((e) => toast(errMsg(e)));
}

function saveName() {
  const n = $("profName").value.trim().slice(0, 16);
  if (!n || n === profile.name) return;
  store("digu-name", n);
  savePrefs({ name: n });
  if (auth.currentUser) updateProfile(auth.currentUser, { displayName: n }).catch(() => {});
}

// The DIGU shout in a player's chosen font and colour.
function shoutEl(style, text = "DIGU!") {
  const f = P.byId(P.SHOUT_FONTS, style?.font);
  const c = P.byId(P.SHOUT_COLORS, style?.color);
  const s = document.createElement("span");
  s.className = "shout" + (c.css === "rainbow" ? " rainbow-text" : "") + (f.small ? " small-font" : "");
  s.style.fontFamily = f.css;
  s.style.fontSize = f.size + "px";
  if (c.css !== "rainbow") s.style.color = c.css;
  s.textContent = text;
  return s;
}

function renderTray() {
  const tray = $("reactTray");
  tray.innerHTML = "";
  const played = gamesPlayed || 0;
  for (const [text, at] of REACTIONS) {
    const btn = document.createElement("button");
    const emoji = /^\p{Extended_Pictographic}+$/u.test(text);
    btn.className = emoji ? "emoji" : "phrase";
    if (played >= at) {
      btn.textContent = text;
      btn.onclick = () => sendReaction(text);
    } else {
      btn.classList.add("locked");
      btn.innerHTML = `<span class="lock-item"></span><small>🔒 ${at}</small>`;
      btn.firstChild.textContent = text;
      btn.title = `Unlocks after ${at} games (you've played ${played})`;
      btn.onclick = () => toast(`Play ${at - played} more ${at - played === 1 ? "game" : "games"} to unlock ${text}`);
    }
    tray.append(btn);
  }
  const note = document.createElement("p");
  note.className = "tray-note";
  note.textContent = `Games played: ${played}. Play more to unlock more.`;
  tray.append(note);
}

// ---------- rendering ----------
function cardEl(id, { small = false } = {}) {
  const c = C.parse(id);
  const el = document.createElement("div");
  el.className = `card ${C.isRed(id) ? "red" : "black"}${small ? " small" : ""}`;
  const sym = C.SUIT_SYMBOL[c.s];
  el.innerHTML = `<span class="corner">${C.label(c.r)}<br>${sym}</span><span class="pip">${sym}</span><span class="corner bottom">${C.label(c.r)}<br>${sym}</span>`;
  el.dataset.id = id;
  return el;
}

// Same card always lands at the same angle on every player's screen.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function tossTransform(id, i) {
  const h = hash(id + ":" + i);
  const dx = (h % 37) - 18, dy = ((h >>> 6) % 25) - 12, rot = ((h >>> 12) % 61) - 30;
  return `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
}

// Thrown cards lie scattered in one spot instead of a neat pile.
function renderHeap() {
  const pile = $("discardPile");
  const ended = room.status === "ended";
  const discard = room.discard || [];
  const pick = isCall() && room.phase === "draw" ? room.pickable : null;
  const key = `${room.round}|${room.status}|${discard.slice(-HEAP_SIZE).join()}|${room.diguCard}|${pick}`;
  if (key === heapKey) return;
  const prevTop = heapTop, firstPaint = heapKey === null;
  heapKey = key;
  pile.innerHTML = "";

  let shown = discard.slice(-HEAP_SIZE);
  const digu = ended && room.diguCard && shown[shown.length - 1] === room.diguCard ? shown.pop() : null;
  if (!shown.length && !ended) pile.innerHTML = '<div class="card empty"></div>';
  const start = discard.length - shown.length - (digu ? 1 : 0);
  shown.forEach((id, i) => {
    const el = cardEl(id);
    el.classList.add("thrown");
    el.style.setProperty("--t", tossTransform(id, start + i));
    el.style.zIndex = i + 1;
    if (i === shown.length - 1 && !ended) {
      el.classList.add("top");
      if (!firstPaint && id !== prevTop) el.classList.add("landing");
    }
    if (id === pick) { // CALL: the previous player's card you may take slides out from under your throw
      el.classList.add("pick");
      el.style.zIndex = shown.length + 5;
    }
    pile.append(el);
  });
  heapTop = ended ? null : shown[shown.length - 1] || null;

  // DIGU! the winning throw lands, then flips over to show the shout on its back
  if (ended) {
    const f = document.createElement("div");
    f.className = "flip-card" + (firstPaint ? " instant" : "") + (digu ? "" : " no-face");
    const inner = document.createElement("div");
    inner.className = "flip-inner";
    const front = document.createElement("div");
    front.className = "flip-front";
    if (digu) front.append(cardEl(digu));
    const back = document.createElement("div");
    back.className = "flip-back";
    back.append(shoutEl(room.diguStyle, gameOf(room) === "call" ? "CALL!" : "DIGU!"));
    inner.append(front, back);
    f.append(inner);
    pile.append(f);
  }
}

function render() {
  if (!room) return;
  const me = room.playerIds.includes(uid);
  const playing = room.status === "playing";
  const myTurn = isMyTurn();

  // players strip
  const strip = $("players");
  strip.innerHTML = "";
  room.players.forEach((p, i) => {
    const active = playing && room.turn === i;
    const chip = document.createElement("div");
    chip.className = "player" + (active ? " active" : "") + (p.uid === uid ? " me" : "");
    chip.dataset.uid = p.uid;
    chip.innerHTML = `<span class="pname"></span>${active ? '<span class="ptime"></span>' : ""}<span class="pscore">${room.scores?.[p.uid] ?? 0}</span>`;
    chip.querySelector(".pname").textContent = p.name + (p.uid === room.host ? " ★" : "");
    chip.prepend(avatarEl(p));
    if (p.rank != null) {
      const rk = document.createElement("span");
      rk.className = "prank";
      rk.textContent = P.RANKS[p.rank]?.icon || "";
      rk.title = `${P.RANKS[p.rank]?.name} rank${p.badges ? ` · ${p.badges} badges` : ""}`;
      chip.querySelector(".pname").after(rk);
    } else chip.title = "Guest";
    if (playing && room.almost?.[p.uid]) {
      const badge = document.createElement("span");
      badge.className = "almost";
      badge.textContent = "1 to DIGU";
      chip.append(badge);
    }
    strip.append(chip);
  });

  // status line
  let status = "";
  if (room.status === "lobby") {
    const last = room.lastChampions?.length ? `🏆 ${room.lastChampions.map(nameOf).join(" & ")} won the last game · ` : "";
    status = last + (room.host === uid
      ? `Your lounge · share code ${roomId} · ${room.players.length}/${room.maxPlayers || 6} players`
      : `Waiting for ${nameOf(room.host)} to start · ${room.players.length}/${room.maxPlayers || 6} players`);
  } else if (playing) {
    if (myTurn && isCall()) status = room.phase === "throw"
      ? (canCall() ? "Your turn: CALL now, or throw a card first" : "Your turn: throw a card first (or several of the same number)")
      : room.pickable
        ? `Now take ${C.label(C.parse(room.pickable).r)}${C.SUIT_SYMBOL[C.parse(room.pickable).s]} (the last player's card) or one from the middle pile`
        : "Now take a card from the middle pile";
    else if (myTurn) status = room.phase === "draw"
      ? (room.discard?.length ? "Your turn: take the last thrown card or one from the middle pile" : "Your turn: take a card from the middle pile")
      : "Drag a card onto the thrown cards to throw it";
    else status = `${nameOf(room.playerIds[room.turn])} is playing…`;
  } else status = `${nameOf(room.winner)} called ${GAME_NAME[gameOf(room)]}!`;
  $("status").textContent = status;
  $("log").textContent = room.log || "";

  // table
  $("table").hidden = room.status === "lobby";
  $("deckCount").textContent = room.deck?.length ?? 0;
  $("deck").classList.toggle("clickable", canDraw());
  renderHeap();
  const pile = $("discardPile");
  pile.classList.toggle("clickable", canDraw() && (isCall() ? !!room.pickable : !!room.discard?.length));
  pile.classList.toggle("target", canThrow());

  // my hand
  const handDiv = $("hand");
  handDiv.innerHTML = "";
  hand.forEach((id) => {
    const el = cardEl(id);
    if (isCall() ? callSel.has(id) : id === selected) el.classList.add("selected");
    if (id === lastDrawn) el.classList.add("new");
    if (drag?.moved && drag.src === "hand" && drag.id === id) { el.classList.add("dragging"); drag.el = el; }
    handDiv.append(el);
  });
  $("handSection").hidden = !me || room.status === "lobby";

  // buttons
  $("startBtn").hidden = !(room.host === uid && room.status === "lobby");
  $("startBtn").disabled = room.players.length < 2;
  const call = isCall();
  [...callSel].forEach((c) => { if (!hand.includes(c)) callSel.delete(c); });
  $("discardBtn").disabled = !(canThrow() && (call ? callSel.size && C.canThrowTogether([...callSel]) : selected));
  $("discardBtn").textContent = call && callSel.size > 1 ? `Throw ${callSel.size} cards` : "Throw away";
  $("diguBtn").hidden = call;
  $("callBtn").hidden = !call;
  $("callBtn").disabled = !canCall();
  $("callBtn").classList.toggle("ready", canCall());
  $("groupSets").hidden = call;
  $("callCount").hidden = !call || !hand.length || room.status === "lobby";
  if (call) {
    const v = C.handValue(hand);
    $("callCount").textContent = `Your count: ${v}${v <= C.CALL_LIMIT ? " · you can CALL on your turn" : ` · CALL at ${C.CALL_LIMIT} or less`}`;
    $("callCount").classList.toggle("can-call", v <= C.CALL_LIMIT);
  }
  const canDigu = !call && myTurn && (room.phase === "draw" ? !!C.findWinningLayout(hand) : !!diguThrow());
  $("diguBtn").disabled = !canDigu;
  $("diguBtn").classList.toggle("ready", canDigu);
  const almostShown = playing && !!room.almost?.[uid];
  const canAlmost = !call && playing && !almostShown && !canDigu && oneAwayNow();
  $("almostBtn").hidden = !(canAlmost || almostShown);
  $("almostBtn").disabled = almostShown;
  $("almostBtn").textContent = almostShown ? "Everyone knows: 1 to DIGU" : "Tell everyone: 1 to DIGU";
  renderTargetSetup();
  renderLoungeScene();
  $("startBtn").hidden = true; // lounges start from the Start button in the middle of the table
  $("targetInfo").textContent = GAME_NAME[gameOf(room)] + " · " + (room.status === "lobby" ? (isLobbyRoom(room) ? "" : "Lounge")
    : roundsTotal(room) ? `Round ${Math.max(1, room.gameRound || 1)} of ${roundsTotal(room)}` : `${isCall() ? "Out at" : "First to"} ${room.target || DEFAULT_TARGET}`);

  // sorting unlocks after a few games
  const sortLocked = (gamesPlayed || 0) < SORT_UNLOCK;
  for (const id of ["sortSuit", "sortRank"]) {
    $(id).classList.toggle("locked", sortLocked);
    $(id).title = sortLocked ? `Unlocks after ${SORT_UNLOCK} games (you've played ${gamesPlayed || 0})` : "";
  }
  $("sortLockNote").hidden = !sortLocked;
  $("sortLockNote").textContent = `🔒 Sorting unlocks after ${SORT_UNLOCK} games · ${Math.max(0, SORT_UNLOCK - (gamesPlayed || 0))} to go`;
  tick();
}

// A lounge waiting to start: the owner's table with its seats, and Start in the middle.
function renderLoungeScene() {
  const box = $("loungeScene");
  const show = room && !isLobbyRoom(room) && room.status === "lobby";
  $("loungeRoom").hidden = !show;
  $("game").classList.toggle("in-lounge", !!show);
  if (!show) return;
  const seats = room.maxPlayers || 6;
  const n = room.players.length;
  const owner = room.host === uid;
  box.innerHTML = "";
  const t = document.createElement("div");
  t.className = "ltable lounge-table mine";
  t.style.setProperty("--chairs", seats);
  const felt = document.createElement("div");
  felt.className = "ltable-felt g-" + gameOf(room);
  felt.append(
    Object.assign(document.createElement("strong"), { className: "table-game", textContent: GAME_NAME[gameOf(room)] }),
    Object.assign(document.createElement("small"), { className: "table-no", textContent: `${nameOf(room.host)}'s lounge` }),
  );
  if (owner) {
    const start = document.createElement("button");
    start.className = "table-play" + (n >= 2 ? "" : " wait");
    start.textContent = "Start";
    start.title = n >= 2 ? `Start with ${n} players` : "Waiting for someone to join";
    start.onclick = () => (n >= 2 ? dealRound() : toast(`Share the code ${roomId} so friends can join`));
    felt.append(start);
  } else {
    felt.append(Object.assign(document.createElement("small"), { textContent: `Waiting for ${nameOf(room.host)}` }));
  }
  t.append(felt);
  for (let i = 0; i < seats; i++) {
    const p = room.players[i];
    const ang = Math.PI / 2 + (i * 2 * Math.PI) / seats;
    const seat = document.createElement("div");
    seat.className = "seat exec-chair" + (p ? " taken" : " empty open-seat");
    seat.style.left = `${50 + 43 * Math.cos(ang)}%`;
    seat.style.top = `${50 + 43 * Math.sin(ang)}%`;
    // the chair faces the table
    seat.style.setProperty("--face", `${(ang * 180) / Math.PI - 90}deg`);
    if (p) {
      seat.append(avatarEl(p, "avatar"));
      seat.append(Object.assign(document.createElement("span"), { className: "seat-name", textContent: p.name + (p.uid === room.host ? " ★" : "") }));
    } else {
      seat.title = "Free seat";
      seat.append(Object.assign(document.createElement("span"), { className: "seat-name", textContent: "free" }));
    }
    t.append(seat);
  }
  box.append(t);
  box.append(Object.assign(document.createElement("p"), {
    className: "muted lounge-wait",
    textContent: n < 2 ? `Waiting for friends to join with the code ${roomId}…` : `${n} of ${seats} seats taken`,
  }));
}

// Lounge settings (lounge owner, before dealing): players 2–6, and end by points or by rounds.
// Lobby tables have no settings: 2–4 players, 4 rounds.
function renderTargetSetup() {
  const box = $("targetSetup");
  box.hidden = room.status !== "lobby" || isLobbyRoom(room); // the notice board inside the lounge
  if (box.hidden) return;
  const host = room.host === uid;
  const owner = nameOf(room.host);
  $("loungeTitle").textContent = host ? "Your lounge" : `${owner}'s lounge`;
  $("loungeNote").innerHTML = `Lounge code <b></b> <button type="button" class="ghost small copy-code">Copy invite</button>`;
  $("loungeNote").querySelector("b").textContent = roomId;
  $("loungeNote").querySelector("button").onclick = () => $("copyCode").click();

  const maxBox = $("maxChoices");
  maxBox.innerHTML = "";
  const max = room.maxPlayers || 6;
  $("maxLabel").textContent = host ? "Players" : `Up to ${max} players`;
  for (let n = 2; n <= 6; n++) {
    const b = document.createElement("button");
    b.textContent = n;
    b.className = "target-chip small-chip" + (n === max ? " on" : "");
    b.disabled = !host || n < room.players.length;
    if (host && n < room.players.length) b.title = `${room.players.length} players are already in`;
    b.onclick = () => setMaxPlayers(n);
    maxBox.append(b);
  }

  const g = gameOf(room);
  $("gameDigu").classList.toggle("on", g === "digu");
  $("gameCall").classList.toggle("on", g === "call");
  $("gameDigu").disabled = $("gameCall").disabled = !host;
  $("gameNote").textContent = g === "call"
    ? "CALL: draw, throw one card or several of the same number, and CALL at 7 or less. Lowest total wins."
    : "DIGU: make two sets of 3 and one set of 4. Highest total wins.";
  const mode = room.endMode === "rounds" ? "rounds" : "points";
  $("endPoints").classList.toggle("on", mode === "points");
  $("endRounds").classList.toggle("on", mode === "rounds");
  $("endPoints").disabled = $("endRounds").disabled = !host;
  $("targetSection").hidden = mode !== "points";
  $("roundsSection").hidden = mode !== "rounds";

  // points
  const target = room.target || DEFAULT_TARGET;
  $("targetLabel").textContent = g === "call"
    ? (host ? "Game ends when someone reaches" : `Game ends when someone reaches ${target}`)
    : (host ? "First to reach" : `First to ${target} points wins`);
  const choices = $("targetChoices");
  choices.innerHTML = "";
  for (const t of [...new Set([...(g === "call" ? CALL_TARGETS : TARGET_CHOICES), target])].sort((a, b) => a - b)) {
    const b = document.createElement("button");
    b.textContent = t;
    b.className = "target-chip" + (t === target ? " on" : "");
    b.disabled = !host;
    b.onclick = () => setTarget(t);
    choices.append(b);
  }
  $("targetCustom").hidden = !host;
  $("targetNote").textContent = g === "call" ? "points · then the lowest total wins" : "points · then the highest total wins";

  // rounds
  const limit = room.roundsLimit || DEFAULT_LOUNGE_ROUNDS;
  $("roundsLabel").textContent = host ? "Number of rounds" : `${limit} rounds · ${g === "call" ? "lowest" : "highest"} total wins`;
  const rc = $("roundsChoices");
  rc.innerHTML = "";
  for (const n of [...new Set([...LOUNGE_ROUND_CHOICES, limit])].sort((a, b) => a - b)) {
    const b = document.createElement("button");
    b.textContent = n;
    b.className = "target-chip small-chip" + (n === limit ? " on" : "");
    b.disabled = !host;
    b.onclick = () => setRoundsLimit(n);
    rc.append(b);
  }
  $("roundsCustom").hidden = !host;
}

// ---------- drag & tap (mouse and touch) ----------
// Drag a hand card onto the thrown cards to throw it. While dragging over your hand,
// the card moves to exactly where your pointer is, so you can place it anywhere.
// Drag the middle pile or the top thrown card down into your hand to take it. A short tap still works.
function startDrag(e, src, id, el) {
  if (e.button > 0 || !room) return;
  drag = { src, id, el, x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
}
$("hand").addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".card");
  if (el) startDrag(e, "hand", el.dataset.id, el);
});
$("deck").addEventListener("pointerdown", (e) => {
  if (mustThrowFirst()) return toast("Throw a card first");
  startDrag(e, "deck", null, $("deck"));
});
$("discardPile").addEventListener("pointerdown", (e) => {
  if (mustThrowFirst()) return toast("Throw a card first");
  const el = e.target.closest(isCall() ? ".card.pick" : ".card.top");
  if (el) startDrag(e, "discard", el.dataset.id, el);
  else if (canDraw() && (isCall() ? !room.pickable : !room.discard?.length)) {
    toast(isCall() ? "No card from the last player to take · take from the middle pile" : "Nothing has been thrown yet · take from the middle pile");
  }
});

function makeGhost() {
  const r = drag.el.getBoundingClientRect();
  const g = drag.el.cloneNode(true);
  g.classList.remove("selected", "new", "clickable", "thrown", "top", "landing");
  g.classList.add("ghost");
  g.removeAttribute("id");
  g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  g.style.width = drag.el.offsetWidth + "px";
  g.style.height = drag.el.offsetHeight + "px";
  g.style.zIndex = "";
  drag.offX = drag.el.offsetWidth / 2;
  drag.offY = drag.el.offsetHeight / 2;
  document.body.append(g);
  drag.ghost = g;
  drag.el.classList.add("dragging");
}

function dropTarget(e, d) {
  const t = document.elementFromPoint(e.clientX, e.clientY);
  if (d.src === "hand") {
    const handTop = $("hand").getBoundingClientRect().top;
    if (canThrow() && (t?.closest("#table") || e.clientY < handTop - 30)) return "throw";
    return null;
  }
  if (canDraw() && (t?.closest("#handSection") || e.clientY > $("table").getBoundingClientRect().bottom + 20)) return "draw";
  return null;
}

// Move the dragged card to the spot under the pointer (like rearranging cards in your real hand).
function placeInHand(e) {
  const hr = $("hand").getBoundingClientRect();
  if (e.clientX < hr.left - 20 || e.clientX > hr.right + 20 || e.clientY < hr.top - 10 || e.clientY > hr.bottom + 10) return;
  const others = [...$("hand").querySelectorAll(".card")].filter((el) => el.dataset.id !== drag.id);
  if (!others.length) return;
  const rects = others.map((el) => ({ id: el.dataset.id, r: el.getBoundingClientRect() }));
  // the row of cards the pointer is level with
  let rowTop = rects[0].r.top, best = Infinity;
  for (const { r } of rects) {
    const d = Math.abs((r.top + r.bottom) / 2 - e.clientY);
    if (d < best) { best = d; rowTop = r.top; }
  }
  const row = rects.filter((o) => Math.abs(o.r.top - rowTop) < 6);
  const before = row.find((o) => e.clientX < (o.r.left + o.r.right) / 2);
  const rest = hand.filter((c) => c !== drag.id);
  const at = before ? rest.indexOf(before.id) : rest.indexOf(row[row.length - 1].id) + 1;
  const next = [...rest.slice(0, at), drag.id, ...rest.slice(at)];
  if (next.join() !== hand.join()) { hand = next; render(); }
}

document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    makeGhost();
  }
  e.preventDefault();
  const tilt = Math.max(-12, Math.min(12, dx / 15));
  drag.ghost.style.transform = `translate(${e.clientX - drag.offX}px, ${e.clientY - drag.offY}px) rotate(${tilt}deg) scale(1.08)`;
  if (drag.src === "hand") placeInHand(e);
  const t = dropTarget(e, drag);
  $("discardPile").classList.toggle("drop-hover", t === "throw");
  $("hand").classList.toggle("drop-hover", t === "draw");
}, { passive: false });

function endDrag(d) {
  d.ghost?.remove();
  d.el?.classList.remove("dragging");
  $("discardPile").classList.remove("drop-hover");
  $("hand").classList.remove("drop-hover");
}

document.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  endDrag(d);
  if (!d.moved) { // a tap
    if (d.src === "hand") {
      if (isCall()) { // pick several of the same number to throw together
        if (callSel.has(d.id)) callSel.delete(d.id);
        else {
          if ([...callSel].some((c) => C.parse(c).r !== C.parse(d.id).r)) callSel.clear();
          callSel.add(d.id);
        }
      } else selected = selected === d.id ? null : d.id;
      render();
    }
    else draw(d.src);
    return;
  }
  const t = dropTarget(e, d);
  if (t === "throw") throwCard(isCall() && callSel.has(d.id) ? [...callSel] : [d.id]);
  else if (t === "draw") draw(d.src);
  else render(); // card stays where it was dropped in the hand
});
document.addEventListener("pointercancel", () => { if (drag) { endDrag(drag); drag = null; render(); } });

function sortLockedToast() {
  if ((gamesPlayed || 0) >= SORT_UNLOCK) return false;
  const left = SORT_UNLOCK - (gamesPlayed || 0);
  toast(`🔒 Play ${left} more ${left === 1 ? "game" : "games"} to unlock sorting`);
  return true;
}
$("sortSuit").onclick = () => { if (sortLockedToast()) return; hand = C.sortBySuit(hand); render(); };
$("sortRank").onclick = () => { if (sortLockedToast()) return; hand = C.sortByRank(hand); render(); };
$("groupSets").onclick = () => {
  const best = C.bestLayout(hand);
  hand = [...best.sets.flat(), ...C.sortBySuit(best.leftover)];
  render();
};

// ---------- reactions tray ----------
renderTray();
$("reactBtn").onclick = (e) => { e.stopPropagation(); $("reactTray").hidden = !$("reactTray").hidden; };
document.addEventListener("click", (e) => {
  if (!e.target.closest("#reactTray, #reactBtn")) $("reactTray").hidden = true;
});

// ---------- buttons ----------
$("createLoungeBtn").onclick = createLounge;
$("seatStart").onclick = startTable;
$("seatLeave").onclick = standUpAndStep;
$("lobbyFloor").addEventListener("click", onFloorTap);
addEventListener("resize", () => { clearTimeout(renderFloor.t); renderFloor.t = setTimeout(() => { walkerEls.forEach((el) => (el._pos = null)); renderFloor(); }, 150); });
$("joinBtn").onclick = () => joinRoom($("code").value);
$("code").addEventListener("keydown", (e) => e.key === "Enter" && joinRoom($("code").value));
$("startBtn").onclick = dealRound;
$("nextRoundBtn").onclick = dealRound;
$("playAgainBtn").onclick = playAgain;
$("endPoints").onclick = () => setEndMode("points");
$("endRounds").onclick = () => setEndMode("rounds");
$("roundsCustom").addEventListener("submit", (e) => {
  e.preventDefault();
  setRoundsLimit($("roundsInput").value);
  $("roundsInput").value = "";
});
$("registerBtn").onclick = () => openAuth("register");
$("signInBtn").onclick = () => openAuth("signin");
$("authSwitch").onclick = () => openAuth($("authModal").dataset.mode === "register" ? "signin" : "register");
$("authForm").addEventListener("submit", submitAuth);
$("authClose").onclick = () => ($("authModal").hidden = true);
$("profileBtn").onclick = () => { renderProfile(); $("profileModal").hidden = false; };
$("profileClose").onclick = () => ($("profileModal").hidden = true);
$("profName").addEventListener("change", saveName);
$("photoInput").addEventListener("change", (e) => { uploadPhoto(e.target.files[0]); e.target.value = ""; });
$("photoThumb").onclick = () => profile.photo
  ? savePrefs({ usePhoto: true })
  : $("photoInput").click();
$("photoRemove").onclick = removePhoto;
$("copyId").onclick = async () => {
  try { await navigator.clipboard.writeText(uid); toast("Player ID copied"); } catch { toast(uid); }
};
$("adminBtn").onclick = openAdmin;
$("adminClose").onclick = () => ($("adminModal").hidden = true);
$("adminSearch").addEventListener("input", renderAdmin);
$("adminFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  adminFilter = b.dataset.f;
  $("adminFilters").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  renderAdmin();
});
$("adminRefresh").onclick = openAdmin;
$("signOutBtn").onclick = () => logOut().catch((e) => toast(errMsg(e)));
$("targetCustom").addEventListener("submit", (e) => {
  e.preventDefault();
  setTarget($("targetInput").value);
  $("targetInput").value = "";
});
$("discardBtn").onclick = () => (isCall() ? callSel.size && throwCard([...callSel]) : selected && throwCard(selected));
$("callBtn").onclick = onCall;
$("gameDigu").onclick = () => setGame("digu");
$("gameCall").onclick = () => setGame("call");
$("diguBtn").onclick = onDigu;
$("almostBtn").onclick = announceAlmost;
$("leaveBtn").onclick = exitRoom;
$("enterLobbyBtn").onclick = openLobby;
$("lobbyBackBtn").onclick = closeLobby;
$("seatDigu").onclick = () => findSeat("digu");
$("seatCall").onclick = () => findSeat("call");
$("name").addEventListener("change", () => { renderWalkers(); writePresence(); });

$("copyCode").onclick = async () => {
  const base = IS_APP ? (CFG.siteUrl || "").replace(/\/?$/, "/") : `${location.origin}${location.pathname}`;
  const link = `${base}#${roomId}`;
  try { await navigator.clipboard.writeText(link); toast("Invite link copied"); }
  catch { toast(link); }
};

// ---------- Android app: push notifications ----------
// In the Android app (Capacitor), the phone registers for push and saves its token on the player's
// profile. After a move, the mover asks the server (api/notify on Vercel) to alert the right players.
// The server checks the sender really is at that table, so nobody can send fake alerts.
const IS_APP = !!window.Capacitor?.isNativePlatform?.();
// the website calls its own /api/notify; the app needs the full address from firebase-config.js
const NOTIFY_URL = IS_APP ? (CFG.notifyUrl && !CFG.notifyUrl.includes("PASTE") ? CFG.notifyUrl : "") : "/api/notify";
let pushToken = null, pushReady = false;

async function sendNotify(kind, code = roomId) {
  if (!NOTIFY_URL || !code || !auth.currentUser) return;
  try {
    const token = await auth.currentUser.getIdToken();
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ roomId: code, kind }),
    });
  } catch { /* notifications are a bonus; the game never waits for them */ }
}

function savePushToken() {
  if (!pushToken || !uid) return;
  // kept in its own private place: only this player (and the server) can read it
  setDoc(doc(db, "pushTokens", uid), { tokens: arrayUnion(pushToken) }, { merge: true }).catch(() => {});
}

async function setupPush() {
  const PN = window.Capacitor?.Plugins?.PushNotifications;
  if (!IS_APP || !PN || pushReady) return;
  pushReady = true;
  // Only builds that include google-services.json can use push; asking without it crashes the app.
  const flag = await fetch("push-enabled.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!flag?.enabled) { console.warn("Push notifications are off in this build (no google-services.json)"); return; }
  try {
    let perm = await PN.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PN.requestPermissions();
    if (perm.receive !== "granted") return;
    await PN.createChannel({
      id: "turns", name: "Turns and games", description: "Your turn, games starting, players joining",
      importance: 5, visibility: 1, sound: "default", vibration: true, lights: true, lightColor: "#E8B64C",
    }).catch(() => {});
    await PN.addListener("registration", ({ value }) => { pushToken = value; savePushToken(); });
    await PN.addListener("registrationError", (e) => console.warn("Push registration failed", e));
    // tapping a notification opens that table
    await PN.addListener("pushNotificationActionPerformed", ({ notification }) => openFromPush(notification?.data?.roomId));
    await PN.register();
  } catch (e) { console.warn("Push setup failed", e); }
}

async function openFromPush(code) {
  if (!code || !uid || code === roomId) return;
  const snap = await getDoc(doc(db, "rooms", code)).catch(() => null);
  if (snap?.exists() && snap.data().playerIds?.includes(uid)) enterRoom(code);
  else if (LOBBY_TABLES.some((t) => t.id === code)) openLobby();
}

// ---------- start ----------
$("name").value = load("digu-name") || "";
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  const changed = uid !== user.uid;
  uid = user.uid;
  if (changed) {
    profile = {}; watchMyStats(); watchRoles(); watchOpenRooms();
    setupPush();
    savePushToken(); // signed in as someone else: this phone now gets their alerts
    if (location.hash === "#lobby") setTimeout(openLobby, 50);
  }
  renderAccount();
  $("lobbyActions").classList.remove("loading");
  const code = location.hash.slice(1).toUpperCase();
  if (code && !roomId) {
    $("code").value = code;
    // rejoin automatically if I'm already in it (page reload)
    const snap = await getDoc(doc(db, "rooms", code)).catch(() => null);
    if (snap?.exists() && snap.data().playerIds.includes(uid)) enterRoom(code);
  }
});
signInAnonymously(auth).catch((e) => toast("Sign-in failed: " + errMsg(e)));
