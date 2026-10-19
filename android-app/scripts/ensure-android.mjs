// Creates the Android Studio project (android/) the first time, and copies google-services.json into it.
import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("..", import.meta.url));
process.chdir(here);
if (!existsSync("android")) {
  console.log("Creating the Android project (first time only)...");
  execSync("npx cap add android", { stdio: "inherit" });
}
if (existsSync("google-services.json")) {
  copyFileSync("google-services.json", "android/app/google-services.json");
  console.log("google-services.json copied into the app");
} else if (!existsSync("android/app/google-services.json")) {
  console.warn("\n⚠  No google-services.json found in android-app/. The app will work, but push notifications won't.\n" +
    "   Download it from Firebase (Project settings → Your apps → Android app) and put it in the android-app folder.\n");
}
