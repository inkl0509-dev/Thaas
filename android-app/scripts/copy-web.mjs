import { fileURLToPath } from "node:url";
// Copies the THAAS website (the files one folder up) into www/, which goes inside the app.
import { mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const root = fileURLToPath(new URL("../..", import.meta.url));
const www = fileURLToPath(new URL("../www", import.meta.url));
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
const files = readdirSync(root).filter((f) => /\.(html|css|js|png|jpg|ttf|woff2)$/.test(f));
for (const f of files) copyFileSync(join(root, f), join(www, f));
if (!files.includes("index.html")) throw new Error("index.html not found next to android-app/");
// the page shown when the phone has no internet
copyFileSync(fileURLToPath(new URL("../static/offline.html", import.meta.url)), join(www, "offline.html"));
console.log("Copied into the app:", files.join(", "));
