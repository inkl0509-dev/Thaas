# Staff Portal

Staff self-service portal built with plain **HTML + JavaScript**, hosted on **Vercel** (from **GitHub**), with **Firebase** for login, database, file storage and push notifications.

## What it does

| Page | Who | What |
|---|---|---|
| `index.html` | everyone | Sign in, forgot-password email |
| `register.html` | new staff | Self-registration → waits for admin approval |
| `dashboard.html` | staff | Today's duty, next 14 days, leave balance, pending requests, my details, enable push |
| `report.html` | staff | **SL / FRL report** with attachments (medical certificate, PDF/photo). Emailed **with the files attached** to the SL or FRL email list + admins, push to admins |
| `leave.html` | staff | **Annual leave** request; calendar shows the admin's daily allocation and how many slots are taken |
| `roster.html` | staff | View any month's **duty roster** (live — updates instantly) |
| `swap.html` | staff | **Duty change**: ask a colleague *at the same level*; they accept/decline. On accept the roster cells are swapped automatically, and the requester, the duty-change email list and admins get email + push |
| `password.html` | staff | Change password |
| `admin.html` | admins | Approve staff & set level/role/leave entitlement · view SL/FRL reports · approve/reject/revoke leave · set leave calendar allocation · build/upload roster (CSV or Excel) and notify staff whose duties changed · view duty changes · notification email lists & shift codes · test email/push |

Every notification is also kept in the bell (🔔) inbox inside the portal.

## How it fits together

```
Browser (HTML/JS, installable as a phone app)
   │  Firebase Auth · Firestore · Storage   (direct, protected by firestore.rules / storage.rules)
   │
   └─ POST /api/notify, /api/swap-respond   (Vercel serverless functions in /api)
          └─ firebase-admin → reads the record, sends push (FCM), writes inbox notifications
          └─ nodemailer (SMTP) → sends emails (with attachments for SL/FRL)
```

---

## Setup (about 30 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project**.
2. **Build → Authentication → Get started → Email/Password → Enable**.
3. **Build → Firestore Database → Create database** (production mode, pick a region close to you).
4. **Build → Storage → Get started.** Firebase Storage requires the **Blaze (pay-as-you-go)** plan; it still has a free monthly allowance and a small office will normally stay within it. Set a budget alert in Google Cloud billing if you want peace of mind.

### 2. Add the web config
1. **Project settings (⚙) → General → Your apps → Web (`</>`)** → register an app (no hosting needed).
2. Copy the `firebaseConfig` values into **`js/config.js`**.
3. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**. Copy the key into `self.FCM_VAPID_KEY` in `js/config.js`.
4. Optional: change `APP_NAME`, `WEEKEND_DAYS` and `DEFAULT_AL_DAYS` in the same file.

### 3. Publish the security rules and index
Either copy-paste in the console:
- **Firestore → Rules** → paste `firestore.rules` → Publish
- **Storage → Rules** → paste `storage.rules` → Publish
- **Firestore → Indexes → Composite → Add index**: collection `notifications`, fields `uid` Ascending, `createdAt` Descending

…or with the Firebase CLI: `npm i -g firebase-tools && firebase login && firebase use <project-id> && firebase deploy --only firestore,storage`

### 4. Get a service-account key (for the server functions)
**Project settings → Service accounts → Generate new private key**. Keep the JSON file secret — never commit it to GitHub.

### 5. Choose how emails are sent (SMTP)
Any SMTP account works. With Gmail / Google Workspace:
1. Turn on 2-Step Verification for the sending account.
2. Create an **App password** (Google Account → Security → App passwords).
3. Use `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the account>`, `SMTP_PASS=<app password>`.

Gmail allows roughly 500 emails a day. For more, use your office mail server or a provider such as Brevo, Mailgun or SendGrid (they all give SMTP details).

### 6. Put the code on GitHub
```bash
cd staff-portal
git init && git add . && git commit -m "Staff portal"
git branch -M main
git remote add origin https://github.com/<you>/staff-portal.git
git push -u origin main
```

### 7. Deploy on Vercel
1. <https://vercel.com> → **Add New → Project** → import the GitHub repo. Framework preset: **Other**. No build command needed.
2. **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the **whole contents** of the service-account JSON file (paste it as one value) |
| `FIREBASE_STORAGE_BUCKET` | the `storageBucket` value from `js/config.js` (e.g. `myproject.firebasestorage.app`) |
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `465` (or `587`) |
| `SMTP_USER` | sending account |
| `SMTP_PASS` | its password / app password |
| `MAIL_FROM` | e.g. `Staff Portal <portal@yourdomain.mv>` (optional) |
| `APP_URL` | your site address, e.g. `https://staff-portal.vercel.app` (used for links in emails) |
| `APP_NAME` | optional, shown in emails |

3. **Redeploy** after adding the variables (Deployments → ⋯ → Redeploy).
4. Every push to `main` on GitHub now deploys automatically.

### 8. Create the first admin
1. Open the site → **Register** with your own details.
2. Firebase console → **Firestore → users → (your document)** → change `role` to `admin` and `status` to `active`.
3. Sign in again → you'll land on **Admin**. Open **Settings**, enter the email lists, shift codes, save, then press **Send test notification**.

From then on, approve new staff in **Admin → Staff** (set their **duty level**, otherwise they can't request duty changes).

---

## Daily use

**Roster:** Admin → Duty roster → choose month → *Download template (CSV)* → fill it in Excel (columns `Staff ID, Name, 1, 2, 3 …`) → *Upload CSV / Excel* → check the grid → **Save & publish**. You can also type directly in the grid. Staff whose cells changed get an email + push listing the changed days; a first-time publish tells everyone on it.

**Leave calendar:** Admin → Leave calendar → tap a start and end day → set *Staff allowed on leave per day* → Apply (0 = blocked). A yearly default fills days you haven't set. Approving a request takes the slots and adds the days to the staff member's "taken" count; *Revoke* gives them back.

**Duty change:** both staff must be at the same level (set by admin). The colleague accepts from the Duty change page (or from the push/email link). The roster cells for the dates are exchanged automatically. If no roster is published for those dates, the admin email says so.

## Push notifications on phones
- **Android (Chrome):** open the site → *Enable notifications*. Optionally ⋮ → *Add to Home screen* / *Install app*.
- **iPhone (iOS 16.4+):** open in **Safari** → Share → **Add to Home Screen** → open the portal from the home-screen icon → *Enable notifications*. iPhones only allow web push from the home-screen app.
- Each device must enable notifications once. Admins can see who has push turned on in Admin → Staff (Push column).

## Notes
- Attachment links stored for admins are Firebase download links; only the staff member and admins can see them in the portal, but treat forwarded links as sensitive.
- Vercel's free Hobby plan is meant for personal/non-commercial use; for an organisation, check whether the Pro plan applies to you.
- Edit colours and fonts in `css/style.css`.

## Files
```
index.html register.html dashboard.html report.html leave.html roster.html swap.html password.html admin.html
css/style.css            js/config.js (your settings)   js/app.js (shared)   js/admin.js
firebase-messaging-sw.js (push service worker)   manifest.json  icons/
api/_lib.js api/notify.js api/swap-respond.js   (Vercel functions)
firestore.rules storage.rules firestore.indexes.json firebase.json   package.json vercel.json
```
