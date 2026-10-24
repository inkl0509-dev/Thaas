// THAAS password reset email, sent by THAAS itself (not Firebase's standard email).
// POST /api/reset  { email }
// Makes a one-time reset link with Firebase and emails it with the THAAS design. The link opens
// reset.html on the THAAS website.
// Needs (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT   (already set)
//   SITE_URL                   e.g. https://thaas.vercel.app/
//   and ONE way to send email:
//     Gmail:  SMTP_USER = yourname@gmail.com, SMTP_PASS = a Gmail "App password" (16 letters)
//     Brevo:  BREVO_API_KEY = your Brevo API key, MAIL_FROM = the sender email you verified in Brevo
//     other:  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   MAIL_FROM_NAME (optional, default "THAAS")
const admin = require("firebase-admin");
const crypto = require("crypto");

function init() {
  if (admin.apps.find((a) => a.name === "[DEFAULT]")) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), ...(databaseURL ? { databaseURL } : {}) });
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function emailHtml(name, email, link) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f1ea;padding:24px 12px;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6dfcf;">
    <div style="background:#0e3b3a;padding:22px;text-align:center;">
      <div style="font-size:30px;font-weight:bold;letter-spacing:3px;color:#e8b64c;">THAAS</div>
      <div style="font-size:14px;letter-spacing:6px;color:#b9c9c4;margin-top:4px;">&#9824; <span style="color:#ff6b81;">&#9829;</span> &#9827; <span style="color:#ff6b81;">&#9830;</span></div>
    </div>
    <div style="padding:26px 26px 10px;color:#2b2b2b;font-size:15px;line-height:1.6;">
      <p style="margin:0 0 14px;">Hello ${esc(name || "there")},</p>
      <p style="margin:0 0 14px;">We received a request to reset the password for your THAAS account (<b>${esc(email)}</b>).</p>
      <p style="margin:0 0 22px;">To choose a new password, please click the button below:</p>
      <p style="margin:0 0 22px;text-align:center;"><a href="${esc(link)}" style="display:inline-block;background:#e8b64c;color:#1b1b1b;text-decoration:none;font-weight:bold;padding:13px 28px;border-radius:10px;">Reset my password</a></p>
      <p style="margin:0 0 14px;font-size:13px;color:#666;">For your security, this link can be used only once and expires in one hour. If the button doesn't work, copy and paste this address into your browser:<br><a href="${esc(link)}" style="color:#1d6b66;word-break:break-all;">${esc(link)}</a></p>
      <p style="margin:0 0 14px;font-size:13px;color:#666;">If you didn't ask to reset your password, you can safely ignore this email. Your password will stay the same.</p>
      <p style="margin:18px 0 0;">See you at the table,<br><b>The THAAS team</b></p>
    </div>
    <div style="padding:14px 26px 20px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;margin-top:18px;">THAAS · the Maldivian card games · DIGU · CALL · BONDI · DHIHA · BABBUSH<br>This is an automatic message, please don't reply to it.</div>
  </div></div>`;
}
const emailText = (name, email, link) => `Hello ${name || "there"},

We received a request to reset the password for your THAAS account (${email}).

To choose a new password, open this link (it can be used once and expires in one hour):
${link}

If you didn't ask to reset your password, you can safely ignore this email. Your password will stay the same.

See you at the table,
The THAAS team`;

async function send(to, subject, html, text) {
  const fromName = process.env.MAIL_FROM_NAME || "THAAS";
  if (process.env.BREVO_API_KEY) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: fromName, email: process.env.MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    });
    if (!r.ok) throw new Error("Brevo: " + (await r.text()).slice(0, 200));
    return;
  }
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = require("nodemailer");
    const gmail = !process.env.SMTP_HOST;
    const t = nodemailer.createTransport(gmail
      ? { service: "gmail", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS.replace(/\s+/g, "") } }
      : { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.sendMail({ from: `"${fromName}" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`, to, subject, html, text });
    return;
  }
  throw new Error("No email sender is set up (Gmail SMTP or Brevo)");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return res.status(400).json({ error: "That email doesn't look right." });
    const app = init(), db = app.firestore();
    // at most one email a minute for the same address
    const key = db.doc(`resetRequests/${crypto.createHash("sha256").update(email).digest("hex").slice(0, 40)}`);
    const last = (await key.get()).data()?.at || 0;
    if (Date.now() - last < 60_000) return res.status(429).json({ error: "We just sent an email to this address · please wait a minute and check your inbox (and spam)." });
    await key.set({ at: Date.now() });
    let user = null;
    try { user = await app.auth().getUserByEmail(email); } catch { /* no such account */ }
    if (!user) return res.status(200).json({ ok: true }); // don't reveal whether an account exists
    const site = (process.env.SITE_URL || "").replace(/\/?$/, "/");
    const fbLink = await app.auth().generatePasswordResetLink(email);
    const oob = new URL(fbLink).searchParams.get("oobCode");
    const link = site.length > 1 ? `${site}reset.html?mode=resetPassword&oobCode=${encodeURIComponent(oob)}` : fbLink;
    let name = user.displayName;
    try { name = (await db.doc(`users/${user.uid}`).get()).data()?.name || name; } catch {}
    await send(email, "Reset your THAAS password", emailHtml(name, email, link), emailText(name, email, link));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("reset", e);
    res.status(500).json({ error: e.message || String(e) });
  }
};
