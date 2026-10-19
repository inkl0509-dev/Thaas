// Paste your own config here: Firebase console → Project settings → Your apps → Web app → SDK setup.
// These keys are safe to commit to GitHub; firestore.rules is what protects the data.
export const firebaseConfig = {
  apiKey: "AIzaSyCf3vJpqRtNV0HL3gvtKdP0AvmOQYp2EWs",
  authDomain: "token-8e106.firebaseapp.com",
  projectId: "token-8e106",
  storageBucket: "token-8e106.firebasestorage.app",
  messagingSenderId: "123062480763",
  appId: "1:123062480763:web:7ccd2236d14c2d932457de",
};

// Your website's address on Vercel (used by the Android app for invite links and push notifications).
// Example: "https://thaas.vercel.app/"
export const siteUrl = "https://PASTE-YOUR-SITE.vercel.app/";
export const notifyUrl = siteUrl.replace(/\/?$/, "/") + "api/notify";
