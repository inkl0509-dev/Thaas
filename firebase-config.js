// Paste your own config here: Firebase console → Project settings → Your apps → Web app → SDK setup.
// These keys are safe to commit to GitHub; firestore.rules is what protects the data.
export const firebaseConfig = {
  apiKey: "AIzaSyA1jfYnqJ92nkotDJSjjeAXvIYEQf0gucQ",
  authDomain: "game-3814f.firebaseapp.com",
  projectId: "game-3814f",
  storageBucket: "game-3814f.firebasestorage.app",
  messagingSenderId: "698322919920",
  appId: "1:698322919920:web:6911800df08c2d0bd87d35",
};

// Your website's address on Vercel (used by the Android app for invite links and push notifications).
// Example: "https://thaas.vercel.app/"
export const siteUrl = "https://thaas-red.vercel.app/";
export const notifyUrl = siteUrl.replace(/\/?$/, "/") + "api/notify";
