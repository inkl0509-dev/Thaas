import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut, updateProfile,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { startMusic, stopMusic, setMuted, isMuted, unlock as unlockMusic } from "./music.js?v=20261029g";
// scene sounds load on their own: if ambience.js is ever missing, the game still works (just quiet)
let AMB = null;
import(`./ambience.js?v=20261029g`).then((m) => { AMB = m; m.setThunderHandler(thunderFromSound); m.setSwellHandler(swellNow); syncMusic(); })
  .catch((e) => console.warn("scene sounds unavailable", e));
const startAmbience = (k) => AMB?.startAmbience(k), stopAmbience = () => AMB?.stopAmbience(), unlockAmbience = () => AMB?.unlockAmbience();
// Card tables live in Realtime Database (see store.js); accounts, profiles etc. in Firestore.
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, runTransaction,
  collection, getDocs, writeBatch, serverTimestamp, increment, query, where, arrayUnion, arrayRemove, deleteField,
  disableNetwork, enableNetwork, initStore, usingRealtime, databaseUrlFor, serverClockOffset, deleteRoomEverywhere, watchPresence, stopPresence, onReconnect, rememberMembership,
} from "./store.js?v=20261029g";
import * as CFG from "./firebase-config.js?v=20261029g";
import * as C from "./cards.js?v=20261029g";
import * as P from "./profile.js?v=20261029g";
import { DV } from "./i18n.js?v=20261029g";

const { firebaseConfig } = CFG;
if (!firebaseConfig?.apiKey || String(firebaseConfig.apiKey).includes("PASTE"))
  throw new Error("firebase-config.js still has the placeholder values (PASTE_API_KEY). Put your own Firebase config in it and rebuild the app.");
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Local cache: the game reloads instantly and your own moves show before the server confirms them.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  // phones, the Android app and some mobile networks can stall the live connection: detect it and
  // fall back to a connection type that keeps working
  experimentalAutoDetectLongPolling: true,
});
// Realtime Database for the card tables: add databaseURL to firebase-config.js to switch it on
initStore(app, db, databaseUrlFor(firebaseConfig, CFG.databaseURL));

const TURN_MS = 40_000;   // each player gets 40 seconds
const GRACE_MS = 10_000;  // others wait 10 s after my time is up before skipping me (my own timeout move lands first)   // others wait a little longer before skipping someone who has gone offline
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
// 💎 Premium reactions
const PREMIUM_REACTIONS = ["🥳", "😍", "🤯", "🙏", "😏", "🤣", "💪", "👏", "💎", "🌴", "🐠", "🦈", "🥥", "🏝️", "☕", "🎉",
  "Bravo!", "Well played!", "Lucky!", "Watch this 😏", "Your turn, boss", "GG 🤝"];
const SORT_UNLOCK = 5;      // "Sort by suit" / "Sort by number" unlock after this many games
const TARGET_CHOICES = [300, 500, 1000];
const DEFAULT_TARGET = 500;
// Lobby tables (listed on the home screen): up to 4 players, 4 rounds, highest total wins.
// Private tables (code only): 2–6 players, play to a target score.
const LOBBY_MAX = 4;
const LOBBY_ROUNDS = 4;
const isLobbyRoom = (r) => r?.public !== false;
// Two games: DIGU (sets, highest total wins) and CALL (low count, lowest total wins).
// Three games: DIGU (sets, highest total wins), CALL (low count, lowest total wins) and
// BONDI (follow suit, get rid of your cards first, lowest total wins).
const gameOf = (r) => (["call", "bondi", "dhiha", "babbush"].includes(r?.game) ? r.game : "digu");
const isBabbush = () => gameOf(room) === "babbush";
const isCall = () => gameOf(room) === "call";
const isBondi = () => gameOf(room) === "bondi";
const isDhiha = () => gameOf(room) === "dhiha";   // team game, holhuashis only
const DHIHA_TARGETS = [3, 5, 7];
const teamName = (t) => (t === "A" ? "Team 1" : "Team 2");
const lowWins = (g) => g === "call" || g === "bondi" || g === "babbush";
const GAME_NAME = { digu: "DIGU", call: "CALL", bondi: "BONDI", dhiha: "DHIHA", babbush: "BABUSH" };
const LOBBY_SEATS = { digu: 4, call: 6, bondi: 6 }; // lobby tables: DIGU 2–4 players, CALL and BONDI 2–6
const targetFor = (g) => (g === "dhiha" ? 5 : lowWins(g) ? CALL_DEFAULT_TARGET : DEFAULT_TARGET);
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
let heapKey = null, heapTop = null, heapLen = 0;
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

const inviteRef = (code) => doc(db, "rooms", code, "secret", "invite");
function randomKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % chars.length]).join("");
}
function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function createRoom({ isPublic = true, game = "digu", loungeName = "" } = {}) {
  if (blockedCheck()) return;
  if (!isPublic && !isRegistered()) return toast("🔒 Register to create your own holhuashi");
  if (!isPublic && premiumGate()) {
    try {
      const mine = await getDocs(query(collection(db, "rooms"), where("owner", "==", uid)));
      const count = mine.docs.filter((d) => !d.data().tourney && !["deleted", "closed"].includes(d.data().status)).length;
      if (count >= FREE_LOUNGES) return needPremium(`You have ${count} holhuashis · free players can have ${FREE_LOUNGES}. More holhuashis are`);
    } catch {}
  }
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
    target: targetFor(game),
    maxPlayers: isPublic ? LOBBY_SEATS[game] : 6,
    gameRound: 0,                 // rounds played in this game (lobby games stop after 4)
    public: isPublic,             // true = lobby table on the home screen; false = a registered player's holhuashi
    endMode: "points",            // lounges: "points" (first to target) or "rounds" (fixed number)
    roundsLimit: DEFAULT_LOUNGE_ROUNDS,
    heartbeat: serverTimestamp(), // players keep this fresh so abandoned rooms drop off the list
    seen: { [uid]: serverTimestamp() },
    log: isPublic ? `${name} opened a ${GAME_NAME[game]} table` : `${name} opened their holhuashi`,
    createdAt: serverTimestamp(),
    // holhuashis stay open for good (until the owner deletes them), even when everyone has left
    ...(isPublic ? {} : { lounge: true, owner: uid, members: [uid], name: (loungeName || `${name}'s holhuashi`).slice(0, 30),
      stats: { rounds: 0, games: 0 } }),
  });
  if (!isPublic) await setDoc(inviteRef(code), { key: randomKey() }).catch((e) => console.warn("Invite code", e));
  if (!isPublic) rememberMembership(uid, code);
  if (!isPublic) rememberLounge(code, (loungeName || `${name}'s holhuashi`).slice(0, 30));
  enterRoom(code);
}

async function joinRoom(code, { quiet = false } = {}) {
  if (blockedCheck()) return false;
  const name = myName();
  if (!name) return false;
  // a holhuashi invite looks like ABCDE-7K2Q (code + private key), or a link ending in #ABCDE-7K2Q
  const [c0, key = ""] = code.trim().toUpperCase().replace(/^.*#/, "").split("-");
  code = c0;
  if (!code) { toast("Enter a room code"); return false; }
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw "Room not found";
      const r = snap.data();
      if (r.status === "deleted") throw "This holhuashi was deleted by its owner";
      if (isLoungeDoc(r) && (r.removed || []).includes(uid)) throw "🚫 The owner removed you from this holhuashi";
      if (r.playerIds.includes(uid)) return; // already in (e.g. page reload)
      // holhuashis are invite-only: first time in, you need the owner's invite code; after that you're a regular
      const regular = !isLoungeDoc(r) || r.owner === uid || (r.members || []).includes(uid) || (!r.owner && !r.members);
      if (!regular && !key) throw "🔒 This holhuashi is invite-only · ask the owner for their invite code or link";
      if (!regular) tx.set(doc(db, "rooms", code, "joins", uid), { key, name, at: serverTimestamp() });
      if (r.status !== "lobby") throw isLoungeDoc(r) ? "A game is being played in this holhuashi right now · try again when it ends" : "That game has already started";
      if (r.playerIds.length >= (r.maxPlayers || 6)) throw `Room is full (${r.maxPlayers || 6} players max)`;
      tx.update(ref, {
        players: [...r.players, myEntry(name)],
        playerIds: [...r.playerIds, uid],
        [`scores.${uid}`]: 0,
        [`seen.${uid}`]: serverTimestamp(),
        log: `${name} joined`,
        ...(r.owner === uid || !r.playerIds.length ? { host: uid, heartbeat: serverTimestamp() } : {}), // the owner runs their own holhuashi
        ...(isLoungeDoc(r) ? { members: arrayUnion(uid), [`memberInfo.${uid}`]: { name, avatar: myEntry(name).avatar || null } } : {}),
      });
    });
    rememberMembership(uid, code);
    enterRoom(code);
    sendNotify("join", code);
    return true;
  } catch (e) {
    if (typeof e === "string" && e.startsWith("🚫")) forgetLounge(code);
    if (!quiet) toast(e?.code === "permission-denied" && key ? "That invite code isn't valid (the owner may have made a new one)" : errMsg(e));
    return false;
  }
}

// ---------- 🏆 DIGU tournaments ----------
// The organiser creates a tournament and shares its code. Players join with the code. When it starts,
// players are drawn into tables of up to 4; each table plays a short DIGU game (a few rounds). The
// player with the most points at each table goes through to the next round, until one table is left:
// the final. Its winner gets the 🏆 Tournament Cup badge.
const T_MATCH_ROUNDS = [3, 5];
const tRef = (code) => doc(db, "tournaments", code);
const tRoundName = (t, r) => ((t.rounds?.[r] || []).length === 1 ? "Final" : `Round ${r + 1}`); // one table left = the final
// split players into tables of at most 4 (sizes as even as possible, at least 2)
// in order: 8 players → the first 4 play game 1, the next 4 play game 2 (sizes kept even, at least 2)
function tGroups(ids) {
  const n = ids.length, tables = Math.max(1, Math.ceil(n / 4));
  const base = Math.floor(n / tables), extra = n % tables, out = [];
  let k = 0;
  for (let i = 0; i < tables; i++) { const size = base + (i < extra ? 1 : 0); out.push(ids.slice(k, k + size)); k += size; }
  return out.filter((g) => g.length);
}
// one game at a time: the first unfinished game of the current round
const tActive = (t) => {
  const r = (t.rounds || []).length - 1;
  const m = r >= 0 ? (t.rounds[r] || []).findIndex((x) => x.status !== "done") : -1;
  return m < 0 ? null : { r, m };
};
let tCurrent = null, tUnsub = null;
const canMakeTournament = () => isRegistered() && (myRank() >= 3 || isPremium()); // 🥇 Gold rank and up, or Premium
async function createTournament() {
  if (!isRegistered()) return toast("🔒 Sign in to create a tournament");
  if (!canMakeTournament()) return toast("🔒 Tournaments can be created by 🥇 Gold players (2,500 career points) and up, or 💎 Premium players. Anyone can join one with a code.");
  if (blockedCheck()) return;
  const name = ($("tourneyName").value.trim() || `${myName()}'s DIGU Cup`).slice(0, 40);
  let code;
  do { code = "T" + randomCode().slice(0, 4); } while ((await getDoc(tRef(code))).exists());
  const me = myEntry(myName());
  try {
    await setDoc(tRef(code), {
      name, owner: uid, status: "open", game: "digu", matchRounds: Number($("tourneyRounds").value) || 3,
      players: [{ uid, name: me.name, avatar: me.avatar || null }], pids: { [uid]: true },
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "tourneyOf", uid), { [code]: name }, { merge: true }).catch(() => {});
    $("tourneyName").value = "";
    openTournament(code);
  } catch (e) { toast(errMsg(e)); }
}
async function joinTournament(code) {
  code = (code || "").trim().toUpperCase().replace(/^.*#/, "");
  if (!code) return toast("Enter the tournament code");
  if (!isRegistered()) return toast("🔒 Sign in to join a tournament");
  try {
    const me = myEntry(myName());
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(tRef(code));
      if (!snap.exists()) throw "No tournament with that code";
      const t = snap.data();
      if ((t.players || []).some((p) => p.uid === uid)) return;
      if (t.status !== "open") throw "This tournament has already started";
      if ((t.players || []).length >= 64) throw "This tournament is full (64 players)";
      tx.update(tRef(code), { players: [...(t.players || []), { uid, name: me.name, avatar: me.avatar || null }], [`pids.${uid}`]: true });
    });
    const t = (await getDoc(tRef(code))).data();
    await setDoc(doc(db, "tourneyOf", uid), { [code]: t?.name || code }, { merge: true }).catch(() => {});
    $("tourneyCode").value = "";
    openTournament(code);
  } catch (e) { toast(typeof e === "string" ? e : errMsg(e)); }
}
function openTournament(code) {
  tUnsub?.();
  tCurrent = { code, t: null };
  $("tourneyModal").hidden = false;
  $("tourneyBody").innerHTML = '<p class="muted">Loading…</p>';
  tUnsub = onSnapshot(tRef(code), (snap) => {
    const t = snap.data();
    if (!t) { $("tourneyBody").innerHTML = '<p class="muted">This tournament no longer exists.</p>'; return; }
    const was = tCurrent?.t;
    tCurrent = { code, t };
    renderTournament();
    if (t.status === "done" && was && was.status !== "done") tourneyCupShow(t);
    if (t.status === "done" && t.champion === uid) claimCup(code, t);
  }, (e) => toast(errMsg(e)));
}
function closeTournament() { tUnsub?.(); tUnsub = null; tCurrent = null; $("tourneyModal").hidden = true; }
async function startTournament() {
  const { code, t } = tCurrent || {};
  if (!t || t.owner !== uid || t.status !== "open") return;
  const ids = (t.players || []).map((p) => p.uid);
  if (ids.length < 2) return toast("At least 2 players are needed");
  const draw = [...ids].sort(() => Math.random() - 0.5);
  const round0 = tGroups(draw).map((g) => ({ players: g, status: "waiting" }));
  await updateDoc(tRef(code), { status: "running", rounds: [round0], current: 0, startedAt: serverTimestamp() }).catch((e) => toast(errMsg(e)));
}
const tName = (t, u) => (t.players || []).find((p) => p.uid === u)?.name || "?";
const matchCode = (code, r, m) => `${code}R${r + 1}M${m + 1}`;
// go to my table: the first one there sets it up, the others sit down
async function playMatch(r, m) {
  const { code, t } = tCurrent || {};
  const match = t?.rounds?.[r]?.[m];
  if (!match || !(match.players || []).includes(uid)) return;
  const act = tActive(t);
  if (!act || act.r !== r || act.m !== m) return toast("Wait: games are played one at a time");
  const rc = matchCode(code, r, m);
  try {
    const name = myName(), me = myEntry(name);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, "rooms", rc));
      if (snap.exists()) return;
      tx.set(doc(db, "rooms", rc), {
        host: uid, status: "lobby", players: [me], playerIds: [uid], scores: { [uid]: 0 },
        round: 0, moveId: 0, game: "digu", target: targetFor("digu"), maxPlayers: match.players.length, gameRound: 0,
        public: false, lounge: true, owner: t.owner, members: match.players,
        name: `🏆 ${t.name} · ${tRoundName(t, r)} · Game ${m + 1}`.slice(0, 60),
        endMode: "rounds", roundsLimit: t.matchRounds || 3, stats: { rounds: 0, games: 0 },
        tourney: { code, r, m, allowed: match.players },
        heartbeat: serverTimestamp(), seen: { [uid]: serverTimestamp() }, createdAt: serverTimestamp(),
        log: `${tRoundName(t, r)} · Game ${m + 1}: waiting for ${match.players.map((u) => tName(t, u)).join(", ")}`,
      });
    });
    const r0 = (await getDoc(doc(db, "rooms", rc))).data();
    if (r0?.playerIds?.includes(uid)) { rememberMembership(uid, rc); enterRoom(rc); }
    else await joinRoom(rc);
    if (match.status === "waiting") updateDoc(tRef(code), { [`rounds.${r}.${m}.status`]: "playing", [`rounds.${r}.${m}.room`]: rc }).catch(() => {});
    $("tourneyModal").hidden = true;
  } catch (e) { toast(errMsg(e)); }
}
// a tournament table finished its game: save the result and, when the whole round is done, draw the next one
async function recordMatch(r0, rc) {
  const tz = r0.tourney;
  if (!tz || recordMatch.done === rc) return;
  recordMatch.done = rc;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(tRef(tz.code));
      const t = snap.data();
      if (!t || t.status !== "running") return;
      const rounds = (t.rounds || []).map((rd) => (rd || []).map((x) => ({ ...x })));
      const match = rounds[tz.r]?.[tz.m];
      if (!match || match.status === "done") return;
      const scores = Object.fromEntries((match.players || []).map((u) => [u, r0.scores?.[u] ?? 0]));
      const winner = [...match.players].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))[0];
      Object.assign(match, { status: "done", scores, winner, room: rc });
      const upd = { rounds };
      if (rounds[tz.r].every((x) => x.status === "done")) {
        const winners = rounds[tz.r].map((x) => x.winner).filter(Boolean);
        if (winners.length <= 1) Object.assign(upd, { status: "done", champion: winners[0] || winner, endedAt: serverTimestamp() });
        else { rounds.push(tGroups(winners).map((g) => ({ players: g, status: "waiting" }))); upd.current = tz.r + 1; }
      }
      tx.update(tRef(tz.code), upd);
    });
  } catch (e) { recordMatch.done = null; console.warn("Tournament result", e); }
}
// the champion's own phone adds the cup to their profile (once)
function claimCup(code, t) {
  if (!isRegistered() || claimCup.done === code) return;
  claimCup.done = code;
  runTransaction(db, async (tx) => {
    const ref = doc(db, "users", uid);
    const d = (await tx.get(ref)).data() || {};
    if ((d.cups || []).includes(code)) return;
    tx.set(ref, { cups: [...(d.cups || []), code].slice(-50), tourneyWins: (d.tourneyWins || 0) + 1, careerPoints: (d.careerPoints || 0) + 500 }, { merge: true });
  }).catch(() => { claimCup.done = null; });
}
// the big moment: a huge cup for the champion
function tourneyCupShow(t) {
  const fx = document.createElement("div");
  fx.className = "cup-fx";
  fx.innerHTML = '<div class="cup-rays"></div><div class="cup-big">🏆</div><div class="cup-title"></div><div class="cup-name"></div>';
  fx.querySelector(".cup-title").textContent = t.name;
  fx.querySelector(".cup-name").textContent = t.champion === uid ? "You are the champion! +500 points" : `${tName(t, t.champion)} is the champion!`;
  document.body.append(fx);
  try { confetti(fx, false); } catch {}
  fx.onclick = () => fx.remove();
  setTimeout(() => fx.remove(), 7000);
}
function renderTournament() {
  const { code, t } = tCurrent || {};
  const box = $("tourneyBody");
  if (!t) return;
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "t-head";
  head.innerHTML = `<h2>🏆 <span></span></h2><p class="muted"></p>`;
  head.querySelector("span").textContent = t.name;
  head.querySelector("p").textContent = `DIGU · ${t.matchRounds || 3} rounds a table · organised by ${tName(t, t.owner)}`
    + (t.status === "open" ? " · waiting for players" : t.status === "running" ? " · in progress" : " · finished");
  box.append(head);
  if (t.status === "done") {
    const ch = document.createElement("div");
    ch.className = "t-champ";
    ch.innerHTML = `<span class="cup">🏆</span><div><small>Champion</small><b></b></div>`;
    ch.querySelector("b").textContent = tName(t, t.champion);
    box.append(ch);
  }
  // invite
  if (t.status === "open") {
    const inv = document.createElement("div");
    inv.className = "t-invite";
    inv.innerHTML = `<span>Invitation code</span><b></b><button type="button" class="ghost small">Copy</button>`;
    inv.querySelector("b").textContent = code;
    inv.querySelector("button").onclick = () => navigator.clipboard?.writeText(code).then(() => toast("Code copied"), () => {});
    box.append(inv);
  }
  // players
  const pl = document.createElement("div");
  pl.className = "t-players";
  pl.append(Object.assign(document.createElement("h3"), { textContent: `Players (${(t.players || []).length})` }));
  const chips = document.createElement("div");
  chips.className = "t-chips";
  const out = new Set();
  (t.rounds || []).forEach((rd) => (rd || []).forEach((x) => { if (x.status === "done") (x.players || []).forEach((u) => { if (u !== x.winner) out.add(u); }); }));
  for (const p of t.players || []) {
    const c = document.createElement("span");
    c.className = "t-chip" + (out.has(p.uid) ? " out" : "") + (p.uid === t.champion ? " champ" : "") + (p.uid === uid ? " me" : "");
    c.textContent = (p.uid === t.champion ? "🏆 " : "") + p.name + (p.uid === t.owner ? " ★" : "");
    chips.append(c);
  }
  pl.append(chips);
  box.append(pl);
  if (t.status === "open") {
    if (t.owner === uid) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: `▶ Start the tournament (${(t.players || []).length} players)` });
      b.disabled = (t.players || []).length < 2;
      b.onclick = startTournament;
      box.append(b);
      box.append(Object.assign(document.createElement("p"), { className: "muted small-note", textContent: "Players are drawn into games of up to 4 (8 players: the first 4, then the next 4), played one at a time. The top scorer of each game goes through to the next round, until the final." }));
    } else box.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "Waiting for the organiser to start the tournament…" }));
  }
  // schedule
  (t.rounds || []).forEach((rd, r) => {
    const sec = document.createElement("div");
    sec.className = "t-round";
    sec.append(Object.assign(document.createElement("h3"), { textContent: tRoundName(t, r) }));
    (rd || []).forEach((x, m) => {
      const card = document.createElement("div");
      card.className = "t-match " + x.status + ((x.players || []).includes(uid) ? " mine" : "");
      const title = document.createElement("div");
      title.className = "t-match-head";
      const act = tActive(t), isAct = act && act.r === r && act.m === m;
      title.textContent = `Game ${m + 1} · ${x.status === "done" ? "finished" : x.status === "playing" ? "playing now" : isAct ? "up next" : "waiting for the game before"}`;
      if (isAct) card.classList.add("active");
      card.append(title);
      for (const u of x.players || []) {
        const row = document.createElement("div");
        row.className = "t-row" + (x.winner === u ? " win" : "");
        row.innerHTML = `<span></span><b></b>`;
        row.firstChild.textContent = (x.winner === u ? "➜ " : "") + tName(t, u) + (u === uid ? " (you)" : "");
        row.lastChild.textContent = x.scores ? `${x.scores[u] ?? 0} pts` : "";
        card.append(row);
      }
      if (isAct && (x.players || []).includes(uid) && t.status === "running") {
        const go = Object.assign(document.createElement("button"), { type: "button", className: "primary small", textContent: x.status === "playing" ? "▶ Go to my table" : "▶ Play my match" });
        go.onclick = () => playMatch(r, m);
        card.append(go);
      }
      sec.append(card);
    });
    box.append(sec);
  });
}
// my tournaments (home page)
async function renderMyTournaments() {
  const box = $("myTourneys");
  if (!box || !isRegistered()) return;
  try {
    const d = (await getDoc(doc(db, "tourneyOf", uid))).data() || {};
    const codes = Object.keys(d).filter((k) => /^T[A-Z0-9]{4}$/.test(k));
    box.innerHTML = "";
    box.hidden = !codes.length;
    for (const c of codes.slice(-6).reverse()) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "ghost small t-mine", textContent: `🏆 ${d[c]}` });
      b.onclick = () => openTournament(c);
      box.append(b);
    }
  } catch { box.hidden = true; }
}

// ---------- the lobby: fixed tables, seats and players walking around ----------
// The lobby is its own screen (address …/#lobby). It always has the same tables: DIGU 1–4 and CALL 1–4.
// Nobody owns a table. Walk in, sit at any free seat, and once 2 or more are seated anyone at the
// table can press Play. You can get up and wander while waiting; your seat is kept.
const LOBBY_TABLES = [
  ...[1, 2, 3, 4].map((no) => ({ id: `DIGU${no}`, game: "digu", no })),
  ...[1, 2, 3, 4].map((no) => ({ id: `CALL${no}`, game: "call", no })),
  ...[1, 2, 3, 4].map((no) => ({ id: `BONDI${no}`, game: "bondi", no })),
];
// Three separate lobbies, one per game, each with its own 4 tables and its own crowd.
// Address: …/#lobby-digu, #lobby-call, #lobby-bondi (plain #lobby = DIGU).
let lobbyGame = "digu";
const lobbyHash = (g = lobbyGame) => "#lobby-" + g;
const lobbyFromHash = (h) => (h === "#lobby" ? "digu" : /^#lobby-(digu|call|bondi)$/.exec(h)?.[1] || null);
const lobbyTables = () => LOBBY_TABLES.filter((t) => t.game === lobbyGame);
const inMyLobby = (p) => (p.lobby || "digu") === lobbyGame;
const FRESH_MS = 75_000;     // a table nobody has kept alive for this long is treated as empty
const OFFLINE_MS = 60_000;   // a player who hasn't checked in for over a minute is removed (waiting at a table)
const OFFLINE_PLAY_MS = 150_000; // during a game: 2½ minutes, so locking the phone or answering a message doesn't throw you out
const OFFLINE_LOUNGE_MS = 150_000; // in a holhuashi: leaving the app for up to 2 minutes never puts you out
// a holhuashi's owner can choose how long (room.offlineMins); otherwise 2½ minutes
const offlineLimit = (r) => (isLoungeDoc(r) ? (Number(r.offlineMins) > 0 ? Math.min(30, Number(r.offlineMins)) * 60_000 : OFFLINE_LOUNGE_MS) : r.status === "playing" || r.status === "ended" ? OFFLINE_PLAY_MS : OFFLINE_MS);
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
setInterval(() => { const o = serverClockOffset(); if (o !== null) { serverOffset = o; serverTimeKnown = true; } }, 2000);
const roomFresh = (r) => {
  const t = tsMs(r.heartbeat);
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

// ----- who is offline -----
// Every player's screen checks in on its table every 20 seconds (room.seen[uid], stamped by the
// server). Anyone who hasn't checked in for over a minute counts as offline: they are hidden in the
// lobby and the other players' screens remove them from the table.
function tsMs(t) { return typeof t === "number" ? t : t?.toMillis?.() ?? (t?.seconds ? t.seconds * 1000 : 0); }
const firstNoticed = new Map();
function isOffline(r, id, rid) {
  if (id === uid || isBot(id) || !serverTimeKnown) return false;
  const t = tsMs(r.seen?.[id]);
  const limit = offlineLimit(r);
  if (t) return serverNow() - t > limit;
  const k = `${rid}:${id}`; // no check-in recorded yet: give them a minute from when I first noticed
  if (!firstNoticed.has(k)) firstNoticed.set(k, Date.now());
  return Date.now() - firstNoticed.get(k) > limit;
}
// how long since a player last checked in (they check in every 20 seconds while the game is open)
function silentFor(id) {
  if (!room || id === uid || isBot(id) || !serverTimeKnown) return 0;
  const t = tsMs(room.seen?.[id]);
  return t ? serverNow() - t : 0;
}
const onlinePlayers = (r, rid) => (r.players || []).filter((p) => !isOffline(r, p.uid, rid));
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
  if (live) {
    const players = onlinePlayers(r, t.id); // offline players aren't shown in the lobby
    return { ...r, id: t.id, game: t.game, no: t.no, public: true, players, playerIds: players.map((p) => p.uid) };
  }
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
    const at = (data) => tsMs(data.at);
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
    seated: !!(me.seated && myLobbyTable()), roomId: myLobbyTable(), lobby: lobbyGame,
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
// This lobby's 4 tables, two by two.
function layoutFloor(all) {
  const tables = all.filter((r) => r.game === lobbyGame);
  const floor = $("lobbyFloor");
  const W = floor.clientWidth || 360;
  const cell = W / 2;
  const head = cell * 0.08;
  const rowH = cell * 0.98;
  const H = Math.round(head + 2 * rowH + cell * 0.45); // + open floor and entrance
  floor.style.height = H + "px";
  floor.style.setProperty("--u", (W / 100) + "px");       // 1% of the floor width, for sizing
  const map = new Map();
  tables.forEach((r) => {
    const k = (r.no || 1) - 1, col = k % 2, row = Math.floor(k / 2);
    const cx = (col + 0.5) * cell, cy = head + row * rowH + rowH * 0.5;
    const size = cell * 0.78;
    const seats = seatsOf(r);
    const seatPos = [];
    for (let j = 0; j < seats; j++) {
      const ang = Math.PI / 2 + (j * 2 * Math.PI) / seats; // first seat at the bottom
      seatPos.push({ x: ((cx + size * 0.4 * Math.cos(ang)) / W) * 100, y: ((cy + size * 0.4 * Math.sin(ang)) / H) * 100 });
    }
    map.set(r.id, { cx: (cx / W) * 100, cy: (cy / H) * 100, size, seatPos });
  });
  floorLayout = { W, H, tables: map };
}

function renderFloor() {
  if (!$("lobbyFloor") || $("lobbyScreen").hidden) return;
  renderBotOffer();
  const tables = lobbyTables().map(tableState);
  const inLobby = [...presence.values()].filter((p) => presenceFresh(p) && inMyLobby(p)).length + [...ghostPeople().values()].filter((g) => !g.seated).length;
  const playing = tables.filter((r) => r.status !== "lobby").reduce((n, r) => n + r.playerIds.length, 0);
  $("openCount").textContent = `${inLobby} ${tr("here", "here")}${playing ? ` · ${playing} playing` : ""}`;
  $("lobbyTitle").textContent = `${gameWord(lobbyGame)} · ${tr("jagaha", "Aammu Jagaha")}`;
  for (const id of ["lobbyTitle", "openCount", "seatFind", "createLoungeBtn"]) { if (document.body.classList.contains("lang-dv")) $(id).lang = "dv"; else $(id).removeAttribute("lang"); }
  $("lobbyScreen").dataset.game = lobbyGame;
  for (const g of ["digu", "call", "bondi"]) $("tab-" + g).classList.toggle("on", g === lobbyGame);
  $("seatFind").textContent = tr("seat.find", `Find a ${GAME_NAME[lobbyGame]} seat`);
  layoutFloor(tables);
  const box = $("floorTables");
  box.innerHTML = "";
  for (const r of tables) box.append(lobbyTable(r));
  renderTableCards(tables);
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
  t.dataset.id = r.id;
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
  // at a glance: free, people waiting, or a game going on
  t.append(Object.assign(document.createElement("span"), {
    className: "tstate " + (!waiting ? "playing" : n ? "seated" : "free"),
    textContent: !waiting ? `🔴 Playing · ${n}/${seats}` : n ? `👥 ${n}/${seats} seated` : "🟢 Free",
  }));
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
      // a chair is reserved for whoever sits in it (offline players are already left out)
      seat.append(avatarEl(p, "avatar"));
      const nm = document.createElement("span");
      nm.className = "seat-name";
      nm.textContent = p.name;
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
    if (id === uid || !presenceFresh(p) || !inMyLobby(p)) continue;
    const table = p.roomId && openRooms.find((r) => r.id === p.roomId && r.status === "lobby" && r.playerIds.includes(id));
    if (p.seated && table) continue; // drawn in their seat instead
    placeWalker(walkerEl(id), id, { uid: id, ...p }, p.x ?? 50, p.y ?? 92);
    shown.add(id);
  }
  for (const [id, g] of ghostPeople()) {
    if (g.seated) continue;
    placeWalker(walkerEl(id), id, { uid: id, name: g.name, avatar: g.avatar }, g.x, g.y);
    shown.add(id);
  }
  for (const [id, el] of walkerEls) {
    if (!shown.has(id)) { el.remove(); walkerEls.delete(id); }
  }
  $("lobbyFloor").classList.toggle("alone", shown.size <= 1);
}

// ----- computer people in Aammu Jagaha -----
// When nobody else is in this lobby, a few computer players (with ordinary names) walk about. If I
// sit at a table and no one comes, they sit down with me and we play; real people can still join.
const ghosts = new Map(); // id → { name, avatar, x, y, seated, game }
const othersInLobby = () => [...presence.entries()].filter(([id, p]) => id !== uid && presenceFresh(p) && inMyLobby(p)).length;
function ghostPeople() {
  if (!inLobbyView() || othersInLobby() > 0) { if (ghosts.size) ghosts.clear(); return ghosts; }
  for (const [id, g] of ghosts) if (g.game !== lobbyGame) ghosts.delete(id);
  if (!ghosts.size) {
    const n = 3 + Math.floor(Math.random() * 2);
    const taken = new Set([myName(), ...(room?.players || []).map((p) => p.name)].filter(Boolean).map((x) => x.toLowerCase()));
    const names = [...BOT_NAMES].filter((x) => !taken.has(x.toLowerCase())).sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) {
      const id = "bot-" + Math.random().toString(36).slice(2, 7);
      ghosts.set(id, { name: names[i], avatar: botFace(), x: 15 + Math.random() * 70, y: 78 + Math.random() * 16, seated: false, game: lobbyGame });
    }
  }
  return ghosts;
}
// they wander about the floor
setInterval(() => {
  if (!inLobbyView() || !ghosts.size) return;
  for (const g of ghosts.values()) if (!g.seated && Math.random() < 0.4) { g.x = 8 + Math.random() * 84; g.y = 74 + Math.random() * 22; }
  renderWalkers();
}, 4000);
// I'm waiting at a lobby table and nobody else is here: computer people come and sit with me,
// one after another, then the game starts. Real people who arrive can still sit down too.
let ghostJoinAt = 0;
setInterval(async () => {
  if (!room || !roomId || !isLobbyRoom(room) || room.status !== "lobby" || room.host !== uid || !room.playerIds.includes(uid)) { ghostJoinAt = 0; return; }
  const free = [...ghostPeople().entries()].filter(([, g]) => !g.seated);
  const humans = room.playerIds.filter((u) => !isBot(u)).length;
  if (!ghostJoinAt) { ghostJoinAt = Date.now() + 4000 + Math.random() * 3000; return; }
  if (Date.now() < ghostJoinAt) return;
  const seats = seatsOf(room);
  const want = Math.min(seats - humans, Math.max(1, Math.min(3, seats - 1)));
  const botsHere = room.playerIds.filter(isBot).length;
  if (botsHere < want && free.length && room.players.length < seats) {
    const inRoom = new Set(room.players.map((p) => p.name.toLowerCase()));
    const pick = free.find(([, g]) => !inRoom.has(g.name.toLowerCase()));
    if (!pick) return;
    const [id, g] = pick;
    // walk to the table, then sit
    const L = floorLayout.tables.get(roomId);
    if (L) { g.x = L.cx; g.y = L.cy + 8; renderWalkers(); }
    ghostJoinAt = Date.now() + 2500 + Math.random() * 2000;
    setTimeout(() => {
      if (!room || room.status !== "lobby" || room.playerIds.includes(id) || room.players.length >= seatsOf(room)) return;
      g.seated = true;
      updateDoc(roomRef(), {
        players: [...room.players, { uid: id, name: g.name, avatar: g.avatar, rank: null, badges: 0 }],
        playerIds: [...room.playerIds, id], [`scores.${id}`]: 0, botLevel: "medium",
        log: `${g.name} sat down`,
      }).catch(() => { g.seated = false; });
    }, 1500);
    return;
  }
  // everyone's seated: start
  if (botsHere && room.players.length >= 2 && Date.now() > ghostJoinAt + 1500) { ghostJoinAt = Date.now() + 60_000; dealRound(); }
}, 1000);

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

// No walking: tap any table and you're given a free chair there straight away.
function onFloorTap(e) {
  if (e.target.closest("button")) return; // Start, + chairs and other buttons handle themselves
  const el = e.target.closest(".ltable");
  if (!el) return toast("Tap a table to sit down");
  const t = LOBBY_TABLES.find((x) => x.id === el.dataset.id);
  if (t) sitAnywhere(t);
}

// Give me the first free chair at this table (moving me from another table if I was waiting there).
// The screen changes straight away; saving happens in the background.
let pendingSeat = null; // { id, from } while my tap is being saved
async function sitAnywhere(t) {
  if (blockedCheck() || !myName()) return;
  if ((pendingSeat?.id || myLobbyTable()) === t.id) return;
  const r = tableState(t);
  if (r.status !== "lobby") return toast("This table is playing right now · pick another one");
  if (r.playerIds.filter((u) => u !== uid).length >= seatsOf(r)) return toast("This table is full · pick another one");
  const chairs = seatMap(r);
  let free = 0;
  while (chairs.has(free) && chairs.get(free).uid !== uid) free++;
  const old = myLobbyTable();
  pendingSeat = { id: t.id, from: old };
  renderFloor(); // show me at the new table now
  if (old) { me.seated = false; leaveRoom(); leaveTable(old); } // leave in the background
  const ok = await sitAt(t, free);
  if (ok) me.seated = true;
  pendingSeat = null;
  writePresence();
  renderFloor();
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
          players: [entry], playerIds: [uid], scores: { [uid]: 0 }, seen: { [uid]: serverTimestamp() },
          round: r?.round || 0, moveId: 0, gameRound: 0, maxPlayers: LOBBY_SEATS[t.game],
          target: targetFor(t.game),
          endMode: "rounds", roundsLimit: LOBBY_ROUNDS, almost: {},
          heartbeat: serverTimestamp(), createdAt: serverTimestamp(),
          log: `${name} sat down`,
        });
        return;
      }
      if (r.status !== "lobby") throw "This table is playing right now";
      const taken = seatMap(r).get(seatIndex);
      if (taken && taken.uid !== uid) {
        throw isOffline(r, taken.uid, t.id)
          ? "That chair is being freed (its player went offline) · try again in a few seconds"
          : `${taken.name} is sitting in that chair`;
      }
      if (r.playerIds.includes(uid)) { // moving to another chair at the same table
        tx.update(ref, { players: r.players.map((p) => (p.uid === uid ? { ...p, seat: seatIndex } : p)) });
        return;
      }
      if (r.playerIds.length >= seatsOf(r)) throw "This table is full";
      tx.update(ref, {
        players: [...r.players, entry], playerIds: [...r.playerIds, uid],
        [`scores.${uid}`]: 0, [`seen.${uid}`]: serverTimestamp(), log: `${name} sat down`,
      });
    });
    enterRoom(t.id);
    setTimeout(clearGhostSeats, 1500); // in case my old table still lists me
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
  if (myLobbyTable() && myLobbyTable() !== t.id) { const old = myLobbyTable(); me.seated = false; leaveRoom(); await leaveTable(old); } // switch tables
  const sameTable = myLobbyTable() === t.id;
  // no walking: sit straight down
  me.x = pos.x; me.y = pos.y;
  if (await sitAt(t, seatIndex)) { me.seated = true; writePresence(); renderFloor(); }
  else if (sameTable) { me.seated = true; renderFloor(); }
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

// ----- "Select a table": four simple cards (tap one to take a chair there) -----
function renderTableCards(tables) {
  const box = $("tableCards");
  if (!box) return;
  box.innerHTML = "";
  const meEntry = { uid, ...myEntry(myName() || "You") };
  const myTable = pendingSeat?.id || myLobbyTable();
  for (const r of tables) {
    const t = LOBBY_TABLES.find((x) => x.id === r.id);
    const seats = seatsOf(r);
    // what to draw: the table as saved, adjusted for a tap that's still being saved
    let players = r.players.filter((p) => !(pendingSeat && p.uid === uid && r.id !== pendingSeat.id));
    if (myTable === r.id && !players.some((p) => p.uid === uid)) players = [...players, { ...meEntry, seat: undefined }];
    const n = players.length;
    const mine = myTable === r.id;
    const playing = r.status !== "lobby";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "rt-card g-" + r.game + (mine ? " mine" : "") + (playing ? " playing" : "") + (n >= seats && !mine ? " full" : "");
    const rt = document.createElement("div");
    rt.className = "rt";
    // chairs around the round table; people fill them in seat order
    const bySeat = [];
    const loose = [];
    for (const p of players) (Number.isInteger(p.seat) && p.seat < seats && !bySeat[p.seat] ? (bySeat[p.seat] = p) : loose.push(p));
    for (let i = 0; i < seats && loose.length; i++) if (!bySeat[i]) bySeat[i] = loose.shift();
    for (let i = 0; i < seats; i++) {
      const ang = Math.PI / 2 + (i * 2 * Math.PI) / seats;
      const ch = document.createElement("span");
      const p = bySeat[i];
      ch.className = "rt-chair" + (p ? " taken" : "") + (p?.uid === uid ? " me" : "");
      ch.style.left = `${50 + 41 * Math.cos(ang)}%`;
      ch.style.top = `${50 + 41 * Math.sin(ang)}%`;
      if (p) ch.append(avatarEl(p, "avatar small"));
      ch.title = p ? (p.uid === uid ? "You" : p.name) : "Free chair";
      rt.append(ch);
    }
    const felt = document.createElement("div");
    felt.className = "rt-felt";
    felt.append(Object.assign(document.createElement("b"), { textContent: `Table ${r.no}` }));
    if (mine && !playing && n >= 2) {
      const start = Object.assign(document.createElement("span"), { className: "rt-start", textContent: "▶ Start" });
      start.onclick = (e) => { e.stopPropagation(); if (!pendingSeat) startTable(); };
      felt.append(start);
    } else {
      felt.append(Object.assign(document.createElement("small"), {
        textContent: playing ? "Playing" : mine ? "Waiting…" : n >= seats ? "Full" : `${n}/${seats}`,
      }));
    }
    rt.append(felt);
    card.append(Object.assign(document.createElement("span"), { // free / people waiting / a game going on
      className: "tstate " + (playing ? "playing" : n ? "seated" : "free"),
      textContent: playing ? `🔴 Playing · ${n}/${seats}` : n ? `👥 ${n}/${seats} seated` : "🟢 Free",
    }));
    const label = Object.assign(document.createElement("div"), {
      className: "rt-label",
      textContent: mine ? (n >= 2 ? `✓ Your table · ${n} players` : "✓ Your table · waiting for 1 more") : playing ? "Game on" : n >= seats ? "Full" : "Tap to join",
    });
    card.append(rt, label);
    card.onclick = () => { if (!mine && !playing) sitAnywhere(t); };
    box.append(card);
  }
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

// Every player at a table checks in every 20 seconds (and right away when they come back to the app).
let checkInSentAt = 0, lastMySeen = 0;
function checkIn() {
  if (!room || !roomId || room.status === "closed" || !room.playerIds?.includes(uid)) return;
  checkInSentAt = Date.now();
  updateDoc(roomRef(), { heartbeat: serverTimestamp(), [`seen.${uid}`]: serverTimestamp(),
    ...(room.away?.[uid] ? { [`away.${uid}`]: deleteField() } : {}) }).catch(() => {});
}
// leaving the app (home button, screen off, closing it): tell the others straight away
function markAway() {
  if (!room || !roomId || room.status === "closed" || !room.playerIds?.includes(uid) || room.away?.[uid]) return;
  updateDoc(roomRef(), { [`away.${uid}`]: true }).catch(() => {});
}
addEventListener("pagehide", markAway);
// Who is online: green dot = here now, grey = away (app closed, phone locked or no connection).
function onlineState(u) {
  if (!room || isBot(u) || !room.playerIds?.includes(u)) return null;
  if (u === uid) return true;
  if (room.away?.[u]) return false;
  return !(isOffline(room, u, roomId) || silentFor(u) > 45_000);
}
function markOnline() {
  if (!room) return;
  document.querySelectorAll("#seats .seat-tag[data-uid], #players .player[data-uid], #loungeMembers .mem-row[data-uid]").forEach((el) => {
    const st = onlineState(el.dataset.uid);
    let dot = el.querySelector(":scope > .odot");
    if (st === null) { dot?.remove(); el.classList.remove("is-away"); return; }
    if (!dot) { dot = Object.assign(document.createElement("span"), { className: "odot" }); el.prepend(dot); }
    dot.className = "odot " + (st ? "on" : "off");
    dot.title = st ? "Online" : "Away";
    el.classList.toggle("is-away", !st);
    if (el.classList.contains("seat-tag")) {
      let tag = el.querySelector(".away-tag");
      const slow = st && room.slow?.[el.dataset.uid] && el.dataset.uid !== uid;
      const txt = !st ? "📵 offline" : slow ? "🐢 slow" : "";
      if (txt && !tag) { tag = Object.assign(document.createElement("span"), { className: "away-tag" }); el.querySelector(".st-info b")?.after(tag); }
      if (tag) { if (txt) tag.textContent = txt; else tag.remove(); }
    }
  });
}
setInterval(markOnline, 5000);

// ----- connection quality -----
// My moves are timed from sending to the server's OK. Slow answers (or a move still waiting) mean a
// slow connection: I see a warning, and the others are told so they wait a little longer for me.
let netSlowUntil = 0, netState = "ok", lastOffNames = "";
function noteRtt(ms) { if (ms > 2500) netSlowUntil = Date.now() + 20_000; }
function myNet() {
  if (!navigator.onLine) return "offline";
  if (pendingMoves.some((m) => Date.now() - (m.at || 0) > 6000)) return "offline";
  if (Date.now() < netSlowUntil || pendingMoves.some((m) => Date.now() - (m.at || 0) > 2500)) return "slow";
  return "ok";
}
function netPill() {
  let el = $("netPill");
  if (!el) { el = Object.assign(document.createElement("div"), { id: "netPill", className: "net-pill" }); document.body.append(el); }
  return el;
}
function watchNet() {
  const el = netPill();
  const inGame = !!room && roomId && room.playerIds?.includes(uid) && ["playing", "ended", "lobby"].includes(room.status) && !$("game").hidden;
  if (!inGame) { el.hidden = true; return; }
  const st = myNet();
  if (st !== netState) {
    const was = netState; netState = st;
    // tell the others I'm slow (so they don't skip me too soon), and when I'm fine again
    if (room.status === "playing" && (st === "slow") !== !!room.slow?.[uid] && st !== "offline")
      updateDoc(roomRef(), { [`slow.${uid}`]: st === "slow" ? true : deleteField() }).catch(() => {});
    if (st === "ok" && was !== "ok") toast("✅ Connection is back to normal");
  }
  const offline = room.status === "playing" ? room.players.filter((p) => onlineState(p.uid) === false) : [];
  const slowOnes = room.status === "playing" ? room.players.filter((p) => p.uid !== uid && room.slow?.[p.uid] && onlineState(p.uid) !== false) : [];
  const names = offline.map((p) => p.name).join(", ");
  if (names !== lastOffNames) {
    const added = offline.filter((p) => !lastOffNames.split(", ").includes(p.name));
    if (added.length) toast(`📵 ${added.map((p) => p.name).join(", ")} went offline`);
    lastOffNames = names;
  }
  let msg = "", cls = "";
  if (st === "offline") { msg = "📵 No connection · your move will be sent when you're back online"; cls = "bad"; }
  else if (st === "slow") { msg = "🐢 Slow connection · moves may take a moment"; cls = "warn"; }
  else if (offline.length) { msg = `📵 ${names} ${offline.length > 1 ? "are" : "is"} offline`; cls = "bad"; }
  else if (slowOnes.length) { msg = `🐢 ${slowOnes.map((p) => p.name).join(", ")}: slow connection`; cls = "warn"; }
  el.hidden = !msg;
  el.textContent = msg;
  el.className = "net-pill " + cls;
}
setInterval(watchNet, 1000);
addEventListener("offline", watchNet);
addEventListener("online", () => { netSlowUntil = Date.now() + 5000; watchNet(); });
setInterval(() => { checkIn(); renderFloor(); }, 20_000);
onReconnect(() => { checkIn(); if (roomId) watchPresence(roomId, uid); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return markAway();
  checkIn();
  if (inLobbyView()) writePresence();
});

// Remove players who have been offline for over a minute. Any online player at the table does it.
function removalUpdate(r, out) {
  const keep = r.players.filter((p) => !out.includes(p.uid));
  const ids = keep.map((p) => p.uid);
  const pick = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !out.includes(k)));
  const names = r.players.filter((p) => out.includes(p.uid)).map((p) => p.name).join(" & ");
  const upd = {
    players: keep, playerIds: ids, scores: pick(r.scores), seen: pick(r.seen), almost: pick(r.almost),
    log: `${names} went offline and left`,
  };
  if (out.includes(r.host) && ids.length) upd.host = ids[0];
  if (r.status === "playing" || r.status === "ended") {
    if (ids.length < 2) { // not enough players left: stop the game
      Object.assign(upd, {
        status: "lobby", gameOver: false, champions: null, gameRound: 0, almost: {}, digus: null,
        scores: Object.fromEntries(ids.map((id) => [id, 0])),
        log: `${names} went offline · not enough players, game stopped`,
      });
    } else if (r.status === "playing" && r.game === "dhiha") {
      Object.assign(upd, { status: "lobby", log: `${names} went offline · the DHIHA round stopped (it needs 4 players)` });
    } else if (r.status === "playing" && r.game === "bondi") {
      Object.assign(upd, bondiRemoval(r, out, ids, pick));
    } else if (r.status === "playing") {
      const cur = r.playerIds[r.turn];
      if (out.includes(cur)) { // it was their turn: pass it to the next player still here
        let k = 1;
        while (out.includes(r.playerIds[(r.turn + k) % r.playerIds.length])) k++;
        const call = r.game === "call";
        Object.assign(upd, {
          turn: ids.indexOf(r.playerIds[(r.turn + k) % r.playerIds.length]),
          phase: call ? "throw" : "draw", moveId: (r.moveId || 0) + 1,
          ...(call && r.phase === "draw" ? { lastThrow: r.thrownNow || null, pickable: null, thrownNow: null } : {}),
        });
      } else upd.turn = ids.indexOf(cur);
    }
  }
  return upd;
}

// The holhuashi owner (or whoever runs the table when the owner isn't there) decides about a
// player who keeps missing turns while offline.
const isDecider = () => !!room && isLoungeDoc(room) && (ownsLounge(room) || (room.host === uid && !room.playerIds.includes(room.owner)));
function renderOfflineAsk() {
  const box = $("offlineAsk");
  const a = room?.status === "playing" ? room.offlineAsk : null;
  const show = !!a && isDecider() && room.playerIds.includes(a.uid);
  box.hidden = !show;
  if (!show) return;
  $("offlineAskText").textContent = `${nameOf(a.uid)} is offline and has missed their turn${gameOf(room) === "dhiha" ? "" : " twice"}. Remove them from the game?`;
  $("offlineKeep").textContent = gameOf(room) === "dhiha" ? "Keep · pause & wait" : "Keep · skip their turns";
}
async function decideOffline(remove) {
  const a = room?.offlineAsk;
  if (!a || !isDecider()) return;
  $("offlineAsk").hidden = true;
  try {
    await runTransaction(db, async (tx) => {
      const r = (await tx.get(roomRef())).data();
      if (!r?.offlineAsk || r.offlineAsk.uid !== a.uid) return;
      if (remove && r.playerIds.includes(a.uid)) tx.update(roomRef(), { ...removalUpdate(r, [a.uid]), offlineAsk: null });
      else tx.update(roomRef(), {
        offlineAsk: null, [`keepOffline.${a.uid}`]: true,
        ...(r.game === "dhiha" ? { paused: { by: uid, at: Date.now() }, log: `⏸ Waiting for ${nameOf(a.uid)} to come back` } : { log: `${nameOf(a.uid)} stays · their turns are skipped while offline` }),
      });
    });
  } catch (e) { toast(errMsg(e)); }
}
// When an offline player is back, forget their missed turns.
setInterval(() => {
  if (!room || room.host !== uid || room.status !== "playing") return;
  const back = Object.keys({ ...(room.missed || {}), ...(room.keepOffline || {}) })
    .filter((u) => room.playerIds.includes(u) && !isOffline(room, u, roomId) && silentFor(u) < 20_000);
  if (!back.length) return;
  const upd = {};
  for (const u of back) { upd[`missed.${u}`] = deleteField(); upd[`keepOffline.${u}`] = deleteField(); }
  if (room.offlineAsk && back.includes(room.offlineAsk.uid)) upd.offlineAsk = null;
  updateDoc(roomRef(), upd).catch(() => {});
}, 8000);

async function kickOffline() {
  if (!room || !roomId || room.status === "closed" || !room.playerIds?.includes(uid)) return;
  if (room.paused && room.status === "playing") return; // paused: wait for them
  if (room.status === "playing" && isLoungeDoc(room)) {
    const deciderHere = [room.owner, room.host].some((u) => u && room.playerIds.includes(u) && !isOffline(room, u, roomId));
    if (deciderHere) return; // the owner decides (see offlineAsk)
  }
  if (!room.players.some((p) => isOffline(room, p.uid, roomId))) return;
  const code = roomId;
  try {
    let names = "";
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const r = (await tx.get(ref)).data();
      if (!r || !r.playerIds.includes(uid) || (r.paused && r.status === "playing")) return;
      const out = r.playerIds.filter((id) => isOffline(r, id, code));
      if (!out.length) return;
      names = r.players.filter((p) => out.includes(p.uid)).map((p) => p.name).join(" & ");
      tx.update(ref, removalUpdate(r, out));
    });
    if (names) toast(`${names} went offline for too long and left the table`);
  } catch { /* someone else removed them first */ }
}
setInterval(kickOffline, 10_000);
// Between rounds: if the host has gone quiet, another player saves the scores and can deal.
setInterval(() => {
  if (!room || room.status !== "ended" || !room.playerIds?.includes(uid)) return;
  if (room.host !== uid && isOffline(room, room.host, roomId)) {
    if (!room.scored && lastRows && resultsRound === room.round) saveScores();
    if (!$("results").hidden) renderResults();
  }
}, 5_000);

// Remove me from a lobby table I'm no longer at (used when switching tables, and as a safety net).
async function leaveTable(code) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "rooms", code);
        const r = (await tx.get(ref)).data();
        if (!r || r.status !== "lobby" || !r.playerIds.includes(uid)) return;
        let players = r.players.filter((p) => p.uid !== uid);
        if (!players.some((p) => !isBot(p.uid))) players = []; // only computer people left: they go too
        const upd = { players, playerIds: players.map((p) => p.uid), log: `${r.players.find((p) => p.uid === uid)?.name || "Someone"} left` };
        if (players.length && r.host === uid) { upd.host = players[0].uid; upd.heartbeat = serverTimestamp(); }
        if (!players.length && !isLoungeDoc(r)) upd.status = "closed";
        tx.update(ref, upd);
      });
      return true;
    } catch (e) { console.warn("Leaving table", code, e); }
  }
  return false;
}
// Any lobby table (other than the one I'm at) that still lists me: take me off it.
function clearGhostSeats() {
  for (const r of openRooms) {
    if (r.id !== roomId && LOBBY_TABLES.some((t) => t.id === r.id) && r.status === "lobby" && r.playerIds?.includes(uid)) leaveTable(r.id);
  }
}
setInterval(clearGhostSeats, 10_000);

// Leaving a table frees the seat.
async function exitRoom() {
  const code = roomId, wasLobby = room?.status === "lobby";
  if (room?.practice && room.host === uid) {
    updateDoc(doc(db, "rooms", code), { status: "closed" }).catch(() => {});
    leaveRoom();
    return;
  }
  leaveRoom();
  if (!code || !wasLobby) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const r = (await tx.get(ref)).data();
      if (!r || r.status !== "lobby" || !r.playerIds.includes(uid)) return;
      let players = r.players.filter((p) => p.uid !== uid);
      if (!players.some((p) => !isBot(p.uid))) players = []; // only computer players left: they go too
      const upd = {
        players, playerIds: players.map((p) => p.uid),
        log: `${r.players.find((p) => p.uid === uid)?.name || "Someone"} left`,
      };
      if (!players.length) { if (!isLoungeDoc(r)) upd.status = "closed"; } // a holhuashi stays open, empty
      else if (r.host === uid) { upd.host = players[0].uid; upd.heartbeat = serverTimestamp(); }
      tx.update(ref, upd);
    });
  } catch (e) { console.warn("Leaving the table", e); }
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
      if (LOBBY_TABLES.some((t) => t.id === roomId)) lobbyGame = gameOf(room);
      layoutFloor(LOBBY_TABLES.map(tableState));
      const L = floorLayout.tables.get(roomId), i = mySeat(room);
      if (L?.seatPos[i]) { me.x = L.seatPos[i].x; me.y = L.seatPos[i].y; }
    }
    renderFloor();
    writePresence();
  }
  if (!atLobby && wasLobby) clearPresence();
  if (!atLobby && !atGame) renderMyLounges();
  renderSeatBar();
}

function openLobby(game = lobbyGame) {
  if (blockedCheck() || !myName()) return;
  lobbyGame = game;
  lobbyOpen = true;
  me = { x: 44 + Math.random() * 12, y: 92, seated: false }; // walk in through the entrance
  if (location.hash !== lobbyHash()) history.pushState(null, "", lobbyHash());
  updateView();
  renderFloor();
  scrollTo(0, 0);
}

// Leave this lobby (standing up first if I'm sitting) and walk into another one.
async function switchLobby(game) {
  if (game === lobbyGame && inLobbyView()) return;
  if (myLobbyTable()) { me.seated = false; await exitRoom(); }
  walkerEls.forEach((el) => el.remove()); walkerEls.clear();
  lobbyGame = game;
  me = { x: 44 + Math.random() * 12, y: 92, seated: false };
  history.replaceState(null, "", lobbyHash());
  updateView();
  renderFloor();
  writePresence();
  toast(`Welcome to the ${GAME_NAME[game]} Aammu Jagaha`);
}

async function closeLobby() {
  if (myLobbyTable()) await exitRoom();
  lobbyOpen = false;
  if (location.hash) history.pushState(null, "", location.pathname);
  updateView();
}

addEventListener("popstate", () => {
  const g = lobbyFromHash(location.hash);
  if (g && !lobbyOpen) openLobby(g);
  else if (g && g !== lobbyGame && !room) switchLobby(g);
  else if (!location.hash && lobbyOpen && !room) { lobbyOpen = false; updateView(); }
  else if (!location.hash && myLobbyTable()) closeLobby();
});

// ---------- playing against the computer ----------
// A practice game is a private room with you and 1–3 computer players ("bot-1", "bot-2", …).
// Your own screen plays for the computer players: their hands are stored like anyone else's,
// and only you (the host) can read them. Practice games don't count toward career points.
const isBot = (id) => typeof id === "string" && id.startsWith("bot-");
const BOT_NAMES = ["Ali", "Sara", "Omar", "Lina", "Zaid", "Mira", "Hassan", "Aisha", "Ibrahim", "Mariyam", "Ahmed", "Fathimath",
  "Shifa", "Nazim", "Riyaz", "Hawwa", "Naseer", "Zeena", "Shamil", "Aminath"];
const BOT_FACES = ["😀", "😎", "🙂", "😄", "🧔", "👩", "👨", "🧕", "👦", "👧", "🧑", "👱"];
const botFace = () => BOT_FACES[Math.floor(Math.random() * BOT_FACES.length)];
// A game with any computer player in it is just for fun: no holhuashi points, no career points.
const hasBots = (r) => !!r?.playerIds?.some(isBot);
const noPoints = (r) => !!r?.practice || hasBots(r);

// Holhuashi owner: fill a free seat with a computer player (or take one away) before the game starts.
const canManageBots = () => !!room && isLoungeDoc(room) && !room.tourney && room.status === "lobby"
  && (ownsLounge(room) || (room.host === uid && !room.playerIds.includes(room.owner)));
async function addBot(silent = false) {
  if (!canManageBots()) return;
  if (room.players.length >= (room.maxPlayers || 6)) return toast("All seats are taken");
  const used = new Set(room.players.map((p) => p.name));
  const name = [...BOT_NAMES].sort(() => Math.random() - 0.5).find((n) => !used.has(n)) || "Player " + (room.players.length + 1);
  let id; do { id = "bot-" + Math.random().toString(36).slice(2, 6); } while (room.playerIds.includes(id));
  const upd = {
    players: [...room.players, { uid: id, name, avatar: botFace(), rank: null, badges: 0 }],
    playerIds: [...room.playerIds, id], [`scores.${id}`]: 0,
    log: `${name} (computer) sat down · games with the computer give no points`,
  };
  if (isDhiha()) { const tm = dhihaTeams(); const free = tm.A.length < 2 ? "A" : tm.B.length < 2 ? "B" : null; if (free) upd[`teams.${id}`] = free; }
  return updateDoc(roomRef(), upd).catch((e) => toast(errMsg(e)));
}
// Not enough people? Fill the empty places with computer players in one tap.
async function fillWithBots() {
  if (!canManageBots()) return;
  const need = (isDhiha() ? 4 : 2) - room.players.length;
  if (need <= 0) return;
  const used = new Set(room.players.map((p) => p.name));
  const names = BOT_NAMES.filter((n) => !used.has(n)).sort(() => Math.random() - 0.5);
  const bots = [], teams = { ...(room.teams || {}) };
  for (let i = 0; i < need; i++) {
    let id; do { id = "bot-" + Math.random().toString(36).slice(2, 6); } while (room.playerIds.includes(id) || bots.some((b) => b.uid === id));
    bots.push({ uid: id, name: names[i] || `Player ${i + 1}`, avatar: botFace(), rank: null, badges: 0 });
    if (isDhiha()) {
      const a = room.playerIds.concat(bots.map((b) => b.uid)).filter((u) => teams[u] === "A").length;
      teams[id] = a < 2 ? "A" : "B";
    }
  }
  const upd = {
    players: [...room.players, ...bots], playerIds: [...room.playerIds, ...bots.map((b) => b.uid)],
    ...Object.fromEntries(bots.map((b) => [`scores.${b.uid}`, 0])),
    log: `🤖 ${bots.map((b) => b.name).join(" & ")} joined · games with the computer give no points`,
  };
  if (isDhiha()) bots.forEach((b) => (upd[`teams.${b.uid}`] = teams[b.uid]));
  await updateDoc(roomRef(), upd).catch((e) => toast(errMsg(e)));
}
function removeBot(id) {
  if (!canManageBots() || !isBot(id)) return;
  updateDoc(roomRef(), {
    players: room.players.filter((p) => p.uid !== id), playerIds: room.playerIds.filter((u) => u !== id),
    [`scores.${id}`]: deleteField(), [`teams.${id}`]: deleteField(), log: `${nameOf(id)} (computer) left`,
  }).catch((e) => toast(errMsg(e)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What a player took from the thrown pile / threw away, kept short (premium card tracker).
function trackUpd(who, kind, cards) {
  const t = room.track?.[who] || {};
  const took = [...(t.took || [])], threw = [...(t.threw || [])];
  (kind === "took" ? took : threw).push(...cards);
  return { [`track.${who}`]: { took: took.slice(-8), threw: threw.slice(-10) } };
}
let practiceDealPending = null, botKey = null;

async function startPractice(game, bots, level = "medium") {
  if (blockedCheck()) return;
  const name = myName();
  if (!name) return;
  if (myLobbyTable()) await exitRoom();
  $("botModal").hidden = true;
  try {
    let code;
    do { code = "P" + randomCode().slice(1); } while ((await getDoc(doc(db, "rooms", code))).exists());
    const ref = doc(db, "rooms", code);
    await setDoc(ref, {
      host: uid, status: "lobby", practice: true, public: false, game, botLevel: level,
      players: [myEntry(name)], playerIds: [uid], scores: { [uid]: 0 },
      round: 0, moveId: 0, gameRound: 0, maxPlayers: bots + 1,
      endMode: "rounds", roundsLimit: LOBBY_ROUNDS,
      target: targetFor(game),
      seen: { [uid]: serverTimestamp() }, heartbeat: serverTimestamp(), createdAt: serverTimestamp(),
      log: `Practice ${GAME_NAME[game]} vs the computer`,
    });
    const robots = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, bots)
      .map((n, i) => ({ uid: `bot-${i + 1}`, name: n, avatar: botFace(), rank: null, badges: 0 }));
    await updateDoc(ref, {
      players: [myEntry(name), ...robots], playerIds: [uid, ...robots.map((r) => r.uid)],
      ...Object.fromEntries(robots.map((r) => [`scores.${r.uid}`, 0])),
    });
    lobbyOpen = false;
    practiceDealPending = code;
    enterRoom(code);
  } catch (e) { toast(errMsg(e)); }
}

// Called whenever the room changes: if it's a computer player's turn, play it after a short pause.
async function maybeBotMove() {
  if (!room || room.status !== "playing" || room.host !== uid || room.paused || roomStale) return;
  if (isBabbush()) return bbHost();
  const bot = room.playerIds[room.turn];
  if (!isBot(bot)) return;
  const key = `${roomId}-${room.round}-${room.moveId || 0}-${room.phase}`;
  if (botKey === key) return;
  botKey = key;
  await sleep(1100 + Math.random() * 1000); // "thinking": a computer takes 1–2 seconds, like a person
  while (shuffling()) await sleep(250); // the new middle pile is still being shuffled
  if (!room || `${roomId}-${room.round}-${room.moveId || 0}-${room.phase}` !== key) return;
  try {
    const cards = (await getDoc(handRef(bot))).data()?.cards || [];
    botKnown = botLevel() === "hard" ? await knownHands(bot, cards) : null;
    if (gameOf(room) === "dhiha") await botDhiha(bot, cards);
    else if (gameOf(room) === "bondi") await botBondi(bot, cards);
    else if (gameOf(room) === "call") await botCall(bot, cards);
    else await botDigu(bot, cards);
  } catch (e) { console.warn("Computer player move failed", e); botKey = null; }
}

// Hard computer players play with what this phone can see: every computer player's hand, and my
// own hand (I'm the one running them). Other people's hands stay hidden.
let botKnown = null;
async function knownHands(bot, cards) {
  const out = { [bot]: cards };
  const pk = (u, c) => [...c, ...(isBondi() ? pickList(u).filter((x) => !c.includes(x)) : [])];
  out[bot] = pk(bot, cards);
  for (const u of room.playerIds) {
    if (u === bot) continue;
    if (u === uid) { out[u] = pk(u, [...hand]); continue; }
    if (!isBot(u)) continue;
    try { out[u] = pk(u, (await getDoc(handRef(u))).data()?.cards || []); } catch {}
  }
  return out;
}
// "last online" for the admin list: stamped when the app opens, then every 3 minutes while it's in use
let seenStampAt = 0;
function stampSeen(force) {
  if (!uid || amBlocked || document.hidden || (!force && Date.now() - seenStampAt < 170_000)) return;
  seenStampAt = Date.now();
  if (usingRealtime()) setDoc(doc(db, "lastSeen", uid), { t: serverTimestamp() }).catch(() => {}); // free to write often
  else setDoc(doc(db, "users", uid), { lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
}
setInterval(() => stampSeen(false), 60_000);
document.addEventListener("visibilitychange", () => stampSeen(false));
const botName = (id) => room.players.find((p) => p.uid === id)?.name || "Computer";

function botCommit(roomUpd, bot, cards) {
  const b = moveBatch();
  b.update(roomRef(), roomUpd);
  if (cards) b.update(handRef(bot), { cards });
  return b.commit().catch((e) => { if (e?.message !== "STALE") throw e; });
}

// DIGU computer: take the thrown card if it helps, otherwise the middle pile; then throw the card
// that leaves the fewest leftover points, or call DIGU when it can.
const botLevel = () => room?.botLevel || "medium";
async function botDigu(bot, cards) {
  const level = botLevel();
  if (room.phase === "draw" && level === "easy") { // easy: usually just takes from the middle pile
    let deck = [...room.deck], discard = [...room.discard], card, from;
    const top = discard[discard.length - 1];
    if (top && Math.random() < 0.25) { card = discard.pop(); from = "the thrown card"; }
    else {
      if (!deck.length) { if (discard.length <= 1) return; ({ deck, discard } = C.reshuffleDiscard(discard)); }
      card = deck.pop(); from = "from the pile";
    }
    return botCommit({ deck, discard, phase: "discard", log: `${botName(bot)} took ${from}`, took: from === "the thrown card" ? card : null,
      ...(from === "the thrown card" ? trackUpd(bot, "took", [card]) : {}) }, bot, [...cards, card]);
  }
  if (room.phase === "discard" && level === "easy") { // easy: throws a random card that isn't in a set
    const lay = C.bestLayout(cards);
    const ban = takenNow(bot);
    let loose = (lay.leftover.length ? lay.leftover : cards).filter((x) => x !== ban);
    if (!loose.length) loose = cards.filter((x) => x !== ban);
    const c = loose[Math.floor(Math.random() * loose.length)];
    const rest = cards.filter((x) => x !== c);
    const win = C.findWinningLayout(rest);
    const upd = { discard: [...room.discard, c], ...trackUpd(bot, "threw", [c]) };
    if (win) Object.assign(upd, { status: "ended", winner: bot, diguCard: c, diguStyle: null, winnerSets: win.map((s) => s.join(",")), log: `${botName(bot)} called DIGU!` });
    else { Object.assign(upd, nextTurn(`${botName(bot)} threw a card`)); if (!room.deck.length && upd.discard.length > 1) Object.assign(upd, C.reshuffleDiscard(upd.discard)); }
    return botCommit(upd, bot, rest);
  }
  if (room.phase === "draw" && level === "hard") { // hard: peeks at the next card of the middle pile
    const top = room.discard?.[room.discard.length - 1];
    let deck = [...room.deck], discard = [...room.discard];
    if (!deck.length && discard.length > 1) ({ deck, discard } = C.reshuffleDiscard(discard));
    const next = deck[deck.length - 1];
    const fromTop = top ? C.diguBestAfter([...cards, top], top) : null;
    const fromDeck = next ? C.diguBestAfter([...cards, next]) : null;
    const rank = (o) => (!o ? Infinity : o.win ? -1 : o.pts);
    let card, from;
    if (fromTop && (rank(fromTop) < rank(fromDeck) || !fromDeck)) { discard = [...room.discard]; deck = [...room.deck]; card = discard.pop(); from = "the thrown card"; }
    else if (next) { card = deck.pop(); from = "from the pile"; }
    else return;
    return botCommit({ deck, discard, phase: "discard", log: `${botName(bot)} took ${from}`, took: from === "the thrown card" ? card : null,
      ...(from === "the thrown card" ? trackUpd(bot, "took", [card]) : {}) }, bot, [...cards, card]);
  }
  if (room.phase === "draw") {
    const top = room.discard?.[room.discard.length - 1];
    const now = C.bestLayout(cards).points;
    const withTop = top ? Math.min(...cards.map((c) => C.bestLayout([...cards, top].filter((x) => x !== c)).points)) : Infinity; // (the taken card can't go straight back)
    let deck = [...room.deck], discard = [...room.discard], card, from;
    if (top && withTop < now) { card = discard.pop(); from = "the thrown card"; }
    else {
      if (!deck.length) {
        if (discard.length <= 1) return;
        ({ deck, discard } = C.reshuffleDiscard(discard));
      }
      card = deck.pop(); from = "from the pile";
    }
    return botCommit({ deck, discard, phase: "discard", log: `${botName(bot)} took ${from}`, took: from === "the thrown card" ? card : null,
      ...(from === "the thrown card" ? trackUpd(bot, "took", [card]) : {}) }, bot, [...cards, card]);
  }
  // throw
  let best = null;
  const meI = room.playerIds.indexOf(bot), nxt = room.playerIds[nextActiveIdx(room, meI)];
  // Medium and Hard watch what the next player takes from the thrown pile (and what they throw
  // away), and don't feed them a card that fits. Hard also knows the next player's hand when this
  // phone can see it, and never throws a card that would help it.
  const tr = room.track?.[nxt] || {};
  const wants = level !== "easy" ? (tr.took || []).filter((id) => !(tr.threw || []).includes(id)) : [];
  const nextHand = level === "hard" ? botKnown?.[nxt] : null;
  const scale = level === "hard" ? 1.5 : 1;
  const helpsNext = (c) => {
    if (level === "easy") return 0;
    if (nextHand?.length) { // exact: how much better would their hand get with this card?
      const now = C.bestLayout(nextHand).points;
      const withC = Math.min(...nextHand.map((x) => C.bestLayout([...nextHand, c].filter((y) => y !== x)).points));
      return withC < now ? 20 + (now - withC) * 2 : 0;
    }
    const s0 = C.parse(c);
    let pen = 0;
    for (const id of wants) {
      const t = C.parse(id);
      if (t.r === s0.r) pen = Math.max(pen, 30);                                   // a set of the same number
      else if (t.s === s0.s && Math.abs(t.r - s0.r) === 1) pen = Math.max(pen, 26); // next to it in a run
      else if (t.s === s0.s && Math.abs(t.r - s0.r) === 2) pen = Math.max(pen, 14); // a run with a gap
    }
    // a number they have thrown away themselves is usually safe to give them
    if (pen && (tr.threw || []).some((id) => C.parse(id).r === s0.r)) pen = Math.round(pen / 2);
    return pen * scale;
  };
  const ban = takenNow(bot);
  for (const c of cards) {
    if (c === ban) continue; // can't throw back the card just taken
    const rest = cards.filter((x) => x !== c);
    const sets = C.findWinningLayout(rest);
    if (sets) { best = { c, rest, sets }; break; }
    const pts = C.bestLayout(rest).points + helpsNext(c);
    if (!best || pts < best.pts || (pts === best.pts && C.points(c) > C.points(best.c))) best = { c, rest, pts };
  }
  const upd = { discard: [...room.discard, best.c], ...trackUpd(bot, "threw", [best.c]) };
  if (best.sets) {
    Object.assign(upd, {
      status: "ended", winner: bot, diguCard: best.c, diguStyle: null,
      winnerSets: best.sets.map((s) => s.join(",")), log: `${botName(bot)} called DIGU!`,
    });
  } else {
    Object.assign(upd, nextTurn(`${botName(bot)} threw a card`));
    if (!room.deck.length && upd.discard.length > 1) Object.assign(upd, C.reshuffleDiscard(upd.discard));
  }
  return botCommit(upd, bot, best.rest);
}

// CALL computer: CALL when its count is low enough; otherwise throw its highest group of
// same-number cards, then take the last player's card if it's small or pairs up, else the pile.
async function botCall(bot, cards) {
  const level = botLevel();
  if (room.phase === "throw") {
    const v = C.handValue(cards);
    const othersMin = Math.min(...activeIds(room).filter((u) => u !== bot).map((u) => room.ccount?.[u] ?? 5));
    // hard: knows the counts of every hand this phone can see
    const seenVals = botKnown ? activeIds(room).filter((u) => u !== bot && botKnown[u]).map((u) => C.handValue(botKnown[u])) : [];
    const allSeen = botKnown && activeIds(room).filter((u) => u !== bot).every((u) => botKnown[u]);
    const callNow = level === "easy" ? v <= 3
      : level === "hard" && allSeen ? v <= C.CALL_LIMIT && v < Math.min(...seenVals)
      : level === "hard" ? v <= C.CALL_LIMIT && v < Math.min(99, ...seenVals) && (v <= 3 || othersMin >= 3 || (v <= 5 && othersMin >= 2))
      : v <= C.CALL_LIMIT && (v <= 3 || othersMin >= 3 || (v <= 5 && othersMin >= 2));
    if (callNow) {
      return botCommit({
        status: "ended", winner: bot, diguCard: null, winnerSets: null, diguStyle: null,
        log: `${botName(bot)} called CALL with ${v}!`,
      });
    }
    const groups = {};
    for (const c of cards) (groups[C.parse(c).r] ||= []).push(c);
    const ids = level === "easy" ? [cards[Math.floor(Math.random() * cards.length)]]
      : Object.values(groups).sort((a, b) => C.callValue(b[0]) * b.length - C.callValue(a[0]) * a.length)[0];
    const prevLast = room.lastThrow?.length ? room.lastThrow[room.lastThrow.length - 1] : null;
    const pickable = prevLast && room.discard.includes(prevLast) ? prevLast : null;
    const upd = {
      discard: [...room.discard, ...ids], phase: "draw", pickable, thrownNow: ids, [`ccount.${bot}`]: cards.length - ids.length,
      log: `${botName(bot)} threw ${ids.length > 1 ? `${ids.length} × ${C.label(C.parse(ids[0]).r)}` : "a card"}`,
    };
    if (!room.deck.length) {
      const pool = room.discard.filter((c) => c !== pickable);
      if (pool.length) { upd.deck = C.shuffle(pool); upd.discard = [...(pickable ? [pickable] : []), ...ids]; }
    }
    return botCommit(upd, bot, cards.filter((c) => !ids.includes(c)));
  }
  // take
  let deck = [...room.deck], discard = [...room.discard], card, from;
  const p = room.pickable;
  const pairs = p && cards.some((c) => C.parse(c).r === C.parse(p).r);
  const peek = level === "hard" ? deck[deck.length - 1] : null; // hard: knows the next card of the pile
  const keepVal = (c) => (cards.some((x) => C.parse(x).r === C.parse(c).r) ? 0 : C.callValue(c));
  if (peek && p && discard.includes(p)) {
    if (keepVal(p) <= keepVal(peek)) { discard.splice(discard.lastIndexOf(p), 1); card = p; from = "the last thrown card"; }
    else { card = deck.pop(); from = "from the pile"; }
  } else if (p && discard.includes(p) && level !== "easy" && (C.callValue(p) <= 4 || pairs)) {
    discard.splice(discard.lastIndexOf(p), 1); card = p; from = "the last thrown card";
  } else if (deck.length) { card = deck.pop(); from = "from the pile"; }
  else return;
  return botCommit({
    deck, discard, lastThrow: room.thrownNow || null, pickable: null, thrownNow: null,
    [`ccount.${bot}`]: cards.length + 1,
    ...nextTurn(`${botName(bot)} took ${from}`),
  }, bot, [...cards, card]);
}

// Offer it when nobody else is around.
function renderBotOffer() {
  const others = [...presence.entries()].filter(([id, pr]) => id !== uid && presenceFresh(pr) && inMyLobby(pr)).length;
  $("aloneBanner").hidden = others > 0;
}

function openBotModal() {
  if (blockedCheck() || !myName()) return;
  $("botModal").hidden = false;
}

// ---------- holhuashis (registered players' own tables) ----------
// A holhuashi has a name and a code that lasts until its owner deletes it. Anyone with the code can
// come back any time, and you can play as many games there as you like.
const isLoungeDoc = (r) => !!r && r.public === false && !r.practice;
// the owner (older holhuashis without one: whoever runs it)
const ownsLounge = (r) => isLoungeDoc(r) && (r.owner ? r.owner === uid : r.host === uid);

// Where the holhuashi is. Everyone starts on the beach; the owner unlocks richer places by rank.
const PLACES = [
  { id: "hut",    name: "Thatched hut",      icon: "🛖", rank: 0, decor: ["🪔", "🥥", "🧺", "🌿"] },
  { id: "beach",  name: "Beach holhuashi",   icon: "🏝️", rank: 1, decor: ["🌴", "🌴", "🐚", "🥥"] },
  { id: "villa",  name: "Water villa deck",  icon: "🌅", rank: 2, decor: ["🌺", "🪴", "🌴", "🌺"] },
  { id: "palace", name: "Island guesthouse", icon: "🏡", rank: 3, decor: ["🪴", "🌿", "🪴", "🌴"] },
  { id: "yacht",  name: "Royal yacht",       icon: "🛥️", rank: 4, decor: ["⚓", "🛟", "🍾", "🌺"] },
  { id: "resort", name: "Resort hotel",      icon: "🏨", rank: 5, decor: ["🌺", "🍹", "🌴", "🍹"] },
];
const placeOf = (r) => PLACES.find((p) => p.id === r?.theme) || PLACES[0];
function setPlace(id) {
  const pl = PLACES.find((p) => p.id === id);
  if (!pl || !room || !ownsLounge(room)) return;
  if (myRank() < pl.rank) return toast(`🔒 ${pl.name} unlocks at ${P.RANKS[pl.rank].icon} ${P.RANKS[pl.rank].name} rank (${P.RANKS[pl.rank].at} points)`);
  updateDoc(roomRef(), { theme: id, log: `Moved to the ${pl.name}` }).catch((e) => toast(errMsg(e)));
}
function rememberLounge(code, name) {
  let list = [];
  try { list = JSON.parse(load("thaas-lounges") || "[]"); } catch {}
  list = [{ code, name }, ...list.filter((l) => l.code !== code)].slice(0, 12);
  store("thaas-lounges", JSON.stringify(list));
}
function forgetLounge(code) {
  let list = [];
  try { list = JSON.parse(load("thaas-lounges") || "[]"); } catch {}
  store("thaas-lounges", JSON.stringify(list.filter((l) => l.code !== code)));
}

// Home screen: the holhuashis I own (any device) and the ones I've been to (this device).
let myLoungesAt = 0;
let myLoungesUid = null;
async function renderMyLounges(force = false) {
  const box = $("myLounges");
  if (!box || !uid) return;
  if (myLoungesUid !== uid) { force = true; myLoungesUid = uid; } // just signed in (or out): refresh straight away
  if (!force && Date.now() - myLoungesAt < 3000) return;
  myLoungesAt = Date.now();
  if (!box.children.length && (isRegistered() || load("thaas-lounges"))) {
    box.hidden = false;
    box.innerHTML = '<p class="my-lounges-head">My holhuashis</p><p class="muted small-note">Loading…</p>';
  }
  const found = new Map();
  try {
    if (isRegistered()) {
      const [mine, joined] = await Promise.all([
        getDocs(query(collection(db, "rooms"), where("owner", "==", uid))),
        getDocs(query(collection(db, "rooms"), where("members", "array-contains", uid))).catch(() => ({ forEach() {} })),
      ]);
      mine.forEach((d) => found.set(d.id, d.data()));
      joined.forEach((d) => { if (isLoungeDoc(d.data())) found.set(d.id, d.data()); });
    }
    let seen = [];
    try { seen = JSON.parse(load("thaas-lounges") || "[]"); } catch {}
    await Promise.all(seen.filter((l) => !found.has(l.code)).map(async (l) => {
      const d = await getDoc(doc(db, "rooms", l.code)).catch(() => null);
      if (d?.exists() && isLoungeDoc(d.data())) found.set(l.code, d.data());
      else if (d && !d.exists()) forgetLounge(l.code);
    }));
  } catch (e) { console.warn("My holhuashis", e); }
  const list = [...found.entries()].filter(([, r]) => !r.tourney && r.status !== "deleted" && r.status !== "closed" && !(r.removed || []).includes(uid));
  box.innerHTML = "";
  box.hidden = !list.length;
  if (!list.length) return;
  box.append(Object.assign(document.createElement("p"), { className: "my-lounges-head", textContent: "My holhuashis" }));
  for (const [code, r] of list) {
    const row = document.createElement("div");
    row.className = "my-lounge";
    const info = document.createElement("div");
    const nm = document.createElement("b");
    nm.textContent = (r.owner === uid ? "⭐ " : "") + (r.name || "Holhuashi");
    const sub = document.createElement("small");
    const n = r.playerIds?.length || 0;
    const lp = loungePoints(r);
    sub.textContent = `⭐ ${lp.points} pts · ${lp.mood} · ${GAME_NAME[gameOf(r)]} · ${r.status === "lobby" ? (n ? `${n} inside` : "empty") : r.paused ? "⏸ paused game · tap to continue" : "playing now"}`;
    info.append(nm, sub);
    const go = Object.assign(document.createElement("button"), { className: "primary small", textContent: r.playerIds?.includes(uid) ? "Back in" : "Enter" });
    go.onclick = () => joinRoom(code);
    row.append(info, go);
    if (r.owner === uid) {
      const del = Object.assign(document.createElement("button"), { className: "ghost small danger", textContent: "🗑", title: "Delete this holhuashi" });
      del.onclick = () => deleteLoungeByCode(code, r.name);
      row.append(del);
    }
    box.append(row);
  }
}

// ---------- holhuashi members (owner) ----------
// Once someone joins with the invite code they're a member and can come back any time without it.
// The owner can remove a member (they then can't come back, even with an old code) or let them back.
function memberName(u) {
  return room.memberInfo?.[u]?.name || room.players.find((p) => p.uid === u)?.name || room.board?.[u]?.name || "Player";
}
function renderMembers() {
  const box = $("loungeMembers");
  const show = !!room && isLoungeDoc(room) && ownsLounge(room) && room.status === "lobby";
  box.hidden = !show;
  if (!show) return;
  const key = JSON.stringify([room.members, room.removed, room.memberInfo, room.playerIds]);
  if (box._key === key) return;
  box._key = key;
  box.innerHTML = "";
  const members = (room.members || []).filter((u) => u !== uid && !isBot(u));
  box.append(Object.assign(document.createElement("p"), { className: "mem-head", textContent: `👥 Members (${members.length}) · they come back without a code` }));
  if (!members.length) box.append(Object.assign(document.createElement("small"), { className: "muted", textContent: "No members yet · share your invite code" }));
  for (const u of members) {
    const row = document.createElement("div");
    row.className = "mem-row";
    row.dataset.uid = u;
    const here = room.playerIds.includes(u);
    row.append(avatarEl({ uid: u, name: memberName(u), avatar: room.memberInfo?.[u]?.avatar || room.board?.[u]?.avatar }, "avatar small"),
      Object.assign(document.createElement("span"), { textContent: memberName(u) + (here ? " · here" : "") }));
    const x = Object.assign(document.createElement("button"), { type: "button", className: "ghost small danger", textContent: "Remove" });
    x.onclick = () => removeMember(u);
    row.append(x);
    box.append(row);
  }
  const gone = room.removed || [];
  if (gone.length) {
    box.append(Object.assign(document.createElement("p"), { className: "mem-head", textContent: `🚫 Removed (${gone.length})` }));
    for (const u of gone) {
      const row = document.createElement("div");
      row.className = "mem-row removed";
      row.append(Object.assign(document.createElement("span"), { textContent: memberName(u) }));
      const back = Object.assign(document.createElement("button"), { type: "button", className: "ghost small", textContent: "Allow back" });
      back.onclick = () => updateDoc(roomRef(), { removed: arrayRemove(u), members: arrayUnion(u), log: `${memberName(u)} can come back again` }).catch((e) => toast(errMsg(e)));
      row.append(back);
      box.append(row);
    }
  }
}
async function removeMember(u) {
  if (!ownsLounge(room) || room.status !== "lobby") return toast("End the game first, then remove members");
  const nm = memberName(u);
  if (!confirm(`Remove ${nm} from this holhuashi? They won't be able to come back unless you allow them.`)) return;
  const upd = { members: arrayRemove(u), removed: arrayUnion(u), log: `${nm} was removed from the holhuashi` };
  if (room.playerIds.includes(u)) {
    upd.players = room.players.filter((p) => p.uid !== u);
    upd.playerIds = room.playerIds.filter((x) => x !== u);
  }
  try {
    const b = writeBatch(db);
    b.update(roomRef(), upd);
    b.delete(doc(db, "rooms", roomId, "joins", u)); // their saved invite key no longer lets them in
    await b.commit();
    toast(`${nm} removed`);
  } catch (e) { toast(errMsg(e)); }
}

function renameLounge() {
  const name = $("loungeNameEdit").value.trim().slice(0, 30);
  if (!name) return toast("Give your holhuashi a name");
  if (!ownsLounge(room)) return;
  updateDoc(roomRef(), { name, log: `Holhuashi renamed to ${name}` }).then(() => { rememberLounge(roomId, name); toast("Holhuashi renamed"); })
    .catch((e) => toast(errMsg(e)));
}

async function deleteLounge() {
  if (!ownsLounge(room)) return;
  if (room.status === "playing") return toast("Finish this game first, then delete");
  if (!confirm(`Delete "${room.name || "your holhuashi"}"? Its code will stop working.`)) return;
  const code = roomId;
  try {
    await updateDoc(roomRef(), { status: "deleted", players: [], playerIds: [], log: "The owner deleted this holhuashi" });
    forgetLounge(code);
    leaveRoom();
    toast("Holhuashi deleted");
    renderMyLounges(true);
  } catch (e) { toast(errMsg(e)); }
}

// ---- invites (only the owner can read or change the private key) ----
let myInvite = { code: null, key: null, loading: false };
async function loadInvite(force = false) {
  if (!roomId || (!force && (myInvite.code === roomId || myInvite.loading))) return;
  myInvite.loading = true;
  const code = roomId;
  try {
    let snap = await getDoc(inviteRef(code));
    if (!snap.exists()) { await setDoc(inviteRef(code), { key: randomKey() }); snap = await getDoc(inviteRef(code)); } // older holhuashis
    myInvite = { code, key: snap.data().key, loading: false };
    // older holhuashis: everyone who's already been in counts as invited
    if (room && isLoungeDoc(room) && (!room.members || !room.owner)) {
      updateDoc(roomRef(), { owner: room.owner || uid, members: arrayUnion(uid, ...room.playerIds), lounge: true }).catch(() => {});
    }
    render();
  } catch (e) { myInvite.loading = false; console.warn("Invite code", e); }
}
async function newInviteCode() {
  if (!ownsLounge(room)) return;
  if (!confirm("Make a new invite code? The old one stops working (players already invited can still come back).")) return;
  try {
    const key = randomKey();
    await setDoc(inviteRef(roomId), { key });
    myInvite = { code: roomId, key, loading: false };
    toast(`New invite code: ${roomId}-${key}`);
    render();
  } catch (e) { toast(errMsg(e)); }
}

// ---- holhuashi points: how many players and how active it is ----
function loungePoints(r) {
  const members = (r.members || r.playerIds || []).length;
  const games = r.stats?.games || 0, rounds = r.stats?.rounds || 0;
  const last = tsMs(r.stats?.lastPlayed);
  const days = last ? (Date.now() - last) / 86400000 : Infinity;
  const mood = !last ? "🌱 New" : days < 1 ? "🔥 Hot" : days < 7 ? "✨ Active" : "😴 Quiet";
  const bonus = days < 1 ? 100 : days < 7 ? 30 : 0;
  return { points: members * 20 + rounds * 5 + games * 25 + bonus, members, games, rounds, mood };
}

// Delete one of my holhuashis from the home screen (without going in).
async function deleteLoungeByCode(code, name) {
  if (!confirm(`Delete "${name || "this holhuashi"}"? Its code will stop working.`)) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "rooms", code);
      const r = (await tx.get(ref)).data();
      if (!r || r.owner !== uid) throw "Only the owner can delete it";
      if (r.status === "playing") throw "A game is on there right now · try again when it ends";
      // I may need to step in first: the rules let a player change a room they're in
      const ids = r.playerIds.includes(uid) ? r.playerIds : [...r.playerIds, uid];
      tx.update(ref, { status: "deleted", playerIds: ids, players: r.players, log: "The owner deleted this holhuashi" });
    });
    await updateDoc(doc(db, "rooms", code), { players: [], playerIds: [] }).catch(() => {});
    forgetLounge(code);
    toast("Holhuashi deleted");
    renderMyLounges(true);
  } catch (e) { toast(typeof e === "string" ? e : errMsg(e)); }
}

// ---------- holhuashi chat ----------
// Messages live on the holhuashi itself (the newest 50), so everyone inside sees them straight away.
// You can delete your own; the holhuashi owner can delete any.
const CHAT_MAX = 50;
let chatKey = null, chatSeen = 0, lastChatAt = 0;
let chatOpen = false;
function renderChat() {
  const box = $("loungeChat");
  const show = !!room && isLoungeDoc(room) && room.playerIds.includes(uid) && !$("game").hidden;
  $("chatBtn").hidden = !show;
  box.hidden = !show || !chatOpen;
  if (!show) { chatKey = null; return; }
  box.open = true;
  const msgs = room.chat || [];
  if (chatOpen) chatSeen = msgs.length;
  const unread = Math.max(0, msgs.length - chatSeen);
  $("chatBtnBadge").hidden = !unread;
  $("chatBtnBadge").textContent = unread;
  const key = JSON.stringify(msgs.map((m) => m.id)) + amAdmin + (room.owner === uid);
  if (key === chatKey) return;
  chatKey = key;
  const list = $("chatList");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.innerHTML = "";
  if (!msgs.length) list.append(Object.assign(document.createElement("p"), { className: "muted small-note", textContent: "No messages yet · say hi 👋" }));
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = "chat-msg" + (m.uid === uid ? " mine" : "");
    const who = Object.assign(document.createElement("b"), { textContent: m.uid === uid ? "You" : m.name });
    const time = Object.assign(document.createElement("small"), { textContent: new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    const text = Object.assign(document.createElement("span"), { textContent: m.text });
    row.append(who, text, time);
    if (m.uid === uid || room.owner === uid || amAdmin) {
      const del = Object.assign(document.createElement("button"), { type: "button", className: "chat-del", textContent: "✕", title: "Delete message" });
      del.onclick = () => updateDoc(roomRef(), { chat: arrayRemove(m) }).catch((e) => toast(errMsg(e)));
      row.append(del);
    }
    list.append(row);
  }
  if (atBottom || msgs[msgs.length - 1]?.uid === uid) list.scrollTop = list.scrollHeight;
}
async function sendChat(e) {
  e.preventDefault();
  if (!room || !isLoungeDoc(room) || blockedCheck()) return;
  if (premiumGate()) return needPremium("Chat is");
  const text = $("chatText").value.trim().slice(0, 200);
  if (!text) return;
  if (Date.now() - lastChatAt < 1500) return toast("Slow down 🙂");
  lastChatAt = Date.now();
  const msg = { id: Math.random().toString(36).slice(2, 10), uid, name: nameOf(uid), text, at: Date.now() };
  $("chatText").value = "";
  try {
    const chat = room.chat || [];
    // keep the newest 50: drop the oldest when it gets long
    if (chat.length >= CHAT_MAX) await updateDoc(roomRef(), { chat: [...chat.slice(-(CHAT_MAX - 1)), msg] });
    else await updateDoc(roomRef(), { chat: arrayUnion(msg) });
  } catch (err) { toast(errMsg(err)); $("chatText").value = text; }
}

// ---------- notice board in the lobby ----------
// Anyone can pin a short message that everyone in the lobbies sees; you can delete your own
// (admins can delete any). The newest 30 are shown.
let notes = [], unsubNotes = null, lastNoteAt = 0;
function watchNotes() {
  if (unsubNotes || !uid) return;
  unsubNotes = onSnapshot(collection(db, "lobbyNotes"), (snap) => {
    notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderNotes();
  }, (e) => { console.warn("Notice board", e); $("noteList").innerHTML = '<p class="muted small-note">The notice board needs the latest Firebase rules (republish firestore.rules).</p>'; });
}
const noteTime = (n) => tsMs(n.at) || Date.now();
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}
function renderNotes() {
  const box = $("noteList");
  if (!box) return;
  box.innerHTML = "";
  const shown = [...notes].sort((a, b) => noteTime(b) - noteTime(a)).slice(0, 30);
  if (!shown.length) box.append(Object.assign(document.createElement("p"), { className: "muted small-note", textContent: "No messages yet · be the first to leave one!" }));
  for (const n of shown) {
    const row = document.createElement("div");
    row.className = "note" + (n.uid === uid ? " mine" : "");
    const head = document.createElement("div");
    head.className = "note-head";
    head.append(avatarEl({ uid: n.uid, name: n.name, avatar: n.avatar }, "avatar small"),
      Object.assign(document.createElement("b"), { textContent: n.name || "Player" }),
      Object.assign(document.createElement("small"), { textContent: `${n.lobby ? GAME_NAME[n.lobby] + " lobby · " : ""}${ago(noteTime(n))}` }));
    if (n.uid === uid || amAdmin) {
      const del = Object.assign(document.createElement("button"), { className: "note-del", textContent: "✕", title: "Delete this message" });
      del.onclick = () => deleteDoc(doc(db, "lobbyNotes", n.id)).catch((e) => toast(errMsg(e)));
      head.append(del);
    }
    row.append(head, Object.assign(document.createElement("p"), { textContent: n.text }));
    box.append(row);
  }
}
async function postNote(e) {
  e.preventDefault();
  if (blockedCheck()) return;
  const text = $("noteText").value.trim().slice(0, 200);
  if (!text) return;
  if (Date.now() - lastNoteAt < 10000) return toast("Wait a few seconds before posting again");
  const name = myName();
  if (!name) return;
  lastNoteAt = Date.now();
  const e2 = myEntry(name);
  try {
    await setDoc(doc(db, "lobbyNotes", `${uid.slice(0, 6)}-${Date.now().toString(36)}`), {
      uid, name: e2.name, avatar: e2.avatar || null, text, lobby: lobbyGame, at: serverTimestamp(),
    });
    $("noteText").value = "";
  } catch (err) { lastNoteAt = 0; toast(errMsg(err)); }
}
const LOUNGE_ROUND_CHOICES = [3, 5, 8, 10];
const DEFAULT_LOUNGE_ROUNDS = 5;

function createLounge() {
  if (!isRegistered()) return toast("🔒 Sign in to create your own holhuashi.");
  createRoom({ isPublic: false, loungeName: $("loungeName").value.trim() }).then(() => { $("loungeName").value = ""; })
    .catch((e) => toast(errMsg(e)));
}

function setGame(game) {
  if (room.host !== uid || room.status !== "lobby" || isLobbyRoom(room) || gameOf(room) === game) return;
  if (game === "dhiha" && !isLoungeDoc(room)) return toast("DHIHA can only be played in a holhuashi");
  if (game === "dhiha" && room.players.length > 4) return toast("DHIHA is for exactly 4 players · there are more than 4 here");
  updateDoc(roomRef(), { game, target: targetFor(game), ...(game === "dhiha" ? { maxPlayers: 4 } : gameOf(room) === "dhiha" ? { maxPlayers: 6 } : {}) }).catch((e) => toast(errMsg(e)));
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
// CALL played to a points target: whoever reaches the target is out; the others play on until
// only one player is left, and they win.
const callElim = (r) => !!r && gameOf(r) === "call" && !isLobbyRoom(r) && r.endMode !== "rounds";
const outOf = (r) => (callElim(r) ? r.eliminated || [] : []);
const activeIds = (r) => r.playerIds.filter((u) => !outOf(r).includes(u));
function nextActiveIdx(r, from) {
  const ids = r.playerIds, n = ids.length, out = outOf(r);
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (!out.includes(ids[i])) return i; }
  return (from + 1) % n;
}
function gameFinished(r, totals) {
  if (isLobbyRoom(r)) return (r.gameRound || 0) >= LOBBY_ROUNDS;
  if (r.endMode === "rounds") return (r.gameRound || 0) >= (r.roundsLimit || DEFAULT_LOUNGE_ROUNDS);
  const target = r.target || DEFAULT_TARGET;
  if (callElim(r)) return r.playerIds.filter((u) => (totals[u] ?? 0) < target).length <= 1;
  return Object.values(totals).some((t) => t >= target);
}
function roundsTotal(r) {
  if (isLobbyRoom(r)) return LOBBY_ROUNDS;
  return r.endMode === "rounds" ? r.roundsLimit || DEFAULT_LOUNGE_ROUNDS : null;
}

let enteredAt = 0;
function enterRoom(code) {
  roomId = code;
  enteredAt = Date.now();
  getDoc(doc(db, "rooms", code)).then((d) => { const r = d.data(); if (isLoungeDoc(r)) rememberLounge(code, r.name || "Holhuashi"); }).catch(() => {});
  const lt = LOBBY_TABLES.find((t) => t.id === code);
  if (lt) { lobbyOpen = true; me.seated = true; lobbyGame = lt.game; }
  location.hash = code;
  $("roomCode").textContent = code;
  unsubRoom?.(); unsubHand?.();
  lastReactionId = undefined;
  heapKey = null;
  watchPresence(code, uid);
  unsubRoom = onSnapshot(roomRef(), (snap) => {
    if (!snap.exists()) { toast("Room was deleted"); return leaveRoom(); }
    lastRoomEvent = Date.now();
    roomConfirmed = !snap.metadata?.hasPendingWrites && !snap.metadata?.fromCache;
    // a copy saved on the phone (e.g. just woke up / came back online): look, but don't play on it
    if (snap.metadata?.fromCache) { if (!roomStale) refreshRoom(); } else roomStale = false;
    const prev = room;
    const fresh = snap.data();
    // right after sitting down, the phone may first show an old copy of the table (from before I
    // sat): wait for the real one instead of saying "you're not in this room"
    if (!fresh.playerIds.includes(uid) && !prev && Date.now() - enteredAt < 8000) return;
    serverRoom = fresh;
    room = withPending(fresh);
    if (!room.playerIds.includes(uid)) {
      if ((room?.removed || []).includes(uid)) { forgetLounge(roomId); toast("🚫 The owner removed you from this holhuashi"); }
      else toast(prev?.playerIds?.includes(uid) ? "You were offline for over a minute, so you left the table" : "You're not in this room");
      return leaveRoom();
    }
    // the server just stamped my check-in: learn its clock (phones' clocks can be off)
    const mySeen = tsMs(room.seen?.[uid]);
    if (mySeen && mySeen !== lastMySeen && !snap.metadata?.hasPendingWrites && Date.now() - checkInSentAt < 8000) {
      lastMySeen = mySeen; serverOffset = mySeen - Date.now(); serverTimeKnown = true;
    }
    if (!prev) checkIn();
    if (practiceDealPending === roomId && room.status === "lobby" && room.playerIds.length > 1 && room.host === uid) {
      practiceDealPending = null;
      setTimeout(dealRound, 50);
    }
    setTimeout(maybeBotMove, 0);
    const sameRound = prev && prev.round === room.round;
    // someone just called DIGU or CALL: the big moment, on everyone's screen
    if (sameRound && prev.status === "playing" && room.status === "ended") playShout(room);
    if (prev && room.gameOver && room.champions?.length && !prev.gameOver) celebrateWinner(room);
    if (room.tourney && room.gameOver && room.champions?.length) recordMatch(room, roomId);
    // a tournament table starts by itself once everyone drawn for it has sat down
    if (room.tourney && room.status === "lobby" && !room.round && room.host === uid
        && (room.tourney.allowed || []).every((u) => room.playerIds.includes(u)) && enterRoom.autoStarted !== `${roomId}-t`) {
      enterRoom.autoStarted = `${roomId}-t`;
      setTimeout(() => dealRound(), 1500);
    }

    // reactions (skip the one already there when I open the room)
    const rx = room.reaction;
    if (lastReactionId !== undefined && rx && rx.id !== lastReactionId) showBubble(rx.uid, rx.text);
    lastReactionId = rx?.id ?? null;
    // someone just said they're one card from DIGU
    if (sameRound && room.status === "playing") {
      for (const p of room.playerIds) {
        if (room.almost?.[p] && !prev.almost?.[p]) {
          showBubble(p, "1 card! 🔥", true);
          showBanner(p === uid ? "📢 You told everyone: 1 card to DIGU!" : `📢 ${nameOf(p)}: 1 card to DIGU!`);
        }
      }
    }

    try { cardMoves(prev); } catch (e) { console.warn("cardMoves", e); }
    if (isBondi() && sameRound && room.status !== "lobby") { try { bondiMoments(prev); } catch (e) { console.warn("bondiMoments", e); } }
    if (isDhiha() && sameRound && room.status !== "lobby") dhihaMoments(prev);
    // CALL: someone threw a set (2+ cards of the same number) → claps for everyone
    if (isCall() && sameRound && room.thrownNow?.length > 1 && JSON.stringify(room.thrownNow) !== JSON.stringify(prev.thrownNow)) {
      const who = room.playerIds[room.turn];
      const n = room.thrownNow.length, r = C.label(C.parse(room.thrownNow[0]).r);
      funMoment("👏", `${who === uid ? "You" : nameOf(who)} threw a set of ${n} × ${r}!`, ["👏", "👏", "🙌", "✨"], "clap");
    }
    applyPickup();
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
      if (!room.scored && lastRows && resultsRound === room.round && (room.host === uid || isOffline(room, room.host, roomId))) saveScores();
      if (!$("results").hidden) renderResults(); // totals / game-over update when the host saves scores
    }
    if (room.status !== "ended") { resultsRound = 0; lastRows = null; clearTimeout(resultsTimer); $("results").hidden = true; }
  }, (e) => toast(errMsg(e)));
  unsubHand = onSnapshot(handRef(), (snap) => {
    handLoaded = !snap.metadata?.hasPendingWrites && !snap.metadata?.fromCache;
    serverHand = snap.exists() ? snap.data().cards : []; handSeen = true;
    const cards = pendingHand() || serverHand;
    // keep my own arrangement: existing cards stay in place, new ones go on the end
    const added = cards.filter((c) => !hand.includes(c));
    hand = [...hand.filter((c) => cards.includes(c)), ...added];
    if ((isBondi() || isDhiha()) && added.length) hand = C.sortBondi(hand); // grouped by suit
    applyPickup();
    if (!hand.includes(selected)) selected = null;
    render();
    afterUpdate();
  });
}

function hideTableOverlays() {
  if ($("leaveBtn").parentElement === $("bottomBack")) $("game").querySelector(".top").prepend($("leaveBtn"));
  for (const id of ["seats", "bottomBar", "turnGlow", "premTools", "tipBubble", "premiumPanel", "premiumPanelR", "pauseBtn", "endGameBtn", "offlineAsk", "pauseBar", "loungeChat", "chatBtn"]) {
    const el = $(id); if (el) el.hidden = true;
  }
  $("seats").innerHTML = ""; $("seats")._key = null; $("turnGlow")._key = null;
  $("game").classList.remove("in-play");
  chatOpen = false; tipOpen = false;
}
function leaveRoomMusic() { stopMusic(); }
function leaveRoom() {
  leaveRoomMusic();
  $("tourneyBtn").hidden = true;
  stopPresence();
  hideTableOverlays();
  pendingMoves = []; serverRoom = null; serverHand = []; handSeen = false;
  $("loungeChat").hidden = true; chatKey = null;
  setTimeout(() => { if (!room) renderMyLounges(true); }, 300); // back home: show my holhuashis straight away
  unsubRoom?.(); unsubHand?.();
  unsubRoom = unsubHand = null;
  clearTimeout(resultsTimer);
  roomId = null; room = null; hand = [];
  me.seated = false;
  history.replaceState(null, "", lobbyOpen ? lobbyHash() : location.pathname);
  $("results").hidden = true;
  updateView();
  renderFloor();
}

// ---------- host actions ----------
function setTarget(value) {
  const t = Math.round(Number(value));
  const lo = isDhiha() ? 1 : 50;
  if (!Number.isFinite(t) || t < lo || t > 100000) return toast(`Pick a target between ${lo} and 100000`);
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
  if (room.host !== uid && !isLobbyRoom(room) && !isOffline(room, room.host, roomId)) return;
  const scores = Object.fromEntries(room.playerIds.map((p) => [p, 0]));
  if (room.practice) { // vs the computer: just deal a new game
    practiceDealPending = roomId;
    updateDoc(roomRef(), { status: "lobby", scores, gameOver: false, champions: null, gameRound: 0, almost: {}, eliminated: [], log: "New game vs the computer" })
      .catch((e) => toast(errMsg(e)));
    return;
  }
  updateDoc(roomRef(), {
    status: "lobby", scores, gameOver: false, champions: null, gameRound: 0, eliminated: [], outRound: {},
    lastChampions: room.champions || null, almost: {},
    log: isLobbyRoom(room) ? "Back in the Aammu Jagaha: press Play to go again" : "New game: pick the settings and deal",
  }).catch((e) => toast(errMsg(e)));
}

async function dealRound() {
  if (room.gameOver) return;
  if (room.status === "ended" && !room.scored) { await saveScores(); if (!room.scored) await new Promise((r) => setTimeout(r, 600)); }
  // at a lobby table, anyone who has left the lobby since sitting down is let go before dealing
  if (isLobbyRoom(room) && room.status === "lobby") {
    // only players who are still checking in on this table (bots and me always count)
    const here = room.players.filter((p) => !isOffline(room, p.uid, roomId));
    if (here.length !== room.players.length) {
      if (here.length < 2) return toast("Wait for at least one more player to sit down");
      await updateDoc(roomRef(), {
        players: here, playerIds: here.map((p) => p.uid),
        scores: Object.fromEntries(here.map((p) => [p.uid, room.scores?.[p.uid] || 0])),
      }).catch(() => {});
      room = { ...room, players: here, playerIds: here.map((p) => p.uid) };
    }
  }
  // holhuashi without enough people: computer players fill the empty places (no points for that game)
  const need = isDhiha() ? 4 : 2;
  if (isLoungeDoc(room) && room.status === "lobby" && room.playerIds.length < need) {
    if (!canManageBots()) return toast(`Need ${need - room.playerIds.length} more player${need - room.playerIds.length > 1 ? "s" : ""} · only the owner can add computer players`);
    toast("🤖 Not enough players · computer players are joining (no points for this game)");
    await fillWithBots();
    for (let i = 0; i < 20 && room.playerIds.length < need; i++) await sleep(150);
    if (room.playerIds.length < need) return toast("Couldn't add computer players · try again");
  }
  const n = room.playerIds.length;
  if (n < 2) return toast("Need at least 2 players");
  if (gameOf(room) === "bondi") return dealBondi();
  if (gameOf(room) === "dhiha") return dealDhiha();
  if (gameOf(room) === "babbush") return dealBabbush();
  // DIGU: 10 cards each (two decks for 5–6 players). CALL: 5 cards each, one deck is enough.
  const call = gameOf(room) === "call";
  const handSize = call ? C.CALL_HAND_SIZE : C.HAND_SIZE;
  const deck = C.shuffle(C.buildDeck(!call && n >= 5 ? 2 : 1));
  const batch = writeBatch(db);
  const out = outOf(room);
  for (const p of room.playerIds) {
    batch.set(handRef(p), { cards: out.includes(p) ? [] : deck.splice(0, handSize) });
  }
  const round = (room.round || 0) + 1;
  batch.update(roomRef(), {
    status: "playing",
    host: uid, // whoever presses Play runs this game (deals rounds, saves scores)
    deck,
    discard: [],                   // the thrown pile starts empty in both games
    ccount: call ? Object.fromEntries(room.playerIds.map((p) => [p, out.includes(p) ? 0 : handSize])) : null,
    turn: out.includes(room.playerIds[(round - 1) % n]) ? nextActiveIdx(room, (round - 1) % n) : (round - 1) % n, // starter rotates
    phase: call ? "throw" : "draw", // CALL: throw first, then take; DIGU: take first, then throw
    lastThrow: null, pickable: null, thrownNow: null,
    moveId: 0,
    reshuffles: 0,
    almost: {},
    track: {},
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

// ---------- BABUSH ----------
// 2–6 players, 4 cards each, face down in a row; the rest is the middle pile. A random player
// chooses how many of their own cards everyone may look at (0–2), then each player secretly looks.
// On your turn: take the top card of the middle pile (only you see it), then either swap it for one
// of your face-down cards (that card is thrown, unseen) or throw it. J = look at any one card,
// Q = switch any two cards, K = lock a card face up (or unlock it). Whenever a card is thrown,
// anyone who has the same number may throw it too (wrong card: 2 penalty cards). Think your count is
// the lowest? Call BABUSH: everyone else has one more turn, then all cards are counted.
// The whole layout lives on the table (room.bb) so J and Q can reach other players' cards.
const BB_POWER_NAME = { J: "👁 Look", Q: "🔄 Switch", K: "🔒 Lock / unlock" };
const bbRows = (r = room) => r?.bb?.rows || {};
const bbRow = (u, r = room) => bbRows(r)[u] || [];
const bbLocked = (r = room) => r?.bb?.locked || [];
const bbIsLocked = (c, r = room) => bbLocked(r).includes(c);
const bbProtected = (u, r = room) => !!r?.bb?.caller && r.bb.caller === u; // the caller's cards can't be touched
// take k cards from the middle pile (the thrown cards are shuffled back in when it runs out)
function bbTake(deck, discard, k) {
  deck = [...deck]; discard = [...discard];
  const got = [];
  for (let i = 0; i < k; i++) {
    if (!deck.length && discard.length > 1) { const top = discard.pop(); deck = C.shuffle(discard); discard = [top]; }
    if (!deck.length) break;
    got.push(deck.pop());
  }
  return { deck, discard, got };
}
async function dealBabbush() {
  const n = room.playerIds.length;
  const deck = C.shuffle(C.buildDeck(1));
  const rows = Object.fromEntries(room.playerIds.map((u) => [u, deck.splice(0, C.BB_HAND)]));
  const chooser = room.playerIds[Math.floor(Math.random() * n)];
  const round = (room.round || 0) + 1;
  try {
    await updateDoc(roomRef(), {
      status: "playing", host: uid, deck, discard: [], turn: room.playerIds.indexOf(chooser), phase: "draw", moveId: 0,
      bb: { stage: "choose", chooser, peekN: null, peeked: {}, rows, locked: [], drawn: null, power: null, snapDone: null,
        caller: null, finalLeft: null, stageAt: Date.now() },
      winner: null, winnerSets: null, diguCard: null, scored: false, round, gameRound: (room.gameRound || 0) + 1,
      reshuffles: 0, track: {}, almost: {},
      log: `${roundsTotal(room) ? `Round ${(room.gameRound || 0) + 1} of ${roundsTotal(room)} · ` : ""}${nameOf(chooser)} chooses how many cards everyone may look at`,
    });
    sendNotify(room?.gameRound > 1 ? "round" : "start");
  } catch (e) { toast(errMsg(e)); }
}
// end of a turn: the next player, or, once BABUSH has been called and everyone had their last turn, the count
function bbEndTurn(upd, log, r = room) {
  const bb = r.bb || {};
  upd["bb.drawn"] = null; upd["bb.power"] = null;
  if (bb.caller) {
    const left = (bb.finalLeft || 0) - 1;
    if (left <= 0) return Object.assign(upd, { status: "ended", winner: bb.caller, phase: "draw", "bb.finalLeft": 0, moveId: (r.moveId || 0) + 1, log: log + " · everyone has had their turn: count the cards!" });
    upd["bb.finalLeft"] = left;
  }
  return Object.assign(upd, nextTurn(log));
}
// someone ran out of time: their drawn card is thrown and the turn moves on
function bbSkipUpd(r) {
  const bb = r.bb || {};
  if (bb.stage !== "play") return { "bb.stage": "play", "bb.peekN": bb.peekN ?? 0, moveId: (r.moveId || 0) + 1, log: "Time's up · the game starts" };
  const upd = {};
  if (bb.drawn) upd.discard = [...(r.discard || []), bb.drawn.c];
  const who = r.playerIds[r.turn];
  const saved = room; room = r; // nextTurn reads the current table
  try { return bbEndTurn(upd, `${nameOf(who)} ran out of time`, r); } finally { room = saved; }
}
// every card move is recorded, so every screen can show it flying (bb.ev, the last few)
function bbEv(upd, evs) {
  const list = (room.bb?.ev || []).filter((e) => e.r === room.round);
  let n = list.reduce((m, e) => Math.max(m, e.n), 0);
  upd["bb.ev"] = [...list, ...[].concat(evs).map((e) => ({ ...e, r: room.round, n: ++n }))].slice(-6);
  return upd;
}
// ----- moves -----
function bbChoose(n) {
  if (room.bb?.stage !== "choose" || (room.bb.chooser !== uid && !(isBot(room.bb.chooser) && room.host === uid))) return;
  const b = moveBatch();
  b.update(roomRef(), { "bb.peekN": n, "bb.stage": n ? "peek" : "play", "bb.stageAt": Date.now(), moveId: (room.moveId || 0) + 1,
    log: n ? `Everyone may look at ${n} of their own card${n > 1 ? "s" : ""}` : "No looking this round! The game starts" });
  commit(b);
}
let bbPeekSel = [], bbReveal = new Map(), bbMode = null, bbPicks = [], bbRevealTimer = null;
const bbKey = (u, i) => `${u}|${i}`;
function bbShow(u, i, ms) { // show a card to me only, for a moment
  bbReveal.set(bbKey(u, i), Date.now() + ms);
  clearTimeout(bbRevealTimer);
  bbRevealTimer = setTimeout(() => { try { render(); } catch {} }, ms + 30);
  render();
}
function bbPeekTap(i) {
  const bb = room.bb;
  if (bb?.stage !== "peek" || bb.peeked?.[uid] || bbPeekSel.includes(i) || bbPeekSel.length >= (bb.peekN || 0)) return;
  bbPeekSel.push(i);
  bbShow(uid, i, 60_000); // stays up while I pick the rest
  if (bbPeekSel.length >= bb.peekN) {
    const picked = [...bbPeekSel];
    picked.forEach((x) => bbShow(uid, x, 5200));
    bbCountdown(4, () => { // 4 · 3 · 2 · 1 · 0 … then the cards turn face down
      picked.forEach((x) => bbReveal.delete(bbKey(uid, x)));
      updateDoc(roomRef(), { [`bb.peeked.${uid}`]: true }).catch(() => {});
      bbPeekSel = [];
      try { render(); } catch {}
    });
  }
}
function bbCountdown(from, done) {
  const el = Object.assign(document.createElement("div"), { className: "bb-count" });
  document.body.append(el);
  let n = from;
  const step = () => {
    el.textContent = n;
    el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick");
    if (n-- <= 0) { setTimeout(() => { el.remove(); done(); }, 900); return; }
    setTimeout(step, 1000);
  };
  step();
}
function bbMatchWait() {
  if (isMyTurn() && bbMatchLeft()) { toast(`⚡ One moment: everyone can throw an alike ${C.label(room.bb.matchRank)} first`); return true; }
  return false;
}
function bbDraw() {
  if (bbMatchWait() || !canDraw()) return;
  if (!claimAction()) return;
  const t = bbTake(room.deck || [], room.discard || [], 1);
  if (!t.got.length) return toast("No cards left in the middle pile");
  const c = t.got[0];
  const b = moveBatch();
  b.update(roomRef(), bbEv({ deck: t.deck, discard: t.discard, phase: "act", "bb.drawn": { u: uid, c }, moveId: (room.moveId || 0) + 1, log: `${nameOf(uid)} took a card from the middle pile` }, { k: "draw", u: uid }));
  commit(b);
}
// take the last thrown card instead (everyone sees it); it must go into one of my places
function bbTakeThrown() {
  if (bbMatchWait() || !canDraw()) return;
  const top = room.discard?.[room.discard.length - 1];
  if (!top) return toast("Nothing has been thrown yet · take from the middle pile");
  if (!claimAction()) return;
  const b = moveBatch();
  b.update(roomRef(), bbEv({ discard: room.discard.slice(0, -1), phase: "act", "bb.drawn": { u: uid, c: top, from: "thrown" }, "bb.matchRank": null,
    moveId: (room.moveId || 0) + 1, log: `${nameOf(uid)} took the thrown ${cardName(top)}` }, { k: "take", u: uid, c: top }));
  commit(b);
}
const bbMyDrawn = () => (isMyTurn() && room.phase === "act" && room.bb?.drawn?.u === uid ? room.bb.drawn.c : null);
function bbReplace(i) {
  const c = bbMyDrawn();
  const row = [...bbRow(uid)];
  if (!c || i < 0 || i >= row.length) return;
  if (bbIsLocked(row[i])) return toast("🔒 That card is locked · it can't be swapped");
  if (!claimAction()) return;
  const old = row[i]; row[i] = c;
  const upd = bbEv({ [`bb.rows.${uid}`]: row, discard: [...(room.discard || []), old], "bb.matchRank": C.parse(old).r }, { k: "swap", u: uid, i, c: old });
  bbEndTurn(upd, `${nameOf(uid)} put ${room.bb.drawn?.from === "thrown" ? cardName(c) : "a card"} in place and threw ${cardName(old)}`);
  const b = moveBatch(); b.update(roomRef(), upd);
  commit(b, upd.status === "ended" ? "ended" : "turn");
  bbShow(uid, i, 2500);
}
function bbThrowDrawn(log) {
  const c = bbMyDrawn();
  if (!c) return;
  if (room.bb.drawn?.from === "thrown" && !log) return toast("You took the thrown card · tap one of your cards to put it in its place");
  if (!claimAction()) return;
  const upd = bbEv({ discard: [...(room.discard || []), c], "bb.matchRank": C.parse(c).r }, { k: "throw", u: uid, c });
  bbEndTurn(upd, log || `${nameOf(uid)} threw ${cardName(c)}`);
  const b = moveBatch(); b.update(roomRef(), upd);
  bbMode = null; bbPicks = [];
  commit(b, upd.status === "ended" ? "ended" : "turn");
}
function bbStartPower() {
  const c = bbMyDrawn(); const k = c && C.bbPower(c);
  if (!k) return;
  bbMode = k; bbPicks = [];
  toast(k === "J" ? "👁 Tap any face-down card to look at it" : k === "Q" ? "🔄 Tap two cards to switch them" : "🔒 Tap a card to lock it face up (or a locked card to unlock it)");
  render();
}
// a card on the table was tapped (mine or someone else's)
function bbTapCard(u, i) {
  const bb = room?.bb; if (!bb || room.status !== "playing") return;
  const row = bbRow(u), c = row[i];
  if (!c) return;
  if (bb.stage === "peek") { if (u === uid) bbPeekTap(i); return; }
  if (bb.stage !== "play") return;
  if (bbMode === "J") {
    if (bbIsLocked(c)) return toast("That card is already face up");
    bbShow(u, i, 3500);
    bbMode = null;
    setTimeout(() => bbThrowDrawn(`${nameOf(uid)} used J 👁 and looked at ${u === uid ? "one of their cards" : `one of ${nameOf(u)}'s cards`}`), 3600);
    return;
  }
  if (bbMode === "Q") {
    if (bbIsLocked(c)) return toast("🔒 Locked cards can't be switched");
    if (bbProtected(u)) return toast(`${nameOf(u)} called BABUSH · their cards can't be touched`);
    if (bbPicks.some((p) => p.u === u && p.i === i)) { bbPicks = bbPicks.filter((p) => !(p.u === u && p.i === i)); return render(); }
    bbPicks.push({ u, i });
    if (bbPicks.length < 2) return render();
    const [a, z] = bbPicks; bbPicks = []; bbMode = null;
    return bbFinishPower({ "Q": [a, z] }, `${nameOf(uid)} used Q 🔄 and switched ${a.u === uid ? "their" : `${nameOf(a.u)}'s`} card with ${z.u === uid ? "their own" : `${nameOf(z.u)}'s`}`);
  }
  if (bbMode === "K") {
    if (bbProtected(u)) return toast(`${nameOf(u)} called BABUSH · their cards can't be touched`);
    bbMode = null;
    return bbFinishPower({ K: { u, i } }, `${nameOf(uid)} used K 🔒 and ${bbIsLocked(c) ? "unlocked" : "locked"} ${u === uid ? "their" : `${nameOf(u)}'s`} ${cardName(c)}`);
  }
  if (u === uid && bbMyDrawn()) return bbReplace(i);
  // not swapping: pick my cards with the same number as the thrown card, then press Throw
  if (u === uid && bb.matchRank != null) {
    bbSel = bbSel.includes(i) ? bbSel.filter((x) => x !== i) : [...bbSel, i];
    return render();
  }
}
let bbSel = [], bbSelKey = null;
function bbFinishPower(act, log) {
  const drawn = bbMyDrawn();
  if (!drawn || !claimAction()) return;
  const upd = { discard: [...(room.discard || []), drawn], "bb.matchRank": C.parse(drawn).r };
  bbEv(upd, act.Q ? [{ k: "switch", u: uid, a: act.Q[0], z: act.Q[1] }, { k: "throw", u: uid, c: drawn }] : { k: "throw", u: uid, c: drawn });
  if (act.Q) {
    const [a, z] = act.Q;
    const ra = [...bbRow(a.u)], rz = a.u === z.u ? ra : [...bbRow(z.u)];
    const t = ra[a.i]; ra[a.i] = rz[z.i]; rz[z.i] = t;
    upd[`bb.rows.${a.u}`] = ra; if (a.u !== z.u) upd[`bb.rows.${z.u}`] = rz;
  }
  if (act.K) {
    const c = bbRow(act.K.u)[act.K.i];
    upd["bb.locked"] = bbIsLocked(c) ? bbLocked().filter((x) => x !== c) : [...bbLocked(), c];
  }
  bbEndTurn(upd, log);
  const b = moveBatch(); b.update(roomRef(), upd);
  commit(b, upd.status === "ended" ? "ended" : "turn");
}
function bbCall() {
  if (!isMyTurn() || room.phase !== "draw" || room.bb?.stage !== "play" || room.bb?.caller) return;
  if (!claimAction()) return;
  const others = activeIds(room).length - 1;
  const b = moveBatch();
  b.update(roomRef(), { "bb.caller": uid, "bb.finalLeft": others, ...nextTurn(`📣 ${nameOf(uid)} called BABUSH! Everyone else has one more turn`) });
  commit(b, "turn");
}
// ⚡ the top thrown card has the same number as one of mine: throw it too (wrong: 2 penalty cards)
// throw the picked cards as matches of the last thrown number (any wrong one: back it goes, +2 cards)
function bbSnap(picks) {
  const bb = room.bb, row = [...bbRow(uid)];
  picks = [...new Set(picks)].filter((i) => row[i]).sort((a, b) => b - a);
  bbSel = [];
  if (!picks.length || bb.stage !== "play" || room.status !== "playing") return render();
  if (bb.matchRank == null) { toast("There's no thrown card to match right now"); return render(); }
  if (picks.some((i) => bbIsLocked(row[i]))) { toast("🔒 Locked cards can't be thrown"); return render(); }
  if (!claimAction()) return;
  const good = picks.filter((i) => C.parse(row[i]).r === bb.matchRank), bad = picks.filter((i) => !good.includes(i));
  const thrown = good.map((i) => row[i]), wrong = bad.map((i) => row[i]);
  const evs = good.map((i) => ({ k: "match", u: uid, i, c: row[i] }));
  for (const i of good) row.splice(i, 1); // (highest place first, so the others don't move)
  const upd = { moveId: (room.moveId || 0) + 1 };
  let discard = [...(room.discard || []), ...thrown], deck = room.deck || [];
  let log = thrown.length ? `⚡ ${nameOf(uid)} threw ${thrown.length > 1 ? `${thrown.length} matching cards` : `a matching ${cardName(thrown[0])}`}!` : "";
  let newRow = row;
  if (wrong.length) {
    const t = bbTake(deck, discard, 2);
    deck = t.deck; discard = t.discard; newRow = [...row, ...t.got];
    upd["bb.penalty"] = { u: uid, c: wrong[0], want: bb.matchRank, n: t.got.length, id: `${room.round}-${Date.now()}` };
    log = (log ? log + " · " : "") + `❌ ${cardName(wrong[0])}${wrong.length > 1 ? ` and ${wrong.length - 1} more` : ""} ${wrong.length > 1 ? "aren't" : "isn't"} a ${C.label(bb.matchRank)} · +${t.got.length} cards`;
  }
  Object.assign(upd, { [`bb.rows.${uid}`]: newRow, discard, deck, log });
  if (evs.length) bbEv(upd, evs);
  const b = moveBatch(); b.update(roomRef(), upd);
  commit(b);
}
function bbAuto() { // my time ran out
  const bb = room.bb;
  if (bb?.stage === "choose" && bb.chooser === uid) return bbChoose(1);
  if (bb?.stage !== "play") return;
  if (room.phase === "draw") { if (!claimAction()) return; const upd = {}; bbEndTurn(upd, `${nameOf(uid)} ran out of time`); const b = moveBatch(); b.update(roomRef(), upd); return commit(b, "turn"); }
  bbMode = null; bbPicks = [];
  bbThrowDrawn(`${nameOf(uid)} ran out of time and threw the card`);
}
// ----- the host runs the computer players and moves the game from one stage to the next -----
let bbBotSnapKey = null;
// ⚡ after every throw, everyone gets 3 seconds to throw an alike card before the next player takes one
const BB_MATCH_MS = 3000;
let bbMatchKey = null, bbMatchAt = 0;
function bbMatchLeft() {
  const bb = room?.bb;
  if (!bb || !isBabbush() || bb.stage !== "play" || bb.matchRank == null || room.status !== "playing" || room.phase !== "draw") return 0;
  const k = `${roomId}|${room.round}|${(room.discard || []).length}|${(room.discard || []).at(-1)}`;
  if (k !== bbMatchKey) { bbMatchKey = k; bbMatchAt = Date.now(); }
  return Math.max(0, BB_MATCH_MS - (Date.now() - bbMatchAt));
}
function bbMatchTimer() {
  let el = $("bbMatchTimer");
  const left = room && !$("game").hidden ? bbMatchLeft() : 0;
  if (!left) {
    if (el && !el.hidden) { el.hidden = true; try { render(); } catch {} } // my turn's piles light up now
    return;
  }
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "bbMatchTimer", className: "bb-match-timer" });
    el.innerHTML = '<svg viewBox="0 0 36 36"><circle class="mt-bg" cx="18" cy="18" r="15"/><circle class="mt-fg" cx="18" cy="18" r="15"/></svg><b></b><span></span>';
    document.body.append(el);
  }
  el.hidden = false;
  el.querySelector("b").textContent = Math.ceil(left / 1000);
  el.querySelector("span").textContent = `Throw alike ${C.label(room.bb.matchRank)}!`;
  el.querySelector(".mt-fg").style.strokeDashoffset = String(94.25 * (1 - left / BB_MATCH_MS));
}
setInterval(bbMatchTimer, 100);
async function bbHost() {
  const bb = room.bb; if (!bb) return;
  const key = `${roomId}-${room.round}-${room.moveId || 0}-${room.phase}-${bb.stage}`;
  if (bb.stage === "choose") {
    if (isBot(bb.chooser) && botKey !== key) { botKey = key; await sleep(1200); if (room?.bb?.stage === "choose") bbChoose(1 + Math.floor(Math.random() * 2)); }
    return;
  }
  if (bb.stage === "peek") {
    const bots = room.playerIds.filter((u) => isBot(u) && !bb.peeked?.[u]);
    if (bots.length) { updateDoc(roomRef(), Object.fromEntries(bots.map((u) => [`bb.peeked.${u}`, true]))).catch(() => {}); return; }
    const all = room.playerIds.every((u) => bb.peeked?.[u]);
    if ((all || Date.now() - (bb.stageAt || 0) > 30_000) && botKey !== key) {
      botKey = key;
      const b = moveBatch(); b.update(roomRef(), { "bb.stage": "play", moveId: (room.moveId || 0) + 1, log: `${nameOf(room.playerIds[room.turn])} starts · take a card from the middle pile` }); commit(b);
    } else if (!all) setTimeout(() => { try { maybeBotMove(); } catch {} }, 3000);
    return;
  }
  bbBotSnaps();
  const bot = room.playerIds[room.turn];
  if (!isBot(bot) || botKey === key) return;
  botKey = key;
  await sleep(1100 + Math.random() * 1000);
  while (shuffling() || bbMatchLeft()) await sleep(200); // let everyone throw alike cards first
  await sleep(300 + Math.random() * 500);
  if (!room || `${roomId}-${room.round}-${room.moveId || 0}-${room.phase}-${room.bb?.stage}` !== key) return;
  try { bbBotTurn(bot); } catch (e) { console.warn("Babush computer", e); botKey = null; }
}
function bbBotTurn(bot) {
  const bb = room.bb, lvl = botLevel(), row = bbRow(bot);
  const b = moveBatch();
  if (room.phase === "draw") {
    const total = C.bbCount(row), n = room.playerIds.length;
    // When to call BABUSH: not before everyone has had about 3 turns, and only when the count is
    // really low. Hard looks at everyone's real count and calls only when it's lower than all of them.
    // Medium guesses the others (cards it can't see count about 6 each). Easy waits for 3 or less.
    const others = room.playerIds.filter((u) => u !== bot);
    const guess = (u) => bbRow(u).reduce((a, x) => a + (bbIsLocked(x) ? C.bbValue(x) : 6), 0);
    const late = (room.moveId || 0) >= n * 6;
    const callNow = !bb.caller && late && (
      lvl === "hard" ? total <= 10 && others.every((u) => C.bbCount(bbRow(u)) > total)
      : lvl === "medium" ? total <= 6 && others.every((u) => guess(u) >= total + 4)
      : total <= 3);
    if (callNow) {
      b.update(roomRef(), { "bb.caller": bot, "bb.finalLeft": activeIds(room).length - 1, ...nextTurn(`📣 ${botName(bot)} called BABUSH! Everyone else has one more turn`) });
      return b.commit().catch(() => {});
    }
    const top = room.discard?.[room.discard.length - 1];
    const freeNow = row.map((x, i) => ({ x, i })).filter((o) => !bbIsLocked(o.x));
    const worstNow = freeNow.reduce((a, o) => (!a || C.bbValue(o.x) > C.bbValue(a.x) ? o : a), null);
    if (top && worstNow && lvl !== "easy" && C.bbValue(top) + 2 <= C.bbValue(worstNow.x)) { // the thrown card is low: take it
      const nr = [...row]; nr[worstNow.i] = top;
      const upd = bbEv({ [`bb.rows.${bot}`]: nr, discard: [...room.discard.slice(0, -1), worstNow.x], "bb.matchRank": C.parse(worstNow.x).r },
        [{ k: "take", u: bot, c: top }, { k: "swap", u: bot, i: worstNow.i, c: worstNow.x }]);
      bbEndTurn(upd, `${botName(bot)} took the thrown ${cardName(top)} and threw ${cardName(worstNow.x)}`);
      b.update(roomRef(), upd);
      return b.commit().catch(() => {});
    }
    const t = bbTake(room.deck || [], room.discard || [], 1);
    if (!t.got.length) return;
    b.update(roomRef(), bbEv({ deck: t.deck, discard: t.discard, phase: "act", "bb.drawn": { u: bot, c: t.got[0] }, moveId: (room.moveId || 0) + 1, log: `${botName(bot)} took a card from the middle pile` }, { k: "draw", u: bot }));
    return b.commit().catch(() => {});
  }
  const c = bb.drawn?.c; if (!c) return;
  const v = C.bbValue(c);
  const free = row.map((x, i) => ({ x, i })).filter((o) => !bbIsLocked(o.x));
  const worst = free.reduce((a, o) => (!a || C.bbValue(o.x) > C.bbValue(a.x) ? o : a), null);
  const upd = { discard: [...(room.discard || [])], "bb.matchRank": null };
  const careless = lvl === "easy" && Math.random() < 0.4;
  if (worst && v < C.bbValue(worst.x) && !careless) { // swap my worst card for it
    const nr = [...row]; nr[worst.i] = c; upd[`bb.rows.${bot}`] = nr; upd.discard.push(worst.x); upd["bb.matchRank"] = C.parse(worst.x).r;
    bbEv(upd, { k: "swap", u: bot, i: worst.i, c: worst.x });
    bbEndTurn(upd, `${botName(bot)} swapped a card and threw ${cardName(worst.x)}`);
  } else if (C.bbPower(c) === "Q" && lvl !== "easy" && worst) { // switch my worst card with someone's low card
    const others = room.playerIds.filter((u) => u !== bot && !bbProtected(u));
    let best = null;
    for (const u of others) bbRow(u).forEach((x, i) => { if (!bbIsLocked(x) && (!best || C.bbValue(x) < C.bbValue(best.x))) best = { u, i, x }; });
    if (best && C.bbValue(best.x) < C.bbValue(worst.x)) {
      const nr = [...row], orow = [...bbRow(best.u)];
      nr[worst.i] = best.x; orow[best.i] = worst.x;
      upd[`bb.rows.${bot}`] = nr; upd[`bb.rows.${best.u}`] = orow;
    }
    upd.discard.push(c); upd["bb.matchRank"] = C.parse(c).r;
    bbEv(upd, { k: "throw", u: bot, c });
    bbEndTurn(upd, `${botName(bot)} used Q 🔄 and switched ${best ? `a card with ${nameOf(best.u)}` : "nothing"}`);
  } else {
    upd.discard.push(c); upd["bb.matchRank"] = C.parse(c).r;
    bbEv(upd, { k: "throw", u: bot, c });
    bbEndTurn(upd, C.bbPower(c) === "J" && lvl !== "easy" ? `${botName(bot)} used J 👁 and looked at a card` : `${botName(bot)} threw ${cardName(c)}`);
  }
  b.update(roomRef(), upd);
  return b.commit().catch(() => {});
}
// computer players throw a matching card when they have one
function bbBotSnaps() {
  const rank = room.bb?.matchRank;
  if (rank == null) return;
  const k = `${roomId}-${room.round}-${room.moveId || 0}-${rank}`;
  if (bbBotSnapKey === k) return;
  bbBotSnapKey = k;
  const chance = { easy: 0.25, medium: 0.6, hard: 0.95 }[botLevel()] ?? 0.6;
  const cands = room.playerIds.filter((u) => isBot(u)).map((u) => ({ u, i: bbRow(u).findIndex((x) => C.parse(x).r === rank && !bbIsLocked(x)) }))
    .filter((o) => o.i >= 0 && Math.random() < chance);
  if (!cands.length) return;
  const o = cands[Math.floor(Math.random() * cands.length)];
  setTimeout(() => { // one at a time: the next update looks again (so a computer can throw several)
    if (!room || room.bb?.matchRank !== rank) return;
    const row = [...bbRow(o.u)], i = row.findIndex((x) => C.parse(x).r === rank && !bbIsLocked(x));
    if (i < 0) return;
    const c = row[i]; row.splice(i, 1);
    const b = moveBatch();
    b.update(roomRef(), bbEv({ [`bb.rows.${o.u}`]: row, discard: [...room.discard, c], moveId: (room.moveId || 0) + 1, log: `⚡ ${botName(o.u)} threw a matching ${cardName(c)}!` }, { k: "match", u: o.u, i, c }));
    b.commit().catch(() => {});
  }, 1000 + Math.random() * 1500);
}
// 😬 a wrong match: everyone sees the card bounce off the pile and 2 penalty cards fly to that player
let bbPenaltySeen = null;
function bbPenaltyShow() {
  const p = room?.bb?.penalty;
  if (!p?.id || p.id === bbPenaltySeen) return;
  const first = bbPenaltySeen === null;
  bbPenaltySeen = p.id;
  if (first && room.status !== "playing") return; // (an old one, from before I opened the table)
  const who = p.u === uid ? (document.querySelector(".bb-mine") || $("table")) : seatEl(p.u) || $("table");
  const pile = $("discardPile");
  // the wrong card flies at the pile, bounces off and goes back
  const a = who.getBoundingClientRect(), b = pile.getBoundingClientRect();
  const el = cardEl(p.c); el.classList.add("flying");
  Object.assign(el.style, { position: "fixed", left: a.left + a.width / 2 - 28 + "px", top: a.top + a.height / 2 - 40 + "px", width: "56px", height: "80px", zIndex: 160, margin: 0 });
  document.body.append(el);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  el.animate([
    { transform: "translate(0,0) rotate(0deg)" },
    { transform: `translate(${dx}px, ${dy}px) rotate(12deg) scale(1.1)`, offset: 0.45 },
    { transform: `translate(${dx * 0.85}px, ${dy * 0.85 - 30}px) rotate(-20deg) scale(1.15)`, offset: 0.6 },
    { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 0.6 },
  ], { duration: 1300, easing: "ease-in-out" }).onfinish = () => el.remove();
  // the big message
  const fx = document.createElement("div");
  fx.className = "bb-penalty";
  fx.innerHTML = `<span class="bp-emoji">😬</span><b></b><small></small>`;
  fx.querySelector("b").textContent = `Not a match! +${p.n} cards`;
  fx.querySelector("small").textContent = `${p.u === uid ? "You" : nameOf(p.u)} threw ${cardName(p.c)} on a ${C.label(p.want)}`;
  document.body.append(fx);
  setTimeout(() => fx.remove(), 2600);
  // the penalty cards fly from the middle pile
  for (let i = 0; i < p.n; i++) setTimeout(() => flyCard($("deck"), who, null, { back: true, slow: true }), 900 + i * 300);
  if (p.u === uid && navigator.vibrate) try { navigator.vibrate([60, 60, 60]); } catch {}
}

// ----- drawing the table -----
function bbCardEl(u, i, c, opts = {}) {
  const shown = bbIsLocked(c) || (bbReveal.get(bbKey(u, i)) || 0) > Date.now() || room.status === "ended";
  const el = shown ? cardEl(c, opts.small ? { small: true } : {}) : Object.assign(document.createElement("div"), { className: "card back" + (opts.small ? " small" : "") });
  el.classList.add("bb-card");
  if (bbIsLocked(c)) el.classList.add("bb-locked");
  el.dataset.uid = u; el.dataset.idx = i;
  return el;
}
let bbLogSeen = null;
function bbPopupLog() { // what just happened, as a pop-up in the middle of the screen
  const k = `${room.round}|${room.moveId}|${room.log}`;
  if (bbLogSeen === null) { bbLogSeen = k; return; }
  if (k === bbLogSeen) return;
  bbLogSeen = k;
  const t = room.log || "";
  // only the big moments pop up (BABUSH, J / Q / K): throws and matches are for the players to watch
  if (!t.startsWith("📣") && !/used [JQK] /.test(t)) return;
  const p = document.createElement("div");
  p.className = "bb-pop" + (t.startsWith("⚡") ? " good" : t.startsWith("📣") ? " call" : "");
  p.textContent = t;
  document.querySelectorAll(".bb-pop").forEach((x) => x.remove());
  document.body.append(p);
  setTimeout(() => p.remove(), 2600);
}
function renderBabbush() {
  const bb = room.bb || {};
  bbPenaltyShow();
  bbPopupLog();
  let area = $("bbArea");
  if (!area) {
    area = Object.assign(document.createElement("section"), { id: "bbArea", className: "bb-area" });
    $("table").after(area);
    area.addEventListener("click", (e) => { const el = e.target.closest(".bb-card[data-uid]"); if (el) bbTapCard(el.dataset.uid, Number(el.dataset.idx)); });
  }
  area.hidden = !room.playerIds.includes(uid) || room.status === "lobby";
  area.innerHTML = "";
  const myTurn = isMyTurn(), drawn = bbMyDrawn();
  // what to do now
  const msg = document.createElement("p");
  msg.className = "bb-msg";
  if (room.status === "ended") msg.textContent = "Round over · all cards are shown";
  else if (bb.stage === "choose") msg.textContent = bb.chooser === uid ? "You choose: how many of their own cards may everyone look at?" : `${nameOf(bb.chooser)} is choosing how many cards everyone may look at…`;
  else if (bb.stage === "peek") msg.textContent = bb.peeked?.[uid] ? "Waiting for everyone to look at their cards…" : `Tap ${bb.peekN} of your cards to look at ${bb.peekN > 1 ? "them" : "it"} · remember ${bb.peekN > 1 ? "them" : "it"}!`;
  else if (bbMode === "J") msg.textContent = "👁 Tap any face-down card (yours or someone else's) to look at it";
  else if (bbMode === "Q") msg.textContent = `🔄 Tap two cards to switch them${bbPicks.length ? " · 1 picked" : ""}`;
  else if (bbMode === "K") msg.textContent = "🔒 Tap a card to lock it face up, or a locked card to unlock it";
  else if (drawn && room.bb.drawn?.from === "thrown") msg.textContent = "Tap one of your cards: the thrown card goes into that place";
  else if (drawn) msg.textContent = "Tap one of your cards to put this card in its place, or throw it" + (C.bbPower(drawn) ? ` · or use its power: ${BB_POWER_NAME[C.bbPower(drawn)]}` : "");
  else if (myTurn) msg.textContent = (bb.caller ? "Last turn! " : "Your turn: ") + "take a card from the middle pile or the last thrown card" + (bb.caller ? "" : ", or call BABUSH");
  else msg.textContent = `${nameOf(room.playerIds[room.turn])} is playing…` + (bb.caller ? ` · ${nameOf(bb.caller)} called BABUSH` : "");
  area.append(msg);
  // choosing 0–2
  if (bb.stage === "choose" && bb.chooser === uid && room.status === "playing") {
    const row = document.createElement("div"); row.className = "bb-btns";
    for (const n of [0, 1, 2]) { const btn = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: `${n} card${n === 1 ? "" : "s"}` }); btn.onclick = () => bbChoose(n); row.append(btn); }
    area.append(row);
  }
  // the card I took
  if (drawn) {
    const box = Object.assign(document.createElement("div"), { id: "bbDrawn", className: "bb-drawn" });
    box.append(Object.assign(document.createElement("small"), { textContent: "Your card" }), cardEl(drawn));
    const btns = document.createElement("div"); btns.className = "bb-btns";
    const fromThrown = room.bb.drawn?.from === "thrown";
    if (!fromThrown) { const th = Object.assign(document.createElement("button"), { type: "button", className: "ghost", textContent: "Throw it" }); th.onclick = () => bbThrowDrawn(); btns.append(th); }
    const pw = fromThrown ? null : C.bbPower(drawn);
    if (pw && !bbMode) { const u = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: `Use ${BB_POWER_NAME[pw]}` }); u.onclick = bbStartPower; btns.append(u); }
    if (bbMode && bbMode !== "snap") { const x = Object.assign(document.createElement("button"), { type: "button", className: "ghost", textContent: "Cancel power" }); x.onclick = () => { bbMode = null; bbPicks = []; render(); }; btns.append(x); }
    box.append(btns);
    area.append(box);
  }
  // my row
  const mine = document.createElement("div");
  mine.className = "bb-mine" + ((drawn && !bbMode) || bbMode || (bb.stage === "peek" && !bb.peeked?.[uid]) ? " pickable" : "");
  bbRow(uid).forEach((c, i) => {
    const el = bbCardEl(uid, i, c);
    if (bbPicks.some((p) => p.u === uid && p.i === i) || bbSel.includes(i)) el.classList.add("bb-picked");
    mine.append(el);
  });
  if (!bbRow(uid).length) mine.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No cards left · count 0!" }));
  area.append(mine);
  // buttons
  const ctl = document.createElement("div"); ctl.className = "bb-btns";
  // picked cards are kept only while the same number is up
  const selKey = `${room.round}|${bb.matchRank}|${bbRow(uid).join()}`;
  if (bbSelKey !== selKey) { bbSelKey = selKey; bbSel = []; }
  if (bb.stage === "play" && room.status === "playing" && bb.matchRank != null && bbRow(uid).length && !drawn && !bbMode && room.discard?.length) {
    area.append(Object.assign(document.createElement("p"), { className: "bb-hint", textContent: `Got a ${C.label(bb.matchRank)} too? Pick your card${bbSel.length ? "s" : "(s)"} and throw` }));
    if (bbSel.length) {
      const tb = Object.assign(document.createElement("button"), { type: "button", className: "bb-snap", textContent: `⚡ Throw ${bbSel.length} card${bbSel.length > 1 ? "s" : ""} as ${C.label(bb.matchRank)}` });
      tb.onclick = () => bbSnap(bbSel);
      const cl = Object.assign(document.createElement("button"), { type: "button", className: "ghost small", textContent: "Clear" });
      cl.onclick = () => { bbSel = []; render(); };
      ctl.append(tb, cl);
    }
  }
  if (myTurn && bb.stage === "play" && room.phase === "draw" && !bb.caller && room.status === "playing") {
    const cb = Object.assign(document.createElement("button"), { type: "button", className: "bb-call", textContent: "📣 BABUSH" });
    cb.onclick = () => { if (confirm("Call BABUSH? Everyone else gets one more turn, then all cards are counted.")) bbCall(); };
    ctl.append(cb);
  }
  if (ctl.children.length) area.append(ctl);
  // others' cards are tappable for J / Q / K
  document.querySelectorAll(".bb-orow").forEach((el) => el.classList.toggle("pickable", bbMode === "J" || bbMode === "Q" || bbMode === "K"));
  document.querySelectorAll(".bb-orow .bb-card").forEach((el) => el.classList.toggle("bb-picked", bbPicks.some((p) => p.u === el.dataset.uid && p.i === Number(el.dataset.idx))));
}
document.addEventListener("click", (e) => { const el = e.target.closest(".bb-orow .bb-card[data-uid]"); if (el && room && isBabbush()) bbTapCard(el.dataset.uid, Number(el.dataset.idx)); });

// ---------- BONDI ----------
// The whole deck is dealt out; whoever has K♠ leads. Follow the suit that was led. If everyone
// follows, those cards are set aside and the highest card leads next. If someone can't follow,
// they play any card and the trick stops: the cards go to whoever played the highest card of the
// led suit, and that player leads. First out of cards scores 0, then 10, 20, …; lowest total wins.
// Picked-up cards wait in room.pickups until the player's own screen (or, for the computer,
// the host's) moves them into their hand — only you can write your own hand.
const SUIT_WORD = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const cardName = (id) => C.label(C.parse(id).r) + C.SUIT_SYMBOL[C.parse(id).s];
const ordinal = (n) => n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");
function trickLeader() {
  const t = room.trick || [];
  if (!t.length) return null;
  const s = C.suitOf(t[0].card);
  return t.filter((x) => C.suitOf(x.card) === s).reduce((a, b) => (C.bondiRank(b.card) > C.bondiRank(a.card) ? b : a)).uid;
}
// true while cards I've been given haven't reached my hand yet, or my hand hasn't caught up with
// the table (the two arrive separately) — I can't play until it's all in step
// (never for more than a moment: after 2 s I can play anyway, and my next card fixes the count)
const pendingPickup = () => isBondi() && !!room && (pickList(uid).some((c) => !hand.includes(c))
  || (room.status === "playing" && room.counts && hand.length !== room.counts[uid]));
const toList = (v) => (!v ? [] : Array.isArray(v) ? v.filter((x) => x != null) : typeof v === "object" ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]).filter((x) => x != null) : []);
const listMap = (m) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, toList(v)]));
// picked-up cards as a list (the live database can hand back a list as {0: …, 1: …})
const isCardId = (x) => typeof x === "string" && /^\d+-[SHDC]-\d+$/.test(x);
const pickList = (u) => toList(room?.pickups?.[u]).filter(isCardId);

async function dealBondi() {
  const ids = room.playerIds, n = ids.length;
  const deck = C.shuffle(C.buildDeck(1));
  const hands = Object.fromEntries(ids.map((p) => [p, []]));
  deck.forEach((c, i) => hands[ids[i % n]].push(c));
  const starter = ids.findIndex((p) => hands[p].includes(C.BONDI_FIRST));
  const batch = writeBatch(db);
  for (const p of ids) batch.set(handRef(p), { cards: hands[p] });
  const round = (room.round || 0) + 1;
  batch.update(roomRef(), {
    status: "playing", host: uid, deck: [], discard: [], turn: starter, phase: "play",
    trick: [], trickSize: n, out: [], aside: 0, pickups: {}, voids: {}, lastTrick: null, order: null,
    counts: Object.fromEntries(ids.map((p) => [p, hands[p].length])),
    lastThrow: null, pickable: null, thrownNow: null, moveId: 0, reshuffles: 0, almost: {},
    winner: null, winnerSets: null, diguCard: null, scored: false, round,
    gameRound: (room.gameRound || 0) + 1,
    log: `${roundsTotal(room) ? `Round ${(room.gameRound || 0) + 1} of ${roundsTotal(room)} · ` : ""}${nameOf(ids[starter])} has K♠ and starts`,
  });
  try { await batch.commit(); sendNotify(room?.gameRound > 1 ? "round" : "start"); } catch (e) { toast(errMsg(e)); }
}

// What a computer player (or my timed-out turn) knows: who still plays this trick, who has run out of what.
function bondiCtx(r, who) {
  const counts = r.counts || {}, played = (r.trick || []).map((t) => t.uid);
  const n = r.playerIds.length, seat = r.playerIds.indexOf(who), later = [];
  for (let k = 1; k < n; k++) {
    const u = r.playerIds[(seat + k) % n];
    if (counts[u] > 0 && !played.includes(u) && u !== who) later.push(u);
  }
  const left = Math.max(0, (r.trickSize || n) - played.length - 1); // how many play after me this trick
  return { me: who, voids: listMap(r.voids), others: r.playerIds.filter((u) => u !== who && counts[u] > 0), later: later.slice(0, left),
    level: isBot(who) && r.botLevel === "easy" ? "easy" : "hard" };
}

const bondiState = (r) => ({
  playerIds: r.playerIds, counts: r.counts || {}, trick: r.trick || [],
  trickSize: r.trickSize || r.playerIds.length, out: r.out || [], aside: r.aside || 0,
});

// Turn the rules' result into the room fields to save, with a line for the log.
function bondiUpdate(r, res, who, card, timedOut = false) {
  const moveId = (r.moveId || 0) + 1;
  const upd = { counts: res.counts, trick: res.trick, moveId };
  if (res.trickSize != null) upd.trickSize = res.trickSize;
  if (res.out) upd.out = res.out;
  if (res.aside != null) upd.aside = res.aside;
  if (res.lastTrick) upd.lastTrick = { ...res.lastTrick, id: `${r.round}-${moveId}` };
  if (res.pickup) upd[`pickups.${res.pickup.uid}`] = arrayUnion(...res.pickup.cards);
  let log = card ? `${nameOf(who)} ${timedOut ? "ran out of time and played" : "played"} ${cardName(card)}` : `${nameOf(who)} was skipped`;
  const ev = res.event;
  if (ev?.kind === "cut") {
    log = `${nameOf(ev.by)} had no ${SUIT_WORD[ev.suit]} and cut! ${nameOf(ev.to)} picks up ${ev.n} cards`;
    upd[`voids.${ev.by}`] = arrayUnion(ev.suit);
  }
  if (ev?.kind === "clear") log = `Everyone followed ${SUIT_WORD[ev.suit]} · cards set aside`;
  if (res.over) {
    Object.assign(upd, { status: "ended", winner: res.order[0], order: res.order, diguCard: null, winnerSets: null, diguStyle: null });
    log += ` · round over`;
  } else {
    upd.turn = res.turn;
    if (ev) log += ` · ${nameOf(r.playerIds[res.turn])} leads`;
  }
  upd.log = log;
  return upd;
}

function bondiThrow(card, timedOut) {
  const trick = room.trick || [];
  if (!C.bondiLegal(hand, trick).includes(card)) {
    const s = C.suitOf(trick[0].card);
    return toast(`You have ${SUIT_WORD[s]}: play a ${C.SUIT_SYMBOL[s]} card`);
  }
  if (!claimAction()) return;
  const res = C.bondiPlay(bondiState(room), uid, card);
  const b = moveBatch();
  b.update(handRef(), { cards: hand.filter((c) => c !== card) });
  b.update(roomRef(), bondiUpdate(room, res, uid, card, timedOut));
  previewThrow([card]);
  selected = null;
  lastDrawn = null;
  commit(b, res.over ? "ended" : "turn");
}

// Cards I've been given: move them into my hand.
function applyPickup() {
  if (!isBondi() || !room?.pickups?.[uid] || !handSeen) return;
  if (applyPickup.busy && Date.now() - applyPickup.busy < 5000) return;
  const add = pickList(uid).filter((c) => !hand.includes(c));
  // wait until my hand is up to date (it arrives separately from the table); the safety net below
  // sorts it out if that never happens
  if (room.status === "playing" && room.counts && hand.length + add.length !== room.counts[uid]) return;
  applyPickup.busy = Date.now();
  const b = writeBatch(db);
  if (add.length) b.update(handRef(), { cards: [...hand, ...add] });
  b.update(roomRef(), { [`pickups.${uid}`]: deleteField() });
  b.commit().catch((e) => console.warn("pickup", e)).finally(() => { applyPickup.busy = 0; });
}

window.__bondiDbg = () => ({ hand: hand.length, count: room?.counts?.[uid], pick: pickList(uid), busy: applyPickup.busy, handSeen, pending: pendingMoves.length, server: serverHand.length });
// BONDI safety net: if my hand and the table disagree for a few seconds (a save got lost on a bad
// connection), reload my hand from the server, take in any picked-up cards, and if the count is still
// off, correct it, so the game never gets stuck on "your turn" with nothing working.
let bondiStuckSince = 0;
setInterval(async () => {
  const off = room && isBondi() && room.status === "playing" && room.playerIds?.includes(uid) && handSeen
    && (room.pickups?.[uid] || (room.counts && hand.length !== room.counts[uid]));
  if (!off) { bondiStuckSince = 0; return; }
  if (!bondiStuckSince) { bondiStuckSince = Date.now(); return; }
  if (Date.now() - bondiStuckSince < 4000 || pendingMoves.length || (applyPickup.busy && Date.now() - applyPickup.busy < 5000)) return;
  bondiStuckSince = Date.now();
  applyPickup.busy = Date.now();
  try {
    const fresh = (await getDoc(handRef())).data()?.cards || [];
    const pick = pickList(uid).filter((c) => !fresh.includes(c));
    const cards = [...fresh, ...pick];
    const b = writeBatch(db);
    if (pick.length) b.update(handRef(), { cards });
    const upd = {};
    if (room.pickups?.[uid]) upd[`pickups.${uid}`] = deleteField();
    if (room.counts?.[uid] !== cards.length) upd[`counts.${uid}`] = cards.length;
    if (Object.keys(upd).length) b.update(roomRef(), upd);
    await b.commit();
    setHandCards(cards);
    render();
  } catch (e) { console.warn("BONDI fix-up", e); } finally { applyPickup.busy = 0; }
}, 1000);

async function botBondi(bot, cards) {
  const got = pickList(bot);
  const held = [...cards, ...got.filter((c) => !cards.includes(c))];
  if (!held.length) return;
  const card = botLevel() === "hard" && botKnown
    ? C.bondiHardCard(held, bondiState(room), bot, { known: botKnown, voids: listMap(room.voids), humans: room.playerIds.filter((u) => !isBot(u)), budgetMs: 250 })
    : C.bondiBotCard(held, room.trick || [], bondiCtx(room, bot));
  const res = C.bondiPlay(bondiState(room), bot, card);
  const upd = bondiUpdate(room, res, bot, card);
  if (room.pickups?.[bot]) upd[`pickups.${bot}`] = deleteField();
  await botCommit(upd, bot, held.filter((c) => c !== card));
}

// Someone went offline mid-round: their cards leave with them.
function bondiRemoval(r, out, ids, pick) {
  const counts = pick(r.counts);
  const trick = (r.trick || []).filter((t) => !out.includes(t.uid));
  const active = ids.filter((u) => counts[u] > 0);
  const upd = { counts, trick, out: (r.out || []).filter((u) => !out.includes(u)), moveId: (r.moveId || 0) + 1 };
  if (active.length <= 1) {
    return { ...upd, status: "ended", order: [...upd.out, ...active], winner: upd.out[0] || active[0], diguStyle: null };
  }
  const played = trick.map((t) => t.uid);
  upd.trickSize = Math.max(1, played.length + active.filter((u) => !played.includes(u)).length);
  const cur = r.playerIds[r.turn];
  if (out.includes(cur) || !trick.length && (r.trick || []).length) {
    // pass the turn on to the next player still here who hasn't played this trick
    let k = 1;
    while (k < r.playerIds.length) {
      const u = r.playerIds[(r.turn + k) % r.playerIds.length];
      if (!out.includes(u) && counts[u] > 0 && !played.includes(u)) break;
      k++;
    }
    upd.turn = ids.indexOf(r.playerIds[(r.turn + k) % r.playerIds.length]);
  } else upd.turn = ids.indexOf(cur);
  if (upd.turn < 0) upd.turn = ids.indexOf(active[0]);
  return upd;
}

// The middle of the table: the cards played in this trick, each with who played it.
// Between tricks, the last trick stays there, faded, until the next card comes down.
function renderTrick() {
  const pile = $("discardPile");
  const live = room.trick || [];
  const last = room.status === "playing" && room.lastTrick && sweptTricks.has(room.lastTrick.id) ? null : room.lastTrick; // gone once it has flown away
  const showing = live.length ? live : last ? last.cards.map((card, i) => ({ card, uid: last.players[i] })) : [];
  const key = `${room.round}|${room.status}|${JSON.stringify(showing)}|${last?.id}`;
  if (key === heapKey) return;
  const prevCount = heapTop?.round === room.round ? heapTop.n : 0;
  heapKey = key;
  heapTop = { round: room.round, n: live.length };
  pile.innerHTML = "";
  pile.classList.toggle("trick-done", !live.length && !!last);
  if (!showing.length) { pile.innerHTML = '<div class="card empty"></div>'; return; }
  const n = showing.length;
  showing.forEach((t, i) => {
    const slot = document.createElement("div");
    slot.className = "trick-slot";
    slot.style.setProperty("--i", i - (n - 1) / 2);
    slot.style.zIndex = i + 1;
    const el = cardEl(t.card);
    el.classList.add("trick-card");
    if (arriving.has(t.card)) el.classList.add("arriving");
    if (live.length && i === n - 1 && n > prevCount && !el.classList.contains("arriving")) el.classList.add("landing");
    if (!live.length && last?.cut === t.uid) el.classList.add("cut-card");
    slot.append(el, Object.assign(document.createElement("small"), { textContent: t.uid === uid ? "You" : nameOf(t.uid) }));
    pile.append(slot);
  });
  // a finished deck never waits on the table: it flies to whoever picks it up (or out of play) by itself
  if (!live.length && last && room.status === "playing" && !sweepPlanned.has(last.id)) {
    sweepPlanned.add(last.id);
    setTimeout(() => sweepTrick(last), isBondi() ? 450 : 900);
  }
  if (!live.length && last) {
    const note = document.createElement("div");
    note.className = "trick-note" + (last.to ? " cut" : "");
    note.textContent = isDhiha() ? `✓ Deck to ${teamName(last.team)}${last.tens ? " · 🔟" : ""}`
      : last.to ? `✋ Cut! → ${last.to === uid ? "you pick up" : nameOf(last.to) + " picks up"}` : "✓ Out of play";
    pile.append(note);
  }
}

// ---------- DHIHA (team game, holhuashis only) ----------
// 4 players, 2 teams (they pick in the holhuashi; teammates sit opposite), 13 cards each.
// Follow suit; the first player who can't sets the Hukum (trump). Each complete trick (a "deck")
// goes to the team of whoever won it. When all four 10s are out, 3 tens wins; at 2 tens each, first to 7 decks wins.
function dhihaTeams(r = room) {
  const t = r.teams || {};
  const A = r.playerIds.filter((u) => t[u] === "A"), B = r.playerIds.filter((u) => t[u] === "B");
  return { A, B, ok: r.playerIds.length === 4 && A.length === 2 && B.length === 2 };
}
function pickTeam(team) {
  if (!room || room.status !== "lobby") return;
  const now = dhihaTeams();
  if (now[team].length >= 2 && room.teams?.[uid] !== team) return toast(`${teamName(team)} is full`);
  updateDoc(roomRef(), { [`teams.${uid}`]: team }).catch((e) => toast(errMsg(e)));
}

async function dealDhiha() {
  if (room.playerIds.length !== 4) return toast("DHIHA needs exactly 4 players");
  const teams = { ...(room.teams || {}) };
  for (const u of room.playerIds) if (teams[u] !== "A" && teams[u] !== "B") delete teams[u];
  for (const u of room.playerIds.filter((x) => isBot(x) && !teams[x])) {
    const a = room.playerIds.filter((x) => teams[x] === "A").length;
    teams[u] = a < 2 ? "A" : "B";
  }
  const tm = dhihaTeams({ ...room, teams });
  if (!tm.ok) return toast("Pick teams first: 2 players in Team 1 and 2 in Team 2");
  // teammates sit opposite: Team 1, Team 2, Team 1, Team 2
  const order = [tm.A[0], tm.B[0], tm.A[1], tm.B[1]];
  const players = order.map((u) => room.players.find((p) => p.uid === u));
  const deck = C.shuffle(C.buildDeck(1));
  const batch = writeBatch(db);
  order.forEach((u, i) => batch.set(handRef(u), { cards: deck.slice(i * 13, i * 13 + 13) }));
  const round = (room.round || 0) + 1;
  const turn = Math.floor(Math.random() * 4); // a random player starts
  batch.update(roomRef(), {
    status: "playing", host: uid, players, playerIds: order, teams, deck: [], discard: [], turn, phase: "play",
    trick: [], hukum: null, hukumBy: null, decks: { A: [], B: [] }, lastTrick: null, dhihaResult: null, dvoids: {},
    lastThrow: null, pickable: null, thrownNow: null, moveId: 0, almost: {}, winner: null, winnerSets: null,
    diguCard: null, scored: false, round, gameRound: (room.gameRound || 0) + 1,
    log: `${roundsTotal(room) ? `Round ${(room.gameRound || 0) + 1} of ${roundsTotal(room)} · ` : ""}${nameOf(order[turn])} starts`,
  });
  try { await batch.commit(); sendNotify(room?.gameRound > 1 ? "round" : "start"); } catch (e) { toast(errMsg(e)); }
}

function dhihaThrow(card, timedOut) {
  const trick = room.trick || [];
  if (!C.dhihaLegal(hand, trick).includes(card)) {
    const s = C.suitOf(trick[0].card);
    return toast(`You have ${SUIT_WORD[s]}: play a ${C.SUIT_SYMBOL[s]} card`);
  }
  if (!claimAction()) return;
  const upd = dhihaMoveUpdate(uid, card, timedOut);
  const b = moveBatch();
  b.update(handRef(), { cards: hand.filter((c) => c !== card) });
  b.update(roomRef(), upd);
  selected = null;
  lastDrawn = null;
  previewThrow([card]);
  commit(b, upd.status === "ended" ? "ended" : "turn");
}
async function botDhiha(bot, cards) {
  const seen = [...(room.decks?.A || []), ...(room.decks?.B || [])].flatMap((d) => d.split(","));
  const level = botLevel();
  const card = level === "easy" ? C.dhihaAutoCard(cards, room.trick || [], room.hukum)
    : level === "hard" ? C.dhihaHardCard(cards, room.trick || [], room.hukum, { me: bot, teams: room.teams, playerIds: room.playerIds,
      seen, voids: listMap(room.dvoids), decksA: room.decks?.A || [], decksB: room.decks?.B || [], budgetMs: 250, known: botKnown || {} })
    : C.dhihaBotCard(cards, room.trick || [], room.hukum, { me: bot, teams: room.teams, playerIds: room.playerIds,
      seen, voids: listMap(room.dvoids) });
  if (!card) return;
  await botCommit(dhihaMoveUpdate(bot, card, false), bot, cards.filter((c) => c !== card));
}
function dhihaMoveUpdate(who, card, timedOut) {
  const trick = room.trick || [];
  const res = C.dhihaPlay({ playerIds: room.playerIds, teams: room.teams, trick, hukum: room.hukum, decks: room.decks }, who, card);
  const moveId = (room.moveId || 0) + 1;
  const upd = { trick: res.trick, hukum: res.hukum, turn: res.turn, moveId,
    log: `${nameOf(who)} ${timedOut ? "ran out of time and played" : "played"} ${cardName(card)}` };
  if (trick.length && C.suitOf(card) !== C.suitOf(trick[0].card)) upd[`dvoids.${who}`] = arrayUnion(C.suitOf(trick[0].card));
  if (res.event?.kind === "hukum") { upd.hukumBy = who; upd.log += ` · Hukum is now ${C.SUIT_SYMBOL[res.hukum]}!`; }
  if (res.decks) {
    upd.decks = res.decks;
    upd.lastTrick = { cards: res.won.cards, players: [...trick.map((t) => t.uid), who], team: res.won.team, winner: res.won.winner, tens: res.won.tens, id: `${room.round}-${moveId}` };
    upd.log = `${nameOf(res.won.winner)} won the deck for ${teamName(res.won.team)}${res.won.tens ? ` · with ${res.won.tens > 1 ? res.won.tens + " tens" : "a 10"}!` : ""}`;
  }
  if (res.over) {
    const champs = room.playerIds.filter((u) => room.teams[u] === res.over.team);
    Object.assign(upd, { status: "ended", winner: champs[0], dhihaResult: res.over, diguStyle: null });
    upd.log += ` · ${teamName(res.over.team)} wins the round`;
  }
  return upd;
}

// The two teams' piles: decks with a 10 lie face up (the 10 on top); the rest are face down.
function renderDhihaPiles() {
  const box = $("dhihaPiles");
  const show = isDhiha() && room.status !== "lobby";
  box.hidden = !show;
  $("hukumBadge").hidden = !show;
  if (!show) return;
  const key = JSON.stringify([room.decks, room.hukum, room.teams, room.round]);
  if (box._key === key) return;
  box._key = key;
  box.innerHTML = "";
  for (const team of ["A", "B"]) {
    const decks = (room.decks?.[team] || []).map((d) => d.split(","));
    const tens = decks.flat().filter((c) => C.parse(c).r === 10);
    const mine = room.teams?.[uid] === team;
    const el = document.createElement("div");
    el.className = "team-pile team-" + team + (mine ? " mine" : "");
    el.id = "teamPile-" + team;
    const names = room.playerIds.filter((u) => room.teams?.[u] === team).map((u) => (u === uid ? "You" : nameOf(u))).join(" & ");
    el.append(Object.assign(document.createElement("div"), { className: "tp-head", textContent: `${teamName(team)} · ${names}` }));
    // every deck in the order it was won, each one lying a little lower and to the side of the last:
    // decks with a 10 face up (the 10 on top), the others face down. A badge shows how many.
    const row = document.createElement("div");
    row.className = "tp-row tp-stack";
    decks.forEach((d, i) => {
      const ten = d.find((c) => C.parse(c).r === 10);
      const c = ten ? cardEl(ten, { small: true }) : document.createElement("div");
      if (!ten) c.className = "card back small";
      c.classList.add("tp-deck");
      if (ten) c.classList.add("tp-ten");
      c.style.setProperty("--i", i);
      row.append(c);
    });
    row.style.setProperty("--n", decks.length);
    if (decks.length) row.append(Object.assign(document.createElement("span"), { className: "tp-count", textContent: decks.length }));
    else row.append(Object.assign(document.createElement("small"), { className: "tp-empty", textContent: "no decks yet" }));
    el.append(row, Object.assign(document.createElement("div"), { className: "tp-stats", textContent: `🔟 ${tens.length} · ${decks.length} deck${decks.length === 1 ? "" : "s"}` }));
    box.append(el);
  }
  const hb = $("hukumBadge");
  hb.className = "hukum-badge" + (room.hukum ? " set " + (["H", "D"].includes(room.hukum) ? "red" : "black") : "");
  hb.textContent = room.hukum ? `Hukum ${C.SUIT_SYMBOL[room.hukum]}` : "Hukum: not chosen yet";
}

function dhihaMoments(prev) {
  if (room.hukum && !prev.hukum) {
    showBanner(`🔥 Hukum is ${C.SUIT_SYMBOL[room.hukum]} · chosen by ${room.hukumBy === uid ? "you" : nameOf(room.hukumBy)}`);
    showBubble(room.hukumBy, `Hukum ${C.SUIT_SYMBOL[room.hukum]}!`, true);
  }
  const t = room.lastTrick;
  if (t?.id && t.id !== prev.lastTrick?.id) {
    setTimeout(() => sweepTrick(t), 650);
    if (t.tens) setTimeout(() => funMoment("🔟", `${teamName(t.team)} got ${t.tens > 1 ? t.tens + " tens" : "a 10"}! (${t.winner === uid ? "you" : nameOf(t.winner)})`, ["🔟", "✨", "👏", "🎉"], "clap"), 900);
  }
}

function playDhihaEnd(r) {
  const res = r.dhihaResult || {};
  const names = r.playerIds.filter((u) => r.teams?.[u] === res.team).map((u) => (u === uid ? "You" : r.players.find((p) => p.uid === u)?.name || "?")).join(" & ");
  const fx = document.createElement("div");
  fx.className = "shout-fx is-digu";
  const word = shoutEl(null, `${teamName(res.team)}!`);
  word.classList.add("fx-word");
  const who = document.createElement("div");
  who.className = "fx-who";
  who.textContent = `🏆 ${names} win the round · ${res.how === "decks" ? `${res.count?.[res.team]} decks` : `${res.tens?.[res.team]} tens`} · +${res.points} point${res.points > 1 ? "s" : ""}`;
  fx.append(Object.assign(document.createElement("div"), { className: "fx-rays" }), word, who);
  confetti(fx, false);
  shakeAndFade(fx);
}

// In the holhuashi before a DHIHA game: everyone picks a team.
function dhihaTeamPicker() {
  const wrap = document.createElement("section");
  wrap.className = "team-picker";
  const tm = dhihaTeams();
  wrap.append(Object.assign(document.createElement("h3"), { textContent: tm.ok ? "✓ Teams are ready · the owner can press Start" : "Pick your team (2 players each)" }));
  const cols = document.createElement("div");
  cols.className = "tp-cols";
  for (const team of ["A", "B"]) {
    const col = document.createElement("div");
    col.className = "tp-col team-" + team;
    col.append(Object.assign(document.createElement("b"), { textContent: teamName(team) }));
    for (const u of tm[team]) {
      const p = room.players.find((x) => x.uid === u);
      const row = document.createElement("div");
      row.className = "tp-member";
      row.append(avatarEl(p, "avatar small"), Object.assign(document.createElement("span"), { textContent: u === uid ? "You" : p.name }));
      col.append(row);
    }
    for (let i = tm[team].length; i < 2; i++) col.append(Object.assign(document.createElement("div"), { className: "tp-member empty", textContent: "free place" }));
    if (room.teams?.[uid] !== team && tm[team].length < 2) {
      const btn = Object.assign(document.createElement("button"), { type: "button", className: "primary small", textContent: `Join ${teamName(team)}` });
      btn.onclick = () => pickTeam(team);
      col.append(btn);
    }
    cols.append(col);
  }
  wrap.append(cols);
  if (room.players.length !== 4) wrap.append(Object.assign(document.createElement("p"), { className: "tp-note", textContent: `DHIHA needs exactly 4 players · ${room.players.length} here now` }));
  return wrap;
}

// ---------- turn actions ----------
// Moves are written straight from the local copy of the game (no server round trip first),
// so they show on your screen instantly.
const nameOf = (u) => room.players.find((p) => p.uid === u)?.name || "?";
const isMyTurn = () => room?.status === "playing" && !room.paused && room.playerIds[room.turn] === uid;
// The holhuashi owner can pause a game (e.g. while someone is offline). While paused nobody can play,
// the turn clock stops and offline players are not removed. If the owner isn't at the table, the host can.
const canPause = () => !!room && isLoungeDoc(room) && room.status === "playing"
  && (ownsLounge(room) || (room.host === uid && !room.playerIds.includes(room.owner)));
function togglePause() {
  if (!canPause()) return;
  const off = room.players.filter((p) => isOffline(room, p.uid, roomId) || silentFor(p.uid) > 30_000).map((p) => p.name);
  updateDoc(roomRef(), room.paused
    ? { paused: null, host: uid, heartbeat: serverTimestamp(), moveId: (room.moveId || 0) + 1, log: `▶ ${myName()} resumed the game` }
    : { paused: { by: uid, at: Date.now() }, log: `⏸ ${myName()} paused the game${off.length ? ` · waiting for ${off.join(" & ")}` : ""}` })
    .catch((e) => toast(errMsg(e)));
}
// End the game now (no points for an unfinished game): back to the holhuashi.
function endGameNow() {
  if (!room || !isLoungeDoc(room) || !["playing", "ended"].includes(room.status)) return;
  if (!(ownsLounge(room) || (room.host === uid && !room.playerIds.includes(room.owner)))) return;
  if (!confirm("End this game now? It stops here and nobody gets points for it.")) return;
  updateDoc(roomRef(), {
    status: "lobby", paused: null, eliminated: [], digus: null, scores: Object.fromEntries(room.playerIds.map((p) => [p, 0])),
    gameOver: false, champions: null, gameRound: 0, almost: {}, trick: [], lastTrick: null, host: uid,
    log: `⏹ ${myName()} ended the game`,
  }).then(() => { $("results").hidden = true; }).catch((e) => toast(errMsg(e)));
}
function renderPause() {
  const btn = $("pauseBtn"), bar = $("pauseBar");
  const playing = room?.status === "playing";
  const off = playing ? room.players.filter((p) => p.uid !== uid && (isOffline(room, p.uid, roomId) || silentFor(p.uid) > 30_000)) : [];
  btn.hidden = !canPause() || $("game").hidden;
  btn.textContent = room?.paused ? "▶" : "⏸";
  btn.setAttribute("aria-label", room?.paused ? "Resume" : "Pause");
  btn.classList.toggle("alert", !room?.paused && off.length > 0);
  btn.title = off.length ? `${off.map((p) => p.name).join(" & ")} offline` : "";
  $("endGameBtn").hidden = $("game").hidden || !(canPause() || (room?.status === "ended" && !room.gameOver && isLoungeDoc(room) && ownsLounge(room)));
  bar.hidden = !(playing && room.paused);
  if (bar.hidden) return;
  const who = room.paused.by === uid ? "You" : nameOf(room.paused.by);
  bar.textContent = `⏸ ${who} paused the game` + (off.length ? ` · waiting for ${off.map((p) => p.name).join(" & ")}` : " · everyone is here");
  bar.append(Object.assign(document.createElement("small"), { textContent: "Everything is saved · you can leave and come back later, the game continues from this card" }));
}
// DIGU turn: take a card ("draw"), then throw one ("discard").
// CALL turn: throw first ("throw"), then take a card ("draw") — the previous player's last thrown
// card (room.pickable) or the top of the middle pile.
const canDraw = () => (isBabbush() ? isMyTurn() && room.bb?.stage === "play" && room.phase === "draw" && !shuffling() && !bbMatchLeft()
  : !isBondi() && isMyTurn() && room.phase === "draw" && (isCall() || hand.length <= C.HAND_SIZE));
// DIGU: holding 11 cards in the "take" step (e.g. my turn was skipped right after I took one): just throw
const holdingExtra = () => gameOf(room) === "digu" && room.phase === "draw" && hand.length > C.HAND_SIZE;
const canThrow = () => isMyTurn() && (isDhiha() ? room.phase === "play" : isBondi() ? room.phase === "play" && !pendingPickup()
  : room.phase === (isCall() ? "throw" : "discard") || holdingExtra());
const mustThrowFirst = () => isCall() && isMyTurn() && room.phase === "throw";

let actedAt = 0;
// After the phone sleeps or loses connection, it first shows its saved copy of the table. Moves made
// on that old copy would overwrite the real game (and leave others unable to play), so nothing is
// played until the server has sent the current table.
let roomStale = false, hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (room && roomId && Date.now() - hiddenAt > 10_000) refreshRoom();
});
addEventListener("online", () => { if (room && roomId) refreshRoom(); });
function refreshRoom() {
  roomStale = true;
  const code = roomId;
  const done = () => { if (roomId === code) roomStale = false; };
  checkServerRoom().then(done, done);
  setTimeout(done, 6000); // never stay locked
}
// Ask the server for the table. If it's ahead of what my screen shows, my live connection has
// stalled: reconnect it (this is the "they see it's my turn but I don't" problem).
let lastRoomEvent = 0, resyncing = false, handLoaded = false, roomConfirmed = false;
async function checkServerRoom() {
  if (!room || !roomId || resyncing) return;
  const code = roomId;
  const s = await getDoc(roomRef());
  if (!s.exists() || roomId !== code || !room) return;
  const d = s.data();
  const ahead = d.round !== room.round || (d.moveId || 0) !== (room.moveId || 0) || d.turn !== room.turn
    || d.status !== room.status || d.phase !== room.phase;
  if (s.metadata?.fromCache) { kickConnection(); return; } // couldn't reach the server: restart the connection
  if (ahead) {
    resyncing = true;
    console.warn("Table was out of date: reconnecting");
    try { enterRoom(code); } finally { setTimeout(() => (resyncing = false), 3000); }
  }
}
// watchdog: during a game something happens at least every turn (50 s); if my screen has heard
// nothing for longer than that, check with the server
setInterval(() => {
  if (!room || !roomId || room.status !== "playing" || room.paused || document.hidden) return;
  if (Date.now() - lastRoomEvent > TURN_MS + GRACE_MS + 6000) { lastRoomEvent = Date.now(); checkServerRoom().catch(() => {}); }
}, 5000);
function claimAction() {
  if (roomStale) { toast("Reconnecting… one moment"); return false; }
  const key = `${room.round}-${room.moveId || 0}-${room.phase}`;
  // a double tap is blocked, but a move that never went through (phone was offline) doesn't lock me out
  if (actedKey === key && Date.now() - actedAt < 4000) return false;
  actedKey = key;
  actedAt = Date.now();
  return true;
}

// Save a move. Once the server has it, optionally tell the other players' phones (push).
// ---------- instant feedback while the server confirms a move ----------
// The moment I tap, my card flies to the pile (or a card flies into my hand) with a little burst
// of sparkles. The card stays faint in my hand until the server says OK; if it's refused, it comes back.
function sparkleAt(target) {
  if (!target) return;
  const r = target.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const marks = ["✨", "⭐", "✦", "✧", "💫", "✨"];
  for (let i = 0; i < 7; i++) {
    const s = document.createElement("span");
    s.className = "sparkle";
    s.textContent = marks[i % marks.length];
    Object.assign(s.style, { left: cx + "px", top: cy + "px" });
    document.body.append(s);
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5, d = 40 + Math.random() * 30;
    s.animate([
      { transform: "translate(-50%,-50%) scale(.4)", opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(1.1)`, opacity: 0 },
    ], { duration: 650, easing: "cubic-bezier(.2,.8,.3,1)" }).onfinish = () => s.remove();
  }
  if (target !== $("hand")) { target.classList.remove("pile-pop"); void target.offsetWidth; target.classList.add("pile-pop"); }
}
let sendingIds = [];
function previewThrow(ids) {
  const pile = $("discardPile");
  ids.forEach((id, i) => {
    const el = document.querySelector(`#hand .card[data-id="${CSS.escape(id)}"]`);
    if (finishGlide(id)) { el?.classList.add("sending"); return; } // it's already on its way
    if (el) {
      flyCard(el, pile, id, { delay: i * 70 });
      el.classList.add("sending");
    }
  });
  sendingIds = ids;
  setTimeout(() => sparkleAt(pile), 560 + ids.length * 70);
}
let drawnByDrag = false;
function previewDraw(from, card) {
  if (drawnByDrag) { drawnByDrag = false; setTimeout(() => sparkleAt($("hand")), 60); return; } // it's already in my hand, where I dropped it
  const src = from === "discard" ? $("discardPile") : $("deck");
  flyCard(src, $("hand"), from === "discard" ? card : null, { back: from !== "discard" });
  setTimeout(() => sparkleAt($("hand")), 520);
}
function undoPreview() {
  document.querySelectorAll("#hand .card.sending").forEach((el) => el.classList.remove("sending"));
  sendingIds = [];
}

// A move is saved only if the table is still exactly where my screen thinks it is (same round,
// turn, step and move number). If another phone already moved on, my move is refused and my
// screen catches up, instead of two phones overwriting each other (which left players seeing
// different turns, or someone stuck on "take a card").
// Speed: my screen shows my move straight away (I can take and then throw without waiting); the
// checked saves go to the server one after another in the background. If the server refuses one,
// my screen goes back to the real table.
let handSeen = false; // my hand has arrived from the server at least once at this table
let serverRoom = null, serverHand = [], pendingMoves = [], moveChain = Promise.resolve();
const isSentinel = (v) => v && typeof v === "object" && ("__s" in v || "_methodName" in v || "__union" in v || "__inc" in v || "__del" in v || "__remove" in v || "__ts" in v);
function applyLocal(obj, data) {
  const res = { ...obj };
  for (const [k, v] of Object.entries(data)) {
    if (isSentinel(v)) continue; // server-side values (counters, list adds…) arrive with the server copy
    const parts = k.split(".");
    let o = res;
    for (const p of parts.slice(0, -1)) { o[p] = { ...(o[p] || {}) }; o = o[p]; }
    o[parts[parts.length - 1]] = v;
  }
  return res;
}
function withPending(fresh) {
  let r = fresh;
  for (const m of pendingMoves) for (const d of m.room) r = applyLocal(r, d);
  return r;
}
function pendingHand() {
  for (let i = pendingMoves.length - 1; i >= 0; i--) if (pendingMoves[i].hand) return pendingMoves[i].hand;
  return null;
}
let pendingInsert = null; // a card I dragged in from the middle goes where I dropped it, not at the end
function setHandCards(cards) {
  const added = cards.filter((c) => !hand.includes(c));
  const kept = hand.filter((c) => cards.includes(c));
  if (pendingInsert && added.length === 1 && Date.now() < pendingInsert.until) {
    const at = Math.max(0, Math.min(kept.length, pendingInsert.at));
    hand = [...kept.slice(0, at), added[0], ...kept.slice(at)];
    pendingInsert = null;
  } else hand = [...kept, ...added];
  if (!hand.includes(selected)) selected = null;
}
function moveBatch() {
  const exp = room ? { round: room.round, moveId: room.moveId || 0, turn: room.turn, phase: room.phase || null, status: room.status } : null;
  const ref0 = roomRef(), myHand = handRef().path;
  const ops = [];
  return {
    update(ref, data) { ops.push(["u", ref, data]); return this; },
    set(ref, data, opt) { ops.push(["s", ref, data, opt]); return this; },
    delete(ref) { ops.push(["d", ref]); return this; },
    commit() {
      tagMove(ops, ref0);
      // 1) show it now
      const entry = { at: Date.now(), room: ops.filter(([k, ref]) => k === "u" && ref.path === ref0.path).map(([, , d]) => d), hand: null };
      const h = ops.find(([k, ref]) => k !== "d" && ref.path === myHand);
      if (h && Array.isArray(h[2]?.cards)) entry.hand = h[2].cards;
      pendingMoves.push(entry);
      const before = room;
      if (room) room = withPending(serverRoom || room);
      // a computer player's move (run on my phone): animate it now, like anyone else's
      try { if (before && room) cardMoves(before); } catch {}
      // the table's big moments (cut! / out first!) for moves made on this phone too
      try { if (before && room && before.round === room.round && room.status !== "lobby") { if (isBondi()) bondiMoments(before); else if (isDhiha()) dhihaMoments(before); } } catch (e) { console.warn("moments", e); }
      if (entry.hand) setHandCards(entry.hand);
      try { render(); } catch {}
      // 2) save it, after any of my earlier moves
      const run = () => runTransaction(db, async (tx) => {
        const r = (await tx.get(ref0)).data();
        if (!r || !exp || r.round !== exp.round || (r.moveId || 0) !== exp.moveId || r.turn !== exp.turn
          || (r.phase || null) !== exp.phase || r.status !== exp.status) throw new Error("STALE");
        for (const [k, ref, d, o] of ops) {
          if (k === "u") tx.update(ref, d); else if (k === "s") tx.set(ref, d, o || {}); else tx.delete(ref);
        }
      });
      const p = moveChain.catch(() => {}).then(run);
      moveChain = p;
      const drop = () => { pendingMoves = pendingMoves.filter((m) => m !== entry); noteRtt(Date.now() - entry.at); };
      p.then(drop, () => {
        // refused (or failed): forget all my pending moves and show the real table again
        pendingMoves = [];
        if (serverRoom) room = serverRoom;
        setHandCards(serverHand);
        try { render(); } catch {}
      });
      return p;
    },
  };
}
function commit(batch, notifyKind = null) {
  const code = roomId;
  let done = false;
  // A move that hasn't reached the server after 6 s: the phone's connection has stalled (my screen
  // would move on while everyone else still sees my turn). Restart the connection so it goes through.
  const watchdog = setTimeout(() => { if (!done) kickConnection("Slow connection · sending your move again…"); }, 6000);
  batch.commit()
    .then(() => { done = true; clearTimeout(watchdog); sendingIds = []; if (notifyKind) sendNotify(notifyKind, code); })
    .catch((e) => {
      done = true; clearTimeout(watchdog); actedKey = null;
      undoPreview();
      if (e?.message === "STALE") { toast("The table moved on · updated"); lastDrawn = null; }
      else toast(errMsg(e));
      checkServerRoom().catch(() => {});
    });
}
let kicking = false;
async function kickConnection(msg) {
  if (kicking) return;
  kicking = true;
  if (msg) toast(msg);
  try { await disableNetwork(db); await enableNetwork(db); } catch {}
  setTimeout(() => { kicking = false; checkServerRoom().catch(() => {}); }, 1500);
}

// DIGU / CALL: each move says exactly what happened (who took from where, what was thrown, whether
// the thrown cards became a new middle pile). Every screen animates these, once each, in order,
// instead of guessing from differences (which could show one player taking from both piles).
function tagMove(ops, ref0) {
  if (!room || (gameOf(room) !== "digu" && gameOf(room) !== "call")) return;
  const ru = ops.find(([k, ref]) => k === "u" && ref.path === ref0.path);
  const handOp = ops.find(([k, ref, d]) => k === "u" && ref.path !== ref0.path && Array.isArray(d?.cards));
  if (!ru || !handOp) return;
  const d = ru[2];
  if (!d.deck && !d.discard) return;
  const oldDeck = room.deck || [], oldDis = room.discard || [];
  const newDis = d.discard || oldDis;
  const drawn = handOp[2].cards.find((c) => oldDeck.includes(c) || oldDis.includes(c));
  const thrown = [...newDis, ...(d.deck || [])].filter((c) => !oldDis.includes(c) && !oldDeck.includes(c) && c !== drawn);
  const shuffled = !!d.deck && d.deck.length > oldDeck.length - (drawn && oldDeck.includes(drawn) ? 1 : 0);
  if (!drawn && !thrown.length && !shuffled) return;
  const list = (room.fx || []).filter((e) => e.r === room.round);
  const n = list.reduce((m, e) => Math.max(m, e.n), 0) + 1;
  const ev = { r: room.round, n, u: room.playerIds[room.turn] };
  if (drawn) { ev.d = oldDis.includes(drawn) ? "take" : "deck"; if (ev.d === "take") ev.c = drawn; }
  if (thrown.length) ev.t = thrown;
  if (shuffled) { ev.s = 1; ev.old = [...oldDis, ...thrown].slice(-8); }
  d.fx = [...list.slice(-4), ev];
}

// DIGU rule: the card you take from the thrown pile can't be thrown straight back on the same turn.
const takenNow = (who) => (gameOf(room) === "digu" && room.took && room.playerIds[room.turn] === who && room.phase === "discard" ? room.took : null);

function nextTurn(log) {
  return {
    turn: nextActiveIdx(room, room.turn),
    phase: isCall() ? "throw" : "draw",
    moveId: (room.moveId || 0) + 1,
    took: null,
    log,
  };
}

function draw(from) {
  if (isBabbush()) return from === "deck" ? bbDraw() : bbTakeThrown();
  if (shuffling()) return toast("🎩 Wait: the new middle pile is being shuffled");
  if (mustThrowFirst()) return toast("Throw a card first");
  if (isMyTurn() && holdingExtra()) return toast(`You already have ${hand.length} cards · throw one away`);
  if (!canDraw()) { // say why nothing happens, and make sure my screen is up to date
    if (room?.status === "playing" && !isMyTurn()) toast(room.paused ? "The game is paused" : `It's ${nameOf(room.playerIds[room.turn])}'s turn`);
    else if (isMyTurn() && room.phase !== "draw") toast("You've taken a card · now throw one");
    checkServerRoom().catch(() => {});
    return;
  }
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
  const b = moveBatch();
  b.update(roomRef(), {
    deck, discard, phase: "discard",
    log: `${nameOf(uid)} took ${from === "discard" ? "the discard" : "from the pile"}`,
    took: from === "discard" ? card : null,
    ...(reshuffled ? { reshuffles: (room.reshuffles || 0) + 1 } : {}),
    ...(from === "discard" ? trackUpd(uid, "took", [card]) : {}),
  });
  b.update(handRef(), { cards: [...hand, card] });
  previewDraw(from, card);
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
  const b = moveBatch();
  b.update(roomRef(), {
    deck, discard, lastThrow: room.thrownNow || null, pickable: null, thrownNow: null,
    [`ccount.${uid}`]: hand.length + 1,
    ...nextTurn(`${nameOf(uid)} took ${from === "discard" ? "the last thrown card" : "from the pile"}`),
  });
  b.update(handRef(), { cards: [...hand, card] });
  previewDraw(from, card);
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
    discard: [...room.discard, ...ids], phase: "draw", pickable, thrownNow: ids, [`ccount.${uid}`]: rest.length,
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
  const b = moveBatch();
  b.update(handRef(), { cards: rest });
  b.update(roomRef(), upd);
  previewThrow(ids);
  selected = null;
  callSel.clear();
  lastDrawn = null;
  commit(b);
}

// DIGU: throw one card; a throw that leaves a winning hand calls DIGU automatically.
// CALL: throw one card, or several cards of the same number together.
// DIGU: it's my turn but I haven't taken a card yet
const needsDrawFirst = () => gameOf(room) === "digu" && isMyTurn() && room.phase === "draw" && !holdingExtra();
function takeFirstHint() {
  nudge("✋", "Take a card first", "from the middle pile or the last thrown card", true);
}

// ↩ A thrown card waits 1 second before it really goes, so an accidental tap can be taken back.
const UNDO_MS = 1000;
let pendingThrow = null;
function throwProblem(ids) { // anything that would stop this throw (then it's handled straight away, with its message)
  if (shuffling() || needsDrawFirst() || !canThrow() || !ids.length || !ids.every((c) => hand.includes(c))) return true;
  if (isBondi()) return !C.bondiLegal(hand, room.trick || []).includes(ids[0]);
  if (isDhiha()) return !C.dhihaLegal(hand, room.trick || []).includes(ids[0]);
  if (isCall()) return !C.canThrowTogether(ids);
  return ids.length !== 1 || (takenNow(uid) && ids.includes(takenNow(uid)));
}
// ↩ The thrown card itself glides out of my hand and along a long curve towards the middle during the
// take-back second (one card, one smooth movement, growing gently to the pile's card size). Taken
// back: it glides home. Not taken back: the same card carries on and lands on the pile.
const glideFor = new Map();
function glideStart(id) {
  const el = document.querySelector(`#hand .card[data-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect(), w0 = el.offsetWidth || r.width, h0 = el.offsetHeight || r.height;
  const rot0 = +(getComputedStyle(el).getPropertyValue("--rot").match(/-?[\d.]+/)?.[0] || 0);
  // the moving card: its face (a copy of my card) and its back; it turns face down as it leaves my hand
  const face = el.cloneNode(true);
  el.querySelectorAll("*").forEach((src, k) => { const d = face.querySelectorAll("*")[k]; if (d) d.style.fontSize = getComputedStyle(src).fontSize; });
  face.classList.remove("selected", "throw-pending", "new", "blocked", "sending", "dragging");
  const back = Object.assign(document.createElement("div"), { className: "card back" });
  for (const c of [face, back]) Object.assign(c.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", margin: "0", transform: "none", transition: "none", animation: "none" });
  back.style.visibility = "hidden";
  const inner = Object.assign(document.createElement("div"), { className: "gl-in" });
  inner.append(face, back);
  const clone = Object.assign(document.createElement("div"), { className: "glide" });
  clone.append(inner);
  const a = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  Object.assign(clone.style, { position: "fixed", left: a.x - w0 / 2 + "px", top: a.y - h0 / 2 + "px", width: w0 + "px", height: h0 + "px",
    margin: "0", zIndex: 160, pointerEvents: "none", transformOrigin: "50% 50%", transform: `rotate(${rot0}deg)` });
  document.body.append(clone);
  el.classList.add("glide-src");
  const g = { id, el, clone, inner, face, back, down: false, w0, h0, a, rot0, x: a.x, y: a.y, sc: 1, rot: rot0 };
  glideTurn(g, true);
  return g;
}
// turn the moving card over (face down while it can still be taken back; face up when it lands)
function glideTurn(g, down) {
  if (g.down === down) return;
  g.down = down;
  g.inner.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: 110, easing: "ease-in" }).onfinish = () => {
    g.face.style.visibility = down ? "hidden" : "visible";
    g.back.style.visibility = down ? "visible" : "hidden";
    g.inner.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 120, easing: "ease-out" });
  };
}
const glideCss = (g) => `translate(${g.x - g.a.x}px, ${g.y - g.a.y}px) rotate(${g.rot}deg) scale(${g.sc})`;
function pileCardSize() { // how big a card is on the pile right now (trick games use smaller cards)
  const pile = $("discardPile");
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;left:0;top:0";
  const card = cardEl("1-S-0");
  if (isBondi() || isDhiha()) { const slot = Object.assign(document.createElement("div"), { className: "trick-slot" }); slot.append(card); probe.append(slot); }
  else probe.append(card);
  pile.append(probe);
  const w = card.offsetWidth || 80, h = card.offsetHeight || 115;
  probe.remove();
  return { w, h };
}
function glideBack(g) {
  const el = document.querySelector(`#hand .card[data-id="${CSS.escape(g.id)}"]`) || g.el;
  const r = el?.isConnected ? el.getBoundingClientRect() : null;
  const to = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : g.a;
  const from = glideCss(g);
  Object.assign(g, { x: to.x, y: to.y, sc: 1, rot: g.rot0 });
  glideTurn(g, false);
  const anim = g.clone.animate([{ transform: from }, { transform: glideCss(g) }], { duration: 280, easing: "cubic-bezier(.3,1.2,.5,1)", fill: "forwards" });
  anim.onfinish = () => { g.clone.remove(); document.querySelectorAll(`#hand .card[data-id="${CSS.escape(g.id)}"]`).forEach((e) => e.classList.remove("glide-src")); };
}
// the real throw went out: land the same card on the pile, smoothly
function finishGlide(id) {
  const g = glideFor.get(id);
  if (!g) return false;
  glideFor.delete(id);
  arriving.add(id);
  setTimeout(() => landed(id), 1500); // safety: never stay hidden
  const go = () => {
    const t = document.querySelector(`#discardPile .card[data-id="${CSS.escape(id)}"]`);
    if (t) t.classList.add("arriving");
    const b = (t || $("discardPile")).getBoundingClientRect(), w = t?.offsetWidth || g.w0 * g.sc;
    const rot = +(((t?.style.getPropertyValue("--t") || "").match(/rotate\((-?[\d.]+)deg/) || [])[1] || 0);
    const from = glideCss(g);
    glideTurn(g, false); // time's up: it turns face up as it lands
    Object.assign(g, { x: b.left + b.width / 2, y: b.top + b.height / 2, sc: w / g.w0, rot });
    const anim = g.clone.animate([{ transform: from }, { transform: glideCss(g) }], { duration: 260, easing: "cubic-bezier(.3,.9,.4,1)", fill: "forwards" });
    anim.onfinish = () => { landed(id); g.clone.remove(); };
  };
  setTimeout(go, 30); // the pile draws the card first, then we know exactly where it lands
  return true;
}
function cancelPendingThrow(silent) {
  if (!pendingThrow) return;
  clearTimeout(pendingThrow.timer); pendingThrow.run = false;
  pendingThrow.ui.remove();
  const gl = pendingThrow.glides || [];
  pendingThrow = null;
  gl.forEach((g) => { glideFor.delete(g.id); glideBack(g); }); // taken back: home into the hand
  if (!silent) { toast("↩ Taken back"); setTimeout(() => { try { render(); } catch {} }, 320); }
}
function throwCard(cardIds, timedOut = false) {
  const ids = Array.isArray(cardIds) ? cardIds : [cardIds];
  if (timedOut) { cancelPendingThrow(true); return doThrowCard(ids, true); }
  if (pendingThrow) return; // one throw at a time
  if (throwProblem(ids)) return doThrowCard(ids, false);
  if (gameOf(room) === "digu" && C.findWinningLayout(hand.filter((c) => !ids.includes(c)))) return doThrowCard(ids, false); // DIGU! slam it down
  const key = `${roomId}|${room.round}|${room.moveId || 0}`;
  const ui = Object.assign(document.createElement("button"), { type: "button", className: "undo-throw" });
  ui.innerHTML = '<span>↩ Take back</span><i></i>';
  ui.onclick = (e) => { e.stopPropagation(); cancelPendingThrow(); };
  document.body.append(ui);
  const pile = $("discardPile").getBoundingClientRect();
  const goal = { x: pile.left + pile.width / 2, y: pile.top + pile.height / 2 };
  const size = pileCardSize();
  const glides = ids.map((id) => glideStart(id)).filter(Boolean);
  const t0 = performance.now();
  const drift = () => {
    if (!pendingThrow || !pendingThrow.run) return;
    // a normal throw towards the middle, face down, slowly enough to take it back
    const f = Math.min(1, (performance.now() - t0) / UNDO_MS);
    const u = 0.85 * (0.55 * f + 0.45 * f * f); // keeps moving the whole time, a touch faster at the end
    glides.forEach((g, k) => {
      const dx = goal.x - g.a.x, dy = goal.y - g.a.y, len = Math.hypot(dx, dy) || 1;
      const side = g.a.x < innerWidth / 2 ? -1 : 1;
      const cx = g.a.x + dx * 0.5 + side * len * 0.12, cy = g.a.y + dy * 0.5 - 30; // a normal throw: a gentle arc
      g.x = (1 - u) * (1 - u) * g.a.x + 2 * (1 - u) * u * cx + u * u * goal.x + k * 6;
      const half = (g.w0 * Math.max(1, g.sc)) / 2 + 8; // never off the edge of the screen
      g.x = Math.max(half, Math.min(innerWidth - half, g.x));
      g.y = (1 - u) * (1 - u) * g.a.y + 2 * (1 - u) * u * cy + u * u * goal.y;
      g.sc = 1 + (size.w / g.w0 - 1) * u;
      g.rot = g.rot0 * (1 - u);
      g.clone.style.transform = glideCss(g);
      // the hand can redraw meanwhile: keep the real card hidden
      document.querySelectorAll(`#hand .card[data-id="${CSS.escape(g.id)}"]`).forEach((e) => e.classList.add("glide-src"));
    });
    requestAnimationFrame(drift);
  };
  pendingThrow = {
    ids, ui, run: true, glides,
    timer: setTimeout(() => {
      const p = pendingThrow;
      clearTimeout(p.timer); p.run = false; p.ui.remove(); pendingThrow = null;
      const same = room && `${roomId}|${room.round}|${room.moveId || 0}` === key;
      if (same) {
        p.glides.forEach((g) => glideFor.set(g.id, g));
        doThrowCard(ids, false); // the pile picks up the gliding card (see previewThrow)
      }
      // anything that didn't go (the table moved on, or the throw was refused): back into the hand
      p.glides.forEach((g) => { if (glideFor.get(g.id) === g) { glideFor.delete(g.id); glideBack(g); } });
    }, UNDO_MS),
  };
  requestAnimationFrame(drift);
}
function doThrowCard(cardIds, timedOut = false) {
  if (shuffling() && !timedOut) return toast("🎩 Wait: the new middle pile is being shuffled");
  if (needsDrawFirst()) return takeFirstHint();
  const ids = Array.isArray(cardIds) ? cardIds : [cardIds];
  if (!canThrow() || !ids.length || !ids.every((c) => hand.includes(c))) return;
  if (isBondi()) return bondiThrow(ids[0], timedOut);
  if (isDhiha()) return dhihaThrow(ids[0], timedOut);
  const call = isCall();
  if (call ? !C.canThrowTogether(ids) : ids.length !== 1) return toast("Only cards of the same number can be thrown together");
  if (!call && takenNow(uid) && ids.includes(takenNow(uid))) return toast("You can't throw back the card you just took · throw another card");
  if (call) return callThrow(ids, timedOut);
  const rest = hand.filter((c) => !ids.includes(c));
  const sets = call ? null : C.findWinningLayout(rest);
  if (!claimAction()) return;
  const upd = { discard: [...room.discard, ...ids], ...trackUpd(uid, "threw", ids) };
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
  const b = moveBatch();
  b.update(handRef(), { cards: rest });
  b.update(roomRef(), upd);
  if (!sets) previewThrow(ids); // a DIGU card is slapped down instead
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
  const b = moveBatch();
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
  return order.find((c) => c !== takenNow(uid) && C.findWinningLayout(hand.filter((x) => x !== c))) || null;
}

function onDigu() {
  if (!isMyTurn()) return;
  if (room.phase === "draw") {
    const sets = C.findWinningLayout(hand);
    if (!sets) return toast("Your hand isn't 3 + 3 + 4 sets yet");
    if (!claimAction()) return;
    const b = moveBatch();
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
  const chip = seatEl(fromUid);
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
  if (isBabbush()) return bbAuto();
  if (isDhiha()) { if (hand.length) throwCard(C.dhihaAutoCard(hand, room.trick || [], room.hukum), true); return; }
  if (isBondi()) { // out of time: play the card the computer would
    if (!pendingPickup() && hand.length) throwCard(C.bondiBotCard(hand, room.trick || [], bondiCtx(room, uid)), true);
    return;
  }
  if (isCall()) { // out of time: throw the highest card if not thrown yet, then take from the middle pile
    if (room.phase === "throw") {
      throwCard([hand.reduce((a, b) => (C.callValue(b) > C.callValue(a) ? b : a))], true);
      setTimeout(() => { if (canDraw()) draw("deck"); }, 600);
    } else draw("deck");
    return;
  }
  if (room.phase === "draw") {
    if (!claimAction()) return;
    const b = moveBatch();
    b.update(roomRef(), nextTurn(`${nameOf(uid)} ran out of time`));
    return commit(b, "turn");
  }
  if (isCall()) { // throw the highest card
    return throwCard([hand.reduce((a, b) => (C.callValue(b) > C.callValue(a) ? b : a))], true);
  }
  let card = diguThrow();
  if (!card) card = hand.includes(lastDrawn) && lastDrawn !== takenNow(uid) ? lastDrawn : worstCard();
  throwCard(card, true);
}

function worstCard() {
  const { leftover } = C.bestLayout(hand);
  const ban = takenNow(uid);
  let pool = (leftover.length ? leftover : hand).filter((c) => c !== ban);
  if (!pool.length) pool = hand.filter((c) => c !== ban);
  return pool.reduce((a, b) => (C.points(b) > C.points(a) ? b : a));
}

async function skipOfflinePlayer() {
  const { round } = room, moveId = room.moveId || 0;
  try {
    let skipped = false;
    await runTransaction(db, async (tx) => {
      const r = (await tx.get(roomRef())).data();
      if (r.status !== "playing" || r.paused || r.round !== round || (r.moveId || 0) !== moveId) return; // already moved on
      const who = r.playerIds[r.turn];
      const away = isOffline(r, who, roomId) || silentFor(who) > 30_000;
      const missed = (r.missed?.[who] || 0) + (away ? 1 : 0);
      // holhuashi: the 2nd time an offline player misses their turn, the owner decides: remove or keep
      const ask = isLoungeDoc(r) && away && !r.keepOffline?.[who] && !r.offlineAsk && (missed >= 2 || r.game === "dhiha")
        ? { offlineAsk: { uid: who, at: Date.now() } } : {};
      if (r.game === "dhiha") { // a team game can't skip anyone: ask the owner (or, outside holhuashis, wait)
        if (ask.offlineAsk) { tx.update(roomRef(), ask); skipped = true; }
        return;
      }
      const extra = { ...(away ? { [`missed.${who}`]: missed } : {}), ...ask };
      if (r.game === "bondi") { // passed over for the rest of this trick
        tx.update(roomRef(), { ...bondiUpdate(r, C.bondiSkip(bondiState(r), who), who, null), ...extra });
        skipped = true;
        return;
      }
      if (r.game === "babbush") { tx.update(roomRef(), { ...bbSkipUpd(r), ...extra }); skipped = true; return; }
      const call = r.game === "call";
      tx.update(roomRef(), {
        ...extra,
        turn: nextActiveIdx(r, r.turn),
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

// 🤔 over a player who has been taking a while on their turn
const THINK_MS = 12_000;
const THINK_GIF = "https://fonts.gstatic.com/s/e/notoemoji/latest/1f914/";
// load it early so it's ready the moment someone starts thinking
try { new Image().src = THINK_GIF + "512.webp"; } catch {}
function showThinking(u) {
  const el = u && u !== uid ? seatEl(u) : null;
  document.querySelectorAll(".think-bubble").forEach((b) => { if (b.parentElement !== el) b.remove(); });
  if (el && !el.querySelector(".think-bubble")) {
    // Google's animated Noto emoji (free to use, CC BY 4.0); plain 🤔 if it can't load
    const b = Object.assign(document.createElement("span"), { className: "think-bubble", title: "Thinking…" });
    b.innerHTML = '<i class="tb-dot d1"></i><i class="tb-dot d2"></i><i class="tb-dot d3"></i>';
    const img = Object.assign(new Image(), { className: "tb-emoji", alt: "🤔", src: THINK_GIF + "512.webp" });
    img.onerror = () => { if (img.src.endsWith(".webp")) img.src = THINK_GIF + "512.gif"; else img.replaceWith(Object.assign(document.createElement("span"), { className: "tb-emoji tb-text", textContent: "🤔" })); };
    b.prepend(img);
    el.append(b);
  }
}
function tick() {
  if (room) renderPremiumPanel(); // cheap: only redraws when something changed (e.g. a card was selected)
  const box = $("timer");
  if (!room || room.status !== "playing") { box.hidden = true; turnKey = null; $("deckRing").hidden = true; drawTurnArrow(0); showThinking(null); renderPause(); return; }
  renderPause();
  if (room.paused) {
    drawTurnArrow(0); showThinking(null);
    box.hidden = false; turnKey = null;
    $("timerText").textContent = "⏸ Paused";
    $("timerBar").style.transform = "scaleX(1)";
    box.classList.remove("low", "mine");
    return;
  }
  const key = `${room.round}-${room.moveId || 0}`;
  if (key !== turnKey) { turnKey = key; turnSeenAt = Date.now(); }
  if (shuffling()) turnSeenAt = Math.max(turnSeenAt, Date.now() - 1); // the clock waits for the shuffle
  const left = TURN_MS - (Date.now() - turnSeenAt);
  const secs = Math.max(0, Math.ceil(left / 1000));
  box.hidden = false;
  $("timerText").textContent = isMyTurn() ? `${secs}s left` : `${nameOf(room.playerIds[room.turn])} · ${secs}s`;
  $("timerBar").style.transform = `scaleX(${Math.max(0, left / TURN_MS)})`;
  box.classList.toggle("low", secs <= 10);
  box.classList.toggle("mine", isMyTurn());
  const col = turnColour(left / TURN_MS);
  const frac = Math.max(0, Math.min(1, left / TURN_MS));
  for (const el of [$("seats"), box, $("table")]) { el.style.setProperty("--tc", col.solid); el.style.setProperty("--tcs", col.soft); el.style.setProperty("--tcf", col.faint); }
  // the countdown: an arrow from the player whose turn it is to the next player, filling up as time runs
  $("deckRing").hidden = true;
  const tp = document.querySelector(".seat-path.turn");
  if (tp) { tp.style.strokeDasharray = "none"; tp.style.strokeDashoffset = "0"; }
  drawTurnArrow(1 - frac, secs <= 10 ? "#ff2a3c" : "#3b9cff", secs <= 10);
  showThinking(Date.now() - turnSeenAt > THINK_MS && !shuffling() ? room.playerIds[room.turn] : null);
  const st = document.querySelector(".seat-tag.turn .st-time");
  if (st) st.textContent = `${secs}s`;
  const chipTime = document.querySelector(".player.active .ptime");
  if (chipTime) chipTime.textContent = `${secs}s`;

  if (isMyTurn()) remindMe(key, secs);

  if (timeoutFired === key) return;
  if (roomStale) return; // wait for the current table before acting on timeouts
  if (isMyTurn() && left <= 0) { if (pendingMoves.length) return; timeoutFired = key; autoPlay(); } // my move is still on its way: don't play for me
  else if (!isMyTurn() && left <= -GRACE_MS - (room.slow?.[room.playerIds[room.turn]] ? 20_000 : 0)) { // a slow connection gets 20 s more
    timeoutFired = key; skipOfflinePlayer(); // their time ran out (they're offline or away): next player
  }
}
setInterval(tick, 200);

// If I was skipped after drawing, I still hold 11 cards: go straight to throwing one away.
function afterUpdate() {
  // DIGU: my turn shows "throw" but I only hold 10 cards (my move and a skip crossed): back to "take"
  if (gameOf(room) === "digu" && isMyTurn() && room.phase === "discard" && hand.length === C.HAND_SIZE && handLoaded && roomConfirmed && claimAction()) {
    const b = moveBatch();
    b.update(roomRef(), { phase: "draw", log: `${nameOf(uid)}: take a card` });
    commit(b);
    return;
  }
  if (!isCall() && isMyTurn() && room.phase === "draw" && hand.length > C.HAND_SIZE && claimAction()) {
    const b = moveBatch();
    b.update(roomRef(), { phase: "discard" });
    commit(b);
  }
}

// ---------- reminders ----------
// A bouncing emoji with a short message just above my cards.
function nudge(emoji, text, sub = "", warn = false) {
  document.querySelector(".nudge")?.remove();
  const n = document.createElement("div");
  n.className = "nudge" + (warn ? " warn" : "");
  n.innerHTML = `<span class="nudge-emoji"></span><span class="nudge-text"><b></b><small></small></span>`;
  n.querySelector(".nudge-emoji").textContent = emoji;
  n.querySelector("b").textContent = text;
  n.querySelector("small").textContent = sub;
  const h = $("hand").getBoundingClientRect();
  n.style.top = Math.max(60, h.top - 16) + "px";
  document.body.append(n);
  try { navigator.vibrate?.(60); } catch {}
  setTimeout(() => n.remove(), 3200);
}

// What should I be doing right now?
function whatToDo() {
  if (isDhiha()) {
    const t = room.trick || [];
    if (!t.length) return ["Play a card!", "you lead · any card"];
    const s = C.suitOf(t[0].card);
    return hand.some((c) => C.suitOf(c) === s) ? [`Play a ${C.SUIT_SYMBOL[s]} card!`, "follow the suit"]
      : room.hukum ? [`No ${C.SUIT_SYMBOL[s]}? Play Hukum ${C.SUIT_SYMBOL[room.hukum]} to win it`, "or any other card"] : ["Choose the Hukum!", "the card you play sets it"];
  }
  if (isBondi()) {
    const t = room.trick || [];
    if (!t.length) return ["Play a card!", "you lead · any card"];
    const s = C.suitOf(t[0].card);
    return hand.some((c) => C.suitOf(c) === s) ? [`Play a ${C.SUIT_SYMBOL[s]} card!`, "follow the suit"] : ["Cut with any card!", `no ${C.SUIT_SYMBOL[s]} left`];
  }
  if (isCall()) return room.phase === "throw"
    ? [canCall() ? "Throw a card or CALL!" : "Throw a card first!", "tap a card, then tap it again"]
    : ["Now take a card!", "the last thrown card or the middle pile"];
  return room.phase === "draw"
    ? ["Take a card!", "from the middle pile or the last thrown card"]
    : ["Throw a card away!", "tap a card, then tap it again"];
}

let remindKey = null;
function remindMe(key, secs) {
  if (remindKey?.key !== key) remindKey = { key, done: new Set(), phase: room.phase, since: Date.now() };
  if (remindKey.phase !== room.phase) Object.assign(remindKey, { phase: room.phase, since: Date.now() });
  const idle = (Date.now() - remindKey.since) / 1000;
  // 🤔 after 20 seconds of doing nothing (once per step); ⏰ with 10 seconds left (once per turn)
  const at = secs <= 10 ? "hurry" : idle >= 20 ? "think-" + room.phase : null;
  if (!at || remindKey.done.has(at)) return;
  remindKey.done.add(at);
  const [text, sub] = whatToDo();
  if (at === "hurry") nudge("⏰", `Hurry! ${secs}s left`, text, true);
  else nudge("🤔", text, sub);
}

// ---------- results & scoring ----------
// DIGU caller: +100 bonus + their card values. Others: cards in sets minus leftover cards,
// or -100 if they have no set at all. First to the target ends the game; highest total wins.
async function saveScores() {
  const rows = lastRows;
  // only ever save the results worked out for THIS round (never the previous round's)
  if (!rows || !room || room.status !== "ended" || rows.round !== room.round) return;
  // the host adds this round's points to the running totals, once, and checks for game over.
  // If the host has gone offline, any player still here does it instead (so scores are never lost).
  if (!room.scored && (room.host === uid || isOffline(room, room.host, roomId))) {
    try {
      await runTransaction(db, async (tx) => {
        const r = (await tx.get(roomRef())).data();
        if (r.scored || r.round !== resultsRound || rows.round !== r.round) return;
        const upd = { scored: true };
        const totals = {};
        rows.forEach((row) => {
          if (row.pts) upd[`scores.${row.uid}`] = increment(row.pts); // 0 points: nothing added
          totals[row.uid] = (r.scores?.[row.uid] || 0) + (row.pts || 0);
        });
        if (callElim(r)) { // CALL to a target: reaching it puts you out
          const target = r.target || DEFAULT_TARGET;
          const gone = r.playerIds.filter((u) => totals[u] >= target && !(r.eliminated || []).includes(u));
          if (gone.length) { upd.eliminated = arrayUnion(...gone); gone.forEach((u) => (upd[`outRound.${u}`] = r.round)); upd.log = `${gone.map((u) => r.players.find((p) => p.uid === u)?.name || "?").join(" & ")} reached ${target} and ${gone.length > 1 ? "are" : "is"} out`; }
        }
        if (gameOf(r) === "digu" && r.winner && r.playerIds.includes(r.winner)) upd[`digus.${r.winner}`] = increment(1); // ⭐ DIGU calls this game
        const fun = noPoints(r); // played with the computer: no holhuashi points
        if (isLoungeDoc(r) && !fun) { upd["stats.rounds"] = increment(1); upd["stats.lastPlayed"] = serverTimestamp(); }
        if (gameFinished(r, totals)) {
          const top = (lowWins(gameOf(r)) ? Math.min : Math.max)(...Object.values(totals)); // CALL, BONDI: lowest wins
          upd.gameOver = true;
          if (isLoungeDoc(r) && !fun) {
            upd["stats.games"] = increment(1);
            // the holhuashi leaderboard: +1 game for everyone who played, +1 win for the winner(s)
            const champs = Object.keys(totals).filter((u) => totals[u] === top);
            for (const p of r.players) {
              if (isBot(p.uid)) continue;
              upd[`board.${p.uid}.name`] = p.name;
              upd[`board.${p.uid}.avatar`] = p.avatar || null;
              upd[`board.${p.uid}.games`] = increment(1);
              if (champs.includes(p.uid)) upd[`board.${p.uid}.wins`] = increment(1);
            }
          }
          upd.champions = Object.keys(totals).filter((u) => totals[u] === top);
          if (isLoungeDoc(r) && !fun) {
            upd.lastGame = {
              game: gameOf(r), at: Date.now(), champions: upd.champions, low: lowWins(gameOf(r)),
              results: r.players.filter((p) => !isBot(p.uid)).map((p) => ({ uid: p.uid, name: p.name, avatar: p.avatar || null, total: totals[p.uid] ?? 0 })),
            };
          }
        }
        tx.update(roomRef(), upd);
      });
    } catch (e) { toast(errMsg(e)); }
  }
}

async function showResults() {
  if (!room || room.status !== "ended") return;
  let snaps;
  try { snaps = await getDocs(collection(db, "rooms", roomId, "hands")); }
  catch (e) { return toast(errMsg(e)); }
  const hands = {};
  snaps.forEach((s) => (hands[s.id] = s.data().cards));

  if (gameOf(room) === "dhiha") {
    const res = room.dhihaResult || C.dhihaResult(room.decks || { A: [], B: [] });
    lastRows = room.players.map((p) => {
      const team = room.teams?.[p.uid];
      const won = team === res.team;
      const decks = (room.decks?.[team] || []).map((d) => d.split(","));
      return { ...p, dhiha: true, team, won, pts: won ? res.points : 0,
        tens: res.tens?.[team] ?? 0, deckCount: res.count?.[team] ?? decks.length,
        sets: decks.filter((d) => d.some((c) => C.parse(c).r === 10)), leftover: [] };
    });
    lastRows.dhiha = res;
  } else if (gameOf(room) === "bondi") {
    const order = room.order || [];
    const sc = C.bondiScores(order);
    lastRows = room.players.map((p) => {
      const held = hands[p.uid] || [];
      const left = [...held, ...pickList(p.uid).filter((c) => !held.includes(c))];
      const place = order.indexOf(p.uid) + 1;
      return { ...p, pts: sc[p.uid] ?? order.length * C.BONDI_STEP, bondi: true, place: place || order.length + 1,
        last: !place || place === order.length, sets: left.length ? [C.sortBondi(left)] : [], leftover: [] };
    });
  } else if (gameOf(room) === "babbush") {
    const rows = room.bb?.rows || {};
    const cs = C.babbushScores(Object.fromEntries(room.playerIds.map((u) => [u, rows[u] || []])), room.winner);
    lastRows = room.players.map((p) => ({ ...p, ...cs.result[p.uid], call: true, bb: true, sets: (rows[p.uid] || []).length ? [rows[p.uid]] : [], leftover: [] }));
    lastRows.caught = cs.caught;
    lastRows.catchers = cs.catchers;
  } else if (gameOf(room) === "call") {
    // players already out before this round (not the ones this round's points just put out)
    const out = outOf(room).filter((u) => (room.outRound?.[u] ?? -1) < room.round);
    const cs = C.callScores(Object.fromEntries(room.players.filter((p) => !out.includes(p.uid)).map((p) => [p.uid, hands[p.uid] || []])), room.winner);
    lastRows = room.players.map((p) => (out.includes(p.uid)
      ? { ...p, pts: 0, count: 0, how: "out", call: true, out: true, sets: [], leftover: [] }
      : { ...p, ...cs.result[p.uid], call: true, sets: hands[p.uid]?.length ? [C.sortByRank(hands[p.uid])] : [], leftover: [] }));
    lastRows.caught = cs.caught;
    lastRows.catchers = cs.catchers;
  } else {
    lastRows = room.players.map((p) => {
      const winnerSets = p.uid === room.winner ? room.winnerSets.map((s) => s.split(",")) : null;
      return { ...p, ...C.roundScore(hands[p.uid] || [], winnerSets) };
    });
  }
  lastRows.round = room.round; // these results belong to this round only
  const rows = lastRows;
  const mine = rows.find((r) => r.uid === uid);
  if (!mine?.out) recordRound(mine);

  await saveScores();
  renderResults();
  $("results").hidden = false;
}

function renderResults() {
  if (!lastRows || !room) return;
  const target = room.target || DEFAULT_TARGET;
  // until the host has saved this round, show totals with this round added
  const totalOf = (u) => (room.scores?.[u] || 0) + (room.scored ? 0 : lastRows.find((r) => r.uid === u)?.pts || 0);
  const totals = Object.fromEntries(lastRows.map((r) => [r.uid, totalOf(r.uid)]));
  const low = lowWins(gameOf(room));
  const top = (low ? Math.min : Math.max)(...Object.values(totals));
  const rounds = roundsTotal(room);
  const over = room.gameOver || gameFinished(room, totals);
  const champs = room.champions || Object.keys(totals).filter((u) => totals[u] === top);
  if (room.gameOver) recordWin();

  const list = $("resultsList");
  list.innerHTML = "";
  [...lastRows].sort((a, b) => (low ? a.pts - b.pts : b.pts - a.pts)).forEach((row) => {
    const div = document.createElement("div");
    const good = row.dhiha ? row.won : low ? row.pts === 0 || row.how === "caught-caller" : row.uid === room.winner;
    const bad = low ? row.how === "caught" || row.how === "penalty" || (row.bondi && row.last && row.pts > 0) : row.pts < 0;
    div.className = "result-row" + (good ? " winner" : "") + (bad ? " negative" : "");
    const head = document.createElement("div");
    head.className = "result-head";
    const name = document.createElement("strong");
    name.textContent = row.name + (row.uid === uid ? " (you)" : "") + (row.thousand ? " · 💯 1000 DIGU!" : row.digu ? " · DIGU" : "") + (row.bondi && row.place === 1 ? " · 🏆" : "")
      + (row.how === "won" || row.how === "caught" ? (row.bb ? " · BABUSH" : " · CALL") : "");
    const pts = document.createElement("span");
    pts.className = "round-pts";
    pts.textContent = (row.pts > 0 ? "+" : "") + row.pts;
    const who = room.players.find((p) => p.uid === row.uid) || row;
    head.append(avatarEl(who, "avatar small"), name, pts);
    const how = document.createElement("div");
    how.className = "breakdown";
    how.textContent = row.dhiha
      ? `${teamName(row.team)} · 🔟 ${row.tens} · ${row.deckCount} decks${row.won ? ` · ${{ all4: "all four 10s", tens: "3 tens", decks: "7+ decks" }[lastRows.dhiha?.how] || ""}` : ""}`
      : row.bondi
      ? (row.place === 1 ? "🏆 Out first · round winner"
        : row.last ? `Loser · ${row.sets[0]?.length ? `left holding ${row.sets[0].length} cards` : "out last"}`
        : `${ordinal(row.place)} out`)
      : row.call
      ? ({ won: `Called with ${row.count} · lowest`, caught: `Called with ${row.count} · caught! +${row.bb ? C.BB_PENALTY : C.CALL_PENALTY}`,
           "caught-caller": `Count ${row.count} · ${row.bb ? "lower than the caller" : "caught the CALL"}`, count: `Count ${row.count}`,
           penalty: `Count ${row.count} · +${C.CALL_PENALTY} (the CALL was caught)`, out: `❌ Out · reached ${room.target || DEFAULT_TARGET}` })[row.how]
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
    : isDhiha()
      ? `🏆 ${teamName(lastRows.dhiha?.team)} wins the round! +${lastRows.dhiha?.points} point${lastRows.dhiha?.points > 1 ? "s" : ""} each`
    : isBondi()
      ? `🏆 ${room.winner === uid ? "You" : nameOf(room.winner)} went out first and ${room.winner === uid ? "win" : "wins"} the round!`
    : low
      ? (lastRows.caught
        ? `${nameOf(room.winner)} called ${isBabbush() ? "BABUSH" : "CALL"}, but ${lastRows.catchers.map(nameOf).join(" & ")} had less!`
        : `${nameOf(room.winner)} called ${isBabbush() ? "BABUSH" : "CALL"} and won the round!`)
      : `${nameOf(room.winner)} called DIGU!`;
  const boardNote = isLoungeDoc(room) && hasBots(room) ? " · 🤖 played with the computer: no points"
    : over && isLoungeDoc(room) && !room.practice
    ? ` · 🏆 +1 holhuashi point to ${champs.map((u) => (u === uid ? "you" : nameOf(u))).join(" & ")}` : "";
  $("resultsSub").textContent = rounds
    ? (over ? `Final score ${top} after ${rounds} rounds` : `Round ${room.gameRound || 1} of ${rounds} · leader has ${top}${isBondi() ? " · points count against you, lowest total wins" : low ? " (lowest wins)" : ""}`)
    : (over ? `Final score ${top} · playing to ${target}` : `Playing to ${target} · leader has ${top}`);
  if (boardNote) $("resultsSub").textContent += boardNote;
  $("results").classList.toggle("game-over", over);
  const host = room.host === uid;
  const hostGone = !host && isOffline(room, room.host, roomId);
  $("nextRoundBtn").hidden = !(host || hostGone) || over;
  const lobbyTable = isLobbyRoom(room);
  $("playAgainBtn").hidden = !over || (!host && !lobbyTable) || !!room.tourney; // a tournament table plays one game
  $("resTourneyBtn").hidden = !room.tourney;
  $("playAgainBtn").textContent = lobbyTable ? "Back to the Aammu Jagaha" : "New game";
  $("waitNext").hidden = host || hostGone || (over && lobbyTable);
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
    let done = [];
    const ref = doc(db, "users", uid);
    const d = (await tx.get(ref)).data() || {};
    if (d.lastCounted === key) return;
    const upd = { gamesPlayed: (d.gamesPlayed || 0) + 1, lastCounted: key };
    if (reg && !noPoints(room)) { // games with the computer don't count toward rank
      // CALL is lowest-wins, so it earns career points for a low score: 0 pts = +50, 50 pts or more = 0
      // CALL / BONDI: a round never adds rank points (a 0 adds nothing); winning the whole game gives +50
      const earned = myRow.dhiha ? myRow.pts * 40 : myRow.call || myRow.bondi ? 0 : myRow.pts;
      upd.careerPoints = (d.careerPoints || 0) + earned;
      if (!myRow.call && !myRow.bondi && !myRow.dhiha) upd.bestRound = Math.max(d.bestRound || 0, myRow.pts);
      if (myRow.digu) upd.digus = (d.digus || 0) + 1;
      const bs = badgeStats(d, myRow, earned);
      Object.assign(upd, bs);
      done = bs._done;
    }
    tx.set(ref, upd, { merge: true });
    return done;
  }).then((done) => {
    for (const c of done || []) toast(`🎯 Challenge done: ${c.text} · +${c.reward} points!`);
  }).catch(() => { recordRound.done = null; });
}
// What this round adds to the badge stats and today's challenges (registered players, real games).
function badgeStats(d, row, earned) {
  const g = gameOf(room), out = {};
  const win = g === "digu" ? !!row.digu : g === "call" ? row.how === "won" || row.how === "caught-caller"
    : g === "bondi" ? row.place === 1 : !!row.won;
  out.played = { ...(d.played || {}), [g]: (d.played?.[g] || 0) + 1 };
  if (g === "call" && row.how === "won") { out.callWins = (d.callWins || 0) + 1; out.lowCall = Math.min(d.lowCall ?? 99, row.count ?? 99); }
  if (g === "call" && row.how === "caught-caller") out.catches = (d.catches || 0) + 1;
  if (g === "bondi" && row.place === 1) out.bondiFirst = (d.bondiFirst || 0) + 1;
  if (g === "dhiha" && row.won) {
    out.dhihaWins = (d.dhihaWins || 0) + 1;
    if (row.tens === 4) out.dhihaTens4 = (d.dhihaTens4 || 0) + 1;
    if (row.deckCount === 13) out.dhihaSweep = (d.dhihaSweep || 0) + 1;
  }
  out.streak = win ? (d.streak || 0) + 1 : 0;
  out.bestStreak = Math.max(d.bestStreak || 0, out.streak);
  const day = P.todayKey();
  if (d.lastDay !== day) { out.days = (d.days || 0) + 1; out.lastDay = day; }
  // today's challenges
  const daily = d.daily?.day === day ? { day, prog: { ...(d.daily.prog || {}) }, done: [...(d.daily.done || [])], games: [...(d.daily.games || [])] }
    : { day, prog: {}, done: [], games: [] };
  const ev = { game: g, win, digu: !!row.digu, pts: row.pts, callWin: row.how === "won", catch: row.how === "caught-caller",
    bondiFirst: g === "bondi" && row.place === 1, dhihaWin: g === "dhiha" && !!row.won, newGameToday: !daily.games.includes(g) };
  if (!daily.games.includes(g)) daily.games.push(g);
  const done = [];
  let bonus = 0;
  for (const c of P.dailyChallenges(day)) {
    if (daily.done.includes(c.id)) continue;
    daily.prog[c.id] = (daily.prog[c.id] || 0) + c.count(ev);
    if (daily.prog[c.id] >= c.goal) { daily.done.push(c.id); bonus += c.reward; done.push(c); }
  }
  out.daily = daily;
  if (bonus) { out.careerPoints = (d.careerPoints || 0) + earned + bonus; out.challengesDone = (d.challengesDone || 0) + done.length; }
  Object.defineProperty(out, "_done", { value: done, enumerable: false });
  return out;
}

function recordWin() {
  if (!uid || !isRegistered() || noPoints(room) || !room?.champions?.includes(uid)) return;
  const key = `${roomId}-${room.round}-win`;
  if (recordWin.done === key) return;
  recordWin.done = key;
  runTransaction(db, async (tx) => {
    const ref = doc(db, "users", uid);
    const d = (await tx.get(ref)).data() || {};
    if (d.lastWin === key) return;
    const bonus = 50; // every game won: +50 career points (CALL / BONDI: the lowest total wins)
    tx.set(ref, { gameWins: (d.gameWins || 0) + 1, lastWin: key, ...(bonus ? { careerPoints: (d.careerPoints || 0) + bonus } : {}) }, { merge: true });
  }).catch(() => { recordWin.done = null; });
}

// Today's 3 challenges with progress bars (profile, and on the home page for signed-in players).
function renderChallenges(box) {
  if (!box) return;
  const day = P.todayKey();
  const daily = profile.daily?.day === day ? profile.daily : { prog: {}, done: [] };
  box.innerHTML = "";
  if (box.id === "homeChallenges") box.append(Object.assign(document.createElement("b"), { className: "ch-head", textContent: "🎯 Today's challenges" }));
  for (const c of P.dailyChallenges(day)) {
    const done = (daily.done || []).includes(c.id), n = Math.min(c.goal, daily.prog?.[c.id] || 0);
    const row = document.createElement("div");
    row.className = "challenge" + (done ? " done" : "");
    row.innerHTML = `<span class="ch-icon"></span><div class="ch-body"><span class="ch-text"></span><div class="ch-bar"><i></i></div></div><small class="ch-rew"></small>`;
    row.querySelector(".ch-icon").textContent = done ? "✅" : c.icon;
    row.querySelector(".ch-text").textContent = `${c.text}${c.goal > 1 ? ` (${n}/${c.goal})` : ""}`;
    row.querySelector(".ch-bar i").style.width = `${(done ? 1 : n / c.goal) * 100}%`;
    row.querySelector(".ch-rew").textContent = done ? "Done" : `+${c.reward}`;
    box.append(row);
  }
  box.append(Object.assign(document.createElement("small"), { className: "muted ch-note", textContent: "New challenges every day · games against the computer don't count" }));
}

// ---------- accounts ----------
const isRegistered = () => !!auth.currentUser && !auth.currentUser.isAnonymous;
const myRank = () => (isRegistered() ? P.rankIndex(profile.careerPoints || 0) : 0);
const myPrefs = () => P.allowedPrefs(profile.prefs, myRank(), isRegistered(), isPremium() || amAdmin); // admins can try everything

// What other players see about me in the room.
function myEntry(name) {
  const reg = isRegistered();
  return {
    uid, name,
    avatar: reg ? (P.premiumAvatar(profile.avatar) && !isPremium() ? P.AVATARS[0] : profile.avatar || P.AVATARS[0]) : null,
    rank: reg ? myRank() : null,
    badges: reg ? P.earnedBadges(profile).length : 0,
    photoV: reg && hasPhoto() ? profile.photoV : null, // others load the picture from my profile
    prem: premiumPaid() || null,
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
        stampSeen(true);
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
  setScene(t.scene || null);
}

// 🏖️ / 🌧️ scenes: the screen becomes a beach (sea and waves at the top, white sand, the cards on a
// wooden table) or a rainy day (rain falling, lightning), each with its own sounds at the table.
let sceneNow = null;
function setScene(kind) {
  if (kind === sceneNow) return;
  sceneNow = kind;
  document.body.classList.remove("scene-beach", "scene-rain", "scene-pool", "scene-window");
  rainRun++; document.querySelectorAll("canvas.rainfront, canvas.tablerain").forEach((c) => c.remove());
  $("sceneFx")?.remove();
  if (kind) {
    document.body.classList.add("scene-" + kind);
    const fx = Object.assign(document.createElement("div"), { id: "sceneFx", className: "scene-fx " + kind });
    fx.innerHTML = kind === "beach"
      ? `<canvas class="shore"></canvas>
         <i class="bird b1"></i><i class="bird b2"></i><i class="bird b3"></i>
         <span class="shell s1">🐚</span><span class="shell s2">🐚</span><span class="shell s3">⭐</span><span class="palm">🌴</span>`
      : kind === "window"
      ? `<canvas class="indoor"></canvas>`
      : kind === "pool"
      ? `<div class="rays"></div><div class="caustics c1"></div><div class="caustics c2"></div>
         ${Array.from({ length: 14 }, (_, i) => `<i class="bubble" style="--x:${(i * 37) % 100}%;--d:${(i * 0.7) % 6}s;--s:${4 + (i * 3) % 9}px;--t:${5 + (i % 5)}s"></i>`).join("")}
         <span class="fish f1">🐠</span><span class="fish f2">🐟</span><span class="fish f3">🐡</span>
         <span class="weed w1">🌿</span><span class="weed w2">🌱</span><span class="weed w3">🪸</span><span class="weed w4">🌿</span><span class="star">⭐</span><span class="shell2">🐚</span>`
      : `<canvas class="rainback"></canvas><div class="flash"></div>`;
    document.body.prepend(fx);
    if (kind === "beach") startShore(fx.querySelector("canvas.shore"));
    if (kind === "rain") startRain(fx.querySelector("canvas.rainback"));
    if (kind === "window") startIndoor(fx.querySelector("canvas.indoor"));
  }
  syncMusic();
}

// 🌧️ Rain, drawn live in three layers: far away (clouds, faint rain, puddles with rings on the
// ground), on the table (drops splashing on the wet wood), and close up (long bright streaks and
// raindrops running down the glass in front of you). Lightning: a real bolt and a flash.
// 🏠 A rainy night, inside a house: a big window behind the table looks out on a small island street
// (a street light glowing in the rain, little houses with lit windows, palm trees, the sea). Rain
// runs down the glass; now and then lightning lights up everything outside. Inside: warm lamplight.
var indoorRun = 0, indoorBolt = () => {};
function startIndoor(cv) {
  const run = ++indoorRun;
  const c = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, last = 0, scene = null, win = null, flashAt = -1e9, lastFlash = performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const drops = [], streaks = [];
  function size() {
    dpr = Math.min(devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    // the window fills the wall above the card table (so the street light is never hidden)
    const tb = !$("game").hidden ? $("table")?.getBoundingClientRect() : null;
    const top = Math.max(22, H * 0.03), bottom = tb && tb.top > top + 90 ? tb.top - 22 : top + Math.min(H * 0.34, 300);
    const ww = Math.min(W * 0.92, 600), wh = Math.max(90, bottom - top);
    win = { x: (W - ww) / 2, y: top, w: ww, h: wh, k: tb ? Math.round(tb.top) : -1 };
    drawOutside();
    drops.length = 0; streaks.length = 0;
    for (let i = 0; i < 38; i++) drops.push({ x: Math.random(), y: Math.random(), r: rnd(1.2, 4.2), v: 0, still: rnd(0, 6000) });
    for (let i = 0; i < 120; i++) streaks.push({ x: Math.random(), y: Math.random(), l: rnd(6, 16), s: rnd(0.012, 0.022) });
  }
  // the view outside, drawn once: night sky, sea, the island street, houses, palms, the street light
  function drawOutside() {
    scene = document.createElement("canvas"); scene.width = win.w * dpr; scene.height = win.h * dpr;
    const g = scene.getContext("2d"); g.scale(dpr, dpr);
    const w = win.w, h = win.h;
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#070b14"); sky.addColorStop(0.55, "#121c2c"); sky.addColorStop(1, "#1a2433");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const moon = g.createRadialGradient(w * 0.78, h * 0.18, 0, w * 0.78, h * 0.18, h * 0.35); // moon behind the clouds
    moon.addColorStop(0, "rgba(160,180,210,.35)"); moon.addColorStop(1, "rgba(160,180,210,0)");
    g.fillStyle = moon; g.fillRect(0, 0, w, h);
    g.fillStyle = "#0c1420"; g.fillRect(0, h * 0.5, w, h * 0.12); // the sea
    g.strokeStyle = "rgba(140,170,210,.18)"; g.lineWidth = 1;
    for (let i = 0; i < 5; i++) { g.beginPath(); const y = h * (0.52 + i * 0.022); g.moveTo(w * rnd(0, 0.3), y); g.lineTo(w * rnd(0.5, 1), y); g.stroke(); }
    g.fillStyle = "#0a0f15"; // the island: the ground and the street
    g.beginPath(); g.moveTo(0, h * 0.62); g.quadraticCurveTo(w * 0.5, h * 0.57, w, h * 0.63); g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = "#161b22"; g.fillRect(0, h * 0.8, w, h * 0.2);
    const house = (x, bw, bh, lit) => {
      const y = h * 0.66;
      g.fillStyle = "#11161d"; g.fillRect(x, y - bh, bw, bh);
      g.beginPath(); g.moveTo(x - 4, y - bh); g.lineTo(x + bw / 2, y - bh - bh * 0.45); g.lineTo(x + bw + 4, y - bh); g.fill();
      for (const [lx, ly] of lit) {
        g.fillStyle = "#ffcf7a"; g.fillRect(x + lx * bw, y - bh + ly * bh, bw * 0.18, bh * 0.22);
        const gl = g.createRadialGradient(x + lx * bw + 4, y - bh + ly * bh + 4, 0, x + lx * bw + 4, y - bh + ly * bh + 4, 22);
        gl.addColorStop(0, "rgba(255,200,110,.25)"); gl.addColorStop(1, "rgba(255,200,110,0)");
        g.fillStyle = gl; g.fillRect(x + lx * bw - 20, y - bh + ly * bh - 20, 50, 50);
      }
    };
    house(w * 0.06, w * 0.16, h * 0.16, [[0.2, 0.35]]);
    house(w * 0.6, w * 0.2, h * 0.2, [[0.15, 0.3], [0.62, 0.3]]);
    house(w * 0.85, w * 0.13, h * 0.13, []);
    const palm = (x, s) => {
      g.strokeStyle = "#090d12"; g.lineWidth = 3 * s;
      g.beginPath(); g.moveTo(x, h * 0.68); g.quadraticCurveTo(x + 10 * s, h * 0.5, x + 4 * s, h * 0.34); g.stroke();
      g.fillStyle = "#090d12";
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k - 2.5) * 0.55, tx = x + 4 * s + Math.cos(a) * 34 * s, ty = h * 0.34 + Math.sin(a) * 18 * s + 10 * s;
        g.beginPath(); g.moveTo(x + 4 * s, h * 0.34); g.quadraticCurveTo((x + 4 * s + tx) / 2, ty - 14 * s, tx, ty); g.lineTo(tx - 3, ty + 3); g.closePath(); g.fill();
      }
    };
    palm(w * 0.33, 1); palm(w * 0.5, 0.75);
    // the street light: a post, its lamp, and a glow spreading in the wet air and on the road
    const lx = w * 0.43, ly = h * 0.42;
    g.strokeStyle = "#0b0f14"; g.lineWidth = 3; g.beginPath(); g.moveTo(lx, h * 0.84); g.lineTo(lx, ly); g.lineTo(lx + 14, ly); g.stroke();
    const glow = g.createRadialGradient(lx + 14, ly + 4, 0, lx + 14, ly + 4, h * 0.42);
    glow.addColorStop(0, "rgba(255,214,140,.55)"); glow.addColorStop(0.25, "rgba(255,190,100,.18)"); glow.addColorStop(1, "rgba(255,190,100,0)");
    g.fillStyle = glow; g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff1cf"; g.beginPath(); g.ellipse(lx + 14, ly + 4, 5, 3, 0, 0, 6.3); g.fill();
    const cone = g.createLinearGradient(0, ly, 0, h * 0.86); // light falling to the road
    cone.addColorStop(0, "rgba(255,210,140,.22)"); cone.addColorStop(1, "rgba(255,210,140,.04)");
    g.fillStyle = cone; g.beginPath(); g.moveTo(lx + 9, ly + 6); g.lineTo(lx + 19, ly + 6); g.lineTo(lx + 60, h * 0.86); g.lineTo(lx - 32, h * 0.86); g.fill();
    const refl = g.createLinearGradient(0, h * 0.84, 0, h); // its reflection in the puddles
    refl.addColorStop(0, "rgba(255,200,120,.35)"); refl.addColorStop(1, "rgba(255,200,120,0)");
    g.fillStyle = refl; g.fillRect(lx + 4, h * 0.84, 20, h * 0.16);
    scene._lamp = { x: lx + 14, y: ly + 4 };
  }
  size(); addEventListener("resize", size);
  indoorBolt = () => { flashAt = performance.now(); lastFlash = flashAt; thunderFlash(); };
  function frame(now) {
    if (run !== indoorRun || !cv.isConnected) return;
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return;
    const dt = Math.min(60, now - last) / 33; last = now;
    if (now - lastFlash > 30000 && Math.random() < 0.004) indoorBolt(); // lightning even with the sound off
    if (now - (frame.chk || 0) > 1000) { // the table moved (a new screen, a new game): fit the window again
      frame.chk = now;
      const tb = !$("game").hidden ? $("table")?.getBoundingClientRect() : null;
      if ((tb ? Math.round(tb.top) : -1) !== win.k) size();
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the room: a warm, dim wall and lamplight from the side
    const wall = c.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, "#2b1f17"); wall.addColorStop(1, "#160f0b");
    c.fillStyle = wall; c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,.025)";
    for (let x = 0; x < W; x += 22) c.fillRect(x, 0, 1, H); // wallpaper stripes
    const lamp = c.createRadialGradient(W * 0.08, H * 0.62, 0, W * 0.08, H * 0.62, Math.max(W, H) * 0.7);
    lamp.addColorStop(0, `rgba(255,170,80,${0.26 + Math.sin(now / 900) * 0.01})`); lamp.addColorStop(1, "rgba(255,170,80,0)");
    c.fillStyle = lamp; c.fillRect(0, 0, W, H);
    const { x: wx, y: wy, w: ww, h: wh } = win;
    // outside
    c.save(); c.beginPath(); c.rect(wx, wy, ww, wh); c.clip();
    c.drawImage(scene, wx, wy, ww, wh);
    const fa = now - flashAt; // lightning lights up the sky
    if (fa < 900) { const a = fa < 80 ? 0.7 : fa < 160 ? 0.1 : fa < 260 ? 0.5 : Math.max(0, 0.4 - (fa - 260) / 1600); c.fillStyle = `rgba(200,215,255,${a})`; c.fillRect(wx, wy, ww, wh); }
    c.strokeStyle = "rgba(170,190,220,.35)"; c.lineWidth = 1; // rain falling outside (brighter in the lamp's light)
    const lp = scene._lamp;
    for (const r of streaks) {
      r.y += r.s * dt; r.x += r.s * dt * 0.18; if (r.y > 1) { r.y = -0.05; r.x = Math.random(); }
      const x = wx + r.x * ww, y = wy + r.y * wh, near = Math.hypot(x - wx - lp.x, y - wy - lp.y) < wh * 0.3;
      c.strokeStyle = near ? "rgba(255,225,170,.7)" : "rgba(160,180,210,.28)";
      c.beginPath(); c.moveTo(x, y); c.lineTo(x - r.l * 0.18, y - r.l); c.stroke();
    }
    // drops on the glass
    for (const d of drops) {
      d.still -= 33 * dt;
      if (d.still < 0) { d.v = Math.min(2.5, d.v + 0.06 * dt); d.y += (d.v * dt) / wh * 2; }
      if (d.y > 1.02) Object.assign(d, { x: Math.random(), y: rnd(-0.05, 0.5), r: rnd(1.2, 4.2), v: 0, still: rnd(1500, 8000) });
      const x = wx + d.x * ww, y = wy + d.y * wh;
      if (d.v > 0.3) { const tg = c.createLinearGradient(x, y, x, y - 22); tg.addColorStop(0, "rgba(200,215,235,.25)"); tg.addColorStop(1, "rgba(200,215,235,0)"); c.strokeStyle = tg; c.lineWidth = d.r * 0.6; c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 22); c.stroke(); }
      const rg = c.createRadialGradient(x - d.r * 0.3, y - d.r * 0.3, 0, x, y, d.r);
      rg.addColorStop(0, "rgba(255,240,210,.7)"); rg.addColorStop(0.5, "rgba(150,170,200,.15)"); rg.addColorStop(1, "rgba(255,255,255,.3)");
      c.fillStyle = rg; c.beginPath(); c.arc(x, y, d.r, 0, 6.3); c.fill();
    }
    const fog = c.createLinearGradient(0, wy + wh * 0.6, 0, wy + wh); // misted glass at the bottom
    fog.addColorStop(0, "rgba(180,190,205,0)"); fog.addColorStop(1, "rgba(180,190,205,.12)");
    c.fillStyle = fog; c.fillRect(wx, wy, ww, wh);
    c.restore();
    // the window frame (wood) with its cross bars and the sill
    c.strokeStyle = "#5a3b22"; c.lineWidth = 10; c.strokeRect(wx, wy, ww, wh);
    c.strokeStyle = "#6b4528"; c.lineWidth = 6;
    c.beginPath(); c.moveTo(wx + ww / 2, wy); c.lineTo(wx + ww / 2, wy + wh); c.moveTo(wx, wy + wh * 0.45); c.lineTo(wx + ww, wy + wh * 0.45); c.stroke();
    c.strokeStyle = "rgba(255,190,120,.25)"; c.lineWidth = 1; c.strokeRect(wx + 5, wy + 5, ww - 10, wh - 10);
    c.fillStyle = "#4a2f1a"; c.fillRect(wx - 16, wy + wh + 3, ww + 32, 10);
    c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(wx - 16, wy + wh + 13, ww + 32, 6);
    // a little light from the street falling into the room under the window
    const spill = c.createLinearGradient(0, wy + wh, 0, wy + wh + H * 0.25);
    spill.addColorStop(0, "rgba(255,210,150,.07)"); spill.addColorStop(1, "rgba(255,210,150,0)");
    c.fillStyle = spill; c.fillRect(wx, wy + wh + 13, ww, H * 0.25);
  }
  requestAnimationFrame(frame);
}

var rainRun = 0, lastBolt = 0, rainBolt = () => {};
function startRain(back) {
  const run = ++rainRun;
  // the close-up layer sits in front of the cards (it never catches taps)
  document.querySelectorAll("canvas.rainfront").forEach((c) => c.remove());
  const front = Object.assign(document.createElement("canvas"), { className: "rainfront" });
  document.body.append(front);
  let W = 0, H = 0, dpr = 1, last = 0, wind = 0.22, windTo = 0.22, bolt = null;
  const bx = back.getContext("2d"), fx = front.getContext("2d");
  let tableCv = null, tx = null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  function size() {
    dpr = Math.min(devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight;
    for (const c of [back, front]) { c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px"; }
  }
  size(); addEventListener("resize", size);
  const n = Math.round(Math.min(420, (innerWidth * innerHeight) / 1500));
  const drop = (z) => ({ x: rnd(-0.2, 1.1), y: rnd(-0.2, 1), z, len: 10 + z * 30, sp: 0.9 + z * 1.8, a: 0.18 + z * 0.4 });
  const far = Array.from({ length: n }, () => drop(rnd(0, 0.45)));
  const near = Array.from({ length: Math.round(n / 5) }, () => drop(rnd(0.6, 1)));
  const splashes = [], rings = [];
  const glass = Array.from({ length: 22 }, () => ({ x: Math.random(), y: Math.random(), r: rnd(1.5, 5.5), v: 0, still: rnd(0, 6000) }));
  const clouds = Array.from({ length: 5 }, (_, i) => ({ x: i / 5, y: rnd(-0.04, 0.06), w: rnd(0.4, 0.7), h: rnd(0.08, 0.14), sp: rnd(0.004, 0.01) }));
  window.__bolt = () => rainBolt();
  rainBolt = () => { // also called by the thunder sound
    const x0 = rnd(0.15, 0.85) * W, pts = [[x0, 0]];
    let x = x0, y = 0;
    while (y < H * rnd(0.35, 0.55)) { y += rnd(14, 34); x += rnd(-22, 22); pts.push([x, y]); }
    bolt = { pts, at: performance.now() }; lastBolt = performance.now();
    thunderFlash();
  };
  function tableLayer() { // drops landing on the table, drawn under the cards
    const tb = $("table");
    if (!tb || $("game").hidden) return null;
    if (!tableCv || !tableCv.isConnected || tableCv.parentElement !== tb) {
      tableCv = Object.assign(document.createElement("canvas"), { className: "tablerain" });
      tb.prepend(tableCv); tx = tableCv.getContext("2d");
    }
    const w = tb.clientWidth, h = tb.clientHeight;
    if (tableCv.width !== Math.round(w * dpr) || tableCv.height !== Math.round(h * dpr)) {
      tableCv.width = Math.round(w * dpr); tableCv.height = Math.round(h * dpr); tableCv.style.width = w + "px"; tableCv.style.height = h + "px";
    }
    return { w, h };
  }
  const tSplash = [];
  function frame(now) {
    if (run !== rainRun || !back.isConnected) { front.remove(); tableCv?.remove(); return; }
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return;
    const dt = Math.min(60, now - last) / 16.7; last = now;
    if (Math.random() < 0.005) windTo = rnd(0.12, 0.38);
    wind += (windTo - wind) * 0.01;
    if (now - lastBolt > 26000 && Math.random() < 0.004) rainBolt(); // lightning even with the sound off
    // ---- far layer
    bx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bx.clearRect(0, 0, W, H);
    for (const c of clouds) { // dark clouds drifting along the top
      c.x += c.sp * dt * 0.016; if (c.x > 1.3) c.x = -0.7;
      const g = bx.createRadialGradient(c.x * W, c.y * H, 0, c.x * W, c.y * H, c.w * W);
      g.addColorStop(0, "rgba(20,26,34,.85)"); g.addColorStop(1, "rgba(20,26,34,0)");
      bx.fillStyle = g; bx.beginPath(); bx.ellipse(c.x * W, c.y * H, c.w * W, c.h * H * 2.4, 0, 0, 6.3); bx.fill();
    }
    bx.lineCap = "round";
    for (const d of far) {
      d.y += d.sp * dt * 0.012; d.x += d.sp * dt * 0.012 * wind;
      if (d.y > 1.05) {
        if (d.y * H > H * 0.55 && Math.random() < 0.5) rings.push({ x: d.x * W, y: H * rnd(0.6, 0.98), r: 1, a: 0.5 });
        Object.assign(d, drop(d.z), { y: rnd(-0.15, 0) });
      }
      bx.strokeStyle = `rgba(190,210,235,${d.a})`; bx.lineWidth = 0.6 + d.z * 1.2;
      bx.beginPath(); bx.moveTo(d.x * W, d.y * H); bx.lineTo(d.x * W - wind * d.len, d.y * H - d.len); bx.stroke();
    }
    for (let i = rings.length - 1; i >= 0; i--) { // rings spreading on the puddles
      const r = rings[i]; r.r += 0.7 * dt; r.a -= 0.018 * dt;
      if (r.a <= 0) { rings.splice(i, 1); continue; }
      bx.strokeStyle = `rgba(200,220,240,${r.a})`; bx.lineWidth = 1;
      bx.beginPath(); bx.ellipse(r.x, r.y, r.r * 2.2, r.r * 0.7, 0, 0, 6.3); bx.stroke();
    }
    if (rings.length > 60) rings.splice(0, rings.length - 60);
    // ---- on the table: splashes and little crowns of water
    const tl = tableLayer();
    if (tl && tx) {
      tx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tx.clearRect(0, 0, tl.w, tl.h);
      for (let k = 0; k < 2; k++) if (Math.random() < 0.55) tSplash.push({ x: Math.random() * tl.w, y: Math.random() * tl.h, t: 0 });
      for (let i = tSplash.length - 1; i >= 0; i--) {
        const sp = tSplash[i]; sp.t += dt;
        if (sp.t > 14) { tSplash.splice(i, 1); continue; }
        const a = 1 - sp.t / 14;
        tx.strokeStyle = `rgba(220,235,255,${0.5 * a})`; tx.lineWidth = 1;
        tx.beginPath(); tx.ellipse(sp.x, sp.y, 1 + sp.t * 1.1, 0.5 + sp.t * 0.45, 0, 0, 6.3); tx.stroke();
        if (sp.t < 6) { // the crown: droplets jumping up
          tx.fillStyle = `rgba(230,240,255,${0.7 * a})`;
          for (let j = 0; j < 4; j++) { const ang = (j / 4) * 6.28 + sp.x; tx.fillRect(sp.x + Math.cos(ang) * sp.t * 1.4, sp.y - sp.t * (2.4 - sp.t * 0.35) + Math.sin(ang) * 1.2, 1.4, 1.4); }
        }
      }
    }
    // ---- close-up layer: bright streaks and raindrops on the glass
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.clearRect(0, 0, W, H);
    fx.lineCap = "round";
    for (const d of near) {
      d.y += d.sp * dt * 0.014; d.x += d.sp * dt * 0.014 * wind;
      if (d.y > 1.1) Object.assign(d, drop(d.z), { y: rnd(-0.2, 0) });
      const gx = d.x * W, gy = d.y * H;
      const g = fx.createLinearGradient(gx, gy, gx - wind * d.len * 1.6, gy - d.len * 1.6);
      g.addColorStop(0, `rgba(230,240,255,${d.a * 0.55})`); g.addColorStop(1, "rgba(230,240,255,0)");
      fx.strokeStyle = g; fx.lineWidth = 1.2 + d.z;
      fx.beginPath(); fx.moveTo(gx, gy); fx.lineTo(gx - wind * d.len * 1.6, gy - d.len * 1.6); fx.stroke();
    }
    for (const g of glass) { // drops on the glass: sit still a while, then run down leaving a trail
      g.still -= 33;
      if (g.still < 0) { g.v = Math.min(3, g.v + 0.08 * dt); g.y += (g.v * dt) / H * 1.4; }
      if (g.y > 1.05) Object.assign(g, { x: Math.random(), y: rnd(-0.05, 0.6), r: rnd(1.5, 5.5), v: 0, still: rnd(1500, 7000) });
      const x = g.x * W, y = g.y * H;
      if (g.v > 0.3) { // a short wet trail behind a running drop, fading out
        const tl = Math.min(34, 9 * g.v + g.r * 2), tg = fx.createLinearGradient(x, y, x, y - tl);
        tg.addColorStop(0, "rgba(200,220,240,.22)"); tg.addColorStop(1, "rgba(200,220,240,0)");
        fx.strokeStyle = tg; fx.lineWidth = g.r * 0.6; fx.beginPath(); fx.moveTo(x, y - g.r * 0.6); fx.lineTo(x + Math.sin(y * 0.05) * 1.5, y - tl); fx.stroke();
      }
      const rg = fx.createRadialGradient(x - g.r * 0.3, y - g.r * 0.35, 0, x, y, g.r);
      rg.addColorStop(0, "rgba(255,255,255,.75)"); rg.addColorStop(0.35, "rgba(190,210,230,.18)"); rg.addColorStop(0.85, "rgba(40,55,70,.25)"); rg.addColorStop(1, "rgba(255,255,255,.35)");
      fx.fillStyle = rg; fx.beginPath(); fx.arc(x, y, g.r, 0, 6.3); fx.fill();
    }
    if (bolt) { // the lightning bolt, for a moment
      const age = now - bolt.at;
      if (age > 260) bolt = null;
      else {
        const a = age < 60 || (age > 120 && age < 170) ? 1 : 0.35;
        fx.strokeStyle = `rgba(235,245,255,${a})`; fx.lineWidth = 2.5; fx.shadowColor = "#cfe3ff"; fx.shadowBlur = 18;
        fx.beginPath(); bolt.pts.forEach(([x, y], i) => (i ? fx.lineTo(x, y) : fx.moveTo(x, y))); fx.stroke();
        fx.shadowBlur = 0;
      }
    }
  }
  requestAnimationFrame(frame);
}

// 🌊 The shoreline, drawn live: the sea at the top, and every few seconds a wave rushes up the sand,
// right under the card table, leaves the sand wet and slides back. Foam, little crests coming in,
// sparkles on the water. (Kept light: about 30 frames a second, paused when the app is hidden.)
var shoreRun = 0, shoreSwell = null;
function swellNow(up, down) { shoreSwell = { at: performance.now(), up: up * 1000, down: down * 1000 }; }
function startShore(cv) {
  const run = ++shoreRun;
  const ctx2 = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, sand = null, wetY = 0, wetAt = 0, last = 0;
  const sparkles = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6 }));
  const bubbles = Array.from({ length: 70 }, () => ({ x: Math.random(), o: Math.random(), r: 0.6 + Math.random() * 1.8 }));
  function size() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    // the sand, drawn once: warm white with fine grains
    sand = document.createElement("canvas"); sand.width = cv.width; sand.height = cv.height;
    const g = sand.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 0, sand.height);
    gr.addColorStop(0, "#efe3c4"); gr.addColorStop(0.5, "#f6eedb"); gr.addColorStop(1, "#ecdcb4");
    g.fillStyle = gr; g.fillRect(0, 0, sand.width, sand.height);
    for (let i = 0; i < (W * H) / 9; i++) {
      g.fillStyle = Math.random() < 0.5 ? "rgba(150,120,70,.16)" : "rgba(255,255,255,.55)";
      g.fillRect(Math.random() * sand.width, Math.random() * sand.height, dpr, dpr);
    }
  }
  size();
  addEventListener("resize", size);
  const shoreLine = () => { // the waves reach the card table: the middle of the table is the shore
    const t = $("table")?.getBoundingClientRect();
    if (t && t.height && !$("game").hidden) return { s: t.top + t.height * 0.35, reach: t.bottom + 26 - (t.top + t.height * 0.35) };
    return { s: H * 0.3, reach: H * 0.12 };
  };
  const ease = (x) => 1 - Math.pow(1 - x, 3), easeIO = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  function frame(now) {
    if (run !== shoreRun || !cv.isConnected) return;
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return;
    last = now;
    // the wave: if the sound isn't driving it, keep our own rhythm
    if (!shoreSwell || now - shoreSwell.at > shoreSwell.up + shoreSwell.down + 1800) shoreSwell = { at: now, up: 2600 + Math.random() * 700, down: 3600 + Math.random() * 1200 };
    const e = now - shoreSwell.at;
    const p = e < shoreSwell.up ? ease(e / shoreSwell.up) : e < shoreSwell.up + shoreSwell.down ? 1 - easeIO((e - shoreSwell.up) / shoreSwell.down) : 0;
    const { s, reach } = shoreLine();
    const back = H * 0.07;
    const edge = s - back + p * (back + reach); // where the water reaches right now
    if (edge > wetY || now - wetAt > 9000) { wetY = Math.max(edge, s - back); wetAt = now; }
    const t = now / 1000;
    const rip = (x) => 7 * Math.sin(x * 0.011 + t * 1.2) + 4 * Math.sin(x * 0.031 - t * 0.8) + 2.5 * Math.sin(x * 0.075 + t * 2.1);
    const c = ctx2;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.drawImage(sand, 0, 0, W, H);
    // wet sand where the last wave reached, drying slowly
    const dry = Math.min(1, (now - wetAt) / 6000);
    c.fillStyle = `rgba(150,118,70,${0.32 * (1 - dry * 0.7)})`;
    c.beginPath(); c.moveTo(0, 0);
    for (let x = 0; x <= W + 8; x += 8) c.lineTo(x, wetY + rip(x) * 0.6 + 6);
    c.lineTo(W, 0); c.closePath(); c.fill();
    // the water
    const wg = c.createLinearGradient(0, 0, 0, edge + 10);
    const cl = (v) => Math.min(0.97, Math.max(0.02, v));
    const k1 = cl(((s - back - 40) / (edge + 10)) * 0.6), k2 = Math.max(k1 + 0.01, cl((s - back) / (edge + 10)));
    wg.addColorStop(0, "#075f86"); wg.addColorStop(k1, "#0e8fb5");
    wg.addColorStop(Math.min(0.99, k2), "rgba(40,190,205,.92)");
    wg.addColorStop(1, "rgba(120,225,215,.35)");
    c.fillStyle = wg;
    c.beginPath(); c.moveTo(0, 0);
    for (let x = 0; x <= W + 8; x += 8) c.lineTo(x, edge + rip(x));
    c.lineTo(W, 0); c.closePath(); c.fill();
    // waves coming in: soft white crests moving down to the shore
    for (let k = 0; k < 3; k++) {
      const ph = ((t * 0.16 + k / 3) % 1), y = (s - back) * (0.25 + ph * 0.75);
      c.strokeStyle = `rgba(255,255,255,${0.35 * Math.sin(ph * Math.PI)})`; c.lineWidth = 2.2;
      c.beginPath();
      for (let x = 0; x <= W + 8; x += 8) { const yy = y + Math.sin(x * 0.02 + k * 2 + t) * 3; x ? c.lineTo(x, yy) : c.moveTo(x, yy); }
      c.stroke();
    }
    // sparkles of sun on the water
    for (const sp of sparkles) {
      const a = Math.max(0, Math.sin(t * 2.4 + sp.p * 6));
      if (a < 0.6) continue;
      c.fillStyle = `rgba(255,255,255,${(a - 0.6) * 2})`;
      c.fillRect(sp.x * W, sp.y * Math.max(10, s - back - 10), 2, 2);
    }
    // the foam edge, thick while rushing in, thin while sliding back
    const rushing = e < shoreSwell.up;
    c.strokeStyle = `rgba(255,255,255,${rushing ? 0.95 : 0.7})`;
    c.lineWidth = rushing ? 6 : 3; c.lineJoin = "round";
    c.beginPath();
    for (let x = 0; x <= W + 8; x += 8) { const y = edge + rip(x); x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    c.fillStyle = "rgba(255,255,255,.8)";
    for (const b of bubbles) {
      const x = b.x * W, y = edge + rip(x) - 4 - b.o * (rushing ? 16 : 26);
      c.beginPath(); c.arc(x, y, b.r, 0, 6.3); c.fill();
    }
  }
  requestAnimationFrame(frame);
}

// cards that fell on the sand: grains of sand and a wet patch on them until the next deal
const sandyCards = new Set();
let sandyKey = null;
function markSandy() {
  const k = room ? `${roomId}|${room.round}|${room.reshuffles || 0}` : null;
  if (k !== sandyKey) { sandyKey = k; sandyCards.clear(); } // a new deck: all clean again
  document.querySelectorAll(".card.sandy").forEach((e) => { if (!sandyCards.has(e.dataset.id)) e.classList.remove("sandy"); });
  if (!sandyCards.size) return;
  for (const id of sandyCards) document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`).forEach((e) => e.classList.add("sandy"));
}
// 🏖️ On the beach, now and then a card misses the table: it drops onto the sand with a little puff,
// then someone puts it back on the table.
function slipOffTable(el) {
  const tb = $("table")?.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (!tb || !r.width) return;
  const left = Math.random() < 0.5;
  // lands on the sand just beside / below the table, always on the screen
  let dx = left ? tb.left - r.left - r.width * 0.75 : tb.right - r.left - r.width * 0.25;
  dx = Math.max(8 - r.left, Math.min(innerWidth - r.right - 8, dx));
  const dy = Math.min(innerHeight - r.bottom - 120, tb.bottom - r.top - r.height * 0.3 + 14);
  const rot = (left ? -1 : 1) * (40 + Math.random() * 40);
  // the ground is further down than the table top, so the card looks smaller lying on the sand
  const g = 0.62;
  el.animate([
    { transform: "none", offset: 0 },
    { transform: `translate(${dx * 0.6}px, ${dy * 0.3}px) rotate(${rot * 0.5}deg) scale(.9)`, offset: 0.12 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${g})`, offset: 0.26 },
    { transform: `translate(${dx}px, ${dy - 5}px) rotate(${rot}deg) scale(${g})`, offset: 0.3 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${g})`, offset: 0.34 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${g})`, offset: 0.66 },
    { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 30}px) rotate(${rot * 0.3}deg) scale(1.02)`, offset: 0.84 },
    { transform: "none", offset: 1 },
  ], { duration: 2200, easing: "ease-in-out" });
  // from now on that card has sand on it and a wet patch (until a new deck is dealt)
  const id = el.dataset.id;
  if (id) setTimeout(() => { sandyCards.add(id); markSandy(); }, 1500);
  setTimeout(() => { // a little puff of sand where it lands
    const pr = el.getBoundingClientRect();
    for (let i = 0; i < 9; i++) {
      const d = Object.assign(document.createElement("i"), { className: "sand-puff" });
      Object.assign(d.style, { left: pr.left + pr.width / 2 + "px", top: pr.bottom - 6 + "px" });
      d.style.setProperty("--dx", (Math.random() - 0.5) * 70 + "px"); d.style.setProperty("--dy", -10 - Math.random() * 30 + "px");
      document.body.append(d); setTimeout(() => d.remove(), 800);
    }
  }, 580);
  setTimeout(() => showBanner("Oops! The card fell on the sand · back on the table", "🏖️"), 900);
}
function thunderFromSound() { if (sceneNow === "rain") rainBolt(); else if (sceneNow === "window") indoorBolt(); }
function thunderFlash() {
  const f = document.querySelector("#sceneFx .flash");
  if (!f) return;
  f.classList.remove("on"); void f.offsetWidth; f.classList.add("on");
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
  } else {
    const pa = P.premiumAvatar(p.avatar);
    a.classList.toggle("prem-av", !!pa);
    a.classList.toggle("metal", pa?.g === "metal");
    if (pa) { a.textContent = pa.e; a.style.setProperty("--pa-bg", pa.bg); a.style.setProperty("--pa-ring", pa.ring); }
    else a.textContent = p.avatar || (p.name || "?").trim().charAt(0).toUpperCase();
  }
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
  // signed in / registered just now: show their holhuashis without waiting
  const regNow = isRegistered();
  if (renderAccount.reg !== regNow) { renderAccount.reg = regNow; if (!room) setTimeout(() => renderMyLounges(true), 0); }
  const reg = isRegistered();
  $("accountGuest").hidden = reg;
  $("loungeLock").hidden = true;
  $("holhuashiPanel").hidden = !reg; // guests only see Aammu Jagaha
  $("homeChallenges").hidden = !reg;
  if (reg && renderAccount.tUid !== uid) { renderAccount.tUid = uid; renderMyTournaments(); }
  if (reg) {
    const ok = canMakeTournament();
    $("tourneyCreate").classList.toggle("locked-btn", !ok);
    $("tourneyCreate").textContent = ok ? "Create tournament" : "🔒 Create tournament";
    $("tourneyLock").hidden = ok;
  }
  if (reg) renderChallenges($("homeChallenges"));
  $("createLoungeBtn").classList.toggle("locked-btn", !reg);
  $("createLoungeBtn").textContent = (reg ? "" : "🔒 ") + tr("holhuashi.create", "Create my holhuashi");
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
  $("authTitle").textContent = mode === "register" ? "Create your account" : tr("auth.signin", "Sign in");
  $("authSubmit").textContent = mode === "register" ? "Register" : tr("auth.signin", "Sign in");
  $("authNameRow").hidden = mode !== "register";
  $("authAvatarRow").hidden = mode !== "register";
  $("authSwitch").textContent = mode === "register" ? "Already registered? Sign in" : tr("auth.toRegister", "New here? Register");
  $("authError").textContent = "";
  $("authForgot").hidden = mode === "register";
  $("authInfo").textContent = "";
  if (mode === "register") {
    $("authName").value = $("name").value.trim();
    renderAvatarPicker($("authAvatars"), pickedAvatar, (a) => { pickedAvatar = a; });
  }
}

function renderAvatarPicker(box, current, onPick) {
  box.innerHTML = "";
  // 💎 Premium avatars first (locked for others while Premium is on sale; hidden while it isn't)
  if (box.id === "profAvatars" && (isPremium() || premiumCfg.visible)) {
    const head = Object.assign(document.createElement("div"), { className: "prem-av-head", textContent: isPremium() ? "💎 Premium avatars" : "💎 Premium avatars · for Premium players" });
    box.append(head);
    let group = null;
    for (const pa of P.PREMIUM_AVATARS) {
      if ((pa.g || "") !== group) {
        group = pa.g || "";
        if (group) box.append(Object.assign(document.createElement("div"), { className: "prem-av-sub", textContent: group === "cute" ? "🧸 Cute" : "🤘 Heavy metal" }));
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "avatar-pick prem-pick" + (pa.id === current ? " on" : "") + (isPremium() ? "" : " locked");
      b.title = pa.name;
      const face = document.createElement("span");
      face.className = "avatar prem-av";
      face.textContent = pa.e;
      face.style.setProperty("--pa-bg", pa.bg); face.style.setProperty("--pa-ring", pa.ring);
      if (pa.g === "metal") face.classList.add("metal");
      b.append(face);
      b.onclick = () => {
        if (!isPremium()) return needPremium("Premium avatars are");
        box.querySelectorAll(".on").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        onPick(pa.id);
      };
      box.append(b);
    }
    box.append(Object.assign(document.createElement("div"), { className: "prem-av-head", textContent: "Everyone" }));
  }
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
    // Remember me: stay signed in after closing the browser (otherwise only until it's closed)
    const remember = $("authRemember").checked;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence).catch(() => {});
    if (remember) store("thaas-email", email); else store("thaas-email", "");
    store("thaas-remember", remember ? "1" : "0");
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

// Forgot password: Firebase emails a link to choose a new one
async function forgotPassword() {
  const email = $("authEmail").value.trim();
  $("authError").textContent = "";
  if (!email) { $("authError").textContent = "Type your email above first, then press Forgot password."; $("authEmail").focus(); return; }
  $("authForgot").disabled = true;
  try {
    // THAAS sends its own email (api/reset.js); if that isn't set up yet, Firebase's standard email is used
    let sent = false;
    const url = NOTIFY_URL ? NOTIFY_URL.replace(/notify$/, "reset") : "";
    if (url) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok) sent = true;
      else if (r && (r.status === 429 || r.status === 400)) throw { code: "x", message: j.error };
    }
    if (!sent) await sendPasswordResetEmail(auth, email);
    $("authError").textContent = "";
    toast("📧 Check your email for a link to choose a new password");
    $("authInfo").textContent = `📧 If ${email} has a THAAS account, a reset link is on its way. Open it, choose a new password, then sign in here. (Check spam too.)`;
  } catch (err) {
    $("authError").textContent = err.code === "auth/user-not-found" ? "No account with that email." : AUTH_ERRORS[err.code] || err.message || "Couldn't send the email · try again";
  } finally { $("authForgot").disabled = false; }
}

let signingOut = false;
async function logOut() {
  if (roomId) return toast("Leave the room first");
  signingOut = true;
  try { await signOut(auth); profile = {}; await signInAnonymously(auth); } finally { signingOut = false; } // back to playing as a guest
  toast("Signed out. Playing as guest.");
}

// ---------- admin & blocked players ----------
// You're an admin if the Firebase console has a document admins/{your player ID}.
let amAdmin = false, amBlocked = false, unsubBlocked = null;
let adminUsers = [], adminBanned = new Set(), adminFilter = "all";

function watchRoles() {
  amAdmin = false;
  $("adminBtn").hidden = true;
  watchPremium();
  getDoc(doc(db, "admins", uid)).then((s) => {
    amAdmin = s.exists();
    $("adminBtn").hidden = !amAdmin;
    renderPremiumEntry();
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

// ---------- 💎 Premium ----------
// Hidden until an admin turns it on (config/premium.visible). Players pay (MVR 5 a month, outside the
// app) and an admin activates it for them (premium/{uid}.until). Admins always see premium tools.
let premiumCfg = { visible: false, price: "MVR 5 / month", payInfo: "" }, myPremiumUntil = 0, unsubPrem = [];
const PREMIUM_FEATURES = [
  ["💬", "Holhuashi chat", "Send messages in your holhuashis (free players can read them)"],
  ["🏝️", "Unlimited holhuashis", `Free players can own ${2}; Premium players as many as they like`],
  ["🃏", "Premium card backs", "Lagoon waves, Coral, Starry night, Diamond, Palm leaf, Royal check"],
  ["🌅", "Premium tables", "Sandbank, Island sunset, Coral reef, Black marble, Emerald"],
  ["🥳", "More emojis & phrases", "22 extra reactions to send at the table"],
  ["👁", "DIGU card tracker", "See the last cards each player took from the thrown pile and what they threw"],
  ["🔎", "What they're collecting", "A rough idea of the sets each player is building (never their exact cards)"],
  ["⚠️", "Next-player warning", "A heads-up when the card you're about to throw may help the next player"],
  ["🧠", "Suit memory", "BONDI & DHIHA: who has run out of which suit"],
  ["🔟", "Tens tracker", "DHIHA: which 10s are still to come"],
  ["💎", "Premium badge", "A diamond next to your name at every table"],
];
const untilMs = (u) => (u?.toMillis ? u.toMillis() : u?.seconds ? u.seconds * 1000 : typeof u === "string" ? Date.parse(u) || 0 : Number(u) || 0);
const premiumPaid = () => premiumCfg.visible && myPremiumUntil > Date.now();
const isPremium = () => amAdmin || premiumPaid();
// Premium limits only apply while Premium is switched on (otherwise there'd be no way to get it).
const premiumGate = () => premiumCfg.visible && !isPremium();
const FREE_LOUNGES = 2;
function needPremium(what) {
  toast(`💎 ${what} for Premium players (${premiumCfg.price || "MVR 5 / month"})`);
  setTimeout(openPremium, 600);
}
function watchPremium() {
  unsubPrem.forEach((f) => f()); unsubPrem = [];
  unsubPrem.push(onSnapshot(doc(db, "config", "premium"), (s) => {
    premiumCfg = { visible: false, price: "MVR 5 / month", payInfo: "", ...(s.data() || {}) };
    renderPremiumEntry();
  }, () => {}));
  unsubPrem.push(onSnapshot(doc(db, "premium", uid), (s) => {
    const u = s.data()?.until;
    myPremiumUntil = untilMs(u);
    renderPremiumEntry();
  }, () => {}));
}
function renderPremiumEntry() {
  const b = $("premiumBtn");
  b.hidden = !premiumCfg.visible; // only when the admin has switched Premium on
  renderChatGate();
  applyLook();
  renderTray();
  if (!$("profileModal").hidden) renderProfile();
  b.textContent = premiumPaid() ? "💎 Premium · active" : "💎 Go Premium";
  b.classList.toggle("active", premiumPaid());
}
// Chat: free players can read but not send while Premium is on.
function renderChatGate() {
  const gate = premiumGate();
  const input = $("chatText"), btn = $("chatForm")?.querySelector("button");
  if (!input) return;
  input.disabled = gate;
  if (btn) btn.disabled = gate;
  input.placeholder = gate ? "💎 Chat is for Premium players" : "Say something…";
  let up = $("chatPremium");
  if (gate && !up) {
    up = Object.assign(document.createElement("button"), { type: "button", id: "chatPremium", className: "premium-btn small", textContent: "💎 Go Premium to chat" });
    up.onclick = openPremium;
    $("chatForm").after(up);
  }
  if (up) up.hidden = !gate;
}
function openPremium() {
  $("premiumModal").hidden = false;
  const f = $("premiumFeatures");
  f.innerHTML = "";
  for (const [icon, t, d] of PREMIUM_FEATURES) {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { className: "pf-icon", textContent: icon }));
    const tx = document.createElement("div");
    tx.append(Object.assign(document.createElement("b"), { textContent: t }), Object.assign(document.createElement("small"), { textContent: d }));
    li.append(tx);
    f.append(li);
  }
  $("premiumPrice").textContent = premiumCfg.price || "MVR 5 / month";
  $("premiumStatus").textContent = premiumPaid()
    ? `✅ Active until ${new Date(myPremiumUntil).toLocaleDateString()}`
    : amAdmin ? "🛡️ You're an admin: premium tools are on for you" : "Not active yet";
  $("premiumPay").textContent = premiumCfg.payInfo || "Pay MVR 5 to the THAAS admin and send them your player ID below. They'll switch it on for you.";
  $("premiumId").textContent = uid;
}

// The tracker panel during a game.
function renderPremiumPanel() {
  const box = $("premiumPanel");
  const g = room ? gameOf(room) : null;
  const show = !!room && room.status === "playing" && isPremium() && premOpen && ["digu", "bondi", "dhiha"].includes(g);
  box.hidden = !show;
  $("premiumPanelR").hidden = !show;
  if (!show) return;
  const body = $("premiumBody");
  const key = JSON.stringify([g, room.track, room.voids, room.dvoids, room.decks, room.turn, selected, room.round, innerWidth]);
  if (body._key === key) return;
  body._key = key;
  body.innerHTML = "";
  const bodyR = $("premiumBodyR");
  bodyR.innerHTML = "";
  // only the players on my left and right (with 2 players, the one opposite)
  const all = room.playerIds.filter((u) => u !== uid);
  const sideOf = (u) => seatTagPos(u).side;
  let others = all.filter((u) => ["left", "right"].includes(sideOf(u)));
  if (!others.length) others = all;
  const colFor = (u) => (sideOf(u) === "left" ? body : bodyR);
  const yOf = (s) => Math.min(...others.filter((u) => sideOf(u) === s).map((u) => seatTagPos(u).y), innerHeight * 0.42);
  box.style.top = ""; box.style.bottom = innerHeight - yOf("left") + 18 + "px";
  $("premiumPanelR").style.bottom = innerHeight - yOf("right") + 18 + "px";
  const me = room.playerIds.indexOf(uid);
  const next = room.playerIds[(me + 1) % room.playerIds.length];
  const SYM = C.SUIT_SYMBOL;
  const chip = (id) => { const c = C.parse(id); return `<span class="pc ${C.isRed(id) ? "red" : ""}">${C.label(c.r)}${SYM[c.s]}</span>`; };
  if (g === "digu") {
    $("premiumTitle").textContent = "💎 Card tracker";
    for (const u of others) {
      const t = room.track?.[u] || {};
      const h = C.diguHints(t.took, t.threw);
      const row = document.createElement("div");
      row.className = "pt-row" + (u === next ? " next" : "");
      row.innerHTML = `<div class="pt-name">${u === next ? "▶ " : ""}<b></b>${u === next ? " <small>next</small>" : ""}</div>
        <div class="pt-line" data-l="⬆"><small>took</small> ${(t.took || []).slice(-3).map(chip).join("") || "<i>nothing yet</i>"}</div>
        <div class="pt-line" data-l="⬇"><small>threw</small> ${(t.threw || []).slice(-5).map(chip).join("") || "<i>nothing yet</i>"}</div>
        <div class="pt-hint"></div>`;
      row.querySelector("b").textContent = nameOf(u);
      row.querySelector(".pt-hint").textContent = h.want.length ? `🔎 maybe collecting ${h.want.join(" or ")}` + (h.avoid.length ? ` · not ${h.avoid.join(" ")}` : "")
        : h.avoid.length ? `🔎 probably not collecting ${h.avoid.join(" ")}` : "🔎 no idea yet";
      colFor(u).append(row);
    }
    // heads-up about the card I'm about to throw
    const sel = selected && hand.includes(selected) ? selected : null;
    if (sel && isMyTurn() && room.phase === "discard") {
      const took = room.track?.[next]?.took || [];
      const s = C.parse(sel);
      const risky = took.some((id) => { const c = C.parse(id); return c.r === s.r || (c.s === s.s && Math.abs(c.r - s.r) <= 2); });
      if (risky) body.prepend(Object.assign(document.createElement("div"), { className: "pt-warn", textContent: `⚠️ ${nameOf(next)} might want this card` }));
    }
  } else {
    $("premiumTitle").textContent = "💎 Suit memory";
    const voids = g === "bondi" ? room.voids || {} : room.dvoids || {};
    for (const u of others) {
      const row = document.createElement("div");
      row.className = "pt-row";
      const v = voids[u] || [];
      row.innerHTML = `<div class="pt-name"><b></b></div><div class="pt-line"></div>`;
      row.querySelector("b").textContent = nameOf(u) + (g === "dhiha" && room.teams?.[u] === room.teams?.[uid] ? " (partner)" : "");
      row.querySelector(".pt-line").innerHTML = v.length ? `<small>out of</small> ${v.map((s) => `<span class="pc ${["H", "D"].includes(s) ? "red" : ""}">${SYM[s]}</span>`).join("")}` : "<i>has every suit so far</i>";
      colFor(u).append(row);
    }
    if (g === "dhiha") {
      const gone = new Set([...(room.decks?.A || []), ...(room.decks?.B || [])].flatMap((d) => d.split(",")).concat((room.trick || []).map((t) => t.card)));
      const left = ["S", "H", "D", "C"].filter((s) => !gone.has(`10-${s}-0`) && !hand.includes(`10-${s}-0`));
      const mine = hand.filter((c) => C.parse(c).r === 10);
      body.append(Object.assign(document.createElement("div"), { className: "pt-hint tens",
        innerHTML: `🔟 still out there: ${left.map((s) => `<span class="pc ${["H", "D"].includes(s) ? "red" : ""}">10${SYM[s]}</span>`).join("") || "<i>none</i>"}` + (mine.length ? ` · you hold ${mine.length}` : "") }));
    }
  }
}

// Admin: premium settings and per-player activation.
async function savePremiumCfg() {
  if (!amAdmin) return;
  try {
    await setDoc(doc(db, "config", "premium"), {
      visible: $("premVisible").checked, price: $("premPrice").value.trim() || "MVR 5 / month",
      payInfo: $("premPayInfo").value.trim(), by: uid, at: serverTimestamp(),
    });
    toast("Premium settings saved");
  } catch (e) { toast(errMsg(e)); }
}
let adminPremium = new Map();
async function grantPremium(u, months) {
  try {
    const cur = adminPremium.get(u.id) || 0;
    const from = Math.max(Date.now(), cur);
    const until = months > 0 ? from + months * 30 * 86400_000 : 0;
    if (until) await setDoc(doc(db, "premium", u.id), { until: new Date(until), name: u.name || null, by: uid, at: serverTimestamp() });
    else await deleteDoc(doc(db, "premium", u.id));
    if (until) adminPremium.set(u.id, until); else adminPremium.delete(u.id);
    renderAdmin();
    toast(until ? `💎 ${u.name || "Player"}: premium until ${new Date(until).toLocaleDateString()}` : `Premium removed for ${u.name || "player"}`);
  } catch (e) { toast(errMsg(e)); }
}

async function openAdmin() {
  if (!amAdmin) return;
  $("adminModal").hidden = false;
  $("adminList").innerHTML = '<p class="muted">Loading players…</p>';
  try {
    const [users, banned, prem] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "banned")),
      getDocs(collection(db, "premium")).catch(() => ({ docs: [] })),
    ]);
    adminPremium = new Map(prem.docs.map((d) => { const u = d.data().until; return [d.id, untilMs(u)]; }));
    $("premVisible").checked = !!premiumCfg.visible;
    $("premPrice").value = premiumCfg.price || "MVR 5 / month";
    $("premPayInfo").value = premiumCfg.payInfo || "";
    adminBanned = new Set(banned.docs.map((d) => d.id));
    adminUsers = users.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (usingRealtime()) { // "last online" lives in Realtime Database
      const ls = await getDocs(collection(db, "lastSeen")).catch(() => null);
      const m = new Map((ls?.docs || []).map((d) => [d.id, d.data()?.t]));
      for (const u of adminUsers) if (m.get(u.id) && m.get(u.id) > untilMs(u.lastSeen)) u.lastSeen = m.get(u.id);
    }
    // players who were blocked after their profile was deleted still show up
    for (const id of adminBanned) if (!adminUsers.some((u) => u.id === id)) adminUsers.push({ id, deleted: true });
    renderAdmin();
  } catch (e) {
    $("adminList").innerHTML = "";
    toast(errMsg(e));
  }
}

// ----- admin: every holhuashi -----
let adminLounges = null;
async function loadAdminLounges() {
  adminLounges = null;
  $("adminList").innerHTML = '<p class="muted">Loading holhuashis…</p>';
  try {
    const snap = await getDocs(query(collection(db, "rooms"), where("lounge", "==", true)));
    adminLounges = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status !== "closed");
  } catch (e) { adminLounges = []; toast(errMsg(e)); }
  renderAdminLounges();
}
function renderAdminLounges() {
  const box = $("adminList");
  if (!adminLounges) { loadAdminLounges(); return; }
  const q = $("adminSearch").value.trim().toLowerCase();
  const nameOfUser = (u) => adminUsers.find((x) => x.id === u)?.name || adminLounges.flatMap((r) => r.players || []).find((p) => p.uid === u)?.name || (u ? u.slice(0, 8) + "…" : "?");
  const list = adminLounges
    .filter((r) => !q || (r.name || "").toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || nameOfUser(r.owner).toLowerCase().includes(q))
    .sort((a, b) => untilMs(b.heartbeat) - untilMs(a.heartbeat));
  $("adminCount").textContent = `${adminLounges.length} holhuashis · ${adminLounges.filter((r) => r.status === "playing").length} playing now`;
  box.innerHTML = "";
  if (!list.length) box.innerHTML = '<p class="muted">No holhuashis match.</p>';
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "admin-row lounge-row";
    const info = document.createElement("div");
    info.className = "admin-info";
    const members = (r.members || []).filter((u) => !isBot(u));
    const last = untilMs(r.heartbeat);
    info.append(Object.assign(document.createElement("strong"), { textContent: `🌴 ${r.name || "Holhuashi"}` }),
      Object.assign(document.createElement("small"), { textContent:
        `Code ${r.id} · owner ${nameOfUser(r.owner)} · ${members.length} member${members.length === 1 ? "" : "s"} · ${GAME_NAME[gameOf(r)] || ""}`
        + ` · ${r.status === "playing" ? "▶ playing now" : r.paused ? "⏸ paused" : "waiting"}`
        + (r.points ? ` · ${r.points} pts` : "") + (last ? ` · active ${ago(last)}` : "") }));
    const det = document.createElement("details");
    det.className = "lounge-members";
    det.append(Object.assign(document.createElement("summary"), { textContent: "Members" }),
      Object.assign(document.createElement("p"), { textContent: members.map((u) => nameOfUser(u) + (u === r.owner ? " (owner)" : "")).join(", ") || "No members" }));
    if ((r.playerIds || []).length) det.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "At the table: " + (r.players || []).map((p) => p.name).join(", ") }));
    info.append(det);
    const del = Object.assign(document.createElement("button"), { type: "button", className: "ghost small danger", textContent: "Delete" });
    del.onclick = async () => {
      if (!confirm(`Delete the holhuashi "${r.name || r.id}" for everyone? This can't be undone.`)) return;
      try {
        await deleteRoomEverywhere(r.id, [...new Set([r.owner, ...members].filter(Boolean))]);
        adminLounges = adminLounges.filter((x) => x.id !== r.id);
        toast("Holhuashi deleted");
        renderAdminLounges();
      } catch (e) { toast(errMsg(e)); }
    };
    row.append(info, del);
    box.append(row);
  }
}
// ----- guests who have left are removed (by the server) -----
const cleanupUrl = () => (NOTIFY_URL ? NOTIFY_URL.replace(/notify$/, "cleanup") : ""); // (NOTIFY_URL is set further down)
async function runCleanup(asAdmin) {
  if (!cleanupUrl() || !auth.currentUser) return null;
  const headers = { "content-type": "application/json" };
  if (asAdmin) headers.authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
  const r = await fetch(cleanupUrl(), { method: "POST", headers, body: "{}" });
  return r.json().catch(() => null);
}
setTimeout(() => runCleanup(false).catch(() => {}), 25_000); // the server does this at most every 30 minutes

const isOnlineNow = (u) => !u.deleted && Date.now() - untilMs(u.lastSeen) < 4 * 60_000;
// "online now", "5 min ago", "yesterday 21:04", …
function seenAgo(ms) {
  const d = Date.now() - ms;
  if (d < 4 * 60_000) return "🟢 online now";
  if (d < 60 * 60_000) return `last online ${Math.round(d / 60_000)} min ago`;
  if (d < 24 * 3600_000) return `last online ${Math.round(d / 3600_000)} h ago`;
  const t = new Date(ms);
  return `last online ${t.toLocaleDateString()} ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
const adminPick = new Set(); // players chosen for a 📣 update alert
function syncPickLabel() {
  $("adminUpdateAlert").textContent = adminPick.size ? `📣 Alert ${adminPick.size} selected` : "📣 Update alert";
}
function renderAdmin() {
  if (adminFilter === "lounges") return renderAdminLounges();
  const q = $("adminSearch").value.trim().toLowerCase();
  const list = adminUsers
    .filter((u) => adminFilter === "all"
      || (adminFilter === "registered" && u.registered)
      || (adminFilter === "guests" && !u.registered && !u.deleted)
      || (adminFilter === "blocked" && adminBanned.has(u.id))
      || (adminFilter === "recent" && untilMs(u.lastSeen))
      || (adminFilter === "online" && isOnlineNow(u)))
    .filter((u) => !q || (u.name || "").toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    .sort((a, b) => adminFilter === "recent" || adminFilter === "online" ? untilMs(b.lastSeen) - untilMs(a.lastSeen)
      : (b.careerPoints || 0) - (a.careerPoints || 0) || (b.gamesPlayed || 0) - (a.gamesPlayed || 0));

  const reg = adminUsers.filter((u) => u.registered).length;
  const onlineN = adminUsers.filter(isOnlineNow).length;
  $("adminCount").textContent = `${adminUsers.length} players · 🟢 ${onlineN} online now · ${reg} registered · ${adminBanned.size} blocked`;
  const box = $("adminList");
  box.innerHTML = "";
  if (!list.length) box.innerHTML = '<p class="muted">No players match.</p>';
  for (const u of list) {
    const row = document.createElement("div");
    row.className = "admin-row" + (adminBanned.has(u.id) ? " is-blocked" : "");
    const who = { uid: u.id, name: u.name || (u.registered ? "Player" : "Guest"), avatar: u.registered ? u.avatar : null,
      photoV: u.usePhoto && u.photo ? u.photoV || 1 : null };
    if (who.photoV) photoCache.set(u.id, { v: who.photoV, url: u.photo });
    if (!u.deleted) {
      const pick = document.createElement("input");
      pick.type = "checkbox"; pick.className = "admin-pick"; pick.title = "Select for 📣 update alert";
      pick.checked = adminPick.has(u.id);
      pick.onchange = () => { pick.checked ? adminPick.add(u.id) : adminPick.delete(u.id); syncPickLabel(); };
      row.append(pick);
    }
    row.append(avatarEl(who, "avatar"));
    const info = document.createElement("div");
    info.className = "admin-info";
    const rk = P.RANKS[P.rankIndex(u.careerPoints || 0)];
    const name = document.createElement("strong");
    name.textContent = u.deleted ? "(profile deleted)" : who.name;
    const meta = document.createElement("small");
    meta.textContent = u.deleted ? `ID ${u.id}`
      : `${u.registered ? `${rk.icon} ${rk.name} · ${u.careerPoints || 0} pts` : "Guest"} · ${u.gamesPlayed || 0} rounds`
        + ` · ID ${u.id.slice(0, 8)}…`;
    info.append(name, meta);
    // online status on its own line, so the buttons never hide it
    if (!u.deleted) {
      const on = isOnlineNow(u), ms = untilMs(u.lastSeen);
      info.append(Object.assign(document.createElement("span"), { className: "admin-seen" + (on ? " on" : ""), textContent: on ? "🟢 Online now" : ms ? `⚪ ${seenAgo(ms).replace("last online", "Last online")}` : "⚪ Not seen yet" }));
      if (on) row.classList.add("is-online");
    }
    if (adminBanned.has(u.id)) info.append(Object.assign(document.createElement("span"), { className: "tag-blocked", textContent: "BLOCKED" }));
    const pu = adminPremium.get(u.id) || 0;
    if (pu > Date.now()) info.append(Object.assign(document.createElement("span"), { className: "tag-prem", textContent: `💎 until ${new Date(pu).toLocaleDateString()}` }));
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
    if (!u.deleted && u.registered) {
      const pm = document.createElement("button");
      pm.className = "ghost small prem";
      pm.textContent = "💎 +1 month";
      pm.title = "Activate / extend premium for 30 days";
      pm.onclick = () => grantPremium(u, 1);
      btns.append(pm);
      if ((adminPremium.get(u.id) || 0) > Date.now()) {
        const rm = Object.assign(document.createElement("button"), { className: "ghost small", textContent: "Remove 💎" });
        rm.onclick = () => grantPremium(u, 0);
        btns.append(rm);
      }
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

  renderChallenges($("profChallenges"));
  $("profBadgeCount").textContent = `${P.earnedBadges(profile).length} of ${P.BADGES.length}`;
  const badges = $("profBadges");
  badges.innerHTML = "";
  for (const b of P.BADGES) {
    const has = b.test(profile);
    const el = document.createElement("div");
    el.className = "badge" + (has ? "" : " locked") + (b.big ? " big" : "");
    el.title = b.desc;
    el.innerHTML = `<span></span><small></small>`;
    el.firstChild.textContent = has ? b.icon : "🔒";
    el.lastChild.textContent = b.name;
    badges.append(el);
  }

  renderAvatarPicker($("profAvatars"), hasPhoto() ? null : profile.avatar, (a) => savePrefs({ avatar: a, usePhoto: false }));
  const prefs = myPrefs();
  renderScenePicker(prefs.table);
  renderStylePicker("profTables", P.TABLES.filter((o) => !o.scene), prefs.table, "table",
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

// 🏖️ / 🌧️ scenes get their own big tiles with names, so they're easy to find
function renderScenePicker(current) {
  const box = $("profScenes");
  if (!box) return;
  box.innerHTML = "";
  const rank = myRank(), free = P.TABLES.find((o) => !o.scene);
  for (const o of [{ id: free.id, name: "Normal table", icon: "🟢", plain: true }, ...P.TABLES.filter((x) => x.scene)]) {
    const ok = o.plain || (isRegistered() && (o.rank <= rank || isPremium() || amAdmin));
    const on = o.plain ? !P.byId(P.TABLES, current).scene : o.id === current;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "scene-tile" + (o.scene ? " sp-" + o.scene : " plain") + (on ? " on" : "") + (ok ? "" : " locked");
    b.innerHTML = "<span></span><b></b><small></small>";
    b.querySelector("span").textContent = o.icon;
    b.querySelector("b").textContent = o.name;
    b.querySelector("small").textContent = o.plain ? "no scene" : ok ? (on ? "✓ in use" : "tap to use") : `🔒 ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name} or 💎`;
    b.onclick = () => {
      if (!isRegistered()) return toast("Register to use table scenes");
      if (!ok) return toast(`🔒 ${o.name} unlocks at ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name} rank (${P.RANKS[o.rank].at} career points) · or with 💎 Premium`);
      savePrefs({ prefs: { table: o.id } });
    };
    box.append(b);
  }
}
function renderStylePicker(boxId, list, current, key, styleFor, label = "") {
  const box = $(boxId);
  box.innerHTML = "";
  const rank = myRank();
  for (const o of list) {
    if (o.premium && !premiumCfg.visible && !amAdmin) continue; // premium styles only show when Premium is on
    if (o.premium) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "style-pick prem" + (o.id === current ? " on" : "") + (isPremium() && isRegistered() ? "" : " locked");
      b.setAttribute("style", styleFor(o));
      b.textContent = label;
      b.title = `💎 ${o.name}`;
      b.dataset.lock = "💎";
      b.onclick = () => (isPremium() && isRegistered() ? savePrefs({ prefs: { [key]: o.id } }) : needPremium(`${o.name} is`));
      box.append(b);
      continue;
    }
    const ok = isRegistered() && (o.rank <= rank || (o.scene && isPremium()));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "style-pick" + (o.id === current ? " on" : "") + (ok ? "" : " locked");
    b.setAttribute("style", styleFor(o));
    if (key === "color" && o.css === "rainbow") {
      b.innerHTML = '<span class="rainbow-text"></span>';
      b.firstChild.textContent = label;
    } else b.textContent = o.icon ? o.icon : label;
    if (o.scene) b.classList.add("scene-pick", "sp-" + o.scene);
    b.title = ok ? o.name : `${o.name} · unlocks at ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name}`;
    if (!ok) b.dataset.lock = P.RANKS[o.rank].icon;
    b.onclick = () => ok
      ? savePrefs({ prefs: { [key]: o.id } })
      : toast(`🔒 ${o.name} unlocks at ${P.RANKS[o.rank].icon} ${P.RANKS[o.rank].name} rank (${P.RANKS[o.rank].at} career points)${o.scene ? " · or with 💎 Premium" : ""}`);
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
// the winning hand was a 💯 1000 DIGU (ten in a row, one suit)
const thousandOf = (r) => gameOf(r) === "digu" && Array.isArray(r?.winnerSets) && C.isThousandDigu(r.winnerSets.flatMap((x) => String(x).split(",")));
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
  if (premiumCfg.visible || amAdmin) {
    tray.append(Object.assign(document.createElement("p"), { className: "tray-prem-head", textContent: "💎 Premium" }));
    for (const text of PREMIUM_REACTIONS) {
      const btn = document.createElement("button");
      btn.className = (/^\p{Extended_Pictographic}+$/u.test(text) ? "emoji" : "phrase") + " prem" + (isPremium() ? "" : " locked");
      btn.textContent = text;
      btn.onclick = () => (isPremium() ? sendReaction(text) : needPremium("These emojis and phrases are"));
      tray.append(btn);
    }
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
  renderDhihaPiles();
  if (isBondi() || isDhiha()) return renderTrick();
  const pile = $("discardPile");
  pile.classList.remove("trick-done");
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
    if (arriving.has(id)) el.classList.add("arriving");
    el.style.setProperty("--t", tossTransform(id, start + i));
    el.style.zIndex = i + 1;
    if (i === shown.length - 1 && !ended) {
      el.classList.add("top");
      // only a card that was just thrown drops in; when the top card is taken, the one below stays exactly as it lies
      if (!firstPaint && id !== prevTop && !arriving.has(id) && discard.length > heapLen) el.classList.add("landing");
    }
    if (id === pick) { // CALL: the previous player's card you may take slides out from under your throw
      el.classList.add("pick");
      el.style.zIndex = shown.length + 5;
    }
    pile.append(el);
  });
  heapTop = ended ? null : shown[shown.length - 1] || null;
  heapLen = discard.length;

  // DIGU! the winning throw lands, then flips over to show the shout on its back
  if (ended) {
    const f = document.createElement("div");
    f.className = "flip-card" + (firstPaint ? " instant" : "") + (digu ? "" : " no-face");
    const inner = document.createElement("div");
    inner.className = "flip-inner";
    const front = document.createElement("div");
    front.className = "flip-front";
    if (digu) front.append(gameOf(room) === "digu" ? Object.assign(document.createElement("div"), { className: "card back" }) : cardEl(digu)); // lies face down
    const back = document.createElement("div");
    back.className = "flip-back";
    back.append(shoutEl(room.diguStyle, gameOf(room) === "call" ? "CALL!" : gameOf(room) === "babbush" ? "BABUSH!" : thousandOf(room) ? "1000 DIGU!" : "DIGU!"));
    inner.append(front, back);
    f.append(inner);
    pile.append(f);
  }
}

// ---------- "it's your turn" ----------
// When the turn comes to me: a big badge pops up, a label pulses over my cards, the screen edge
// glows, the phone buzzes, a short chime plays, and (if I'm in another tab) the tab title flashes.
let wasMyTurn = false, titleFlash = null, audioCtx = null;
const BASE_TITLE = document.title;
function turnAlert(mine) {
  $("game").classList.toggle("my-turn", mine);
  $("game").classList.toggle("is-dhiha", isDhiha() && room.status !== "lobby");
  $("turnBadge").hidden = !mine;
  if (mine && !wasMyTurn) {
    const pop = document.createElement("div");
    pop.className = "turn-pop";
    pop.innerHTML = "<b>YOUR TURN</b><small>" + (isBondi() || isDhiha() ? "play a card" : isCall() ? "throw first, then take" : "take a card, then throw one") + "</small>";
    document.body.append(pop);
    setTimeout(() => pop.remove(), 1000);
    try { navigator.vibrate?.([120, 60, 120]); } catch {}
    chime();
    if (document.hidden && !titleFlash) {
      let on = false;
      titleFlash = setInterval(() => { on = !on; document.title = on ? "🔔 Your turn!" : BASE_TITLE; }, 900);
    }
  }
  if (!mine || !document.hidden) stopTitleFlash();
  wasMyTurn = mine;
}
function stopTitleFlash() {
  if (titleFlash) { clearInterval(titleFlash); titleFlash = null; document.title = BASE_TITLE; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) stopTitleFlash(); });
function chime() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t + i * 0.13);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.13 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.13 + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.3);
    });
  } catch {}
}

// ---------- players around the screen ----------
// Names sit on the side of the screen where each player "sits" (I'm the bottom). The player whose
// turn it is lights up blue, turning red as their time runs out.
// Where each player sits on my screen (I'm at the bottom). Going round from the next player:
//   A right side · B top-right (angled) · C top · D top-left (angled) · E left side.
// Fewer players take the best-fitting places.
const SEAT_SLOTS = { 1: ["C"], 2: ["B", "D"], 3: ["A", "C", "E"], 4: ["A", "B", "D", "E"], 5: ["A", "B", "C", "D", "E"] };
function slotGeom(name) {
  const W = innerWidth, H = innerHeight;
  switch (name) {
    case "A": return { side: "right", tag: { x: W - 22, y: H * 0.5, rot: -90 }, line: { x: W - 3, y: H * 0.5, rot: 90, len: H * 0.22 } };
    case "E": return { side: "left", tag: { x: 22, y: H * 0.5, rot: 90 }, line: { x: 3, y: H * 0.5, rot: 90, len: H * 0.22 } };
    case "B": return { side: "right", tag: { x: W - 44, y: 66, rot: 45 }, line: { x: W - 20, y: 20 }, path: `M ${W - 105} 4 L ${W - 46} 4 Q ${W - 4} 4 ${W - 4} 46 L ${W - 4} ${H * 0.2}` };
    case "D": return { side: "left", tag: { x: 44, y: 66, rot: -45 }, line: { x: 20, y: 20 }, path: `M 4 ${H * 0.2} L 4 46 Q 4 4 46 4 L 105 4` };
    case "C": return { side: "top", tag: { x: W / 2, y: 24, rot: 0 }, line: { x: W / 2, y: 4, rot: 0, len: W * 0.32 } };
    default: return { side: "bottom", tag: { x: 0, y: 0, rot: 0 }, line: { x: W / 2, y: H - 3, rot: 0, len: W * 0.32 } };
  }
}
function seatSlot(u) {
  if (!room || u === uid) return slotGeom("me");
  const ids = room.playerIds, n = ids.length;
  const me = Math.max(0, ids.indexOf(uid));
  const k = (ids.indexOf(u) - me + n) % n; // 1 = the player after me
  const slots = SEAT_SLOTS[Math.min(n - 1, 5)] || SEAT_SLOTS[5];
  return slotGeom(slots[k - 1] || slots[slots.length - 1]);
}
function seatTagPos(u) { const s = seatSlot(u); return { x: s.tag.x, y: s.tag.y, side: s.side }; }
// How many cards a player is holding (face down on the others' screens).
function cardsHeld(u) {
  if (!room || room.status !== "playing" || outOf(room).includes(u)) return 0;
  const g = gameOf(room);
  if (g === "babbush") return bbRow(u).length;
  if (g === "call") return room.ccount?.[u] ?? C.CALL_HAND_SIZE;
  if (g === "bondi") return room.counts?.[u] ?? 0;
  if (g === "dhiha") {
    const done = (room.decks?.A || []).length + (room.decks?.B || []).length;
    return Math.max(0, 13 - done - ((room.trick || []).some((t) => t.uid === u) ? 1 : 0));
  }
  return C.HAND_SIZE + (room.playerIds[room.turn] === u && room.phase === "discard" ? 1 : 0);
}
function seatEl(u) {
  return document.querySelector(`.seat-tag[data-uid="${CSS.escape(u)}"]`) || document.querySelector(`.player[data-uid="${CSS.escape(u)}"]`);
}
function renderSeats() {
  const box = $("seats");
  const show = !!room && ["playing", "ended"].includes(room.status) && !$("game").hidden;
  $("game").classList.toggle("in-play", show);
  // during a game the back button joins pause / end / tips in the bar at the bottom
  $("bottomBar").hidden = !show;
  const back = $("leaveBtn");
  if (show && back.parentElement !== $("bottomBack")) $("bottomBack").append(back);
  if (!show && back.parentElement === $("bottomBack")) $("game").querySelector(".top").prepend(back);
  box.hidden = !show;
  if (!show) { box._key = null; return; }
  const key = JSON.stringify([room.players.map((p) => [p.uid, p.name, p.avatar, p.photoV, p.prem]), room.scores, room.digus, room.counts, room.ccount, room.out, room.eliminated,
    room.teams, room.status, innerWidth, innerHeight, isDhiha() && room.teams, room.players.map((p) => cardsHeld(p.uid))]);
  if (box._key !== key) {
    box._key = key;
    box.innerHTML = "";
    // every player's line on the edge where they sit; the one whose turn it is shrinks as time runs out
    const W = innerWidth, H = innerHeight;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "seat-lines");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    Object.assign(svg.style, { width: W + "px", height: H + "px" }); // exactly the visible screen (100vh can be taller on phones)
    for (const p of room.players) {
      const sl = seatSlot(p.uid);
      let d = sl.path;
      if (!d) { // a straight line centred on line.x / line.y
        const L = sl.line.len, rad = ((sl.line.rot || 0) * Math.PI) / 180, dx = (Math.cos(rad) * L) / 2, dy = (Math.sin(rad) * L) / 2;
        d = `M ${sl.line.x - dx} ${sl.line.y - dy} L ${sl.line.x + dx} ${sl.line.y + dy}`;
      }
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "seat-path");
      path.dataset.uid = p.uid;
      svg.append(path);
    }
    box.append(svg);
    for (const p of room.players) {
      const mine = p.uid === uid;
      const slot = seatSlot(p.uid);
      const t = document.createElement("div");
      t.className = mine ? "seat-tag s-me" : "seat-tag s-slot";
      t.dataset.uid = p.uid;
      if (!mine) {
        Object.assign(t.style, { left: slot.tag.x + "px", top: slot.tag.y + "px" });
        t.style.setProperty("--rot", slot.tag.rot + "deg");
      }
      // their cards, face down and standing upright, fanned out next to their name (towards the
      // middle of the table, so they're never cut off by the edge of the screen)
      const nCards = mine ? 0 : cardsHeld(p.uid);
      if (!mine && isBabbush()) { // BABUSH: their cards lie face down in a row (tappable for J / Q / K)
        const orow = document.createElement("div");
        orow.className = "bb-orow";
        orow.dataset.uid = p.uid;
        const vx = W / 2 - slot.tag.x, vy = H / 2 - slot.tag.y, vl = Math.hypot(vx, vy) || 1;
        const fx = Math.min(W - 64, Math.max(64, slot.tag.x + (vx / vl) * 58));
        const fy = Math.min(H - 80, Math.max(48, slot.tag.y + (vy / vl) * 52));
        Object.assign(orow.style, { left: fx + "px", top: fy + "px" });
        box.append(orow);
        t._bbrow = orow;
      } else if (nCards > 0) {
        const fan = document.createElement("span");
        fan.className = "seat-fan";
        fan.dataset.uid = p.uid;
        const show = Math.min(nCards, 9);
        for (let i = 0; i < show; i++) {
          const c = document.createElement("i");
          c.className = "card back mini-back";
          c.style.setProperty("--a", ((i - (show - 1) / 2) * (show > 1 ? 50 / (show - 1) : 0)).toFixed(1) + "deg");
          fan.append(c);
        }
        const vx = W / 2 - slot.tag.x, vy = H / 2 - slot.tag.y, vl = Math.hypot(vx, vy) || 1;
        const off = slot.side === "top" ? 40 : 46;
        const fx = Math.min(W - 34, Math.max(34, slot.tag.x + (vx / vl) * off));
        const fy = Math.min(H - 60, Math.max(44, slot.tag.y + (vy / vl) * off));
        Object.assign(fan.style, { left: fx + "px", top: fy + "px" });
        box.append(fan);
        t._fan = fan;
      }
      t.append(avatarEl(p, "avatar small"));
      const info = document.createElement("span");
      info.className = "st-info";
      const nm = Object.assign(document.createElement("b"), { textContent: mine ? "You" : p.name });
      const dn = gameOf(room) === "digu" ? room.digus?.[p.uid] || 0 : 0;
      if (dn) nm.append(Object.assign(document.createElement("span"), { className: "digu-star", textContent: dn > 1 ? `⭐${dn}` : "⭐", title: `Called DIGU ${dn} time${dn > 1 ? "s" : ""} this game` }));
      const sub = document.createElement("small");
      const bits = [`${room.scores?.[p.uid] ?? 0} pts`];
      if (outOf(room).includes(p.uid)) bits.push("❌ out");
      else if (isCall() && room.status === "playing" && room.ccount?.[p.uid] != null) bits.push(`🂠 ${room.ccount[p.uid]} card${room.ccount[p.uid] === 1 ? "" : "s"}`);
      if (isBondi() && room.status === "playing") bits.push((room.out || []).includes(p.uid) ? "out ✓" : `🂠 ${room.counts?.[p.uid] ?? 0}`);
      if (isDhiha() && room.teams?.[p.uid]) bits.unshift(room.teams[p.uid] === "A" ? "T1" : "T2");
      sub.textContent = bits.join(" · ") + (p.prem ? " 💎" : "");
      info.append(nm, sub);
      t.append(info, Object.assign(document.createElement("span"), { className: "st-time" }));
      box.append(t);
      if (t._bbrow && Math.abs(slot.tag.rot) === 90) { // left / right players: their row sits above their name
        const half = (t.offsetWidth || 90) / 2;
        t._bbrow.classList.add("vertical"); // a column along the edge, going up from the top of the name
        Object.assign(t._bbrow.style, { left: Math.min(W - 16, Math.max(16, slot.tag.x)) + "px", top: (slot.tag.y - half - 8) + "px" });
      }
      // left and right players: their cards sit just above their name
      if (t._fan && Math.abs(slot.tag.rot) === 90) {
        const half = (t.offsetWidth || 90) / 2;
        Object.assign(t._fan.style, { left: Math.min(W - 42, Math.max(42, slot.tag.x)) + "px", top: Math.max(44, slot.tag.y - half - 24) + "px" });
      }
    }
  }
  if (isBabbush()) box.querySelectorAll(".bb-orow").forEach((orow) => {
    const u = orow.dataset.uid;
    orow.innerHTML = "";
    bbRow(u).forEach((c, i) => orow.append(bbCardEl(u, i, c, { small: true })));
    orow.classList.toggle("caller", room.bb?.caller === u);
  });
  const cur = room.status === "playing" ? room.playerIds[room.turn] : null;
  const nxt = nextPlayerUid();
  box.querySelectorAll(".seat-tag").forEach((t) => {
    t.classList.toggle("turn", t.dataset.uid === cur && !room.paused);
    t.classList.toggle("next", t.dataset.uid === nxt);
  });
  box.querySelectorAll(".seat-path").forEach((l) => l.classList.toggle("turn", l.dataset.uid === cur && !room.paused));
}
addEventListener("resize", () => { if (room) renderSeats(); });

// The turn colour: blue at the start of a turn, red when time is nearly up.
function turnColour(frac) {
  const h = Math.round(215 * Math.max(0, Math.min(1, frac)));
  return { solid: `hsl(${h}, 90%, 55%)`, soft: `hsla(${h}, 90%, 55%, .5)`, faint: `hsla(${h}, 90%, 55%, .22)` };
}

// ---------- cards flying between the piles and the players ----------
// cards on their way to the pile: hidden there until the flying copy lands
const arriving = new Set();
function landed(id) {
  const was = arriving.delete(id);
  if (was && sceneNow === "beach" && Math.random() < 0.12) {
    const el = document.querySelector(`#discardPile .card[data-id="${CSS.escape(id)}"]`);
    if (el) setTimeout(() => slipOffTable(el), 60);
  }
  document.querySelectorAll(`#discardPile .card[data-id="${CSS.escape(id)}"].arriving`).forEach((el) => {
    el.classList.remove("arriving"); el.classList.add("just-landed");
  });
}
function flyCard(from, to, id, { delay = 0, back = false, slow = false } = {}) {
  if (!from || !to) return;
  const toPile = to === $("discardPile") && id;
  const dur = slow ? 700 : 550;
  if (toPile) {
    arriving.add(id);
    document.querySelectorAll(`#discardPile .card[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add("arriving"));
    setTimeout(() => landed(id), dur + delay + 900); // safety: never stay hidden
  }
  const a = from.getBoundingClientRect();
  if (!a.width && !a.height) return;
  const el = back || !id ? Object.assign(document.createElement("div"), { className: "card back" }) : cardEl(id);
  el.classList.add("flying", "fly-move");
  const handSrc = toPile && from.closest?.("#hand") && from.classList?.contains("card")
    ? { w: from.offsetWidth || 56, h: from.offsetHeight || 80, r: +(getComputedStyle(from).getPropertyValue("--rot").match(/-?[\d.]+/)?.[0] || 0) } : null;
  if (handSrc) { // my own card: show it leaving the hand straight away, no gap
    const w0 = handSrc.w, h0 = handSrc.h;
    Object.assign(el.style, { position: "fixed", left: a.left + a.width / 2 - w0 / 2 + "px", top: a.top + a.height / 2 - h0 / 2 + "px", width: w0 + "px", height: h0 + "px", zIndex: 60, margin: 0 });
    el.style.transform = `rotate(${handSrc.r}deg)`;
    document.body.append(el);
    el._holder = true;
  }
  if (toPile) {
    // a thrown card starts small and grows on the way, landing exactly the size and angle of the
    // card on the pile (measured once the pile has drawn it, a moment later)
    const go = () => {
      const found = document.querySelector(`#discardPile .card[data-id="${CSS.escape(id)}"]`), t = found || to;
      const b = t.getBoundingClientRect();
      // (no such card on the pile, e.g. the pile ran out and was shuffled: a normal-sized card, not the pile's width)
      const ps = found ? null : pileCardSize();
      const w = found ? found.offsetWidth || 56 : ps.w, h = found ? found.offsetHeight || 80 : ps.h;
      const rot = +((t.style.getPropertyValue("--t") || "").match(/rotate\((-?[\d.]+)deg/)?.[1] || 0);
      // from my hand: the card itself leaves, full size and at its angle in the hand; from another player: it starts small
      const fromHand = !!handSrc;
      const s0 = fromHand ? Math.max(0.5, Math.min(1.6, handSrc.w / w)) : 0.4;
      const r0 = fromHand ? handSrc.r : 0;
      Object.assign(el.style, { position: "fixed", left: a.left + a.width / 2 - w / 2 + "px", top: a.top + a.height / 2 - h / 2 + "px", width: w + "px", height: h + "px", zIndex: 60, margin: 0, transform: "" });
      document.body.append(el);
      const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
      el.animate([
        { transform: `translate(0,0) scale(${s0}) rotate(${r0}deg)`, opacity: fromHand ? 1 : 0.85 },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 26}px) scale(${(s0 + 1) / 2}) rotate(${rot / 2 + (dx > 0 ? 8 : -8)}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(${rot}deg)`, opacity: 1 },
      ], { duration: dur, easing: slow ? "cubic-bezier(.33,.0,.2,1)" : "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).onfinish = () => { landed(id); el.remove(); };
    };
    setTimeout(go, Math.max(delay, 16));
    return;
  }
  const b = to.getBoundingClientRect();
  const w = 56, h = 80;
  Object.assign(el.style, { position: "fixed", left: a.left + a.width / 2 - w / 2 + "px", top: a.top + a.height / 2 - h / 2 + "px", width: w + "px", height: h + "px", zIndex: 60, margin: 0 });
  document.body.append(el);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const toHand = to === $("hand");
  el.animate([
    { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1 },
    { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 30}px) scale(1.05) rotate(${dx > 0 ? 12 : -12}deg)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${toHand ? 0.9 : 0.45}) rotate(${dx > 0 ? 20 : -20}deg)`, opacity: toHand ? 0.3 : 0.15 },
  ], { duration: dur, delay, easing: slow ? "cubic-bezier(.33,.0,.2,1)" : "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).onfinish = () => el.remove();
}
const seatOrHand = (u) => (u === uid ? $("hand") : seatEl(u));
// What moved since the last update? Animate it: a card taken from the middle pile (face down),
// one taken from the thrown pile (face up), cards thrown, cards played to the table.
const animated = new Set();
function once(key) { if (animated.has(key)) return false; animated.add(key); if (animated.size > 300) animated.clear(); return true; }
// BABUSH: show every card move flying (pile → player, player's place → thrown pile, …)
function bbMoves(prev) {
  const seen = (prev.bb?.ev || []).filter((e) => e.r === room.round).reduce((m, e) => Math.max(m, e.n), 0);
  const evs = (room.bb?.ev || []).filter((e) => e.r === room.round && e.n > seen).sort((a, b) => a.n - b.n);
  const slot = (u, i) => (u === uid ? document.querySelector(`.bb-mine .bb-card[data-idx="${i}"]`) || document.querySelector(".bb-mine")
    : document.querySelector(`.bb-orow[data-uid="${CSS.escape(u)}"] .bb-card[data-idx="${i}"]`) || document.querySelector(`.bb-orow[data-uid="${CSS.escape(u)}"]`) || seatEl(u));
  const holder = (u) => (u === uid ? $("bbDrawn") || document.querySelector(".bb-mine") : document.querySelector(`.bb-orow[data-uid="${CSS.escape(u)}"]`) || seatEl(u));
  let at = 0;
  for (const e of evs) {
    if (!once(`${room.round}|bb|${e.n}|${e.k}`)) continue;
    const slow = e.u !== uid, d = at;
    const go = (fn) => setTimeout(fn, d);
    if (e.k === "draw") go(() => flyCard($("deck"), holder(e.u), null, { back: true, slow }));
    else if (e.k === "take") go(() => flyCard($("discardPile"), holder(e.u), e.c, { slow }));
    else if (e.k === "throw") flyCard(holder(e.u), $("discardPile"), e.c, { delay: d, slow });
    else if (e.k === "match") flyCard(slot(e.u, e.i), $("discardPile"), e.c, { delay: d, slow });
    else if (e.k === "swap") { // the old card flies to the pile, the new one (face down) into its place
      const hold = holder(e.u);
      flyCard(slot(e.u, e.i), $("discardPile"), e.c, { delay: d, slow });
      if (e.u !== uid) go(() => flyCard(hold?.isConnected ? hold : holder(e.u), slot(e.u, e.i), null, { back: true, slow }));
    } else if (e.k === "switch") {
      go(() => { const A = slot(e.a.u, e.a.i), Z = slot(e.z.u, e.z.i); flyCard(A, Z, null, { back: true, slow: true }); flyCard(Z, A, null, { back: true, slow: true }); });
    }
    at += slow ? 700 : 350;
  }
}
function cardMoves(prev) {
  if (!prev || prev.status !== "playing" || room.status === "lobby" || prev.round !== room.round) return;
  const g = gameOf(room);
  if (g === "babbush") return bbMoves(prev);
  if (g === "bondi" || g === "dhiha") {
    const pt = prev.trick || [], nt = room.trick || [];
    const fresh = nt.length > pt.length && pt.every((t, i) => nt[i]?.card === t.card) ? nt.slice(pt.length)
      : nt.length && !pt.some((t) => t.card === nt[0].card) && nt.length <= 1 ? nt : [];
    for (const t of fresh) if (t.uid !== uid && once(`${room.round}|play|${t.card}`)) flyCard(seatOrHand(t.uid), $("discardPile"), t.card, { slow: true });
    // a trick that ended straight away (last card): the last card still flies in
    if (!fresh.length && room.lastTrick?.id && room.lastTrick.id !== prev.lastTrick?.id) {
      const lt = room.lastTrick, who = lt.players?.[lt.players.length - 1];
      if (who && who !== uid && once(`${room.round}|play|${lt.cards[lt.cards.length - 1]}`)) flyCard(seatOrHand(who), $("discardPile"), lt.cards[lt.cards.length - 1], { slow: true });
    }
    return;
  }
  const fx = (room.fx || []).filter((e) => e.r === room.round && e.n > fxSeen(prev));
  fx.sort((a, b) => a.n - b.n);
  let at = 0;
  for (const e of fx) {
    if (!once(`${room.round}|fx|${e.n}|${e.u}|${(e.t || []).join()}|${e.d || ""}`)) continue;
    const who = seatOrHand(e.u), wait = at;
    if (e.d && e.u !== uid) {
      setTimeout(() => flyCard(e.d === "take" ? $("discardPile") : $("deck"), seatOrHand(e.u), e.d === "take" ? e.c : null, { back: e.d !== "take", slow: true }), wait);
      at += 600;
    }
    if (e.t?.length && e.u !== uid && !(room.status === "ended" && e.t.includes(room.diguCard))) {
      const w2 = at;
      e.t.forEach((c, i) => flyCard(who, $("discardPile"), c, { delay: w2 + i * 120, slow: true }));
      at += 700 + e.t.length * 120;
    }
    if (e.s) {
      const w3 = e.u === uid ? 700 : at;
      shuffleBusyUntil = Date.now() + w3 + SHUFFLE_MS; // nobody plays (and no clock runs) until the new pile is set
      setTimeout(() => rebuildDeck(e.old || [], (e.n || 0) % SHUFFLE_STYLES), w3); at = w3 + 1300; // a different trick each time (the same on every phone)
    }
  }
}
// while the thrown cards are being shuffled into a new middle pile, everyone waits
const SHUFFLE_MS = 5200;
let shuffleBusyUntil = 0;
const shuffling = () => Date.now() < shuffleBusyUntil;
// 🃏 While the new middle pile is being made, two big hands shuffle the cards over the middle (a riffle:
// cards falling from both hands into the middle), then the new pile is put down.
function shuffleWaiter() {
  let el = $("shuffleWait");
  const on = !!room && room.status === "playing" && !$("game").hidden && shuffling();
  if (!on) { if (el && !el.classList.contains("bye")) { el.classList.add("bye"); setTimeout(() => el.remove(), 450); } return; }
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "shuffleWait", className: "dealer" });
    // two big hands, each holding half of the cards, riffling them together into the middle
    const half = (side) => `<div class="dl-half ${side}">${'<i class="card back"></i>'.repeat(4)}<span class="dl-bighand">${side === "l" ? "🫱" : "🫲"}</span><span class="dl-thumb">${side === "l" ? "🫱" : "🫲"}</span></div>`;
    const fall = Array.from({ length: 10 }, (_, k) => `<i class="card back dl-drop ${k % 2 ? "r" : "l"}" style="--k:${k}"></i>`).join("");
    el.innerHTML = `${half("l")}${half("r")}<div class="dl-mid">${fall}</div>`;
    document.body.append(el);
  }
  // he stands behind the middle pile, his hands right over it
  const d = $("deck").getBoundingClientRect();
  Object.assign(el.style, { left: d.left + d.width / 2 + "px", top: d.top + d.height * 0.55 + "px" });
}
setInterval(shuffleWaiter, 150);
// the newest move my screen had already shown before this update
function fxSeen(prev) {
  return (prev?.fx || []).filter((e) => e.r === room.round).reduce((m, e) => Math.max(m, e.n), 0);
}
// The middle pile ran out: the thrown cards flip face down one after another, fly into the middle
// and settle into a new pile.
function rebuildDeck(old, style = 0) {
  const from = $("discardPile"), to = $("deck");
  if (!from || !to || !to.offsetParent) return;
  toast("🎩 Middle pile ran out: shuffling the thrown cards into a new pile");
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const w = to.offsetWidth || 56, h = to.offsetHeight || 80;
  const n = Math.max(6, Math.min(8, old.length || 6));
  to.classList.add("rebuilding");
  // 1) the thrown cards flip face down one after another and fly to the middle
  for (let i = 0; i < n; i++) {
    const id = old.length ? old[old.length - 1 - (i % old.length)] : null;
    const face = id ? cardEl(id) : Object.assign(document.createElement("div"), { className: "card back" });
    face.classList.add("flying");
    Object.assign(face.style, { position: "fixed", left: a.left + a.width / 2 - w / 2 + "px", top: a.top + a.height / 2 - h / 2 + "px", width: w + "px", height: h + "px", zIndex: 140, margin: 0, backfaceVisibility: "hidden" });
    const back = Object.assign(document.createElement("div"), { className: "card back flying" });
    back.style.cssText = face.style.cssText;
    document.body.append(face, back);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const lift = -40 - i * 3;
    const kf = (flip) => [
      { transform: `perspective(600px) translate(0,0) rotateY(${flip}deg)` },
      { transform: `perspective(600px) translate(${dx / 2}px, ${dy / 2 + lift}px) rotateY(${flip + 90}deg) scale(1.08)`, offset: 0.5 },
      { transform: `perspective(600px) translate(${dx}px, ${dy}px) rotateY(${flip + 180}deg)` },
    ];
    const opt = { duration: 600, delay: i * 90, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" };
    face.animate(kf(0), opt);
    back.animate(kf(180), opt).onfinish = () => { face.remove(); back.remove(); };
  }
  // 2) the dealer shuffles them by hand over the middle (see shuffleWaiter), then puts the new pile down
  setTimeout(() => {
    to.classList.remove("rebuilding", "settle"); void to.offsetWidth; to.classList.add("settle");
    sparkleAt(to);
  }, Math.max(n * 90 + 600, SHUFFLE_MS - 500));
}
const SHUFFLE_STYLES = 5;
function magicShuffle(deckEl, w, h, style, done) {
  const r = deckEl.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "magic-box";
  Object.assign(box.style, { left: r.left + r.width / 2 + "px", top: r.top + r.height / 2 + "px" });
  document.body.append(box);
  const N = 12, cards = [];
  for (let i = 0; i < N; i++) {
    const c = Object.assign(document.createElement("div"), { className: "card back magic-card" });
    Object.assign(c.style, { width: w + "px", height: h + "px", left: -w / 2 + "px", top: -h / 2 - i * 0.6 + "px", zIndex: i });
    box.append(c); cards.push(c);
  }
  const at = (x, y, rot = 0, s = 1) => `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${s})`;
  const riffle = (t0) => cards.forEach((c, i) => {
    const left = i % 2 === 0, side = left ? -1 : 1;
    c.animate([
      { transform: at(0, 0), offset: 0 },
      { transform: at(side * (w * 0.75), 8, side * -14), offset: 0.35 },
      { transform: at(side * (w * 0.75), 8, side * -14), offset: 0.45 },
      { transform: at(side * 4, -6 - i, side * -4), offset: 0.45 + (i / N) * 0.4 },
      { transform: at(0, 0), offset: 1 },
    ], { duration: 800, delay: t0, easing: "ease-in-out" });
  });
  const spring = (t0) => cards.forEach((c, i) => {
    c.animate([
      { transform: at(0, 0), offset: 0 },
      { transform: at(-w * 0.6, 4, -10), offset: 0.15 },
      { transform: at(0, -h * 1.1, 0, 1.05), offset: 0.55 },
      { transform: at(w * 0.6, 4, 10), offset: 0.85 },
      { transform: at(0, 0), offset: 1 },
    ], { duration: 600, delay: t0 + i * 45, easing: "ease-in-out" });
  });
  const cut = (t0) => cards.forEach((c, i) => {
    const top = i >= N / 2;
    c.animate([
      { transform: at(0, 0) },
      { transform: at(top ? w * 0.9 : 0, top ? -20 : 0, top ? 8 : 0), offset: 0.4 },
      { transform: at(top ? w * 0.9 : 0, top ? 10 : 0, top ? 8 : 0), offset: 0.6 },
      { transform: at(0, 0) },
    ], { duration: 600, delay: t0, easing: "ease-in-out" });
  });
  // a fan: the cards spread round their bottom corner, then close up again
  const fan = (t0) => cards.forEach((c, i) => {
    const a = ((i / (N - 1)) - 0.5) * 120 * Math.PI / 180;
    const fx = Math.sin(a) * h * 0.55, fy = h * 0.55 - Math.cos(a) * h * 0.55;
    c.animate([
      { transform: at(0, 0) },
      { transform: at(fx, fy - 10, (a * 180) / Math.PI), offset: 0.4 },
      { transform: at(fx, fy - 10, (a * 180) / Math.PI), offset: 0.62 },
      { transform: at(0, 0) },
    ], { duration: 1000, delay: t0, easing: "cubic-bezier(.45,0,.25,1)" });
  });
  // the whole pack flips over in the air
  const flipAll = (t0) => box.animate([
    { transform: "perspective(700px) rotateY(0deg) scale(1)" },
    { transform: "perspective(700px) rotateY(180deg) scale(1.15) translateY(-14px)", offset: 0.5 },
    { transform: "perspective(700px) rotateY(360deg) scale(1)" },
  ], { duration: 700, delay: t0, easing: "ease-in-out" });
  // the cards fly round in a circle, then spiral back into the pack
  const whirl = (t0) => cards.forEach((c, i) => {
    const R = w * 0.95, th = (i / N) * Math.PI * 2;
    const p = (k) => at(Math.cos(th + k) * R, Math.sin(th + k) * R * 0.75, ((th + k) * 180) / Math.PI + 90);
    c.animate([
      { transform: at(0, 0) },
      { transform: p(0), offset: 0.25 },
      { transform: p(Math.PI * 0.8), offset: 0.5 },
      { transform: p(Math.PI * 1.6), offset: 0.75 },
      { transform: at(0, 0, 360) },
    ], { duration: 1400, delay: t0, easing: "ease-in-out" });
  });
  // the pack spins round and drops into place
  const spinDrop = (t0) => box.animate([
    { transform: "rotate(0deg) scale(1)" },
    { transform: "rotate(200deg) scale(1.25) translateY(-20px)", offset: 0.5 },
    { transform: "rotate(360deg) scale(1)" },
  ], { duration: 700, delay: t0, easing: "cubic-bezier(.5,0,.3,1.3)" });
  // overhand: small bunches lift off the top and drop to the bottom
  const toss = (t0) => cards.forEach((c, i) => {
    const chunk = Math.floor(i / 3);
    c.animate([
      { transform: at(0, 0) },
      { transform: at((chunk % 2 ? 1 : -1) * 18, -h * 0.85, (chunk % 2 ? 1 : -1) * 10), offset: 0.45 },
      { transform: at(0, 6), offset: 0.85 },
      { transform: at(0, 0) },
    ], { duration: 600, delay: t0 + (3 - chunk) * 180, easing: "ease-in-out" });
  });
  // a bridge: the two halves arch up towards each other and cascade together
  const bridge = (t0) => cards.forEach((c, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    c.animate([
      { transform: at(0, 0) },
      { transform: at(side * w * 0.65, 0, side * 12), offset: 0.3 },
      { transform: at(side * w * 0.3, -h * 0.45, side * -28), offset: 0.55 },
      { transform: at(side * 2, -2 - i * 0.5, 0), offset: 0.6 + (i / N) * 0.3 },
      { transform: at(0, 0) },
    ], { duration: 900, delay: t0, easing: "ease-in-out" });
  });
  let total;
  if (style === 1) { fan(0); flipAll(1100); fan(1900); cut(2950); total = 3600; }
  else if (style === 2) { whirl(0); riffle(1500); spinDrop(2400); total = 3150; }
  else if (style === 3) { toss(0); bridge(1450); cut(2450); total = 3100; }
  else if (style === 4) { spring(0); fan(1250); spinDrop(2350); total = 3100; }
  else { // riffle, spring the cards in an arc, riffle again, cut
    riffle(0); spring(850); riffle(850 + N * 45 + 650); cut(850 + N * 45 + 650 + 850);
    total = 850 + N * 45 + 650 + 850 + 650;
  }
  setTimeout(() => { box.remove(); done(); }, total);
}

// ---------- 💎 tips ----------
const TIPS = {
  digu: ["Keep cards that work two ways, like 7♥ when you hold 7♠ and 8♥: a set or a run.",
    "Watch what the next player takes from the thrown pile, and don't throw them what they collect.",
    "Throw high cards early if they don't fit: they cost the most if someone calls DIGU.",
    "A 4-card set is the hardest to finish: start building it early.",
    "Say \u201c1 card!\u201d only when it can't help them stop you."],
  call: ["CALL as soon as your count is 7 or less: waiting lets others go lower.",
    "Throw pairs and sets together to drop your count fast.",
    "Take the last thrown card if it's small or pairs with one of yours.",
    "Aces are worth 1: keep them, they keep your count low."],
  bondi: ["Never lead a suit someone has run out of: they cut, and the highest card picks up the pile.",
    "When you can't follow suit, cut with your biggest card to get rid of it.",
    "Play just under the highest card on the table when someone after you might cut.",
    "Last to play in a trick? Nobody can cut, so it's safe to throw your highest."],
  dhiha: ["If your partner is sure to win the deck, give them your 10!",
    "Keep your 10s safe: don't play them when the other team is winning.",
    "Choose the Hukum from your longest suit when you first can't follow.",
    "Lead an Ace or the highest card left in a suit to win the deck safely.",
    "Win 3 of the four 10s to win the round (it ends when the last 10 is taken). At 2 tens each, the first team to 7 decks wins."],
};
function contextTip() {
  const g = gameOf(room);
  const others = room.playerIds.filter((u) => u !== uid);
  if (g === "digu") {
    const me = room.playerIds.indexOf(uid), next = room.playerIds[(me + 1) % room.playerIds.length];
    const took = room.track?.[next]?.took || [];
    if (took.length) { const h = C.diguHints(took, room.track?.[next]?.threw); if (h.want.length) return `${nameOf(next)} (next) may be collecting ${h.want[0]}: careful what you throw.`; }
  }
  if (g === "bondi") {
    const v = others.find((u) => (room.voids?.[u] || []).length);
    if (v) return `${nameOf(v)} has no ${room.voids[v].map((s) => C.SUIT_SYMBOL[s]).join(" ")} left: don't lead that suit.`;
  }
  if (g === "dhiha" && (room.trick || []).length) {
    const w = C.dhihaTrickWinner(room.trick, room.hukum);
    if (room.teams?.[w] === room.teams?.[uid] && w !== uid && hand.some((c) => C.parse(c).r === 10)) return "Your partner is winning this deck: if it's safe, give them a 10!";
  }
  return null;
}
// What would be a good next move for me right now?
function moveAdvice() {
  const g = gameOf(room);
  const nm = (c) => cardName(c);
  if (!isMyTurn()) {
    const extra = contextTip();
    return `Wait for ${nameOf(room.playerIds[room.turn])}.` + (extra ? " " + extra : "");
  }
  if (g === "digu") {
    if (room.phase === "draw" && !holdingExtra()) {
      if (C.findWinningLayout(hand)) return "You can call DIGU right now!";
      const top = room.discard?.[room.discard.length - 1];
      if (top) {
        const now = C.bestLayout(hand).points;
        const withTop = Math.min(...[...hand, top].map((c) => C.bestLayout([...hand, top].filter((x) => x !== c)).points));
        if (withTop < now) return `Take the thrown ${nm(top)}: it fits your sets.`;
      }
      return "Take from the middle pile: the thrown card doesn't help you.";
    }
    let best = null;
    const me = room.playerIds.indexOf(uid), next = room.playerIds[(me + 1) % room.playerIds.length];
    const took = room.track?.[next]?.took || [];
    for (const c of hand) {
      const rest = hand.filter((x) => x !== c);
      if (C.findWinningLayout(rest)) return `Throw ${nm(c)} and call DIGU!`;
      const s = C.parse(c);
      const helps = took.some((id) => { const t = C.parse(id); return t.r === s.r || (t.s === s.s && Math.abs(t.r - s.r) <= 2); });
      const pts = C.bestLayout(rest).points + (helps ? 15 : 0);
      if (!best || pts < best.pts || (pts === best.pts && C.points(c) > C.points(best.c))) best = { c, pts };
    }
    return `Throw ${nm(best.c)}: it doesn't fit your sets` + (took.length ? ` and ${nameOf(next)} probably doesn't need it.` : ".");
  }
  if (g === "call") {
    const v = C.handValue(hand);
    if (room.phase === "throw") {
      if (v <= C.CALL_LIMIT) return `CALL now: your count is ${v}.`;
      const groups = {};
      for (const c of hand) (groups[C.parse(c).r] ||= []).push(c);
      const ids = Object.values(groups).sort((a, b) => C.callValue(b[0]) * b.length - C.callValue(a[0]) * a.length)[0];
      return ids.length > 1 ? `Throw your ${ids.length} × ${C.label(C.parse(ids[0]).r)} together: your count drops by ${C.callValue(ids[0]) * ids.length}.` : `Throw ${nm(ids[0])}: it's your highest card.`;
    }
    const p = room.pickable;
    if (p && (C.callValue(p) <= 3 || hand.some((c) => C.parse(c).r === C.parse(p).r))) return `Take the thrown ${nm(p)}: it's small or pairs with your cards.`;
    return "Take from the middle pile.";
  }
  if (g === "bondi") {
    const c = C.bondiBotCard(hand, room.trick || [], bondiCtx(room, uid));
    const t = room.trick || [];
    if (!t.length) return `Lead ${nm(c)}: a low card in a suit nobody has run out of.`;
    if (C.suitOf(c) !== C.suitOf(t[0].card)) return `You can't follow: cut with ${nm(c)}, your biggest card.`;
    return `Play ${nm(c)}.` + (C.bondiRank(c) < Math.max(...t.filter((x) => C.suitOf(x.card) === C.suitOf(t[0].card)).map((x) => C.bondiRank(x.card))) ? " Staying under the highest card keeps you from picking up." : "");
  }
  if (g === "dhiha") {
    const seen = [...(room.decks?.A || []), ...(room.decks?.B || [])].flatMap((d) => d.split(","));
    const c = C.dhihaBotCard(hand, room.trick || [], room.hukum, { me: uid, teams: room.teams, playerIds: room.playerIds, seen, voids: listMap(room.dvoids) });
    const t = room.trick || [];
    if (!t.length) return `Lead ${nm(c)}.`;
    const w = C.dhihaTrickWinner(t, room.hukum);
    if (room.teams?.[w] === room.teams?.[uid]) return C.parse(c).r === 10 ? `Your partner wins this deck: give them your ${nm(c)}!` : `Your partner is winning: play a low card (${nm(c)}).`;
    return `Play ${nm(c)}` + (!room.hukum && C.suitOf(c) !== C.suitOf(t[0].card) ? `: it makes ${C.SUIT_SYMBOL[C.suitOf(c)]} the Hukum.` : ".");
  }
  return "";
}
let tipOpen = false;
function showTip() {
  if (!room || !isPremium()) return;
  const el = $("tipBubble");
  tipOpen = !tipOpen;
  $("premTip").classList.toggle("on", tipOpen);
  if (!tipOpen) { el.classList.remove("show"); setTimeout(() => { if (!tipOpen) el.hidden = true; }, 350); return; }
  el.textContent = "💡 " + (moveAdvice() || contextTip() || "");
  el.hidden = false;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}
// the advice follows the game while it's open
let tipKey = null;
setInterval(() => {
  if (!tipOpen || !room) return;
  const k = JSON.stringify([room.moveId, room.phase, room.turn, hand.length]);
  if (k !== tipKey) { tipKey = k; $("tipBubble").textContent = "💡 " + (moveAdvice() || ""); }
}, 600);
let premOpen = false;
function renderPremTools() {
  const show = !!room && room.status === "playing" && isPremium() && !$("game").hidden;
  $("premTools").hidden = !show;
  $("premEye").classList.toggle("on", premOpen);
  $("premEye").hidden = !["digu", "bondi", "dhiha"].includes(room ? gameOf(room) : "");
}

// ---------- whose turn: a red light on the edge of the screen where that player "sits" ----------
// I'm always at the bottom; the others sit round the screen in playing order (the next player on
// my right, then on up and round): 2 players = top, 4 = right/top/left, 3 or 5+ = corners too.
// ----- the turn arrow -----
// Where a player sits on my screen (me: just above my cards).
function seatAnchor(u) {
  if (u === uid) return { x: innerWidth / 2, y: innerHeight }; // me: the bottom edge
  const s = seatSlot(u); return { x: s.tag.x, y: s.tag.y };
}
let arrowKey = null;
function drawTurnArrow(fill, colour, low = false) {
  let svg = $("turnArrow");
  const show = !!room && room.status === "playing" && !room.paused && !$("game").hidden && $("game").classList.contains("in-play");
  const cur = show ? room.playerIds[room.turn] : null, nxt = show ? nextPlayerUid() : null;
  if (!cur || !nxt || cur === nxt) { if (svg) svg.style.display = "none"; arrowKey = null; return; }
  const NS = "http://www.w3.org/2000/svg";
  if (!svg) {
    svg = document.createElementNS(NS, "svg");
    svg.id = "turnArrow";
    svg.setAttribute("class", "turn-arrow");
    svg.innerHTML = '<defs><marker id="taHead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>'
      + '<path class="ta-track" marker-end="url(#taHead)"/><path class="ta-fill"/><circle class="ta-tip" r="5"/>';
    document.body.append(svg);
  }
  svg.style.display = "";
  const W = innerWidth, H = innerHeight;
  const key = `${cur}>${nxt}|${W}x${H}`;
  const track = svg.querySelector(".ta-track"), bar = svg.querySelector(".ta-fill"), tip = svg.querySelector(".ta-tip");
  if (key !== arrowKey) {
    arrowKey = key;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    Object.assign(svg.style, { width: W + "px", height: H + "px" }); // exactly the visible screen (100vh can be taller on phones)
    // the arrow runs round the edge of the screen (through the corners), the short way round
    const m = 12, r = 44;
    let ring = svg._ring;
    if (!ring || ring._k !== `${W}x${H}`) {
      ring = svg._ring || document.createElementNS(NS, "path");
      ring.setAttribute("d", `M ${W / 2} ${H - m} L ${W - m - r} ${H - m} Q ${W - m} ${H - m} ${W - m} ${H - m - r} L ${W - m} ${m + r} Q ${W - m} ${m} ${W - m - r} ${m}`
        + ` L ${m + r} ${m} Q ${m} ${m} ${m} ${m + r} L ${m} ${H - m - r} Q ${m} ${H - m} ${m + r} ${H - m} Z`);
      ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "none");
      if (!svg._ring) svg.append(ring);
      ring._k = `${W}x${H}`; ring._len = ring.getTotalLength();
      ring._pts = Array.from({ length: 240 }, (_, i) => { const q = ring.getPointAtLength((i / 240) * ring._len); return { x: q.x, y: q.y, l: (i / 240) * ring._len }; });
      svg._ring = ring;
    }
    const P = ring._len;
    const at = (pt) => ring._pts.reduce((bst, q) => { const dd = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2; return dd < bst.d ? { d: dd, l: q.l } : bst; }, { d: Infinity, l: 0 }).l;
    let la = at(seatAnchor(cur)), lb = at(seatAnchor(nxt));
    let span = (lb - la + P) % P;          // going one way round …
    let dir = 1;
    if (span > P / 2) { span = P - span; dir = -1; } // … or the other, whichever is shorter
    const gap = Math.min(28, span * 0.15);   // start and stop just clear of the names
    la += dir * gap; span -= gap * 2;
    const N = Math.max(8, Math.round(span / 8)), pts = [];
    for (let i = 0; i <= N; i++) { const q = ring.getPointAtLength((((la + dir * span * (i / N)) % P) + P) % P); pts.push(`${q.x.toFixed(1)} ${q.y.toFixed(1)}`); }
    const d = "M " + pts.join(" L ");
    track.setAttribute("d", d); bar.setAttribute("d", d);
    bar._len = bar.getTotalLength();
  }
  const L = bar._len || 1, f = Math.max(0, Math.min(1, fill));
  bar.style.strokeDasharray = `${L} ${L}`;
  bar.style.strokeDashoffset = String(L * (1 - f));
  svg.style.setProperty("--tc", colour);
  const pt = bar.getPointAtLength(L * f);
  tip.setAttribute("cx", pt.x.toFixed(1)); tip.setAttribute("cy", pt.y.toFixed(1));
  svg.classList.toggle("full", f > 0.97);
  svg.classList.toggle("low", low); // the last 10 seconds: red, and it pulses
}

function nextPlayerUid() {
  if (!room || room.status !== "playing") return null;
  const ids = room.playerIds, n = ids.length;
  for (let k = 1; k < n; k++) {
    const u = ids[(room.turn + k) % n];
    if (isBondi() && ((room.counts?.[u] ?? 1) <= 0 || (room.out || []).includes(u))) continue;
    if (outOf(room).includes(u)) continue;
    return u;
  }
  return null;
}
function seatPoint(u) {
  const ids = room.playerIds, n = ids.length;
  const me = Math.max(0, ids.indexOf(uid));
  const k = (ids.indexOf(u) - me + n) % n;
  const a = Math.PI / 2 - (k * 2 * Math.PI) / n; // bottom, then right, top, left …
  const w = innerWidth / 2, h = innerHeight / 2, c = Math.cos(a), s = Math.sin(a);
  const t = Math.min(Math.abs(c) > 1e-6 ? w / Math.abs(c) : Infinity, Math.abs(s) > 1e-6 ? h / Math.abs(s) : Infinity);
  const x = w + c * t, y = h + s * t;
  const side = Math.abs(x) < 2 ? "left" : Math.abs(x - 2 * w) < 2 ? "right" : Math.abs(y) < 2 ? "top" : "bottom";
  const corner = (Math.abs(x) < 2 || Math.abs(x - 2 * w) < 2) && (Math.abs(y) < 2 || Math.abs(y - 2 * h) < 2);
  return { x, y, side, corner };
}
function renderTurnGlow() {
  $("turnGlow").hidden = true; return; // replaced by the seat lines (see renderSeats)
  const el = $("turnGlow");
  const show = !!room && room.status === "playing" && !room.paused && !$("game").hidden && room.playerIds.length > 1;
  el.hidden = !show;
  if (!show) return;
  const cur = room.playerIds[room.turn];
  const nxt = nextPlayerUid();
  const key = [cur, nxt, room.playerIds.join(), innerWidth, innerHeight].join("|");
  if (el._key === key) return;
  el._key = key;
  const place = (node, u, isNext) => {
    const pt = seatPoint(u);
    node.className = `tg-spot ${pt.side}${pt.corner ? " corner" : ""}${isNext ? " next" : ""}`;
    node.style.left = pt.x + "px";
    node.style.top = pt.y + "px";
    const tag = node.querySelector(".tg-name");
    tag.textContent = isNext ? `next: ${u === uid ? "you" : nameOf(u)}` : u === uid ? "your turn" : nameOf(u);
  };
  place($("tgNow"), cur, false);
  $("tgNext").hidden = !nxt || nxt === cur;
  if (nxt) place($("tgNext"), nxt, true);
}
addEventListener("resize", () => { if (room) renderTurnGlow(); });

// ---------- 🔄 forced updates ----------
// version.json on the website says which version is current. When it's newer than this copy (an old
// copy kept by the phone, e.g. an iPhone home-screen app), a full-screen notice asks to update and
// can't be closed. Updating reloads the page from the server; the game carries on where it was.
const APP_VERSION = "20261029g";
let updateShown = false;
async function checkForUpdate() {
  if (updateShown || document.hidden) return;
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    const v = String((await r.json()).version || "");
    if (v && v > APP_VERSION) showUpdate(v);
  } catch { /* offline: try again later */ }
}
function showUpdate(v) {
  updateShown = true;
  const o = document.createElement("div");
  o.className = "update-wall";
  o.innerHTML = `<div class="uw-card"><div class="uw-icon">🔄</div><h2>Update available</h2>
    <p>A new version of THAAS is ready, with new features and fixes. Please update to keep playing.</p>
    <button type="button" class="primary">Update now</button>
    <small>Your game and points are safe · you'll be back where you were.</small></div>`;
  o.querySelector("button").onclick = () => {
    o.querySelector("button").textContent = "Updating…";
    // a new address makes the phone fetch everything fresh instead of using its saved copy
    const u = new URL(location.href);
    u.searchParams.set("v", v);
    try { caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k))); } catch {}
    location.replace(u.toString());
  };
  document.body.append(o);
}
setTimeout(checkForUpdate, 3000);
setInterval(checkForUpdate, 120_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });

// 🎵 background music while at a table (game or round results), unless muted
function syncMusic() {
  const at = !!room && room.playerIds?.includes(uid) && room.status !== "lobby" && !$("game").hidden && !document.hidden;
  if (at && !isMuted()) startMusic(); else stopMusic();
  if (at && !isMuted() && sceneNow) startAmbience(sceneNow); else stopAmbience();
  const b = $("musicBtn");
  if (b) { b.textContent = isMuted() ? "🔇" : "🔊"; b.title = isMuted() ? "Music off · tap to turn on" : "Music on · tap to mute"; }
}
setMuted(load("thaas-music") === "off");
addEventListener("pointerdown", () => { unlockMusic(); unlockAmbience(); syncMusic(); }, { passive: true });
document.addEventListener("visibilitychange", syncMusic);
function render() {
  if (!room) return;
  queueMicrotask(syncMusic);
  queueMicrotask(markSandy);
  if ($("game").hidden) hideTableOverlays();
  renderTurnGlow();
  renderOfflineAsk();
  renderSeats();
  renderPremTools();
  queueMicrotask(markOnline);
  $("tourneyBtn").hidden = !room.tourney;
  turnAlert(isMyTurn() && !$("game").hidden);
  const me = room.playerIds.includes(uid);
  const playing = room.status === "playing";
  const myTurn = isMyTurn();

  // players strip
  const strip = $("players");
  const nextU = nextPlayerUid();
  queueMicrotask(() => strip.querySelectorAll(".player").forEach((ch) => {
    ch.classList.toggle("next", !!nextU && ch.dataset.uid === nextU);
  }));
  const stripKey = JSON.stringify([room.players.map((p) => [p.uid, p.name, p.avatar, p.photoV, p.rank, p.badges]),
    room.host, room.scores, playing, playing && room.almost, isBondi() && playing && [room.counts, room.out], isDhiha() && room.teams]);
  if (strip._key !== stripKey) {
  strip._key = stripKey;
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
    if (p.prem) chip.append(Object.assign(document.createElement("span"), { className: "pprem", textContent: "💎", title: "Premium player" }));
    if (isDhiha() && room.teams?.[p.uid]) {
      chip.append(Object.assign(document.createElement("span"), { className: "pteam team-" + room.teams[p.uid], textContent: room.teams[p.uid] === "A" ? "T1" : "T2" }));
    }
    if (isBondi() && playing) {
      const place = (room.out || []).indexOf(p.uid);
      chip.append(Object.assign(document.createElement("span"), {
        className: "pcards" + (place >= 0 ? " out" : ""),
        textContent: place === 0 ? "🏆 Winner" : place > 0 ? `Out ${ordinal(place + 1)}` : `🂠 ${room.counts?.[p.uid] ?? 0}`,
      }));
    }
    if (playing && room.almost?.[p.uid]) {
      const badge = document.createElement("span");
      badge.className = "almost";
      badge.textContent = "1 to DIGU";
      chip.append(badge);
    }
    strip.append(chip);
  });
  }
  // whose turn it is: just move the highlight and the seconds (no redraw, so pictures don't blink)
  [...strip.children].forEach((chip, i) => {
    const active = playing && room.turn === i;
    chip.classList.toggle("active", active);
    let t = chip.querySelector(".ptime");
    if (active && !t) { t = document.createElement("span"); t.className = "ptime"; chip.querySelector(".pscore").before(t); }
    if (!active && t) t.remove();
  });
  tick(); // fill in the seconds straight away so the chip doesn't jump

  // status line
  let status = "";
  if (room.status === "lobby") {
    const last = room.lastChampions?.length ? `🏆 ${room.lastChampions.map(nameOf).join(" & ")} won the last game · ` : "";
    status = last + (room.host === uid
      ? `Your holhuashi · share code ${roomId} · ${room.players.length}/${room.maxPlayers || 6} players`
      : `Waiting for ${nameOf(room.host)} to start · ${room.players.length}/${room.maxPlayers || 6} players`);
  } else if (playing && isDhiha()) {
    const trick = room.trick || [];
    const lead = trick.length ? C.suitOf(trick[0].card) : null;
    if (myTurn && !lead) status = "Your turn: you lead · play any card";
    else if (myTurn && hand.some((c) => C.suitOf(c) === lead)) status = `Your turn: play a ${C.SUIT_SYMBOL[lead]} card`;
    else if (myTurn) status = room.hukum ? `No ${C.SUIT_SYMBOL[lead]}: play Hukum ${C.SUIT_SYMBOL[room.hukum]} to win the deck, or any other card` : `No ${C.SUIT_SYMBOL[lead]}: the card you play now sets the Hukum!`;
    else status = `${nameOf(room.playerIds[room.turn])} is playing…` + (lead ? ` (${C.SUIT_SYMBOL[lead]} was led)` : "");
  } else if (playing && isBondi()) {
    const trick = room.trick || [];
    const lead = trick.length ? C.suitOf(trick[0].card) : null;
    const outFirst = (room.out || []).includes(uid);
    if (outFirst) status = room.out[0] === uid ? "🏆 You went out first · you win this round!" : `You're out (${ordinal(room.out.indexOf(uid) + 1)}) · watching the others`;
    else if (myTurn && !lead) status = "Your turn: you lead · play any card";
    else if (myTurn && hand.some((c) => C.suitOf(c) === lead)) status = `Your turn: play a ${C.SUIT_SYMBOL[lead]} card`;
    else if (myTurn) status = `No ${C.SUIT_SYMBOL[lead]}? Cut with any card · ${nameOf(trickLeader())} picks up the pile`;
    else status = `${nameOf(room.playerIds[room.turn])} is playing…` + (lead ? ` (${C.SUIT_SYMBOL[lead]} was led)` : "");
  } else if (playing && isBabbush()) {
    status = ""; // the Babush area says what to do
  } else if (playing) {
    if (myTurn && isCall()) status = room.phase === "throw"
      ? (canCall() ? "Your turn: CALL now, or throw a card first" : "Your turn: throw a card first (or several of the same number)")
      : room.pickable
        ? `Now take ${C.label(C.parse(room.pickable).r)}${C.SUIT_SYMBOL[C.parse(room.pickable).s]} (the last player's card) or one from the middle pile`
        : "Now take a card from the middle pile";
    else if (myTurn) status = room.phase === "draw"
      ? (room.discard?.length ? "Your turn: take the last thrown card or one from the middle pile" : "Your turn: take a card from the middle pile")
      : "Tap a card, then tap it again to throw it (or drag it to the pile)";
    else status = `${nameOf(room.playerIds[room.turn])} is playing…`;
  } else if (isDhiha() && room.status === "ended") status = `${teamName(room.dhihaResult?.team)} wins the round!`;
  else if (isBondi()) status = room.status === "ended" ? `${nameOf(room.winner)} went out first!` : "";
  else status = `${nameOf(room.winner)} called ${GAME_NAME[gameOf(room)]}!`;
  $("status").textContent = status;
  $("log").textContent = room.log || "";

  // table
  $("table").hidden = room.status === "lobby";
  $("deckCount").textContent = isBondi() ? room.aside || 0 : room.deck?.length ?? 0;
  $("deck").classList.toggle("aside-pile", isBondi());
  $("deck").nextElementSibling.textContent = isBondi() ? "Out of play" : "Middle pile";
  $("discardPile").nextElementSibling.textContent = isBondi() ? "On the table" : "Discard";
  $("deck").classList.toggle("clickable", canDraw());
  $("deck").parentElement.hidden = isDhiha();
  if (isDhiha()) $("discardPile").nextElementSibling.textContent = "On the table";
  renderHeap();
  const pile = $("discardPile");
  pile.classList.toggle("clickable", canDraw() && (isCall() ? !!room.pickable : !!room.discard?.length));
  pile.classList.toggle("target", canThrow());

  // my hand
  if (isBabbush()) {
    $("handSection").hidden = true;
    for (const id of ["discardBtn", "diguBtn", "callBtn", "almostBtn", "groupSets", "callCount"]) $(id).hidden = true;
    renderBabbush();
    renderTargetSetup(); renderLoungeScene(); renderMembers(); renderPremiumPanel(); renderChat();
    $("startBtn").hidden = true;
    tick();
    return;
  }
  $("bbArea")?.remove();
  const handDiv = $("hand");
  const dragId = drag?.moved && drag.src === "hand" ? drag.id : "";
  const legal = canThrow() ? (isBondi() ? C.bondiLegal(hand, room.trick || []) : isDhiha() ? C.dhihaLegal(hand, room.trick || []) : null) : null;
  const handKey = [hand.join(), isCall() ? [...callSel].join() : selected, lastDrawn, dragId, room.round, legal?.join()].join("|");
  if (handDiv._key !== handKey || !handDiv.children.length !== !hand.length) {
  handDiv._key = handKey;
  handDiv.innerHTML = "";
  hand.forEach((id) => {
    const el = cardEl(id);
    if (isCall() ? callSel.has(id) : id === selected) el.classList.add("selected");
    if (id === lastDrawn) el.classList.add("new");
    if (legal && !legal.includes(id)) el.classList.add("blocked");
    if (drag?.moved && drag.src === "hand" && drag.id === id) { el.classList.add("dragging"); drag.el = el; }
    handDiv.append(el);
  });
  }
  $("handSection").hidden = !me || room.status === "lobby";
  if (handDiv._fanW !== handDiv.clientWidth || handDiv._fanKey !== handKey) {
    handDiv._fanKey = handKey; fanHand(); handDiv._fanW = handDiv.clientWidth;
  }
  const sel = isCall() ? callSel.size > 0 : !!selected;
  handDiv.classList.toggle("tap-to-throw", sel && canThrow());

  // buttons
  $("startBtn").hidden = !(room.host === uid && room.status === "lobby");
  $("startBtn").disabled = room.players.length < 2;
  const call = isCall();
  [...callSel].forEach((c) => { if (!hand.includes(c)) callSel.delete(c); });
  $("discardBtn").disabled = !((canThrow() || needsDrawFirst()) && (call ? callSel.size && C.canThrowTogether([...callSel]) : selected));
  $("discardBtn").textContent = isBondi() || isDhiha() ? "Play card" : call && callSel.size > 1 ? `Throw ${callSel.size} cards` : "Throw away";
  $("diguBtn").hidden = call || isBondi() || isDhiha();
  $("callBtn").hidden = !call;
  $("callBtn").disabled = !canCall();
  $("callBtn").classList.toggle("ready", canCall());
  $("groupSets").hidden = call || isBondi() || isDhiha();
  $("callCount").hidden = !(call || isBondi() || isDhiha()) || !hand.length || room.status === "lobby";
  if (isDhiha()) {
    $("callCount").textContent = `You're in ${teamName(room.teams?.[uid])} · ${room.hukum ? `Hukum ${C.SUIT_SYMBOL[room.hukum]}` : "no Hukum yet"}`;
    $("callCount").classList.remove("can-call");
  }
  if (isBondi()) {
    $("callCount").textContent = `You have ${hand.length} card${hand.length === 1 ? "" : "s"} · get rid of them first to win`;
    $("callCount").classList.remove("can-call");
  }
  if (call && hand.length) {
    const v = C.handValue(hand);
    $("callCount").textContent = `Your count: ${v}${v <= C.CALL_LIMIT ? " · you can CALL on your turn" : ` · CALL at ${C.CALL_LIMIT} or less`}`;
    $("callCount").classList.toggle("can-call", v <= C.CALL_LIMIT);
  }
  const canDigu = gameOf(room) === "digu" && myTurn && (room.phase === "draw" ? !!C.findWinningLayout(hand) : !!diguThrow());
  $("diguBtn").disabled = !canDigu;
  $("diguBtn").classList.toggle("ready", canDigu);
  const almostShown = playing && !!room.almost?.[uid];
  const canAlmost = gameOf(room) === "digu" && playing && !almostShown && !canDigu && oneAwayNow();
  $("almostBtn").hidden = !(canAlmost || almostShown);
  $("almostBtn").disabled = almostShown;
  $("almostBtn").textContent = almostShown ? "📢 Everyone knows: 1 card!" : "📢 1 card! Tell everyone";
  renderTargetSetup();
  renderLoungeScene();
  renderMembers();
  renderPremiumPanel();
  renderChat();
  $("copyCode").hidden = !!room.practice;
  $("startBtn").hidden = true; // holhuashis start from the Start button in the middle of the table
  $("targetInfo").textContent = GAME_NAME[gameOf(room)] + (room.practice ? " vs computer" : "") + " · " + (room.status === "lobby" ? (isLobbyRoom(room) ? "" : "Holhuashi")
    : roundsTotal(room) ? `Round ${Math.max(1, room.gameRound || 1)} of ${roundsTotal(room)}` : `${lowWins(gameOf(room)) ? "Out at" : "First to"} ${room.target || DEFAULT_TARGET}`);

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

// A holhuashi waiting to start: the owner's table with its seats, and Start in the middle.
function renderLoungeScene() {
  if (room && isLoungeDoc(room) && (room.removed || []).includes(uid) && !room.playerIds.includes(uid)) {
    forgetLounge(roomId); toast("🚫 The owner removed you from this holhuashi"); leaveRoom(); return;
  }
  const box = $("loungeScene");
  const show = room && !isLobbyRoom(room) && !room.practice && room.status === "lobby";
  $("loungeRoom").hidden = !show;
  if (show) {
    const pl = placeOf(room);
    $("loungeRoom").className = "lounge-room theme-" + pl.id;
    document.querySelectorAll("#loungeRoom .plant").forEach((el, i) => { el.textContent = pl.decor[i] || ""; });
  }
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
    Object.assign(document.createElement("small"), { className: "table-no", textContent: `${nameOf(room.host)}'s holhuashi` }),
  );
  if ((owner || canManageBots()) && !(room.tourney && n < 2)) { // tournament tables: real players only
    const start = document.createElement("button");
    const enough = n >= (isDhiha() ? 4 : 2);
    start.className = "table-play";
    start.textContent = enough ? "Start" : "🤖 Start";
    start.title = enough ? `Start with ${n} players` : "Start now · computer players fill the empty places";
    start.onclick = () => dealRound();
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
      if (isBot(p.uid) && canManageBots()) {
        const x = Object.assign(document.createElement("button"), { type: "button", className: "bot-x", textContent: "✕", title: "Remove the computer player" });
        x.onclick = (e) => { e.stopPropagation(); removeBot(p.uid); };
        seat.append(x);
      }
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
  const need = isDhiha() ? 4 : 2;
  if (canManageBots() && n < need) {
    const fill = Object.assign(document.createElement("button"), { type: "button", className: "primary fill-bots",
      textContent: n === 1 ? `🤖 No one here? Play with the computer` : `🤖 Fill ${need - n} free place${need - n > 1 ? "s" : ""} with the computer` });
    fill.onclick = fillWithBots;
    box.append(fill);
  } else if (canManageBots() && n < seats) {
    const add = Object.assign(document.createElement("button"), { type: "button", className: "ghost small add-bot", textContent: "🤖 Add a computer player" });
    add.onclick = () => addBot();
    box.append(add);
  }
  if (canManageBots() || hasBots(room)) {
    const lv = document.createElement("div");
    lv.className = "bot-level";
    lv.append(Object.assign(document.createElement("span"), { textContent: "🤖 Computer level" }));
    for (const [id, label] of [["easy", "😊 Easy"], ["medium", "🙂 Medium"], ["hard", "😈 Hard"]]) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: (room.botLevel || "medium") === id ? "on" : "", textContent: label });
      b.disabled = !canManageBots();
      b.onclick = () => updateDoc(roomRef(), { botLevel: id, log: `Computer level: ${label}` }).catch((e) => toast(errMsg(e)));
      lv.append(b);
    }
    box.append(lv);
  }
  if (hasBots(room)) box.append(Object.assign(document.createElement("p"), { className: "bot-note", textContent: "🤖 Playing with the computer is just for fun · no holhuashi or career points for this game" }));
  if (isDhiha()) box.append(dhihaTeamPicker());
  if (room.lastGame) box.append(lastGameCard(room.lastGame));
  box.append(loungeBoard());
}

// The holhuashi leaderboard: game wins add up over every game played here.
// The most recent finished game here: everyone's total, winner first.
function lastGameCard(lg) {
  const wrap = document.createElement("section");
  wrap.className = "last-game";
  const when = new Date(lg.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  wrap.append(Object.assign(document.createElement("h3"), { textContent: `🏁 Last game · ${GAME_NAME[lg.game] || ""} · ${when}` }));
  const rows = [...(lg.results || [])].sort((a, b) => (lg.low ? a.total - b.total : b.total - a.total));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "lg-row" + ((lg.champions || []).includes(r.uid) ? " champ" : "") + (r.uid === uid ? " me" : "");
    row.append(
      Object.assign(document.createElement("span"), { className: "lg-place", textContent: (lg.champions || []).includes(r.uid) ? "🏆" : "" }),
      avatarEl({ uid: r.uid, name: r.name, avatar: r.avatar }, "avatar small"),
      Object.assign(document.createElement("span"), { className: "lg-name", textContent: r.name + (r.uid === uid ? " (you)" : "") }),
      Object.assign(document.createElement("b"), { textContent: `${r.total} pts` }),
    );
    wrap.append(row);
  }
  if (lg.low) wrap.append(Object.assign(document.createElement("small"), { className: "lg-note", textContent: "lowest total wins this game" }));
  return wrap;
}

function loungeBoard() {
  const wrap = document.createElement("section");
  wrap.className = "lounge-board lb2";
  const rows = Object.entries(room.board || {})
    .map(([u, b]) => ({ uid: u, name: b.name || nameOf(u), avatar: b.avatar, wins: b.wins || 0, games: b.games || 0 }))
    .sort((a, b) => b.wins - a.wins || (b.wins / (b.games || 1)) - (a.wins / (a.games || 1)) || b.games - a.games || a.name.localeCompare(b.name));
  const total = room.stats?.games || 0;
  const head = document.createElement("div");
  head.className = "lb-head";
  head.append(Object.assign(document.createElement("h3"), { textContent: "🏆 Leaderboard" }),
    Object.assign(document.createElement("small"), { textContent: `${total} game${total === 1 ? "" : "s"} played here · 1 point for each game won` }));
  wrap.append(head);
  if (!rows.length) {
    wrap.append(Object.assign(document.createElement("p"), { className: "board-empty", textContent: "No games finished here yet · win a game to get the first point!" }));
    return wrap;
  }
  const rate = (r) => (r.games ? Math.round((100 * r.wins) / r.games) : 0);
  // podium: 2nd · 1st · 3rd
  const pod = document.createElement("div");
  pod.className = "lb-podium";
  [1, 0, 2].forEach((i) => {
    const r = rows[i];
    const col = document.createElement("div");
    col.className = `lb-step lb-p${i + 1}` + (r ? "" : " empty") + (r?.uid === uid ? " me" : "");
    if (r) {
      col.append(Object.assign(document.createElement("span"), { className: "lb-medal", textContent: ["🥇", "🥈", "🥉"][i] }),
        avatarEl({ uid: r.uid, name: r.name, avatar: r.avatar }, "avatar"),
        Object.assign(document.createElement("b"), { className: "lb-name", textContent: r.uid === uid ? "You" : r.name }),
        Object.assign(document.createElement("span"), { className: "lb-pts", textContent: `${r.wins} pt${r.wins === 1 ? "" : "s"}` }));
    }
    const block = Object.assign(document.createElement("div"), { className: "lb-block", textContent: r ? `${i + 1}` : "" });
    col.append(block);
    pod.append(col);
  });
  wrap.append(pod);
  // everyone, with wins, games and win rate
  const top = Math.max(1, rows[0].wins);
  const list = document.createElement("div");
  list.className = "lb-list";
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "lb-row" + (r.uid === uid ? " me" : "");
    const bar = document.createElement("span");
    bar.className = "lb-bar";
    bar.style.width = `${Math.max(4, (100 * r.wins) / top)}%`;
    row.append(
      Object.assign(document.createElement("span"), { className: "lb-rank", textContent: i + 1 }),
      avatarEl({ uid: r.uid, name: r.name, avatar: r.avatar }, "avatar small"),
      Object.assign(document.createElement("span"), { className: "lb-who", textContent: r.name }),
      Object.assign(document.createElement("span"), { className: "lb-stat", innerHTML: `<b>${r.wins}</b><small>pts</small>` }),
      Object.assign(document.createElement("span"), { className: "lb-stat", innerHTML: `<b>${r.games}</b><small>games</small>` }),
      Object.assign(document.createElement("span"), { className: "lb-stat", innerHTML: `<b>${rate(r)}%</b><small>wins</small>` }),
    );
    const track = document.createElement("span");
    track.className = "lb-track";
    track.append(bar);
    row.append(track);
    list.append(row);
  });
  wrap.append(list);
  return wrap;
}

// Holhuashi settings (holhuashi owner, before dealing): players 2–6, and end by points or by rounds.
// Lobby tables have no settings: 2–4 players, 4 rounds.
function renderTargetSetup() {
  const box = $("targetSetup");
  box.hidden = room.status !== "lobby" || isLobbyRoom(room) || !!room.practice; // the notice board inside the holhuashi
  if (box.hidden) return;
  const host = room.host === uid;
  const owner = nameOf(room.host);
  $("loungeTitle").textContent = room.name || (host ? "Your holhuashi" : `${owner}'s holhuashi`);
  const isOwner = ownsLounge(room);
  const cur = placeOf(room);
  const pc = $("placeChoices");
  pc.innerHTML = "";
  for (const pl of isOwner ? PLACES : [cur]) {
    const locked = isOwner && myRank() < pl.rank;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "place-chip" + (pl.id === cur.id ? " on" : "") + (locked ? " locked" : "");
    b.innerHTML = `<span></span><small></small>`;
    b.querySelector("span").textContent = pl.icon;
    b.querySelector("small").textContent = locked ? `🔒 ${P.RANKS[pl.rank].icon} ${P.RANKS[pl.rank].name}` : pl.name;
    b.title = locked ? `Unlocks at ${P.RANKS[pl.rank].name} rank (${P.RANKS[pl.rank].at} points)` : pl.name;
    b.disabled = !isOwner;
    b.onclick = () => setPlace(pl.id);
    pc.append(b);
  }
  $("loungeManage").hidden = !isOwner;
  if (isOwner && document.activeElement !== $("loungeNameEdit")) $("loungeNameEdit").value = room.name || "";
  const om = String(Number(room.offlineMins) > 0 ? room.offlineMins : 2.5);
  if (isOwner && document.activeElement !== $("loungeOfflineMins")) $("loungeOfflineMins").value = om;
  $("loungeOfflineNote").hidden = isOwner;
  $("loungeOfflineNote").textContent = `⏱️ Players offline for more than ${om === "2.5" ? "2½" : om} minute${om === "1" ? "" : "s"} are removed from the table`;
  if (isOwner) {
    $("loungeNote").innerHTML = `Invite code <b></b> <button type="button" class="ghost small copy-code">Copy invite</button> <button type="button" class="ghost small new-code" title="The old invite code stops working">New code</button>`;
    $("loungeNote").querySelector("b").textContent = myInvite.code === roomId ? `${roomId}-${myInvite.key}` : "…";
    $("loungeNote").querySelector(".copy-code").onclick = () => $("copyCode").click();
    $("loungeNote").querySelector(".new-code").onclick = newInviteCode;
    loadInvite();
  } else {
    $("loungeNote").textContent = "🔒 Invite only · ask the owner to invite your friends";
  }
  const pts = loungePoints(room);
  $("loungePoints").innerHTML = "";
  $("loungePoints").append(
    Object.assign(document.createElement("b"), { textContent: `⭐ ${pts.points} holhuashi points` }),
    Object.assign(document.createElement("small"), { textContent: `${pts.mood} · ${pts.members} player${pts.members === 1 ? "" : "s"} · ${pts.games} games · ${pts.rounds} rounds` }),
  );

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
  $("gameBondi").classList.toggle("on", g === "bondi");
  $("gameDhiha").classList.toggle("on", g === "dhiha");
  $("gameBabbush").classList.toggle("on", g === "babbush");
  $("gameBabbush").disabled = !host;
  $("gameDhiha").hidden = !isLoungeDoc(room);
  $("gameDigu").disabled = $("gameCall").disabled = $("gameBondi").disabled = $("gameDhiha").disabled = !host;
  $("gameNote").textContent = g === "call" ? "CALL: draw, throw one card or several of the same number, and CALL at 7 or less. Caught (someone has less)? The caller scores 50 and everyone else their count. Lowest total wins."
    : g === "babbush"
    ? "BABUSH: 4 cards each, face down. Look at 0–2 of yours, then each turn take a card (middle pile or the last thrown card) and put it in the place of one of yours. J looks, Q switches, K locks. Same number as the thrown card? Tap yours twice to throw it too. 8 = 0. Call BABUSH when you think yours is lowest. Lowest total wins."
    : g === "call"
    ? "CALL: draw, throw one card or several of the same number, and CALL at 7 or less. Lowest total wins."
    : g === "dhiha"
    ? "DHIHA: 4 players in 2 teams, 13 cards each. Follow suit; the first player who can't sets the Hukum (trump). Win decks with 10s: once all four 10s are out, 3 tens wins (2 each: first to 7 decks). Points: 1 a round, 2 for all four 10s, 3 if the other team won no deck."
    : g === "bondi"
    ? "BONDI: all cards are dealt, there's no pile to take from. K♠ starts. Follow suit; if you can't, cut with any card (your biggest!) and the player with the highest card of the suit picks up all the cards and plays next. When everyone follows, the cards go out of play and the highest card plays next. First out scores 0, then 10, 20… Lowest total wins."
    : "DIGU: make two sets of 3 and one set of 4. Highest total wins.";
  const mode = room.endMode === "rounds" ? "rounds" : "points";
  $("endPoints").classList.toggle("on", mode === "points");
  $("endRounds").classList.toggle("on", mode === "rounds");
  $("endPoints").disabled = $("endRounds").disabled = !host;
  $("targetSection").hidden = mode !== "points";
  $("roundsSection").hidden = mode !== "rounds";

  // points
  const target = room.target || DEFAULT_TARGET;
  $("targetLabel").textContent = lowWins(g)
    ? (host ? "Game ends when someone reaches" : `Game ends when someone reaches ${target}`)
    : (host ? "First to reach" : `First to ${target} points wins`);
  const choices = $("targetChoices");
  choices.innerHTML = "";
  for (const t of [...new Set([...(g === "dhiha" ? DHIHA_TARGETS : lowWins(g) ? CALL_TARGETS : TARGET_CHOICES), target])].sort((a, b) => a - b)) {
    const b = document.createElement("button");
    b.textContent = t;
    b.className = "target-chip" + (t === target ? " on" : "");
    b.disabled = !host;
    b.onclick = () => setTarget(t);
    choices.append(b);
  }
  $("targetCustom").hidden = !host;
  $("targetNote").textContent = lowWins(g) ? "points · then the lowest total wins" : "points · then the highest total wins";

  // rounds
  const limit = room.roundsLimit || DEFAULT_LOUNGE_ROUNDS;
  $("roundsLabel").textContent = host ? "Number of rounds" : `${limit} rounds · ${lowWins(g) ? "lowest" : "highest"} total wins`;
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

// ---------- big moments ----------
// The game is over: a trophy, the winner's name and confetti for everyone. In a holhuashi,
// after a few seconds everyone goes back to the holhuashi, where the results and points show.
let celebrated = null;
function celebrateWinner(r) {
  const key = `${roomId}-${r.round}`;
  if (celebrated === key) return;
  celebrated = key;
  setTimeout(() => {
    $("results").hidden = true;
    const champs = r.champions.map((u) => r.players.find((p) => p.uid === u)).filter(Boolean);
    const fx = document.createElement("div");
    fx.className = "win-fx";
    const box = document.createElement("div");
    box.className = "win-box";
    box.append(Object.assign(document.createElement("div"), { className: "win-trophy", textContent: "🏆" }));
    const who = document.createElement("div");
    who.className = "win-who";
    champs.forEach((p) => who.append(avatarEl(p, "avatar")));
    box.append(who,
      Object.assign(document.createElement("h2"), { textContent: champs.map((p) => (p.uid === uid ? "You" : p.name)).join(" & ") + (champs.length > 1 || champs[0]?.uid === uid ? " win the game!" : " wins the game!") }),
      Object.assign(document.createElement("p"), { textContent: isLoungeDoc(r) ? "🏆 +1 holhuashi point · back to the holhuashi in a moment…" : `${GAME_NAME[gameOf(r)]} · ${roundsTotal(r) ? roundsTotal(r) + " rounds" : "target " + (r.target || "")}` }));
    fx.append(Object.assign(document.createElement("div"), { className: "fx-rays" }), box);
    confetti(fx, false);
    document.body.append(fx);
    try { navigator.vibrate?.([100, 60, 100, 60, 200]); } catch {}
    setTimeout(() => fx.classList.add("fade"), 5200);
    setTimeout(() => {
      fx.remove();
      // holhuashi: everyone heads back to the holhuashi (the owner/host starts the new game state)
      if (room && roomId && isLoungeDoc(room) && room.gameOver && (room.host === uid || isOffline(room, room.host, roomId))) playAgain();
      else if (room && isLoungeDoc(room) && room.gameOver) $("results").hidden = true;
      else if (room?.gameOver) $("results").hidden = false;
    }, 5800);
  }, RESULTS_DELAY + 1500);
}

// A quick fun moment for everyone: a big bouncing emoji, a line of text, and little emojis floating up.
function funMoment(emoji, text, floaters, kind) {
  showBanner(text, emoji);
  try { navigator.vibrate?.(kind === "laugh" ? [60, 40, 60, 40, 60] : [40, 30, 40]); } catch {}
}

// BONDI: someone cut, someone ran out of cards.
// 🤣 a big animated laughing face next to a player's name for a few seconds (Google's free animated
// Noto emoji; a plain one if it can't load). Placed on top of the page so redraws don't remove it.
const NOTO = (hex) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${hex}/512.webp`;
try { new Image().src = NOTO("1f923"); } catch {}
// 😳 beside a player's own name: they picked up big cards (A, K, Q, J)
try { new Image().src = NOTO("1f633"); } catch {}
function shyEmoji(u, names, ms = 4000) {
  const seat = u === uid ? (document.querySelector(".seat-tag.s-me") || $("hand")) : seatEl(u);
  if (!seat) return;
  document.querySelectorAll(`.shy-emoji[data-uid="${CSS.escape(u)}"]`).forEach((e) => e.remove());
  const r = seat.getBoundingClientRect();
  const el = Object.assign(document.createElement("div"), { className: "shy-emoji" });
  el.dataset.uid = u;
  const img = Object.assign(new Image(), { alt: "😳", src: NOTO("1f633") });
  img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "se-text", textContent: "😳" }));
  el.append(img, Object.assign(document.createElement("small"), { textContent: `got ${names}` }));
  // just beside the name, on the side towards the middle of the screen
  const left = r.left + r.width / 2 < innerWidth / 2 ? r.right + 2 : r.left - 62;
  Object.assign(el.style, { left: Math.max(4, Math.min(innerWidth - 66, left)) + "px", top: Math.max(4, Math.min(innerHeight - 76, r.top + r.height / 2 - 34)) + "px" });
  document.body.append(el);
  setTimeout(() => el.classList.add("bye"), ms - 400);
  setTimeout(() => el.remove(), ms);
}
function shameEmoji(u, ms = 4200) {
  // up in the top corner of the screen, with the name of whoever has to pick the deck up
  document.querySelectorAll(".shame-emoji").forEach((e) => e.remove());
  const el = Object.assign(document.createElement("div"), { className: "shame-emoji" });
  el.dataset.uid = u;
  const img = Object.assign(new Image(), { alt: "🤣", src: NOTO("1f923") });
  img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "se-text", textContent: "🤣" }));
  el.append(img, Object.assign(document.createElement("small"), { textContent: u === uid ? "haha, you!" : `haha ${nameOf(u)}!` }));
  document.body.append(el);
  setTimeout(() => el.classList.add("bye"), ms - 400);
  setTimeout(() => el.remove(), ms);
}
function bondiMoments(prev) {
  const t = room.lastTrick;
  if (t?.id && t.id !== prev.lastTrick?.id) setTimeout(() => sweepTrick(t), isBondi() ? 250 : 650); // BONDI: straight to the picker / out of play
  if (t?.id && t.id !== prev.lastTrick?.id && t.cut) {
    // big cards picked up (A, K, Q, J) → the table laughs
    const big = t.cards.map((c) => C.parse(c).r).filter((r) => r === 1 || r >= 11).sort((a, b) => (a === 1 ? 14 : a) < (b === 1 ? 14 : b) ? 1 : -1);
    if (big.length) {
      const names = [...new Set(big.map((r) => C.label(r)))].join(", ");
      setTimeout(() => shyEmoji(t.to, names), 1000); // 😳 the one who got them, embarrassed
    }
    showBubble(t.cut, "Cut! ✋", true);
    setTimeout(() => shameEmoji(t.to), 700); // 🤣 the whole table laughs at whoever has to pick the deck up
    showBanner(t.to === uid ? `✋ ${nameOf(t.cut)} cut! You pick up ${t.cards.length} cards`
      : t.cut === uid ? `✋ You cut! ${nameOf(t.to)} picks up ${t.cards.length} cards`
      : `✋ ${nameOf(t.cut)} cut! ${nameOf(t.to)} picks up ${t.cards.length} cards`);
  }
  for (const u of (room.out || []).slice((prev.out || []).length)) {
    const place = room.out.indexOf(u) + 1;
    showBubble(u, place === 1 ? "Out first! 🏆 Winner" : `Out! ${ordinal(place)}`, true);
    if (place === 1) showBanner(u === uid ? "🏆 You're out first · you win this round!" : `🏆 ${nameOf(u)} is out first and wins the round!`);
    else if (u === uid) showBanner(`You're out ${ordinal(place)} · +${(place - 1) * C.BONDI_STEP} points`);
  }
}

// The cards on the table fly to whoever picks them up (into my hand if it's me),
// or onto the set-aside pile when everyone followed suit.
const sweptTricks = new Set(), sweepPlanned = new Set();
function sweepTrick(t) {
  if (!room || sweptTricks.has(t.id)) return; // each deck flies away once
  sweptTricks.add(t.id);
  if (room.lastTrick?.id !== t.id || (room.trick || []).length) { heapKey = null; try { render(); } catch {} return; } // a new deck already started
  setTimeout(() => { heapKey = null; try { render(); } catch {} }, 1300); // then the table is clear
  const slots = [...$("discardPile").querySelectorAll(".trick-slot")];
  if (!slots.length) return;
  const target = t.team ? $("teamPile-" + t.team)
    : t.to ? (t.to === uid ? $("hand") : seatEl(t.to))
    : $("deck");
  if (!target) return;
  const to = target.getBoundingClientRect();
  slots.forEach((slot, i) => {
    const card = slot.querySelector(".card");
    const r = card.getBoundingClientRect();
    const fly = card.cloneNode(true);
    // keep the card's own look (red/black, size) exactly as it sat on the table
    const cs = getComputedStyle(card);
    fly.classList.add("flying"); if (!t.to) fly.classList.add("back-fade");
    const w = card.offsetWidth || r.width, h = card.offsetHeight || r.height; // its real size (the box around a tilted card is bigger)
    Object.assign(fly.style, { position: "fixed", margin: "0", left: r.left + r.width / 2 - w / 2 + "px", top: r.top + r.height / 2 - h / 2 + "px", width: w + "px", height: h + "px",
      fontSize: cs.fontSize, color: cs.color, transform: "none" });
    // the little corner/centre marks keep their table size too
    card.querySelectorAll("*").forEach((src, k) => { const dst = fly.querySelectorAll("*")[k]; if (dst) dst.style.fontSize = getComputedStyle(src).fontSize; });
    document.body.append(fly);
    slot.style.visibility = "hidden";
    const dx = to.left + to.width / 2 - (r.left + r.width / 2) + (i - (slots.length - 1) / 2) * 6;
    const dy = to.top + to.height / 2 - (r.top + r.height / 2);
    fly.animate([
      { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) rotate(${(i % 2 ? 1 : -1) * 20}deg) scale(.85)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${(i % 2 ? 1 : -1) * 35}deg) scale(${t.to ? 0.4 : 0.7})`, opacity: t.to ? 0.2 : 0.4 },
    ], { duration: 750, delay: i * 110, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" }).onfinish = () => fly.remove();
  });
  // the receiver's name (or my hand) bumps with how many cards arrived
  const bump = t.to || t.team ? target : $("deck");
  setTimeout(() => {
    bump.classList.remove("got-cards"); void bump.offsetWidth; bump.classList.add("got-cards");
    const tag = document.createElement("span");
    tag.className = "got-tag" + (t.to ? "" : " aside");
    tag.textContent = `+${(t.cards || []).length}`;
    const br = bump.getBoundingClientRect();
    Object.assign(tag.style, { left: br.left + br.width / 2 + "px", top: br.top + "px" });
    document.body.append(tag);
    setTimeout(() => tag.remove(), 1300);
  }, 650 + slots.length * 110);
}

// A banner that drops in across the top (e.g. "Hassan: 1 card to DIGU!").
// news of the table: a small note in the top-left corner (several stack up), never over the middle
function showBanner(text, emoji) {
  const box = $("fxCorner") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "fxCorner", className: "fx-corner" }));
  const b = document.createElement("div");
  b.className = "fx-banner";
  if (emoji) b.append(Object.assign(document.createElement("span"), { className: "fxb-emoji", textContent: emoji }));
  b.append(document.createTextNode(text));
  box.prepend(b);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => b.classList.add("bye"), 3000);
  setTimeout(() => b.remove(), 3400);
}

// DIGU! / CALL!: flash, spinning rays, the word slamming in with the winner's shout style,
// a shake, and confetti. Plays on every player's screen before the scores appear.
function playShout(r) {
  if (gameOf(r) === "bondi") return playBondiEnd(r);
  if (gameOf(r) === "dhiha") return playDhihaEnd(r);
  const call = gameOf(r) === "call" || gameOf(r) === "babbush";
  if (gameOf(r) === "babbush" && r.winner && !r._slapped) { r._slapped = true; return slapCard((r.bb?.rows?.[r.winner] || []).length ? r.bb.rows[r.winner] : null, r.winner, () => playShout(r)); }
  if (!call && r.diguCard && !r._slapped) { r._slapped = true; return slapCard(r.diguCard, r.winner, () => playShout(r)); }
  if (call && r.winner && !r._slapped) { // CALL: the caller slaps their whole hand down, face up
    r._slapped = true;
    const go = (cards) => slapCard(cards?.length ? cards : null, r.winner, () => playShout(r));
    if (r.winner === uid) return go([...hand]);
    getDoc(handRef(r.winner)).then((d) => go(d.data()?.cards), () => go(null));
    return;
  }
  const fx = document.createElement("div");
  fx.className = "shout-fx " + (call ? "is-call" : "is-digu");
  const rays = document.createElement("div");
  rays.className = "fx-rays";
  const callWord = gameOf(r) === "babbush" ? "BABUSH" : "CALL";
  const word = shoutEl(r.diguStyle, call ? callWord + "!" : thousandOf(r) ? "1000 DIGU!" : "DIGU!");
  word.classList.add("fx-word");
  const who = document.createElement("div");
  who.className = "fx-who";
  const winner = r.players.find((p) => p.uid === r.winner);
  who.textContent = r.winner === uid ? `You called ${call ? callWord : "DIGU"}!` : `${winner?.name || "Someone"} called ${call ? callWord : "DIGU"}`;
  fx.append(rays, word, who);
  confetti(fx, call);
  shakeAndFade(fx);
}

// DIGU! The winning card is lifted high and slapped down on the middle with a bang.
function slapCard(id, who, then) {
  const pile = $("discardPile"), src = seatOrHand(who) || pile;
  if (!pile || !pile.offsetParent) return then();
  const p = pile.getBoundingClientRect(), a = src.getBoundingClientRect();
  const w = 70, h = 100;
  const cx = p.left + p.width / 2, cy = p.top + p.height / 2;
  let el;
  if (Array.isArray(id) || !id) { // several cards (CALL: the caller's hand), fanned out
    const ids = Array.isArray(id) ? id : [null, null, null];
    el = Object.assign(document.createElement("div"), { className: "slap-group" });
    ids.forEach((c, i) => {
      const k = c ? cardEl(c) : Object.assign(document.createElement("div"), { className: "card back" });
      const a = (i - (ids.length - 1) / 2) * 14;
      Object.assign(k.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", margin: 0,
        transformOrigin: "50% 110%", transform: `rotate(${a}deg)` });
      el.append(k);
    });
  } else el = gameOf(room) === "digu" ? Object.assign(document.createElement("div"), { className: "card back" }) : cardEl(id); // DIGU: slammed down face down
  el.classList.add("flying", "slap-card");
  Object.assign(el.style, { position: "fixed", left: cx - w / 2 + "px", top: cy - h / 2 + "px", width: w + "px", height: h + "px", zIndex: 170, margin: 0 });
  document.body.append(el);
  const sx = a.left + a.width / 2 - cx, sy = a.top + a.height / 2 - cy;
  const up = Math.min(160, cy - 40);
  el.animate([
    { transform: `translate(${sx}px, ${sy}px) scale(.5) rotate(0deg)`, offset: 0 },
    { transform: `translate(0px, ${-up}px) scale(2.3) rotate(-18deg)`, offset: 0.45, easing: "ease-out" },
    { transform: `translate(0px, ${-up - 25}px) scale(2.4) rotate(-24deg)`, offset: 0.7, easing: "cubic-bezier(.7,0,1,.6)" }, // wind up...
    { transform: "translate(0,0) scale(1) rotate(-6deg)", offset: 0.9 },                                                        // ...SLAP
    { transform: "translate(0,0) scale(1.08) rotate(-4deg)", offset: 0.95 },
    { transform: "translate(0,0) scale(1) rotate(-5deg)", offset: 1 },
  ], { duration: 1100, fill: "forwards" });
  setTimeout(() => { // the impact
    const ring = Object.assign(document.createElement("div"), { className: "slap-ring" });
    const bang = Object.assign(document.createElement("div"), { className: "slap-bang", textContent: "💥" });
    for (const x of [ring, bang]) { Object.assign(x.style, { left: cx + "px", top: cy + "px" }); document.body.append(x); }
    ring.animate([{ transform: "translate(-50%,-50%) scale(.2)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(3.2)", opacity: 0 }], { duration: 600, easing: "ease-out" }).onfinish = () => ring.remove();
    bang.animate([{ transform: "translate(-50%,-50%) scale(.3)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(1.8)", opacity: 0 }], { duration: 550, easing: "ease-out" }).onfinish = () => bang.remove();
    for (let i = 0; i < 12; i++) { // dust flying out
      const d = Object.assign(document.createElement("span"), { className: "slap-dust" });
      Object.assign(d.style, { left: cx + "px", top: cy + "px" });
      document.body.append(d);
      const ang = (i / 12) * Math.PI * 2, dist = 60 + Math.random() * 50;
      d.animate([{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(.3)`, opacity: 0 }],
        { duration: 500 + Math.random() * 200, easing: "cubic-bezier(.2,.8,.3,1)" }).onfinish = () => d.remove();
    }
    const t = $("table") || document.body;
    t.animate([{ transform: "translate(0,0)" }, { transform: "translate(-7px,5px)" }, { transform: "translate(6px,-4px)" }, { transform: "translate(-4px,3px)" }, { transform: "translate(2px,-1px)" }, { transform: "translate(0,0)" }], { duration: 380 });
    if (navigator.vibrate) try { navigator.vibrate(80); } catch {}
  }, 990);
  setTimeout(() => {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).onfinish = () => el.remove();
    then();
  }, 1700);
}

function playBondiEnd(r) {
  const fx = document.createElement("div");
  fx.className = "shout-fx is-bondi";
  const rays = document.createElement("div");
  rays.className = "fx-rays";
  const word = shoutEl(null, "BONDI!");
  word.classList.add("fx-word");
  const who = document.createElement("div");
  who.className = "fx-who";
  const order = r.order || [];
  const first = order[0], last = order[order.length - 1];
  const nm = (u) => (u === uid ? "You" : r.players.find((p) => p.uid === u)?.name || "Someone");
  who.textContent = `🏆 ${nm(first)} went out first` + (last && last !== first ? ` · ${nm(last)} ${last === uid ? "are" : "is"} left holding cards` : "");
  fx.append(rays, word, who);
  confetti(fx, false);
  shakeAndFade(fx);
}

function confetti(fx, call) {
  const colors = call ? ["#63b3ed", "#90cdf4", "#ffffff", "#e8b64c", "#2b6cb0"] : ["#e8b64c", "#ffd76a", "#c8283a", "#ffffff", "#16a34a"];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("i");
    c.className = "fx-confetti";
    c.style.setProperty("--x", `${Math.random() * 100}vw`);
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 30}vw`);
    c.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    c.style.setProperty("--d", `${Math.random() * 0.6}s`);
    c.style.setProperty("--t", `${1.6 + Math.random() * 1.2}s`);
    c.style.background = colors[i % colors.length];
    if (i % 3 === 0) c.style.borderRadius = "50%";
    fx.append(c);
  }
}

function shakeAndFade(fx) {
  document.body.append(fx);
  $("game").classList.remove("shake"); void $("game").offsetWidth; $("game").classList.add("shake");
  setTimeout(() => fx.classList.add("fade"), RESULTS_DELAY - 500);
  setTimeout(() => fx.remove(), RESULTS_DELAY + 200);
}

// ---------- the hand: one row of overlapping cards, held like a real hand ----------
// Cards overlap just enough to fit the screen, each showing its number and suit in the corner,
// in a gentle arc. Tapping a card lifts it; tapping it again throws it.
function fanHand() {
  const box = $("hand");
  box.querySelector(".row-break")?.remove();
  const cards = [...box.querySelectorAll(".card")];
  const n = cards.length;
  if (!n) return;
  const W = box.clientWidth || 320;
  const cw = cards[0].offsetWidth || 64;
  const stepFor = (k) => (k > 1 ? Math.min(cw * 0.72, (W - cw - 8) / (k - 1)) : cw);
  // a big hand (e.g. BONDI with 2 players = 26 cards) on a narrow screen gets two rows,
  // so every card still shows enough to tap
  const two = n > 1 && stepFor(n) < 22;
  const split = two ? Math.ceil(n / 2) : n;
  const rows = two ? [[0, split], [split, n - split]] : [[0, n]];
  box.classList.toggle("two-rows", two);
  box._fan = { rows: rows.map(([from, count]) => {
    const step = stepFor(count);
    const tilt = Math.min(4, 36 / count);
    for (let j = 0; j < count; j++) {
      const el = cards[from + j], off = j - (count - 1) / 2;
      el.style.marginLeft = j ? `${step - cw}px` : "0";
      el.style.setProperty("--rot", `${off * tilt}deg`);
      el.style.setProperty("--y", `${Math.abs(off) * Math.abs(off) * 0.9}px`);
      el.style.zIndex = from + j + 1;
    }
    // where the row starts inside the hand box (it's centred), for rearranging by drag
    return { from, count, step, start: Math.max(0, (W - (cw + step * (count - 1))) / 2) };
  }) };
  if (two) cards[split].before(Object.assign(document.createElement("div"), { className: "row-break" }));
}
addEventListener("resize", () => { if (room) fanHand(); });

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
  if (canThrow() && (isCall() ? callSel.size && C.canThrowTogether([...callSel]) : selected)) {
    return throwCard(isCall() ? [...callSel] : selected);
  }
  if (mustThrowFirst()) return toast("Throw a card first");
  const el = e.target.closest(isCall() ? ".card.pick" : ".card.top");
  if (el) startDrag(e, "discard", el.dataset.id, el);
  else if (canDraw() && (isCall() ? !room.pickable : !room.discard?.length)) {
    toast(isCall() ? "No card from the last player to take · take from the middle pile" : "Nothing has been thrown yet · take from the middle pile");
  }
});

function makeGhost() {
  if (drag.src === "deck" || drag.src === "discard") {
    const w = drag.src === "deck" ? drag.el.offsetWidth : drag.el.offsetWidth, h = drag.el.offsetHeight;
    const g = Object.assign(document.createElement("div"), { className: "drag-flip ghost" });
    const inner = drag.src === "deck" ? Object.assign(document.createElement("div"), { className: "card back" }) : drag.el.cloneNode(true);
    inner.classList.remove("selected", "new", "clickable", "thrown", "top", "landing", "pick");
    inner.removeAttribute("id");
    Object.assign(inner.style, { width: "100%", height: "100%", margin: "0", position: "absolute", left: "0", top: "0", transform: "none" });
    g.append(inner);
    Object.assign(g.style, { width: w + "px", height: h + "px" });
    drag.offX = w / 2; drag.offY = h / 2;
    drag.inner = inner;
    drag.face = drag.src === "deck" ? (room.deck || []).at(-1) || null : null; // the card I'm about to take
    drag.flipped = drag.src !== "deck";
    drag.startY = drag.el.getBoundingClientRect().top + h / 2;
    document.body.append(g);
    drag.ghost = g;
    drag.el.classList.add("dragging");
    document.body.classList.add("is-dragging");
    return;
  }
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
  document.body.classList.add("is-dragging");
}

function dropTarget(e, d) {
  const t = document.elementFromPoint(e.clientX, e.clientY);
  if (d.src === "hand") {
    const handTop = $("hand").getBoundingClientRect().top;
    if (canThrow() && (t?.closest("#table") || e.clientY < handTop - 70)) return "throw";
    return null;
  }
  if (canDraw() && (t?.closest("#handSection") || e.clientY > $("table").getBoundingClientRect().bottom + 20)) return "draw";
  return null;
}

// where a card coming in from the middle would go, for the pointer's position over my hand
function insertSlot(e) {
  const box = $("hand"), hr = box.getBoundingClientRect(), f = box._fan;
  if (!f || !hand.length) return hand.length;
  let row = f.rows[0];
  if (f.rows.length > 1) {
    const second = box.querySelectorAll(".card")[f.rows[1].from];
    if (second && e.clientY > second.getBoundingClientRect().top + 12) row = f.rows[1];
  }
  const k = Math.round((e.clientX - hr.left - row.start) / row.step);
  return row.from + Math.max(0, Math.min(row.count, k));
}
function showInsertMark(slot) {
  let m = $("insertMark");
  if (slot == null) { m?.remove(); return; }
  if (!m) { m = Object.assign(document.createElement("div"), { id: "insertMark", className: "insert-mark" }); document.body.append(m); }
  const cards = $("hand").querySelectorAll(".card");
  const ref = cards[Math.min(slot, cards.length - 1)];
  if (!ref) { m.remove(); return; }
  const r = ref.getBoundingClientRect();
  const x = slot >= cards.length ? r.right + 2 : r.left - 2;
  Object.assign(m.style, { left: x - 2 + "px", top: r.top - 6 + "px", height: r.height + 12 + "px" });
}

// Move the dragged card to the spot under the pointer (like rearranging cards in your real hand).
// The fan has fixed slots (they don't move when cards swap), so the same finger position
// always means the same spot and the hand stays still while you slide.
function placeInHand(e) {
  const box = $("hand"), hr = box.getBoundingClientRect();
  if (e.clientX < hr.left - 40 || e.clientX > hr.right + 40 || e.clientY < hr.top - 60 || e.clientY > hr.bottom + 40) return;
  const f = box._fan;
  if (!f || hand.length < 2) return;
  let row = f.rows[0];
  if (f.rows.length > 1) {
    const second = box.querySelectorAll(".card")[f.rows[1].from];
    if (second && e.clientY > second.getBoundingClientRect().top + 12) row = f.rows[1];
  }
  const slot = row.from + Math.max(0, Math.min(row.count - 1, Math.floor((e.clientX - hr.left - row.start) / row.step)));
  const cur = hand.indexOf(drag.id);
  if (cur < 0 || slot === cur) return;
  const rest = hand.filter((c) => c !== drag.id);
  hand = [...rest.slice(0, slot), drag.id, ...rest.slice(slot)];
  render();
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
  if (drag.src === "deck" && !drag.flipped && drag.face && canDraw()) { // halfway to my hand: it turns over
    const handTop = $("hand").getBoundingClientRect().top;
    if (e.clientY > drag.startY + (handTop - drag.startY) * 0.45) {
      drag.flipped = true;
      const inner = drag.inner, face = cardEl(drag.face);
      Object.assign(face.style, { width: "100%", height: "100%", margin: "0", position: "absolute", left: "0", top: "0" });
      inner.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(90deg)" }], { duration: 110, easing: "ease-in" }).onfinish = () => {
        inner.replaceWith(face); drag && (drag.inner = face);
        face.animate([{ transform: "rotateY(-90deg)" }, { transform: "rotateY(0deg)" }], { duration: 130, easing: "ease-out" });
      };
    }
  }
  const t = dropTarget(e, drag);
  if (drag.src !== "hand") showInsertMark(t === "draw" && e.clientY > $("hand").getBoundingClientRect().top - 40 ? insertSlot(e) : null);
  $("discardPile").classList.toggle("drop-hover", t === "throw");
  $("hand").classList.toggle("drop-hover", t === "draw");
}, { passive: false });

function endDrag(d) {
  d.ghost?.remove();
  showInsertMark(null);
  d.el?.classList.remove("dragging");
  document.body.classList.remove("is-dragging");
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
      // tapping a card that's already lifted throws it (with any others picked in CALL)
      if (needsDrawFirst() && selected === d.id) return takeFirstHint();
      if (canThrow() && (isCall() ? callSel.has(d.id) : selected === d.id)) {
        if (isCall()) {
          if (C.canThrowTogether([...callSel])) return throwCard([...callSel]);
        } else return throwCard(d.id);
      }
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
  let t = dropTarget(e, d);
  // a card from the middle pile that has already turned over (I've seen it) can't be put back
  if (d.src === "deck" && d.flipped && d.face && t !== "draw" && canDraw()) t = "draw";
  if (t === "throw") throwCard(isCall() && callSel.has(d.id) ? [...callSel] : [d.id]);
  else if (d.src === "hand" && d.moved && needsDrawFirst() && e.clientY < $("hand").getBoundingClientRect().top - 70) takeFirstHint();
  else if (t === "draw") {
    // dropped over my hand: the new card goes into that spot
    if (e.clientY > $("hand").getBoundingClientRect().top - 40) { pendingInsert = { at: insertSlot(e), until: Date.now() + 5000 }; drawnByDrag = true; }
    draw(d.src);
    if (drawnByDrag) drawnByDrag = false; // (the draw didn't happen)
    setTimeout(() => { if (pendingInsert && Date.now() > pendingInsert.until) pendingInsert = null; }, 5200);
    render();
  }
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
$("loungeRenameBtn").onclick = renameLounge;
$("loungeDeleteBtn").onclick = deleteLounge;
$("chatForm").onsubmit = sendChat;
$("chatBtn").onclick = () => { chatOpen = !chatOpen; chatKey = null; renderChat(); if (chatOpen) setTimeout(() => { const l = $("chatList"); l.scrollTop = l.scrollHeight; }, 0); };
$("chatClose").onclick = (e) => { e.preventDefault(); chatOpen = false; renderChat(); };
$("seatStart").onclick = startTable;
$("seatLeave").onclick = standUpAndStep;
$("lobbyFloor").addEventListener("click", onFloorTap);
addEventListener("resize", () => { clearTimeout(renderFloor.t); renderFloor.t = setTimeout(() => { walkerEls.forEach((el) => (el._pos = null)); renderFloor(); }, 150); });
$("joinBtn").onclick = () => joinRoom($("code").value);
$("tourneyCreate").onclick = createTournament;
$("tourneyJoin").onclick = () => joinTournament($("tourneyCode").value);
$("tourneyClose").onclick = closeTournament;
$("authForgot").onclick = forgotPassword;
$("musicBtn").onclick = () => { setMuted(!isMuted()); store("thaas-music", isMuted() ? "off" : "on"); toast(isMuted() ? "🔇 Music off" : "🔊 Music on"); syncMusic(); };
$("tourneyBtn").onclick = $("resTourneyBtn").onclick = () => { if (room?.tourney) { $("results").hidden = true; openTournament(room.tourney.code); } };
$("code").addEventListener("keydown", (e) => e.key === "Enter" && joinRoom($("code").value));
$("startBtn").onclick = dealRound;
$("pauseBtn").onclick = togglePause;
$("offlineRemove").onclick = () => decideOffline(true);
$("offlineKeep").onclick = () => decideOffline(false);
$("endGameBtn").onclick = endGameNow;
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
$("premiumBtn").onclick = openPremium;
$("premEye").onclick = () => { premOpen = !premOpen; $("premiumPanel")._key = null; $("premiumBody")._key = null; renderPremTools(); renderPremiumPanel(); };
$("premTip").onclick = showTip;
$("premiumClose").onclick = () => ($("premiumModal").hidden = true);
$("premSave").onclick = savePremiumCfg;
$("premiumCopy").onclick = () => navigator.clipboard?.writeText(uid).then(() => toast("Player ID copied"), () => {});
$("adminClose").onclick = () => ($("adminModal").hidden = true);
$("adminSearch").addEventListener("input", renderAdmin);
$("adminFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  adminFilter = b.dataset.f;
  $("adminFilters").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  renderAdmin();
});
$("adminRefresh").onclick = () => { adminLounges = null; openAdmin(); };
$("adminCleanGuests").onclick = async () => {
  if (!confirm("Remove every guest who hasn't been active in the last 15 minutes? Registered players are never removed.")) return;
  try {
    const r = await runCleanup(true);
    if (!r?.ok) throw new Error(r?.error || "The cleanup service isn't reachable");
    toast(`🧹 ${r.removed} guest${r.removed === 1 ? "" : "s"} removed`);
    openAdmin();
  } catch (e) { toast(errMsg(e)); }
};
$("adminUpdateAlert").onclick = async () => {
  const picked = [...adminPick];
  const text = prompt(picked.length ? `Notification text for the ${picked.length} selected player${picked.length === 1 ? "" : "s"}:` : "Notification text for EVERY phone with the THAAS app (tick players first to send to only them):", "New features and fixes are ready. Open THAAS to update.");
  if (text === null) return;
  try {
    if (!NOTIFY_URL || !auth.currentUser) throw new Error("The notification service isn't set up");
    const r = await fetch(NOTIFY_URL, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
      body: JSON.stringify({ roomId: "-", kind: "update", text, version: APP_VERSION, ...(picked.length ? { to: picked } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Sending failed");
    const by = j.by ? Object.entries(j.by).filter(([, n]) => n).map(([k, n]) => `${n} ${{ android: "Android", ios: "iPhone", web: "browser", unknown: "older Android" }[k] || k}`).join(", ") : "";
    toast(!j.sent && !j.failed ? "📣 None of these players has turned on notifications yet"
      : `📣 Sent to ${j.sent} phone${j.sent === 1 ? "" : "s"}${by ? ` (${by})` : ""}${j.failed ? ` · ${j.failed} failed${j.error ? ": " + j.error : ""}` : ""}`, 9000);
    if (picked.length) { adminPick.clear(); syncPickLabel(); renderAdmin(); }
  } catch (e) { toast(errMsg(e)); }
};
$("loungeOfflineMins").onchange = () => {
  if (!room || !ownsLounge(room)) return;
  const v = Number($("loungeOfflineMins").value);
  if (!(v > 0)) return;
  updateDoc(roomRef(), { offlineMins: v, log: `${nameOf(uid)} set the offline time to ${v === 2.5 ? "2½" : v} minute${v === 1 ? "" : "s"}` })
    .then(() => toast(`⏱️ Offline players are now removed after ${v === 2.5 ? "2½" : v} minute${v === 1 ? "" : "s"}`)).catch((e) => toast(errMsg(e)));
};
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
$("gameBondi").onclick = () => setGame("bondi");
$("gameDhiha").onclick = () => setGame("dhiha");
$("gameBabbush").onclick = () => setGame("babbush");
$("diguBtn").onclick = onDigu;
$("almostBtn").onclick = announceAlmost;
$("leaveBtn").onclick = exitRoom;
for (const g of ["digu", "call", "bondi"]) {
  $("enter-" + g).onclick = () => openLobby(g);
  $("tab-" + g).onclick = () => switchLobby(g);
}
$("seatFind").onclick = () => findSeat(lobbyGame);
$("botBtn").onclick = openBotModal;
$("resultsLeave").onclick = () => { $("results").hidden = true; exitRoom(); };
$("aloneBotBtn").onclick = openBotModal;
$("botClose").onclick = () => ($("botModal").hidden = true);
$("botForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  startPractice(["call", "bondi", "babbush"].includes(f.get("game")) ? f.get("game") : "digu", Number(f.get("bots")) || 1,
    ["easy", "hard"].includes(f.get("level")) ? f.get("level") : "medium");
});
$("lobbyBackBtn").onclick = closeLobby;
$("name").addEventListener("change", () => { renderWalkers(); writePresence(); });

$("copyCode").onclick = async () => {
  const base = BUNDLED_APP ? (CFG.siteUrl || "").replace(/\/?$/, "/") : `${location.origin}${location.pathname}`;
  const own = room && ownsLounge(room) && myInvite.code === roomId;
  if (room && isLoungeDoc(room) && !own) return toast("🔒 Only the owner can invite people to this holhuashi");
  const link = `${base}#${roomId}${own ? "-" + myInvite.key : ""}`;
  try { await navigator.clipboard.writeText(link); toast("Invite link copied"); }
  catch { toast(link); }
};

// ---------- Android app: push notifications ----------
// In the Android app (Capacitor), the phone registers for push and saves its token on the player's
// profile. After a move, the mover asks the server (api/notify on Vercel) to alert the right players.
// The server checks the sender really is at that table, so nobody can send fake alerts.
const IS_APP = !!window.Capacitor?.isNativePlatform?.();
// The app normally loads the live website (so website updates reach it straight away); then it can
// use the site's own /api/notify. A copy of the game bundled inside the app runs on "localhost" and
// needs the full address from firebase-config.js.
const BUNDLED_APP = IS_APP && location.hostname === "localhost";
const NOTIFY_URL = BUNDLED_APP ? (CFG.notifyUrl && !CFG.notifyUrl.includes("PASTE") ? CFG.notifyUrl : "") : "/api/notify";
// The app tells the website whether this build can use push (?push=1); remember it for this visit.
const PUSH_PARAM = (() => {
  const v = new URLSearchParams(location.search).get("push");
  try { if (v !== null) sessionStorage.setItem("thaas-push", v); return v ?? sessionStorage.getItem("thaas-push"); }
  catch { return v; }
})();
let pushToken = null, pushReady = false;

// Push alerts only for requests (someone joined my holhuashi / sat at my table), never for moves in a
// game that's already being played: the players are looking at the screen anyway.
const PUSH_KINDS = new Set(["join", "sit"]);
async function sendNotify(kind, code = roomId) {
  if (!PUSH_KINDS.has(kind)) return;
  if (!NOTIFY_URL || !code || !auth.currentUser || (room?.practice && code === roomId)) return;
  try {
    const token = await auth.currentUser.getIdToken();
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ roomId: code, kind }),
    });
  } catch { /* notifications are a bonus; the game never waits for them */ }
}

// ---------- Web push (iPhone home-screen app, and Chrome/Edge/Firefox on any device) ----------
// iPhone: only works when THAAS was added to the Home Screen (Share → Add to Home Screen), iOS 16.4+.
// Needs `export const vapidKey = "…"` in firebase-config.js (Firebase → Project settings → Cloud Messaging
// → Web Push certificates → Generate key pair).
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_STANDALONE = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const WEB_PUSH_OK = !IS_APP && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  && !!CFG.vapidKey && !String(CFG.vapidKey).includes("PASTE");
let swReg = null, webPushBusy = false;
if (!IS_APP && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data?.thaasPush;
    if (!d) return;
    if (d.kind === "update") checkForUpdate(); else if (d.roomId) openFromPush(d.roomId);
  });
}
{ // a tapped notification opened a fresh window
  const q = new URLSearchParams(location.search).get("push");
  if (q && q !== "0" && q !== "1") setTimeout(() => openFromPush(q), 2500);
}
let webPushErr = "", webPushToken = "";
async function enableWebPush(ask) {
  if (!WEB_PUSH_OK || webPushBusy || !uid) return false;
  webPushBusy = true;
  try {
    let perm = Notification.permission;
    if (perm === "default" && ask) perm = await Notification.requestPermission();
    if (perm !== "granted") return false;
    const reg = swReg || await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const { getMessaging, getToken, isSupported } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
    if (isSupported && !(await isSupported())) throw new Error("this browser can't receive notifications");
    const t = await getToken(getMessaging(app), { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
    if (!t) throw new Error("no notification address was given");
    pushToken = webPushToken = t; webPushErr = "";
    await savePushToken();
    return true;
  } catch (e) {
    console.warn("web push", e);
    webPushErr = e?.code || e?.message || String(e);
    if (ask) toast("Couldn't turn on notifications: " + webPushErr);
    return false;
  } finally { webPushBusy = false; syncWebPushBar(); }
}
// what the 🔔 bar says: always tells the player why notifications aren't working yet
function webPushState() {
  if (IS_APP || !uid) return null;
  if (IS_IOS && !IS_STANDALONE) return { text: "🔔 Want notifications on iPhone? Tap Share ⬆️ → Add to Home Screen, then open THAAS from that icon." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return IS_IOS ? { text: "🔔 Notifications need iOS 16.4 or newer (Settings → General → Software Update)." } : null;
  if (!WEB_PUSH_OK) return IS_IOS ? { text: "🔔 Notifications aren't switched on for THAAS yet (the admin needs to add the web push key)." } : null;
  if (Notification.permission === "denied") return { text: IS_IOS ? "🔕 Notifications are blocked. Turn them on in iPhone Settings → Notifications → THAAS." : "🔕 Notifications are blocked for this site in your browser settings." };
  if (Notification.permission === "default") return { text: "🔔 Get a notification when someone joins your holhuashi or sits at your table, and when THAAS updates.", btn: "Turn on" };
  if (webPushErr) return { text: "⚠ Notifications couldn't start: " + webPushErr, btn: "Try again" };
  if (!webPushToken) return null; // getting ready
  return null; // all good
}
function syncWebPushBar() {
  const bar = $("webPushBar");
  if (!bar) return;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem("thaas-webpush-x") === "1"; } catch {}
  const st = dismissed ? null : webPushState();
  if (!st) { bar.hidden = true; return; }
  $("webPushText").textContent = st.text;
  $("webPushBtn").hidden = !st.btn;
  if (st.btn) $("webPushBtn").textContent = st.btn;
  bar.hidden = false;
}
async function testPush() {
  try {
    const r = await fetch(NOTIFY_URL, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
      body: JSON.stringify({ roomId: "-", kind: "test" }) });
    const j = await r.json().catch(() => ({}));
    toast(j.sent ? "🔔 Notifications are on · a test is on its way" : `⚠ Test notification failed: ${j.error || r.status}`);
  } catch (e) { toast("⚠ Test notification failed: " + (e.message || e)); }
}
$("webPushBtn").onclick = () => enableWebPush(true).then((ok) => ok && testPush());
$("webPushX").onclick = () => { try { sessionStorage.setItem("thaas-webpush-x", "1"); } catch {} $("webPushBar").hidden = true; };
// keep trying quietly until this phone is registered (sign-in can finish after the page loads)
setInterval(() => {
  syncWebPushBar();
  if (WEB_PUSH_OK && uid && !webPushToken && !webPushErr && Notification.permission === "granted") enableWebPush(false);
}, 4000);
let pushSavedFor = "";

function savePushToken() {
  if (!pushToken || !uid) return;
  // kept in its own private place: only this player (and the server) can read it
  // also note which kind of phone it is, so the admin can see who an alert reached
  const kind = IS_APP ? "android" : IS_IOS ? "ios" : "web";
  pushSavedFor = uid;
  return setDoc(doc(db, "pushTokens", uid), { tokens: arrayUnion(pushToken), [kind]: arrayUnion(pushToken) }, { merge: true })
    .catch((e) => { console.warn("push token not saved", e); webPushErr = "couldn't save: " + (e.code || e.message); });
}

async function setupPush() {
  const PN = window.Capacitor?.Plugins?.PushNotifications;
  if (!IS_APP || !PN || pushReady) return;
  pushReady = true;
  // Only builds that include google-services.json can use push; asking without it crashes the app.
  const enabled = PUSH_PARAM !== null
    ? PUSH_PARAM === "1"
    : !!(await fetch("push-enabled.json").then((r) => (r.ok ? r.json() : null)).catch(() => null))?.enabled;
  if (!enabled) { console.warn("Push notifications are off in this build (no google-services.json)"); return; }
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
    await PN.addListener("pushNotificationActionPerformed", ({ notification }) => (notification?.data?.kind === "update" ? checkForUpdate() : openFromPush(notification?.data?.roomId)));
    await PN.register();
  } catch (e) { console.warn("Push setup failed", e); }
}

async function openFromPush(code) {
  if (!code || !uid || code === roomId) return;
  const snap = await getDoc(doc(db, "rooms", code)).catch(() => null);
  if (snap?.exists() && snap.data().playerIds?.includes(uid)) enterRoom(code);
  else if (LOBBY_TABLES.some((t) => t.id === code)) openLobby(LOBBY_TABLES.find((t) => t.id === code).game);
}

// ---------- start ----------
$("name").value = load("digu-name") || "";
// On start, Firebase first loads the saved sign-in (Remember me). Only if nobody is signed in on this
// device do we start as a guest; signing in a guest straight away would replace the saved player.
let authChecked = false;
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // first visit, or my saved login stopped working (e.g. a guest account that was tidied away, so
    // Google answers "400 Bad Request" when renewing it): carry on as a new guest straight away
    const lost = authChecked && !signingOut && !!uid;
    if (!authChecked || lost) {
      authChecked = true;
      if (lost) { uid = null; profile = {}; if (roomId) { try { leaveRoom(); } catch {} } toast("Your guest session ended · you're playing as a new guest"); }
      signInAnonymously(auth).catch((e) => toast("Sign-in failed: " + errMsg(e)));
    }
    return;
  }
  authChecked = true;
  const changed = uid !== user.uid;
  uid = user.uid;
  if (changed) {
    profile = {}; watchMyStats(); watchRoles(); watchOpenRooms();
    setupPush();
    savePushToken(); // signed in as someone else: this phone now gets their alerts
    if (lobbyFromHash(location.hash)) setTimeout(() => openLobby(lobbyFromHash(location.hash)), 50);
  }
  renderAccount();
  $("lobbyActions").classList.remove("loading");
  const code = location.hash.slice(1).toUpperCase();
  if (/^[A-Z0-9]{5}-[A-Z0-9]{4}$/.test(code) && !roomId) { // an invite link
    $("code").value = code;
    if (myName()) joinRoom(code);
    else toast("Type your name, then press Join to enter the holhuashi");
  } else if (code && !roomId) {
    $("code").value = code;
    // rejoin automatically if I'm already in it (page reload)
    const snap = await getDoc(doc(db, "rooms", code)).catch(() => null);
    if (snap?.exists() && snap.data().playerIds.includes(uid)) enterRoom(code);
  }
});
// (guest sign-in happens above, only once Firebase has said nobody is signed in)

// Remember me: fill in the email and the tick from last time
$("authRemember").checked = load("thaas-remember") !== "0";
if (!$("authEmail").value) $("authEmail").value = load("thaas-email") || "";

// ---------- language: English / ދިވެހި ----------
// tr("key", "English") → the Dhivehi text when Dhivehi is on (and translated), else the English
function tr(key, en) { return document.body.classList.contains("lang-dv") && DV[key] ? DV[key] : en; }
const gameWord = (g) => tr("game." + g, GAME_NAME[g]);
// Elements marked data-i18n="key" switch to the Dhivehi text in i18n.js (right to left).
function setLang(lang) {
  const dv = lang === "dv";
  document.body.classList.toggle("lang-dv", dv);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (el.dataset.en === undefined) el.dataset.en = el.innerHTML;
    const t = DV[el.dataset.i18n];
    if (dv && t) { el.textContent = t; el.dir = "rtl"; el.lang = "dv"; }
    else { el.innerHTML = el.dataset.en; el.removeAttribute("dir"); el.removeAttribute("lang"); }
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    if (el.dataset.enPh === undefined) el.dataset.enPh = el.placeholder;
    const t = DV[el.dataset.i18nPh];
    el.placeholder = dv && t ? t : el.dataset.enPh;
    el.dir = dv && t ? "rtl" : "";
  });
  try { renderAccount(); renderFloor(); } catch {} // texts the game sets itself
  $("langEn").classList.toggle("on", !dv);
  $("langDv").classList.toggle("on", dv);
  store("thaas-lang", lang);
}
$("langEn").onclick = () => setLang("en");
$("langDv").onclick = () => setLang("dv");
setLang(load("thaas-lang") === "dv" ? "dv" : "en");
window.__thaasStarted = true; document.getElementById("bootErr")?.remove();
