// ONE-TIME move of THAAS to a new Firebase project, run from the page /move.html (no computer setup).
// POST /api/move  { password, step, dry, ... }
// Needs these Vercel environment variables while you move (remove them afterwards):
//   MOVE_PASSWORD             a password you choose; the page must send it
//   MOVE_OLD_SERVICE_ACCOUNT  the OLD project's service-account JSON (or FIREBASE_SERVICE_ACCOUNT is used)
//   MOVE_NEW_SERVICE_ACCOUNT  the NEW project's service-account JSON
//   MOVE_NEW_DATABASE_URL     the NEW project's Realtime Database address (Singapore)
// Nothing is ever deleted from the old project.
const admin = require("firebase-admin");

let apps = null;
function init() {
  if (apps) return apps;
  const oldRaw = process.env.MOVE_OLD_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  const newRaw = process.env.MOVE_NEW_SERVICE_ACCOUNT;
  const url = process.env.MOVE_NEW_DATABASE_URL;
  if (!oldRaw || !newRaw || !url) throw new Error("Set MOVE_OLD_SERVICE_ACCOUNT, MOVE_NEW_SERVICE_ACCOUNT and MOVE_NEW_DATABASE_URL in Vercel, then redeploy.");
  const oldKey = JSON.parse(oldRaw), newKey = JSON.parse(newRaw);
  if (oldKey.project_id === newKey.project_id) throw new Error("The old and new keys are for the same project (" + oldKey.project_id + ").");
  const o = admin.apps.find((a) => a.name === "move-old") || admin.initializeApp({ credential: admin.credential.cert(oldKey) }, "move-old");
  const n = admin.apps.find((a) => a.name === "move-new") || admin.initializeApp({ credential: admin.credential.cert(newKey), databaseURL: url }, "move-new");
  apps = { o, n, oldId: oldKey.project_id, newId: newKey.project_id, url };
  return apps;
}

function plain(v) {
  if (v === null || v === undefined) return null;
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = plain(x); if (y !== null && y !== undefined) out[k.replace(/[.#$\[\]\/]/g, "_")] = y; }
    return out;
  }
  return v;
}
const asSet = (a) => (Array.isArray(a) && a.length ? Object.fromEntries(a.filter((x) => typeof x === "string").map((u) => [u, true])) : null);
const SKIP = ["rooms", "presence"]; // tables go to Realtime Database; presence is live-only

async function check({ o, n, oldId, newId, url }) {
  const cols = (await o.firestore().listCollections()).map((c) => c.id).filter((c) => !SKIP.includes(c));
  const users = await o.auth().listUsers(1000);
  const newUsers = await n.auth().listUsers(1);
  await n.database().ref(".info/serverTimeOffset").once("value"); // the new database answers
  const lounges = await o.firestore().collection("rooms").where("lounge", "==", true).get();
  return { oldProject: oldId, newProject: newId, newDatabase: url, collections: cols,
    usersInOld: users.users.length + (users.pageToken ? "+" : ""), newProjectHasUsers: newUsers.users.length > 0,
    holhuashis: lounges.docs.filter((d) => d.data().status !== "closed").length };
}

async function copyAuth({ o, n }, { dry, pageToken, hash }) {
  const page = await o.auth().listUsers(1000, pageToken || undefined);
  const recs = page.users.map((u) => {
    const r = { uid: u.uid, disabled: u.disabled, emailVerified: u.emailVerified,
      metadata: { creationTime: u.metadata.creationTime, lastSignInTime: u.metadata.lastSignInTime } };
    if (u.email) r.email = u.email;
    if (u.displayName) r.displayName = u.displayName;
    if (u.photoURL) r.photoURL = u.photoURL;
    if (u.phoneNumber) r.phoneNumber = u.phoneNumber;
    if (u.customClaims) r.customClaims = u.customClaims;
    if (u.passwordHash) { r.passwordHash = Buffer.from(u.passwordHash, "base64"); r.passwordSalt = Buffer.from(u.passwordSalt || "", "base64"); }
    const prov = (u.providerData || []).filter((p) => p.providerId !== "password").map((p) => ({ uid: p.uid, providerId: p.providerId, email: p.email, displayName: p.displayName, photoURL: p.photoURL }));
    if (prov.length) r.providerData = prov;
    return r;
  });
  const withPw = recs.filter((r) => r.passwordHash).length;
  let imported = 0, errors = [];
  if (!dry && recs.length) {
    const opts = withPw ? { hash: { algorithm: "SCRYPT", key: Buffer.from(hash.key, "base64"), saltSeparator: Buffer.from(hash.saltSeparator, "base64"),
      rounds: Number(hash.rounds), memoryCost: Number(hash.memCost) } } : undefined;
    if (withPw && (!hash?.key || !hash?.saltSeparator)) throw new Error("Enter the password hash parameters first (from the OLD project's console).");
    const res = await n.auth().importUsers(recs, opts);
    imported = res.successCount;
    errors = res.errors.slice(0, 10).map((e) => `${recs[e.index]?.email || recs[e.index]?.uid}: ${e.error.message}`);
  }
  return { users: recs.length, withPassword: withPw, imported, errors, nextPageToken: page.pageToken || null };
}

async function copyCollection({ o, n }, { dry, collection }) {
  if (!collection || SKIP.includes(collection)) throw new Error("Pick a collection");
  const ofs = o.firestore(), nfs = n.firestore();
  let count = 0, batch = nfs.batch(), inBatch = 0;
  const walk = async (col, path) => {
    const snap = await col.get();
    for (const d of snap.docs) {
      const p = `${path}/${d.id}`;
      if (!dry) { batch.set(nfs.doc(p), d.data()); inBatch++; if (inBatch >= 400) { await batch.commit(); batch = nfs.batch(); inBatch = 0; } }
      count++;
      for (const sub of await d.ref.listCollections()) await walk(sub, `${p}/${sub.id}`);
    }
  };
  await walk(ofs.collection(collection), collection);
  if (!dry && inBatch) await batch.commit();
  // admins also go to the Realtime Database list (deleting notice-board messages needs it)
  if (collection === "admins" && !dry) {
    const ad = await ofs.collection("admins").get();
    if (ad.size) await n.database().ref("admins").update(Object.fromEntries(ad.docs.map((d) => [d.id, true])));
  }
  return { collection, documents: count };
}

async function copyLounges({ o, n }, { dry }) {
  const ofs = o.firestore(), upd = {}, list = [];
  let hands = 0, joins = 0;
  const snap = await ofs.collection("rooms").where("lounge", "==", true).get();
  for (const d of snap.docs) {
    const r = d.data();
    if (r.status === "closed") continue;
    const code = d.id, room = plain(r);
    room._rev = 1;
    const pids = asSet(r.playerIds), mset = asSet(r.members), rset = asSet(r.removed);
    if (pids) room.pids = pids; if (mset) room.mset = mset; if (rset) room.rset = rset;
    delete room.seen;
    upd[`rooms/${code}`] = room;
    for (const u of new Set([r.owner, ...(r.members || [])].filter(Boolean))) upd[`memberOf/${u}/${code}`] = true;
    for (const h of (await d.ref.collection("hands").get()).docs) { upd[`hands/${code}/${h.id}`] = plain(h.data()); hands++; }
    const inv = await d.ref.collection("secret").doc("invite").get();
    if (inv.exists) upd[`secrets/${code}`] = plain(inv.data());
    for (const j of (await d.ref.collection("joins").get()).docs) { upd[`joins/${code}/${j.id}`] = plain(j.data()); joins++; }
    list.push(`${code} "${r.name || "Holhuashi"}" · ${(r.members || []).length} members`);
  }
  const notes = (await ofs.collection("lobbyNotes").get().catch(() => ({ docs: [] }))).docs
    .map((x) => ({ id: x.id, v: plain(x.data()) })).sort((a, b) => (b.v.at || 0) - (a.v.at || 0)).slice(0, 40);
  for (const x of notes) upd[`lobbyNotes/${x.id}`] = x.v;
  if (!dry) {
    const keys = Object.keys(upd);
    for (let i = 0; i < keys.length; i += 400) await n.database().ref().update(Object.fromEntries(keys.slice(i, i + 400).map((k) => [k, upd[k]])));
  }
  return { holhuashis: list.length, hands, joins, notes: notes.length, list };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pw = process.env.MOVE_PASSWORD;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (!pw || pw.length < 8) return res.status(403).json({ error: "Set MOVE_PASSWORD (8+ characters) in Vercel first, then redeploy." });
  if (body.password !== pw) { await new Promise((r) => setTimeout(r, 1500)); return res.status(403).json({ error: "Wrong password" }); }
  try {
    const a = init();
    const dry = !!body.dry;
    let out;
    if (body.step === "check") out = await check(a);
    else if (body.step === "auth") out = await copyAuth(a, { dry, pageToken: body.pageToken, hash: body.hash || {} });
    else if (body.step === "collection") out = await copyCollection(a, { dry, collection: body.collection });
    else if (body.step === "lounges") out = await copyLounges(a, { dry });
    else return res.status(400).json({ error: "Unknown step" });
    res.status(200).json({ ok: true, dry, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
