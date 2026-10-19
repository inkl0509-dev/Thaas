# THAAS — online multiplayer card games (DIGU & CALL)

A 2–6 player rummy-style game in plain HTML/CSS/JS, using Firebase for realtime multiplayer and Vercel for hosting. There is no build step.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: lobby, table, hand, results |
| `style.css` | Green-felt table and card styling |
| `cards.js` | Game rules: deck, valid sets, DIGU check, scoring |
| `profile.js` | Ranks, badges, avatars, table / deck / shout styles |
| `game.js` | Firebase rooms, turns, drawing, discarding, DIGU, scores |
| `firebase-config.js` | **Your** Firebase keys go here |
| `firestore.rules` | Security rules that keep hands hidden |
| `api/notify.js` | Sends push notifications (runs on Vercel) |
| `package.json` | Gives `api/notify.js` its one dependency |
| `android-app/` | The Android app (Capacitor): settings, icons, build scripts |
| `.github/workflows/android.yml` | Builds the Android app on GitHub every time you push |

## Rules as built

- Each player gets 10 cards (5 in CALL). The rest stay face-down in the middle; the thrown pile starts empty.
- Each round starts with an **empty thrown pile** (in both games). On your turn, take the last card the previous player threw or the top card of the middle pile, then throw one away.
- A set is 3–4 cards of the same number in any suits, or the same suit in a run (Ace low or high, e.g. A-2-3 or Q-K-A).
- When you have 2 sets of 3 plus 1 set of 4, the **DIGU** button lights up. You can press it after picking a card to throw away, or at the start of your turn if your 10 cards already win.
- Everyone's hand is shown and scored (A = 15, 2–10 = face value, J/Q/K = 10):
  - **DIGU caller:** 100 bonus + the value of all their cards.
  - **Everyone else:** value of cards in sets of 3 or 4, minus value of leftover cards (can go negative).
  - **No set at all:** −100.
- **Target score (lounges).** Before dealing, the lounge owner can pick when the game ends (200, 300, 500, 1000 or any number). When anyone reaches it, the game ends and the **highest total wins** (ties share the win). **New game** resets everyone to 0 and lets the host pick a new target.
- **🏛️ Lobby.** Tap **Enter the lobby** on the home screen to open the lobby on its own screen (address `…/#lobby`). The lobby has a fixed layout that is the same for everyone (it just scales to fit each screen): the **DIGU** tables 1–4 (4 seats) on the left and the **CALL** tables 1–4 (6 seats) on the right, under big signs. That means when another player walks somewhere, you see them in the same spot relative to the tables on your screen. Nobody owns a table: walk around, tap any **+** to sit where you like, and the middle of each table shows its game (**DIGU** or **CALL**). Once you're seated, a **Start** button appears in the middle of your table, and anyone sitting there can press it once 2 or more are seated. A full table starts by itself. Lobby games are 4 rounds, then **Back to the lobby** returns everyone to their seats. You sit in the exact chair you tap, and everyone sees you in it. It stays reserved for you until you stand up and walk away (tap the floor), which frees it for others. While you're sitting you belong to that table: tapping the floor won't move you. To leave, tap **Stand up** (or your own chair) before the game starts.
- **Offline players.** Every player's screen checks in on its table every 20 seconds. Anyone who hasn't checked in for **over a minute** is removed, wherever they are: waiting at a lobby table, in a lounge, or mid-game. If it was their turn, the turn passes on. If fewer than 2 players are left, the game stops. Offline players aren't shown in the lobby, and their chair is free again. Coming back to the app checks in immediately. Note that switching to another app for over a minute counts as offline.
- **🛋️ Lounges (registered players).** Open your own lounge: you're sitting at your table, and friends who join with the code or invite link take the free seats around it. While you wait, the lounge is shown as a private room with a wood-panelled wall, a carpet, plants and leather **executive chairs** around the table (one per allowed player). A cork **notice board** beside the table holds the house rules: the lounge code, game (DIGU/CALL), number of players, and how the game ends. The owner sets them there; guests can read them. Press **Start** in the middle of the table when you're ready. The owner picks **2–6 players** and how the game ends: **🎯 Points** (first to a target, e.g. 500) or **🔁 Rounds** (e.g. 3, 5, 8, 10). Guests can join a lounge but can't create one.
- **Room size.** Before dealing, the host picks how many players can join (2–4 at a lobby table, 2–6 at a private one). It can't be set below the number already in the room.
- **Guests and registered players.** Anyone can play as a guest with just a name. Registering (email + password) keeps your current guest progress and lets you pick an avatar emoji. Your round points then add up into **career points** that raise your rank (🃏 Rookie → 🥉 300 → 🥈 1,000 → 🥇 2,500 → 💠 5,000 → 💎 10,000 → 👑 20,000) and earn badges (first DIGU, 10 DIGUs, a 150+ round, game wins and more).
- **Profile picture.** Registered players can upload a picture in **Profile** (it's cropped to a square and shrunk to about 10 KB), or use an emoji avatar instead.
- **Rank rewards.** In **Profile**, higher ranks unlock table colours and card backs (shown on your screen) and the font and colour of your DIGU shout (everyone sees it when you win). Guests always use the classic look.
- **Unlocks.** Every finished round counts as one game played, saved to each player's own profile. Sorting (by suit / by number) unlocks at 5 games. Reactions unlock at 0, 2, 3, 5, 8, 10 and 15 games; locked ones show a 🔒 and the number needed.
- 2–4 players use one deck; 5–6 players use two.
- When the middle pile runs out, the discard pile (except its top card) is reshuffled into it.
- **50-second turns.** A timer bar shows who is playing and how long they have left. If you run out of time before taking a card, your turn passes. If you already took one, the card you took is thrown away (or a DIGU is called, if one is possible). If a player's phone is off or offline, the other players skip them about 4 seconds after their time ends.
- **Drag or tap.** With a mouse or a finger, drag a hand card onto the thrown cards to throw it, or drag the middle pile or the top thrown card down into your hand to take it. While you drag within your hand, the card moves to exactly where your finger or pointer is and stays wherever you let go. Tapping still works too. Throwing a card that leaves a winning hand calls DIGU automatically.
- **Thrown cards** land scattered at different angles in one spot, like a real table. Everyone sees the same layout, and the newest card is on top.
- **DIGU!** The winning card lands on the table, flips over, and shows "DIGU!" on its back. The scores appear a couple of seconds later.
- **1 to DIGU.** When your 10 cards are one card away from winning, a button lets you tell everyone. Your name gets a glowing "1 to DIGU" badge, which comes off automatically if a later throw breaks it.
- **Reactions.** Tap 😀 (bottom right) to send an emoji or a quick phrase like "Quick!" or "Oh man!". It pops up under your name on everyone's screen.

## If it feels slow

Your own moves show instantly, before the server confirms them. Other players see a move as fast as the trip to the Firestore server allows, so **server location matters most**. It's set when you create the database and can't be changed later. If yours is far away (for example, the default `us-central`), create a new Firebase project with Firestore in **asia-south1 (Mumbai)** or **asia-southeast1 (Singapore)**, then paste the new config into `firebase-config.js`.

## CALL (the second game)

- 2–6 players, **5 cards each**, one deck.
- On your turn, **throw first**: **one card**, or **several cards of the same number together** (for example, three Qs). To throw several, tap them, then press **Throw**, or drag one of them onto the table. **Then take a card**: the last card the previous player threw (it slides out from under your throw with a blue glow) or one from the **middle pile**. Trying to take before throwing shows "Throw a card first".
- Card values: A = 1, 2–10 = face value, J/Q/K = 10. Your current count is shown under your hand.
- At the **start of your turn**, instead of throwing, if your count is **7 or less**, you can press **CALL** to end the round:
  - If you have the lowest count (ties count in your favour), you score **0** and everyone else scores their count.
  - If anyone has a **lower** count than you, you score **50**, the lowest player scores **0**, and everyone else scores their count.
- **Lowest total wins.** Lobby CALL tables seat 2–6 and last 4 rounds. A lounge can play CALL to a points limit (50, 100, 200 or any number) or a number of rounds.
- For registered players, a CALL round adds career points for a low score: 0 points earns +50, and 50 or more earns nothing.

## 1. Set up Firebase (about 5 minutes)

1. Go to <https://console.firebase.google.com> and click **Add project**. Google Analytics is optional.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
   Then also enable **Email/Password** on the same screen. Registered players need it; guests don't.
3. **Build → Firestore Database → Create database** → pick a nearby location → start in **production mode**.
4. Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**. Do this again whenever `firestore.rules` changes, because the unlocks need the new `users` rule.
5. Go to **Project settings (gear icon) → Your apps → Web (`</>`)**, register an app, and copy the `firebaseConfig` values into `firebase-config.js`.

## 2. Test locally

ES modules don't load from `file://`, so serve the folder:

```bash
npx serve .
```

Open the URL in two **different** browsers, or in one normal window and one incognito window, or on two phones. Each one counts as a separate player. **Two tabs in the same browser are the same player**, so they won't see each other walking in the lobby. Create a room in one, then join with the code in the other.

## 3. Put it on GitHub

```bash
git init
git add .
git commit -m "Digu card game"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/digu.git
git push -u origin main
```

Committing `firebase-config.js` is fine. Those keys only identify your project, and `firestore.rules` is what protects the data.

## 4. Deploy on Vercel

1. Go to <https://vercel.com/new> and import the GitHub repo.
2. Framework preset: **Other**. Leave the build command empty and the output directory as is.
3. Click **Deploy**. You'll get a URL like `digu-yourname.vercel.app`.
4. In Firebase, go to **Authentication → Settings → Authorized domains** and add that Vercel domain.

From then on, every `git push` redeploys automatically.

## Playing

- Enter a name, click **Create room**, and share the 5-letter code (or **Copy invite** for a link).
- The host clicks **Deal cards** once 2–6 players are in.
- Click a card to select it, and click the glowing pile to draw. **Group sets** auto-arranges your hand into the best sets it can find. On desktop you can also drag cards to reorder them.
- Reloading the page rejoins the same room.

## Known limits (fine for friends, worth knowing)

- **Cheating is possible for a determined player.** Hands are hidden by the rules, but the middle pile's order lives in the room document, and players' browsers enforce the turn rules. Making it cheat-proof means moving drawing, discarding and DIGU into Firebase Cloud Functions, which require the pay-as-you-go Blaze plan.
- If a player closes the tab mid-game, the game waits on their turn. There's no timeout or kick button yet.
- New players can join only in the lobby, before the first deal.
- Old rooms stay in Firestore. You can delete them from the console occasionally, or add a TTL policy on `createdAt`.

## Admins

Admins get a **🛡️ Admin panel** button in the lobby. It lists every player (search, plus filters for registered, guests and blocked) and lets the admin:

- **Delete** a player's profile, which wipes their name, avatar, picture, career points, rank and badges. They can still sign in and start fresh unless they're also blocked.
- **Block / Unblock** a player. Blocked players can't create or join rooms or save anything, even after signing in again.

A website can't delete someone's login account itself; that needs server code. To remove a login completely, also delete it in **Firebase console → Authentication → Users**.

**Make someone an admin** (only possible from the Firebase console, never from the game):

1. The person registers in the game, opens **Profile**, and copies their **Player ID** from the bottom.
2. In Firebase console → **Firestore Database → Data**, click **Start collection**, name it `admins`, and set the Document ID to that Player ID. Add any field (e.g. `note` = `owner`) and save.
3. They reload the game, and the Admin panel button appears.

To remove an admin, delete their document from `admins`.


## Android app with push notifications

The Android app is your THAAS game wrapped in a real app (using **Capacitor**). Every time you push to GitHub, GitHub builds the app for you, so you don't need Android Studio.

Push notifications tell players when:
- it's **their turn**,
- a **game starts** or the next round is dealt,
- someone **calls DIGU or CALL**,
- someone **joins their lounge**,
- someone **sits at their lobby table**.

Notifications only appear when the app is in the background. Tapping one opens that table. They're sent by `api/notify.js`, a small function on your Vercel site, so you **don't** need Firebase's paid plan. The function checks that the sender is really at that table, so nobody can send fake alerts.

### One-time setup (about 15 minutes)

**1. Add an Android app in Firebase**
- Firebase console → ⚙️ Project settings → **Your apps** → **Add app** → Android icon.
- Android package name: **`com.thaas.game`** (it must match `android-app/capacitor.config.json`).
- Click **Register app**, then **Download google-services.json**. Skip the remaining SDK steps.

**2. Give GitHub that file**
- Your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
- Name: `GOOGLE_SERVICES_JSON`. Value: open `google-services.json` in a text editor, copy **everything**, and paste it.

**3. Let Vercel send notifications**
- Firebase console → ⚙️ Project settings → **Service accounts** → **Generate new private key**. A `.json` file downloads. Keep it secret and never commit it to GitHub.
- Vercel → your project → **Settings → Environment Variables** → add `FIREBASE_SERVICE_ACCOUNT` and paste the **whole** contents of that file → Save.
- Vercel → **Deployments** → ⋯ → **Redeploy**.

**4. Tell the app where your website is**
- In `firebase-config.js`, set `siteUrl` to your Vercel address, e.g. `"https://thaas.vercel.app/"`.

**5. Republish `firestore.rules`** in the Firebase console. It has a new private place for phones' push addresses.

**6. Push to GitHub**
```bash
git add .
git commit -m "Android app with push notifications"
git push
```

### Getting the app

1. GitHub → your repo → **Actions** → the latest **Android app** run. It takes about 5–8 minutes; wait for the green ✓.
2. Scroll to **Artifacts** → download **THAAS-apk-1.0.N**. It's a zip containing the `.apk`.
3. Send the `.apk` to your phone and open it. Android will ask to allow installing apps from that source; allow it.
4. Open THAAS and tap **Allow** when it asks to send notifications.

Each push to GitHub builds a new version (1.0.N). Installing it over the old one keeps everyone's data, because the data lives in Firebase.

### Or build it on your own computer (VS Code + Android Studio)

You'll need **Node.js** (LTS), **Android Studio** (Ladybug 2024.2 or newer; it includes the Android SDK and Java) and **VS Code**.

1. Open the project folder in VS Code, then open a terminal (**Terminal → New Terminal**).
2. `cd android-app` then `npm install`. This is only needed the first time.
3. Put your `google-services.json` from Firebase into the `android-app` folder. It's needed for push notifications and is ignored by git.
4. `npm run build-app`. The first time, this creates the Android Studio project in `android-app/android`.
5. `npm run open`. This opens the project in Android Studio. Wait for "Gradle sync" to finish (the first time takes a few minutes).
6. Run it:
   - **On your phone:** turn on Developer options (Settings → About phone → tap **Build number** 7 times), turn on **USB debugging**, plug the phone in, pick it in the device list at the top, and press the green **▶ Run**.
   - **On the emulator:** Device Manager → create a phone with a **Google Play** system image (push needs Google Play) → **▶ Run**.
   - **APK file:** **Build → Build App Bundle(s) / APK(s) → Build APK(s)** → **locate**.
7. After changing the game, run `npm run build-app` again in VS Code, then press **▶ Run** in Android Studio.

For the Play Store: in Android Studio, use **Build → Generate Signed App Bundle / APK** and follow the wizard.

### Optional: Google Play Store

Play needs a signed bundle (`.aab`). Make a signing key once and **keep it safe forever**, because every future update must be signed with it:
```bash
keytool -genkeypair -v -keystore thaas.keystore -alias thaas -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 thaas.keystore      # on a Mac: base64 -i thaas.keystore
```
Add these GitHub secrets:
- `ANDROID_KEYSTORE_BASE64`: the base64 text.
- `ANDROID_KEYSTORE_PASSWORD`.
- `ANDROID_KEY_ALIAS`: `thaas`.
- `ANDROID_KEY_PASSWORD`.

The next build adds a **THAAS-playstore-1.0.N** artifact containing the `.aab` to upload in the Google Play Console. A developer account has a one-time $25 fee.

### If notifications don't arrive
- Check the GitHub build log for "GOOGLE_SERVICES_JSON secret is missing".
- Make sure `FIREBASE_SERVICE_ACCOUNT` is set in Vercel and you redeployed.
- Visit `https://your-site.vercel.app/api/notify`. It should say `{"error":"POST only"}`. An error page means the function isn't deployed.
- On the phone: Settings → Apps → THAAS → Notifications must be on.
- Notifications don't show while THAAS is open on screen. That's on purpose, since you're already looking at the game.
