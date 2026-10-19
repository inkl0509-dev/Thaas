// Ranks, badges, avatars and cosmetics for registered players. Pure data + helpers.

export const AVATARS = [
  "🤖", "👾", "🦊", "🐯", "🦁", "🐼", "🐸", "🐙", "🦄", "🐲",
  "👽", "🥷", "🧙", "🧛", "🧜", "🦸", "🐵", "🦉", "🐺", "🐬",
];

// Career points = every round's points added up (registered players only).
export const RANKS = [
  { name: "Rookie",   icon: "🃏", at: 0 },
  { name: "Bronze",   icon: "🥉", at: 300 },
  { name: "Silver",   icon: "🥈", at: 1000 },
  { name: "Gold",     icon: "🥇", at: 2500 },
  { name: "Platinum", icon: "💠", at: 5000 },
  { name: "Diamond",  icon: "💎", at: 10000 },
  { name: "Legend",   icon: "👑", at: 20000 },
];

export function rankIndex(points = 0) {
  let i = 0;
  RANKS.forEach((r, k) => { if (points >= r.at) i = k; });
  return i;
}

export function rankProgress(points = 0) {
  const i = rankIndex(points);
  const next = RANKS[i + 1];
  if (!next) return { i, pct: 1, toNext: 0, next: null };
  const from = RANKS[i].at;
  return { i, pct: Math.max(0, (points - from) / (next.at - from)), toNext: next.at - points, next };
}

export const BADGES = [
  { id: "firstDigu", icon: "🎉", name: "First DIGU",  desc: "Call DIGU once",            test: (s) => (s.digus || 0) >= 1 },
  { id: "hotHand",   icon: "🔥", name: "Hot Hand",    desc: "Call DIGU 10 times",        test: (s) => (s.digus || 0) >= 10 },
  { id: "digu50",    icon: "⚡", name: "Lightning",   desc: "Call DIGU 50 times",        test: (s) => (s.digus || 0) >= 50 },
  { id: "century",   icon: "💯", name: "Big Round",   desc: "Score 150+ in one round",   test: (s) => (s.bestRound || 0) >= 150 },
  { id: "champ",     icon: "🏆", name: "Champion",    desc: "Win a game",                test: (s) => (s.gameWins || 0) >= 1 },
  { id: "dynasty",   icon: "🏰", name: "Dynasty",     desc: "Win 10 games",              test: (s) => (s.gameWins || 0) >= 10 },
  { id: "regular",   icon: "🎴", name: "Regular",     desc: "Play 25 rounds",            test: (s) => (s.gamesPlayed || 0) >= 25 },
  { id: "veteran",   icon: "🎖️", name: "Veteran",     desc: "Play 100 rounds",           test: (s) => (s.gamesPlayed || 0) >= 100 },
  { id: "rich",      icon: "💰", name: "High Roller", desc: "Reach 5,000 career points", test: (s) => (s.careerPoints || 0) >= 5000 },
];

export const earnedBadges = (stats) => BADGES.filter((b) => b.test(stats || {}));

// Cosmetics, each unlocked at a rank (index into RANKS). Guests always get the first option.
export const TABLES = [
  { id: "green",    name: "Lagoon",        rank: 0, c: ["#14a0b0", "#0d7487", "#08495a"] },
  { id: "felt",     name: "Classic green", rank: 0, c: ["#16634b", "#0f4d3a", "#0a3528"] },
  { id: "blue",     name: "Navy",          rank: 1, c: ["#1b4f84", "#123a63", "#0b2645"] },
  { id: "burgundy", name: "Burgundy",      rank: 2, c: ["#74203a", "#5a1424", "#3c0c17"] },
  { id: "purple",   name: "Royal purple",  rank: 3, c: ["#51297e", "#3b1d5e", "#260f40"] },
  { id: "charcoal", name: "Charcoal",      rank: 4, c: ["#323843", "#23272e", "#15181d"] },
  { id: "teal",     name: "Deep ocean",    rank: 5, c: ["#127080", "#0b4f5a", "#06343c"] },
  { id: "night",    name: "Midnight gold", rank: 6, c: ["#2b2b66", "#1a1a40", "#0d0d26"] },
  // 💎 Premium tables
  { id: "sandbank", name: "Sandbank",      rank: 0, premium: true, c: ["#3fc6c9", "#1a9aa6", "#0b6e7c"] },
  { id: "sunset",   name: "Island sunset", rank: 0, premium: true, c: ["#c8553d", "#8f2d56", "#4a1942"] },
  { id: "reef",     name: "Coral reef",    rank: 0, premium: true, c: ["#0f9b8e", "#0a6e75", "#063f50"] },
  { id: "marble",   name: "Black marble",  rank: 0, premium: true, c: ["#3a3a3a", "#1f1f1f", "#0a0a0a"] },
  { id: "emerald",  name: "Emerald",       rank: 0, premium: true, c: ["#1fa36b", "#127a4f", "#094d31"] },
];

export const DECKS = [
  { id: "red",   name: "Red",     rank: 0, bg: "repeating-linear-gradient(45deg, #8c1d2c 0 6px, #a3283a 6px 12px)" },
  { id: "blue",  name: "Blue",    rank: 1, bg: "repeating-linear-gradient(45deg, #1d3f8c 0 6px, #2852a3 6px 12px)" },
  { id: "green", name: "Green",   rank: 2, bg: "repeating-linear-gradient(45deg, #1d6b3d 0 6px, #28834d 6px 12px)" },
  { id: "black", name: "Black",   rank: 3, bg: "repeating-linear-gradient(45deg, #15161a 0 6px, #2a2c33 6px 12px)" },
  { id: "gold",  name: "Gold",    rank: 4, bg: "repeating-linear-gradient(45deg, #9a7420 0 6px, #c9a03c 6px 12px)" },
  { id: "holo",  name: "Holo",    rank: 5, bg: "linear-gradient(135deg, #ff5f6d, #ffc371, #47e891, #4ac1ff, #a86bff)" },
  // 💎 Premium card backs
  { id: "waves",   name: "Lagoon waves", rank: 0, premium: true, bg: "radial-gradient(circle at 50% 120%, transparent 40%, rgba(255,255,255,.35) 41% 44%, transparent 45%) 0 0/18px 12px, linear-gradient(#18b6c8, #0b6e7c)" },
  { id: "coral",   name: "Coral",        rank: 0, premium: true, bg: "radial-gradient(circle, #ffd0c2 18%, transparent 20%) 0 0/12px 12px, linear-gradient(135deg, #ff7a6b, #e0446a)" },
  { id: "stars",   name: "Starry night", rank: 0, premium: true, bg: "radial-gradient(circle, #fff 1px, transparent 1.5px) 0 0/10px 10px, radial-gradient(circle, #ffd76a 1px, transparent 1.6px) 5px 5px/14px 14px, linear-gradient(#1b1d4a, #090a1f)" },
  { id: "diamond", name: "Diamond",      rank: 0, premium: true, bg: "conic-gradient(from 45deg, #b490ff 25%, #7ee8fa 0 50%, #b490ff 0 75%, #7ee8fa 0) 0 0/14px 14px" },
  { id: "palm",    name: "Palm leaf",    rank: 0, premium: true, bg: "repeating-linear-gradient(60deg, #1e7a46 0 4px, #2fa35f 4px 8px), linear-gradient(#1e7a46, #145a33)" },
  { id: "royal",   name: "Royal check",  rank: 0, premium: true, bg: "repeating-conic-gradient(#5a1424 0 25%, #c9a03c 0 50%) 0 0/12px 12px" },
];

export const SHOUT_FONTS = [
  { id: "classic", name: "Classic",  rank: 0, css: "Fraunces, Georgia, serif", size: 27 },
  { id: "comic",   name: "Comic",    rank: 1, css: "Bangers, Impact, sans-serif", size: 30 },
  { id: "script",  name: "Script",   rank: 2, css: "Lobster, cursive", size: 26 },
  { id: "marker",  name: "Marker",   rank: 3, css: "'Permanent Marker', cursive", size: 23 },
  { id: "arcade",  name: "Arcade",   rank: 4, css: "'Press Start 2P', monospace", size: 12, small: true },
  { id: "neon",    name: "Neon",     rank: 5, css: "Monoton, cursive", size: 19 },
];

export const SHOUT_COLORS = [
  { id: "gold",    name: "Gold",    rank: 0, css: "#ffd76a" },
  { id: "white",   name: "White",   rank: 1, css: "#ffffff" },
  { id: "red",     name: "Red",     rank: 2, css: "#ff4d5e" },
  { id: "cyan",    name: "Cyan",    rank: 3, css: "#4ae3ff" },
  { id: "pink",    name: "Pink",    rank: 4, css: "#ff7ad9" },
  { id: "lime",    name: "Lime",    rank: 5, css: "#b6ff4a" },
  { id: "rainbow", name: "Rainbow", rank: 6, css: "rainbow" },
];

export const DEFAULT_PREFS = { table: "green", deck: "red", font: "classic", color: "gold" };

// Only keep choices the player's rank allows (guests: defaults only).
export function allowedPrefs(prefs, rank, registered, premium = false) {
  const pick = (list, id, key) => {
    const o = list.find((x) => x.id === id);
    return o && registered && (o.premium ? premium : o.rank <= rank) ? o.id : DEFAULT_PREFS[key];
  };
  return {
    table: pick(TABLES, prefs?.table, "table"),
    deck: pick(DECKS, prefs?.deck, "deck"),
    font: pick(SHOUT_FONTS, prefs?.font, "font"),
    color: pick(SHOUT_COLORS, prefs?.color, "color"),
  };
}

export const byId = (list, id) => list.find((x) => x.id === id) || list[0];
