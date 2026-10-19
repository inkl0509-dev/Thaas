// THAAS storage layer.
// The game talks to this file with the same calls it used for Firestore (doc, getDoc, updateDoc,
// onSnapshot, runTransaction, writeBatch …). Card tables — rooms, players' hands, holhuashi invites —
// are stored in Firebase Realtime Database (faster for live games, knows instantly when a phone
// disconnects). Everything else (accounts, profiles, Premium, admin, notes) stays in Firestore.
// If no Realtime Database address is configured, everything stays in Firestore as before.
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc as fsDoc, getDoc as fsGetDoc, setDoc as fsSetDoc, updateDoc as fsUpdateDoc, deleteDoc as fsDeleteDoc,
  onSnapshot as fsOnSnapshot, runTransaction as fsRunTransaction, collection as fsCollection, getDocs as fsGetDocs,
  writeBatch as fsWriteBatch, serverTimestamp as fsServerTimestamp, increment as fsIncrement, query as fsQuery,
  where as fsWhere, arrayUnion as fsArrayUnion, arrayRemove as fsArrayRemove, deleteField as fsDeleteField,
  disableNetwork as fsDisableNetwork, enableNetwork as fsEnableNetwork,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getDatabase, ref as rRef, get as rGet, set as rSet, update as rUpdate, remove as rRemove, onValue as rOnValue,
  runTransaction as rTransaction, serverTimestamp as rServerTimestamp, increment as rIncrement,
  query as rQuery, orderByChild, equalTo, limitToLast, onDisconnect, goOnline, goOffline,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

export { initializeFirestore, persistentLocalCache, persistentMultipleTabManager };

let fdb = null, rdb = null, rtOffset = 0, rtOffsetKnown = false;
// The Realtime Database address. If the config doesn't give one, the project's default database in
// Singapore (asia-southeast1) is used.
export function databaseUrlFor(cfg = {}, extra = "") {
  if (extra === false || cfg.databaseURL === false) return "";
  return cfg.databaseURL || extra || (cfg.projectId && !/PASTE/.test(cfg.projectId)
    ? `https://${cfg.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app` : "");
}
export function initStore(app, firestoreDb, databaseURL) {
  fdb = firestoreDb;
  if (databaseURL) {
    try {
      rdb = getDatabase(app, databaseURL);
      rOnValue(rRef(rdb, ".info/serverTimeOffset"), (s) => { rtOffset = Number(s.val()) || 0; rtOffsetKnown = true; });
    } catch (e) { console.warn("Realtime Database not available, using Firestore", e); rdb = null; }
  }
  return !!rdb;
}
export const usingRealtime = () => !!rdb;
// how far this phone's clock is from the server's (null until known)
export const serverClockOffset = () => (rdb && rtOffsetKnown ? rtOffset : null);
const rtNow = () => Date.now() + rtOffset;

// ---------- where things live ----------
// rooms/X → rooms/X · rooms/X/hands/U → hands/X/U · rooms/X/joins/U → joins/X/U · rooms/X/secret/invite → secrets/X
// presence/U (who's walking in Aammu Jagaha) · lobbyNotes/N · lastSeen/U also live there: they change
// often and are read by everyone, which is cheap in Realtime Database and costly in Firestore.
const RT_LISTS = ["presence", "lobbyNotes", "lastSeen"];
function rtPath(segs) {
  if (rdb && RT_LISTS.includes(segs[0]) && segs.length <= 2) return segs.join("/");
  if (!rdb || segs[0] !== "rooms") return null;
  if (segs.length === 1) return "rooms";
  if (segs.length === 2) return `rooms/${segs[1]}`;
  const [, code, sub, id] = segs;
  if (sub === "hands") return id ? `hands/${code}/${id}` : `hands/${code}`;
  if (sub === "joins") return id ? `joins/${code}/${id}` : `joins/${code}`;
  if (sub === "secret") return `secrets/${code}`;
  return null;
}
export function doc(db, ...segs) {
  const path = segs.join("/"), rt = rtPath(segs);
  return { path, id: segs[segs.length - 1], rt, fs: rt ? null : fsDoc(fdb, ...segs) };
}
export function collection(db, ...segs) {
  const rt = rtPath(segs);
  return { path: segs.join("/"), coll: true, rt, fs: rt ? null : fsCollection(fdb, ...segs) };
}
export function where(field, op, value) { return { field, op, value, fs: fsWhere(field, op, value) }; }
export function query(c, ...filters) {
  if (c.rt) return { ...c, filters };
  return { fsq: fsQuery(c.fs, ...filters.map((f) => f.fs)) };
}

// ---------- special values ----------
export const serverTimestamp = () => ({ __s: "ts" });
export const increment = (n) => ({ __s: "inc", n });
export const arrayUnion = (...v) => ({ __s: "union", v });
export const arrayRemove = (...v) => ({ __s: "remove", v });
export const deleteField = () => ({ __s: "del" });
const isS = (v) => v && typeof v === "object" && typeof v.__s === "string";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function toFs(v) {
  if (isS(v)) return v.__s === "ts" ? fsServerTimestamp() : v.__s === "inc" ? fsIncrement(v.n)
    : v.__s === "union" ? fsArrayUnion(...v.v) : v.__s === "remove" ? fsArrayRemove(...v.v) : fsDeleteField();
  if (Array.isArray(v)) return v.map(toFs);
  if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)]));
  return v;
}
// a whole value for Realtime Database (set): special values become real ones
function toRtValue(v) {
  if (isS(v)) return v.__s === "ts" ? rServerTimestamp() : v.__s === "inc" ? v.n : v.__s === "union" ? v.v : v.__s === "remove" ? [] : null;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(toRtValue);
  if (plain(v)) { const o = {}; for (const [k, x] of Object.entries(v)) { const y = toRtValue(x); if (y !== null && y !== undefined) o[k] = y; } return o; }
  return v === undefined ? null : v;
}
const needsTx = (upd) => Object.values(upd).some((v) => isS(v) && (v.__s === "union" || v.__s === "remove"));
// apply an update to a value here (used inside transactions)
function applyLocal(cur, upd) {
  const d = cur ? JSON.parse(JSON.stringify(cur)) : {};
  for (const [k, val] of Object.entries(upd)) {
    const parts = k.split("."); let o = d;
    for (const p of parts.slice(0, -1)) { if (!plain(o[p])) o[p] = {}; o = o[p]; }
    const last = parts[parts.length - 1];
    if (isS(val)) {
      if (val.__s === "del") delete o[last];
      else if (val.__s === "ts") o[last] = rtNow();
      else if (val.__s === "inc") o[last] = (Number(o[last]) || 0) + val.n;
      else if (val.__s === "union") { const a = Array.isArray(o[last]) ? o[last] : []; o[last] = [...a, ...val.v.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))]; }
      else if (val.__s === "remove") { const ks = val.v.map((x) => JSON.stringify(x)); o[last] = (Array.isArray(o[last]) ? o[last] : []).filter((x) => !ks.includes(JSON.stringify(x))); }
    } else o[last] = JSON.parse(JSON.stringify(toRtLocal(val)));
  }
  return d;
}
function toRtLocal(v) { // like toRtValue but timestamps as numbers (inside a transaction)
  if (isS(v)) return v.__s === "ts" ? rtNow() : v.__s === "inc" ? v.n : v.__s === "union" ? v.v : v.__s === "remove" ? [] : null;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(toRtLocal);
  if (plain(v)) { const o = {}; for (const [k, x] of Object.entries(v)) { const y = toRtLocal(x); if (y !== null && y !== undefined) o[k] = y; } return o; }
  return v === undefined ? null : v;
}
// lookup maps the security rules need (they can't search lists)
const asSet = (a) => (Array.isArray(a) && a.length ? Object.fromEntries(a.filter((x) => typeof x === "string").map((u) => [u, true])) : null);
function withIndexes(room) {
  if (!room) return room;
  room.pids = asSet(room.playerIds); room.mset = asSet(room.members); room.rset = asSet(room.removed);
  for (const k of ["pids", "mset", "rset"]) if (!room[k]) delete room[k];
  return room;
}

// ---------- reading ----------
const ROOM_LISTS = ["players", "playerIds", "deck", "discard", "trick", "chat", "members", "removed", "eliminated", "out"];
function norm(rt, v) {
  if (v === null || v === undefined) return v;
  if (rt.startsWith("rooms/")) {
    const r = { ...v };
    for (const k of ROOM_LISTS) if (r[k] == null) r[k] = []; else if (!Array.isArray(r[k]) && typeof r[k] === "object") r[k] = Object.values(r[k]);
    if (r.decks) { r.decks = { A: r.decks.A ? Object.values(r.decks.A) : [], B: r.decks.B ? Object.values(r.decks.B) : [] }; }
    return r;
  }
  if (rt.startsWith("hands/")) return { ...v, cards: v.cards ? Object.values(v.cards) : [] };
  return v;
}
const snapOf = (ref, v) => {
  const val = norm(ref.rt, v);
  return { id: ref.id, exists: () => val !== null && val !== undefined, data: () => (val == null ? undefined : JSON.parse(JSON.stringify(val))),
    metadata: { fromCache: false, hasPendingWrites: false }, ref };
};
export async function getDoc(ref) {
  if (!ref.rt) return fsGetDoc(ref.fs);
  const s = await rGet(rRef(rdb, ref.rt));
  return snapOf(ref, s.val());
}
function listOf(collRt, obj, filters = []) {
  const docs = Object.entries(obj || {}).map(([id, v]) => snapOf({ id, rt: `${collRt}/${id}` }, v))
    .filter((d) => filters.every((f) => {
      const x = d.data()?.[f.field];
      return f.op === "==" ? x === f.value : f.op === "in" ? f.value.includes(x) : f.op === "array-contains" ? Array.isArray(x) && x.includes(f.value) : true;
    }));
  return docs;
}
async function rtQueryDocs(q) {
  const f = q.filters || [];
  const owner = f.find((x) => x.field === "owner" && x.op === "==");
  const pub = f.find((x) => x.field === "public" && x.op === "==");
  const mem = f.find((x) => x.field === "members" && x.op === "array-contains");
  if (q.rt === "rooms" && mem) { // holhuashis I've joined: from my own list
    const mine = (await rGet(rRef(rdb, `memberOf/${mem.value}`))).val() || {};
    const out = {};
    await Promise.all(Object.keys(mine).map(async (code) => { const v = (await rGet(rRef(rdb, `rooms/${code}`))).val(); if (v) out[code] = v; }));
    return listOf("rooms", out, f);
  }
  let src = rRef(rdb, q.rt);
  if (q.rt === "rooms" && owner) src = rQuery(src, orderByChild("owner"), equalTo(owner.value));
  else if (q.rt === "rooms" && pub) src = rQuery(src, orderByChild("public"), equalTo(pub.value));
  return listOf(q.rt, (await rGet(src)).val(), f);
}
const querySnap = (docs, changes = []) => ({ docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn), docChanges: () => changes });
export async function getDocs(q) {
  if (q.fsq) return fsGetDocs(q.fsq);
  if (!q.rt) return fsGetDocs(q.fs);
  return querySnap(await rtQueryDocs(q));
}
export function onSnapshot(target, a, b, c) {
  const opts = plain(a) && !a.__s && typeof a !== "function" ? a : null;
  const next = opts ? b : a, err = opts ? c : b;
  if (target.fsq) return opts ? fsOnSnapshot(target.fsq, opts, next, err) : fsOnSnapshot(target.fsq, next, err);
  if (!target.rt) return opts ? fsOnSnapshot(target.fs, opts, next, err) : fsOnSnapshot(target.fs, next, err);
  if (!target.coll) return rOnValue(rRef(rdb, target.rt), (s) => next(snapOf(target, s.val())), err);
  // a list of rooms (the lobby tables)
  const f = target.filters || [];
  const pub = f.find((x) => x.field === "public" && x.op === "==");
  let src = rRef(rdb, target.rt);
  if (target.rt === "rooms" && pub) src = rQuery(src, orderByChild("public"), equalTo(pub.value));
  if (target.rt === "lobbyNotes") src = rQuery(src, orderByChild("at"), limitToLast(40)); // only the newest
  let last = new Map();
  return rOnValue(src, (s) => {
    const docs = listOf(target.rt, s.val(), f);
    const now = new Map(docs.map((d) => [d.id, JSON.stringify(d.data())]));
    const changes = [];
    for (const d of docs) if (last.get(d.id) !== now.get(d.id)) changes.push({ type: last.has(d.id) ? "modified" : "added", doc: d });
    for (const id of last.keys()) if (!now.has(id)) changes.push({ type: "removed", doc: { id } });
    last = now;
    next(querySnap(docs, changes));
  }, err);
}

// ---------- writing ----------
function flatUpdate(ref, upd) { // Firestore-style update → Realtime Database paths
  const out = {};
  for (const [k, v] of Object.entries(upd)) out[`${ref.rt}/${k.split(".").join("/")}`] = isS(v)
    ? (v.__s === "ts" ? rServerTimestamp() : v.__s === "inc" ? rIncrement(v.n) : null) : toRtValue(v);
  if (ref.rt.startsWith("rooms/") && ref.rt.split("/").length === 2) {
    out[`${ref.rt}/_rev`] = rIncrement(1);
    if ("playerIds" in upd) out[`${ref.rt}/pids`] = asSet(upd.playerIds);
    if ("members" in upd && Array.isArray(upd.members)) out[`${ref.rt}/mset`] = asSet(upd.members);
    if ("removed" in upd && Array.isArray(upd.removed)) out[`${ref.rt}/rset`] = asSet(upd.removed);
  }
  return out;
}
function setValue(ref, data, merge, cur) {
  if (merge) return applyLocal(cur, data);
  const v = toRtValue(data);
  if (ref.rt.startsWith("rooms/") && ref.rt.split("/").length === 2) { v._rev = 1; withIndexes(v); }
  return v;
}
async function txUpdate(ref, upd) { // updates that add to / remove from lists
  const r = rRef(rdb, ref.rt);
  await rGet(r);
  const res = await rTransaction(r, (cur) => (cur === null ? null : withRoomMeta(ref, applyLocal(cur, upd))));
  if (!res.committed) throw { code: "aborted", message: "Couldn't save · try again" };
}
function withRoomMeta(ref, v) {
  if (v && ref.rt.startsWith("rooms/") && ref.rt.split("/").length === 2) { v._rev = (Number(v._rev) || 0) + 1; withIndexes(v); }
  return v;
}
const autoGone = new Set();
export async function setDoc(ref, data, opt) {
  if (!ref.rt) return opt ? fsSetDoc(ref.fs, toFs(data), opt) : fsSetDoc(ref.fs, toFs(data));
  if (ref.rt.startsWith("presence/") && !autoGone.has(ref.rt)) { // gone from the floor the moment the phone disconnects
    autoGone.add(ref.rt);
    onDisconnect(rRef(rdb, ref.rt)).remove().catch(() => autoGone.delete(ref.rt));
  }
  if (opt?.merge) return needsTx(data) ? txUpdate(ref, data) : rUpdate(rRef(rdb), flatUpdate(ref, data));
  return rSet(rRef(rdb, ref.rt), setValue(ref, data, false));
}
export async function updateDoc(ref, upd) {
  if (!ref.rt) return fsUpdateDoc(ref.fs, toFs(upd));
  if (needsTx(upd)) return txUpdate(ref, upd);
  return rUpdate(rRef(rdb), flatUpdate(ref, upd));
}
export async function deleteDoc(ref) {
  if (!ref.rt) return fsDeleteDoc(ref.fs);
  if (autoGone.has(ref.rt)) { autoGone.delete(ref.rt); onDisconnect(rRef(rdb, ref.rt)).cancel().catch(() => {}); }
  return rRemove(rRef(rdb, ref.rt));
}
export function writeBatch(db) {
  const ops = [];
  const b = {
    set(ref, data, opt) { ops.push(["s", ref, data, opt]); return b; },
    update(ref, data) { ops.push(["u", ref, data]); return b; },
    delete(ref) { ops.push(["d", ref]); return b; },
    async commit() {
      const fsOps = ops.filter(([, ref]) => !ref.rt), rtOps = ops.filter(([, ref]) => ref.rt);
      if (fsOps.length) {
        const fb = fsWriteBatch(fdb);
        for (const [k, ref, d, o] of fsOps) k === "s" ? (o ? fb.set(ref.fs, toFs(d), o) : fb.set(ref.fs, toFs(d))) : k === "u" ? fb.update(ref.fs, toFs(d)) : fb.delete(ref.fs);
        await fb.commit();
      }
      if (!rtOps.length) return;
      // list additions/removals need their own transaction; everything else goes in ONE all-or-nothing update
      for (const [k, ref, d] of rtOps) if (k === "u" && needsTx(d)) await txUpdate(ref, d);
      const multi = {};
      for (const [k, ref, d, o] of rtOps) {
        if (k === "u" && needsTx(d)) continue;
        if (k === "d") multi[ref.rt] = null;
        else if (k === "s" && !o?.merge) multi[ref.rt] = setValue(ref, d, false);
        else Object.assign(multi, flatUpdate(ref, d));
      }
      if (Object.keys(multi).length) await rUpdate(rRef(rdb), multi);
    },
  };
  return b;
}

// Transactions: read, decide, then save the table only if nobody changed it meanwhile
// (every save of a table bumps its _rev counter); otherwise try again, like Firestore does.
export async function runTransaction(db, fn) {
  if (!rdb) return fsRunTransaction(fdb, (tx) => fn({
    get: (ref) => tx.get(ref.fs), update: (ref, d) => tx.update(ref.fs, toFs(d)),
    set: (ref, d, o) => (o ? tx.set(ref.fs, toFs(d), o) : tx.set(ref.fs, toFs(d))), delete: (ref) => tx.delete(ref.fs),
  }));
  for (let attempt = 0; attempt < 6; attempt++) {
    const reads = new Map(), writes = [];
    const tx = {
      get: async (ref) => {
        if (!ref.rt) return fsGetDoc(ref.fs); // (profiles: a plain read is enough)
        const v = (await rGet(rRef(rdb, ref.rt))).val();
        reads.set(ref.rt, v ? v._rev ?? 0 : null);
        return snapOf(ref, v);
      },
      update: (ref, d) => writes.push(["u", ref, d]), set: (ref, d, o) => writes.push(["s", ref, d, o]), delete: (ref) => writes.push(["d", ref]),
    };
    const result = await fn(tx); // may throw (e.g. "STALE"): that's the caller's answer
    const guarded = writes.filter(([, ref]) => ref.rt && reads.has(ref.rt));
    const before = writes.filter(([, ref]) => ref.rt && !reads.has(ref.rt) && ref.rt.startsWith("joins/")); // invite keys first
    const after = writes.filter((w) => !guarded.includes(w) && !before.includes(w));
    for (const [k, ref, d, o] of before) k === "d" ? await rRemove(rRef(rdb, ref.rt)) : await rSet(rRef(rdb, ref.rt), setValue(ref, d, false));
    let ok = true;
    for (const path of new Set(guarded.map(([, ref]) => ref.rt))) {
      const mine = guarded.filter(([, ref]) => ref.rt === path), ref = mine[0][1];
      let applied = false;
      const res = await rTransaction(rRef(rdb, path), (cur) => {
        applied = false;
        const rev = cur ? cur._rev ?? 0 : null;
        if (cur === null && reads.get(path) !== null) return null; // not cached yet: the server sends the real value and asks again
        if (rev !== reads.get(path)) return; // someone else saved first: give up this try
        let v = cur;
        for (const [k, , d, o] of mine) v = k === "d" ? null : k === "s" && !o?.merge ? setValue(ref, d, false) : applyLocal(v, d);
        applied = true;
        return v === null ? null : withRoomMeta(ref, v);
      }, { applyLocally: true });
      if (!res.committed || !applied) { ok = false; break; }
    }
    if (!ok) { await new Promise((r) => setTimeout(r, 60 + Math.random() * 140)); continue; }
    for (const [k, ref, d, o] of after) {
      if (!ref.rt) { k === "d" ? await fsDeleteDoc(ref.fs) : k === "s" ? await fsSetDoc(ref.fs, toFs(d), o || {}) : await fsUpdateDoc(ref.fs, toFs(d)); continue; }
      if (k === "d") await rRemove(rRef(rdb, ref.rt));
      else if (k === "s" && !o?.merge) await rSet(rRef(rdb, ref.rt), setValue(ref, d, false));
      else await updateDoc(ref, d);
    }
    return result;
  }
  throw { code: "aborted", message: "The table was busy · try again" };
}

export async function disableNetwork() { if (rdb) goOffline(rdb); try { await fsDisableNetwork(fdb); } catch {} }
export async function enableNetwork() { if (rdb) goOnline(rdb); try { await fsEnableNetwork(fdb); } catch {} }

// ---------- extras for Realtime Database ----------
// The moment my phone disconnects, the server marks me as away at this table (no waiting a minute).
let presence = null;
export function watchPresence(code, uid) {
  if (!rdb) return;
  stopPresence();
  const node = rRef(rdb, `rooms/${code}`);
  const od = onDisconnect(node);
  presence = { od, code };
  od.update({ [`seen/${uid}`]: 1, _rev: rIncrement(1) }).catch(() => {});
}
export function stopPresence() { if (presence) { presence.od.cancel().catch(() => {}); presence = null; } }
// "I'm connected again" (to check in straight away)
export function onReconnect(cb) {
  if (!rdb) return () => {};
  let first = true;
  return rOnValue(rRef(rdb, ".info/connected"), (s) => { if (s.val() === true) { if (!first) cb(); first = false; } });
}
// my own list of holhuashis I've joined (so "My holhuashis" can find them)
export function rememberMembership(uid, code) {
  if (!rdb || !uid || !code) return;
  rSet(rRef(rdb, `memberOf/${uid}/${code}`), true).catch(() => {});
}
