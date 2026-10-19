// Makes the app open your live website (siteUrl in firebase-config.js) instead of the copy inside it,
// so anything you publish on the website shows up in the app straight away, with no rebuild.
// Runs after "cap sync" and edits the app's own copy of the Capacitor settings.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("..", import.meta.url));
const cfgFile = here + "android/app/src/main/assets/capacitor.config.json";
const site = (readFileSync(here + "../firebase-config.js", "utf8").match(/siteUrl\s*=\s*["'`]([^"'`]+)["'`]/) || [])[1];

if (!existsSync(cfgFile)) { console.warn("Run 'npx cap sync android' first."); process.exit(0); }
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
if (!site || site.includes("PASTE") || !/^https:\/\//.test(site)) {
  delete cfg.server;
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  console.warn("\n⚠  siteUrl in firebase-config.js isn't set, so the app uses the copy of the game inside it.\n" +
    "   Set siteUrl to your Vercel address and rebuild, so website updates reach the app automatically.\n");
  process.exit(0);
}
const push = existsSync(here + "android/app/google-services.json") ? "1" : "0";
const url = new URL(site);
url.searchParams.set("app", "android");
url.searchParams.set("push", push);
cfg.server = { ...(cfg.server || {}), url: url.toString(), cleartext: false, errorPath: "offline.html" };
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
console.log("The app will open the live site:", url.toString());
