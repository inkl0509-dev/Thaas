import { fileURLToPath } from "node:url";
// Small changes to the generated Android project:
//  - a white card-suit icon and gold colour for notifications, and the "turns" channel as default
//  - version number from the GitHub build number
//  - keep the game below the status bar on Android 15+
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const A = fileURLToPath(new URL("../android/app/", import.meta.url));
const res = A + "src/main/res/"; // A ends with a slash
const edit = (file, fn) => { const s = readFileSync(file, "utf8"); const t = fn(s); if (t === s) console.warn("No change in", file); writeFileSync(file, t); };

// notification icon (must be white on transparent) and colour
mkdirSync(res + "drawable", { recursive: true });
writeFileSync(res + "drawable/ic_stat_thaas.xml", `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M7,2h10a2,2 0,0 1,2 2v16a2,2 0,0 1,-2 2H7a2,2 0,0 1,-2 -2V4a2,2 0,0 1,2 -2z M12,6.5c-0.8,1.6 -3.5,3.6 -3.5,5.6c0,1.3 1,2.2 2.2,2.2c0.4,0 0.8,-0.1 1,-0.3l-0.6,2.5h1.8l-0.6,-2.5c0.3,0.2 0.6,0.3 1,0.3c1.2,0 2.2,-0.9 2.2,-2.2C15.5,10.1 12.8,8.1 12,6.5z" android:fillType="evenOdd"/>
</vector>
`);
mkdirSync(res + "values", { recursive: true });
writeFileSync(res + "values/thaas_colors.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources><color name="thaas_gold">#E8B64C</color></resources>
`);

edit(A + "src/main/AndroidManifest.xml", (s) => s.includes("default_notification_icon") ? s : s.replace("</application>", `
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_thaas" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/thaas_gold" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="turns" />
    </application>`));

// Android 15 draws apps under the status bar by default; opt out so nothing is hidden
mkdirSync(res + "values-v35", { recursive: true });
writeFileSync(res + "values-v35/styles.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
    </style>
</resources>
`);

// the app stands upright (portrait); replaces any earlier setting (e.g. landscape)
edit(A + "src/main/AndroidManifest.xml", (s) => s.includes("screenOrientation")
  ? s.replace(/android:screenOrientation="[^"]*"/, 'android:screenOrientation="portrait"')
  : s.replace(/<activity\b/, '<activity android:screenOrientation="portrait"'));

// version: 1.0.<build number>
const n = Number(process.env.GITHUB_RUN_NUMBER || 1);
edit(A + "build.gradle", (s) => s
  .replace(/versionCode\s+\d+/, `versionCode ${n}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "1.0.${n}"`));

// Tell the game whether this build can use push. Without google-services.json, asking Android for
// push would crash the app on start, so the game skips it instead.
const pushOn = existsSync(A + "google-services.json");
const www = fileURLToPath(new URL("../www/", import.meta.url));
mkdirSync(www, { recursive: true });
writeFileSync(www + "push-enabled.json", JSON.stringify({ enabled: pushOn }) + "\n");
if (!pushOn) {
  console.warn("WARNING: android/app/google-services.json is missing, so push notifications are turned off in this build.");
}
console.log("Android project patched (version 1.0." + n + ")");
