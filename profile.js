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
  // DIGU
  { id: "firstDigu", icon: "🎉", name: "First DIGU",  desc: "Call DIGU once",            test: (s) => (s.digus || 0) >= 1 },
  { id: "hotHand",   icon: "🔥", name: "Hot Hand",    desc: "Call DIGU 10 times",        test: (s) => (s.digus || 0) >= 10 },
  { id: "digu50",    icon: "⚡", name: "Lightning",   desc: "Call DIGU 50 times",        test: (s) => (s.digus || 0) >= 50 },
  { id: "digu100",   icon: "🌪️", name: "Storm",       desc: "Call DIGU 100 times",       test: (s) => (s.digus || 0) >= 100 },
  { id: "century",   icon: "💯", name: "Big Round",   desc: "Score 150+ in one DIGU round", test: (s) => (s.bestRound || 0) >= 150 },
  { id: "monster",   icon: "🦈", name: "Shark",       desc: "Score 200+ in one DIGU round", test: (s) => (s.bestRound || 0) >= 200 },
  // CALL
  { id: "firstCall", icon: "📣", name: "First CALL",  desc: "Win a round by calling CALL", test: (s) => (s.callWins || 0) >= 1 },
  { id: "callMaster",icon: "🎙️", name: "CALL Master", desc: "Win 25 rounds by calling CALL", test: (s) => (s.callWins || 0) >= 25 },
  { id: "catcher",   icon: "🪤", name: "Gotcha",      desc: "Catch someone who called CALL", test: (s) => (s.catches || 0) >= 1 },
  { id: "sharpEye",  icon: "🦅", name: "Sharp Eye",   desc: "Catch 10 callers",           test: (s) => (s.catches || 0) >= 10 },
  { id: "iceCold",   icon: "🧊", name: "Ice Cold",    desc: "Win a CALL with a count of 2 or less", test: (s) => s.lowCall != null && s.lowCall <= 2 },
  // BONDI
  { id: "firstOut",  icon: "🏃", name: "First Out",   desc: "Be first out in BONDI",      test: (s) => (s.bondiFirst || 0) >= 1 },
  { id: "escape",    icon: "🪂", name: "Escape Artist", desc: "Be first out in BONDI 20 times", test: (s) => (s.bondiFirst || 0) >= 20 },
  // DHIHA
  { id: "teamPlayer",icon: "🤝", name: "Team Player", desc: "Win a DHIHA round",          test: (s) => (s.dhihaWins || 0) >= 1 },
  { id: "tens",      icon: "🔟", name: "All the Tens", desc: "Win all four 10s in DHIHA",  test: (s) => (s.dhihaTens4 || 0) >= 1 },
  { id: "sweep",     icon: "🧹", name: "Clean Sweep", desc: "Win all 13 decks in DHIHA",  test: (s) => (s.dhihaSweep || 0) >= 1 },
  // everything
  { id: "champ",     icon: "🏆", name: "Champion",    desc: "Win a game",                test: (s) => (s.gameWins || 0) >= 1 },
  { id: "dynasty",   icon: "🏰", name: "Dynasty",     desc: "Win 10 games",              test: (s) => (s.gameWins || 0) >= 10 },
  { id: "grandmaster", icon: "👑", name: "Grandmaster", desc: "Win 50 games",            test: (s) => (s.gameWins || 0) >= 50 },
  { id: "onFire",    icon: "♨️", name: "On Fire",     desc: "Win 3 rounds in a row",     test: (s) => (s.bestStreak || 0) >= 3 },
  { id: "unstoppable", icon: "🚀", name: "Unstoppable", desc: "Win 5 rounds in a row",   test: (s) => (s.bestStreak || 0) >= 5 },
  { id: "allRounder",icon: "🎲", name: "All-Rounder", desc: "Play DIGU, CALL, BONDI and DHIHA", test: (s) => ["digu", "call", "bondi", "dhiha"].every((g) => (s.played?.[g] || 0) >= 1) },
  { id: "regular",   icon: "🎴", name: "Regular",     desc: "Play 25 rounds",            test: (s) => (s.gamesPlayed || 0) >= 25 },
  { id: "veteran",   icon: "🎖️", name: "Veteran",     desc: "Play 100 rounds",           test: (s) => (s.gamesPlayed || 0) >= 100 },
  { id: "legend",    icon: "🗿", name: "Island Legend", desc: "Play 500 rounds",         test: (s) => (s.gamesPlayed || 0) >= 500 },
  { id: "loyal",     icon: "📅", name: "Loyal",       desc: "Play on 7 different days",  test: (s) => (s.days || 0) >= 7 },
  { id: "local",     icon: "🌴", name: "True Local",  desc: "Play on 30 different days", test: (s) => (s.days || 0) >= 30 },
  { id: "challenger",icon: "🎯", name: "Challenger",  desc: "Finish 10 daily challenges", test: (s) => (s.challengesDone || 0) >= 10 },
  { id: "rich",      icon: "💰", name: "High Roller", desc: "Reach 5,000 career points", test: (s) => (s.careerPoints || 0) >= 5000 },
];

// ---------- daily challenges ----------
// Everyone gets the same 3 challenges each day. Finishing one adds career points. They count only in
// games with other people (games against the computer don't count, like career points).
// ev (what happened in a round): { game, win, digu, pts, callWin, catch, bondiFirst, dhihaWin, games: [games played today] }
export const CHALLENGES = [
  { id: "play5",   icon: "🎴", text: "Play 5 rounds",                 goal: 5, reward: 40,  count: (e) => 1 },
  { id: "play10",  icon: "🃏", text: "Play 10 rounds",                goal: 10, reward: 80, count: (e) => 1 },
  { id: "win2",    icon: "🏅", text: "Win 2 rounds",                  goal: 2, reward: 60,  count: (e) => (e.win ? 1 : 0) },
  { id: "win4",    icon: "🥇", text: "Win 4 rounds",                  goal: 4, reward: 120, count: (e) => (e.win ? 1 : 0) },
  { id: "digu1",   icon: "🎉", text: "Call DIGU",                     goal: 1, reward: 60,  count: (e) => (e.digu ? 1 : 0) },
  { id: "digu2",   icon: "🔥", text: "Call DIGU twice",               goal: 2, reward: 120, count: (e) => (e.digu ? 1 : 0) },
  { id: "big100",  icon: "💯", text: "Score 100+ in a DIGU round",    goal: 1, reward: 80,  count: (e) => (e.game === "digu" && e.pts >= 100 ? 1 : 0) },
  { id: "digu3r",  icon: "♠️", text: "Play 3 DIGU rounds",            goal: 3, reward: 40,  count: (e) => (e.game === "digu" ? 1 : 0) },
  { id: "call1",   icon: "📣", text: "Win a round by calling CALL",   goal: 1, reward: 60,  count: (e) => (e.callWin ? 1 : 0) },
  { id: "catch1",  icon: "🪤", text: "Catch a CALL",                  goal: 1, reward: 80,  count: (e) => (e.catch ? 1 : 0) },
  { id: "call3r",  icon: "♣️", text: "Play 3 CALL rounds",            goal: 3, reward: 40,  count: (e) => (e.game === "call" ? 1 : 0) },
  { id: "bondi1",  icon: "🏃", text: "Be first out in BONDI",         goal: 1, reward: 60,  count: (e) => (e.bondiFirst ? 1 : 0) },
  { id: "bondi3r", icon: "♥️", text: "Play 3 BONDI rounds",           goal: 3, reward: 40,  count: (e) => (e.game === "bondi" ? 1 : 0) },
  { id: "dhiha1",  icon: "🤝", text: "Win a DHIHA round",             goal: 1, reward: 70,  count: (e) => (e.dhihaWin ? 1 : 0) },
  { id: "mix2",    icon: "🎲", text: "Play 2 different games",        goal: 2, reward: 50,  count: (e) => (e.newGameToday ? 1 : 0) },
];
const hashStr = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// today's 3 challenges (one easy "play", one "win", one special), the same for everyone
export function dailyChallenges(day = todayKey()) {
  const h = hashStr(day);
  const easy = ["play5", "play10", "digu3r", "call3r", "bondi3r", "mix2"];
  const win = ["win2", "win4", "digu1", "call1", "bondi1"];
  const special = ["digu2", "big100", "catch1", "dhiha1", "win4", "call1"];
  const pick = (list, k) => CHALLENGES.find((c) => c.id === list[(h >>> k) % list.length]);
  const out = [pick(easy, 0), pick(win, 5), pick(special, 11)];
  return out.filter((c, i) => out.findIndex((x) => x.id === c.id) === i);
}
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
