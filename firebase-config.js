// Paste your own config here: Firebase console → Project settings → Your apps → Web app → SDK setup.
// These keys are safe to commit to GitHub; firestore.rules is what protects the data.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT",
  storageBucket: "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Your website's address on Vercel (used by the Android app for invite links and push notifications).
// Example: "https://thaas.vercel.app/"
export const siteUrl = "https://PASTE-YOUR-SITE.vercel.app/";
export const notifyUrl = siteUrl.replace(/\/?$/, "/") + "api/notify";
