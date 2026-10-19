// Removes guest players (anonymous sign-ins) who have left: their login, profile, push tokens and
// "online" records. Registered players are never touched.
// POST /api/cleanup
//   - from any player's screen (no login needed): runs at most once every 30 minutes and only
//     removes guests not seen for 3 hours or more
//   - from the admin panel (Authorization: Bearer <admin's ID token>): runs now and removes guests
//     not seen for 15 minutes or more
// Needs FIREBASE_SERVICE_ACCOUNT (and FIREBASE_DATABASE_URL when Realtime Database is used).
const admin = require("firebase-admin");

function init() {
  if (admin.apps.find((a) => a.name === "[DEFAULT]")) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), ...(databaseURL ? { databaseURL } : {}) });
}

const AUTO_EVERY = 30 * 60_000, AUTO_AGE = 3 * 3600_000, ADMIN_AGE = 15 * 60_000;
const t = (s) => (s ? Date.parse(s) || 0 : 0);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const app = init(), db = app.firestore();
    let force = false;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (m) {
      const who = await app.auth().verifyIdToken(m[1]).catch(() => null);
      if (who && (await db.doc(`admins/${who.uid}`).get()).exists) force = true;
    }
    const now = Date.now();
    const stamp = db.doc("config/cleanup");
    if (!force) {
      const last = (await stamp.get()).data()?.lastRun || 0;
      if (now - last < AUTO_EVERY) return res.status(200).json({ ok: true, skipped: true });
    }
    await stamp.set({ lastRun: now }, { merge: true });

    const minAge = force ? ADMIN_AGE : AUTO_AGE;
    const admins = new Set((await db.collection("admins").get()).docs.map((d) => d.id));
    const gone = [];
    let token;
    do {
      const page = await app.auth().listUsers(1000, token);
      for (const u of page.users) {
        const guest = !u.email && !u.phoneNumber && !(u.providerData || []).length;
        if (!guest || admins.has(u.uid)) continue;
        const seen = Math.max(t(u.metadata.lastRefreshTime), t(u.metadata.lastSignInTime), t(u.metadata.creationTime));
        if (now - seen >= minAge) gone.push(u.uid);
      }
      token = page.pageToken;
    } while (token && gone.length < 5000);

    // profiles and push tokens (Firestore), then online records (Realtime Database), then the logins
    for (let i = 0; i < gone.length; i += 200) {
      const part = gone.slice(i, i + 200), b = db.batch();
      for (const u of part) { b.delete(db.doc(`users/${u}`)); b.delete(db.doc(`pushTokens/${u}`)); b.delete(db.doc(`presence/${u}`)); }
      await b.commit();
    }
    if (process.env.FIREBASE_DATABASE_URL && gone.length) {
      const upd = {};
      for (const u of gone) { upd[`presence/${u}`] = null; upd[`lastSeen/${u}`] = null; upd[`memberOf/${u}`] = null; }
      await app.database().ref().update(upd);
    }
    for (let i = 0; i < gone.length; i += 1000) await app.auth().deleteUsers(gone.slice(i, i + 1000));
    res.status(200).json({ ok: true, removed: gone.length, force });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
