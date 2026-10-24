// Pure game logic — no Firebase here, so it can be tested on its own.
// A card is stored as a string id "rank-suit-deck", e.g. "1-S-0" = Ace of Spades from deck 0.
// The deck index keeps ids unique when two decks are used (5–6 players).

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

export const HAND_SIZE = 10;
export const WIN_SHAPE = [4, 3, 3]; // 1 set of 4 + 2 sets of 3 = 10 cards

export function parse(id) {
  const [r, s, d] = id.split('-');
  return { id, r: Number(r), s, d: Number(d) };
}

export function label(r) {
  return RANK_LABEL[r] || String(r);
}

export function isRed(id) {
  const s = parse(id).s;
  return s === 'H' || s === 'D';
}

export function buildDeck(numDecks) {
  const deck = [];
  for (let d = 0; d < numDecks; d++)
    for (const s of SUITS)
      for (let r = 1; r <= 13; r++) deck.push(`${r}-${s}-${d}`);
  return deck;
}

// Unbiased random number in [0, n) using the browser's secure random generator.
function randInt(n) {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.floor(Math.random() * n);
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { c.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// How many cards still sit right next to a card they were next to before (either direction).
function keptNeighbours(before, after) {
  const pairs = new Set();
  for (let i = 0; i + 1 < before.length; i++) {
    pairs.add(before[i] + "|" + before[i + 1]);
    pairs.add(before[i + 1] + "|" + before[i]);
  }
  let kept = 0;
  for (let i = 0; i + 1 < after.length; i++) if (pairs.has(after[i] + "|" + after[i + 1])) kept++;
  return kept;
}

// Middle pile is empty: every thrown card is shuffled into a new middle pile (the thrown pile
// starts empty again). It reshuffles until no two cards stay together in the order they were
// thrown, so nobody can predict the new pile by remembering the discards.
export function reshuffleDiscard(discard) {
  if (discard.length <= 1) return { deck: [], discard: [...discard] };
  const rest = [...discard];
  let best = shuffle(rest), bestKept = keptNeighbours(rest, best);
  for (let i = 0; i < 300 && bestKept > 0; i++) {
    const s = shuffle(rest);
    const k = keptNeighbours(rest, s);
    if (k < bestKept) { best = s; bestKept = k; }
  }
  return { deck: best, discard: [] };
}

// Penalty points for a card left over when someone calls DIGU.
export function points(id) {
  const r = parse(id).r;
  if (r === 1) return 15;
  if (r >= 11) return 10;
  return r;
}

const consecutive = (rs) => rs.every((v, i) => i === 0 || v === rs[i - 1] + 1);

// A valid set is either:
//  - same number, any suits (e.g. 7♠ 7♥ 7♦), or
//  - same suit in number order (e.g. 2♥ 3♥ 4♥). Ace can be low (A-2-3) or high (Q-K-A), no wrapping.
export function isValidGroup(ids) {
  if (ids.length < 3) return false;
  const cs = ids.map(parse);
  if (cs.every((c) => c.r === cs[0].r)) return true;
  if (!cs.every((c) => c.s === cs[0].s)) return false;
  const rs = cs.map((c) => c.r).sort((a, b) => a - b);
  if (consecutive(rs)) return true;
  if (rs[0] === 1) return consecutive([...rs.slice(1), 14]);
  return false;
}

function combinations(arr, k, start = 0, prefix = [], out = []) {
  if (prefix.length === k) { out.push(prefix); return out; }
  for (let i = start; i <= arr.length - (k - prefix.length); i++)
    combinations(arr, k, i + 1, [...prefix, arr[i]], out);
  return out;
}

// Returns [[4 cards], [3 cards], [3 cards]] if the 10 cards are a winning hand, else null.
export function findWinningLayout(ids) {
  if (ids.length !== HAND_SIZE) return null;
  for (const four of combinations(ids, 4)) {
    if (!isValidGroup(four)) continue;
    const rest = ids.filter((c) => !four.includes(c));
    const [first, ...others] = rest;
    for (const pair of combinations(others, 2)) {
      const a = [first, ...pair];
      const b = rest.filter((c) => !a.includes(c));
      if (isValidGroup(a) && isValidGroup(b)) return [four, a, b];
    }
  }
  return null;
}

// Best arrangement of a hand into sets of 3 or 4, leaving the fewest penalty points.
// Used to count losers' hands and for the "Group sets" button.
export function bestLayout(ids) {
  const n = ids.length;
  const groups = [];
  for (const k of [3, 4]) {
    for (const idx of combinations([...Array(n).keys()], k)) {
      if (isValidGroup(idx.map((i) => ids[i]))) {
        groups.push(idx.reduce((m, i) => m | (1 << i), 0));
      }
    }
  }
  const memo = new Map();
  // returns { pts, picks } for cards not yet used in `used`
  function solve(used) {
    if (memo.has(used)) return memo.get(used);
    let i = 0;
    while (i < n && used & (1 << i)) i++;
    if (i === n) return { pts: 0, picks: [] };
    // option 1: card i is left over
    const skip = solve(used | (1 << i));
    let best = { pts: skip.pts + points(ids[i]), picks: skip.picks };
    // option 2: card i goes in a set
    for (const g of groups) {
      if (!(g & (1 << i)) || g & used) continue;
      const sub = solve(used | g);
      if (sub.pts < best.pts) best = { pts: sub.pts, picks: [g, ...sub.picks] };
    }
    memo.set(used, best);
    return best;
  }
  const { pts, picks } = solve(0);
  const sets = picks.map((g) => ids.filter((_, i) => g & (1 << i)));
  const inSets = new Set(sets.flat());
  return { points: pts, sets, leftover: ids.filter((c) => !inSets.has(c)) };
}

// True if a 10-card hand is one card away from DIGU:
// swapping one card for one specific card would make 3 + 3 + 4 sets.
export function oneAway(ids) {
  if (ids.length !== HAND_SIZE || findWinningLayout(ids)) return false;
  // only cards that could join a set with something in the hand are worth trying
  const cand = new Set();
  for (const id of ids) {
    const { r, s } = parse(id);
    for (const s2 of SUITS) cand.add(`${r}-${s2}-9`);
    // same suit within 2 steps; Ace counts as 1 and as 14 (for Q-K-A)
    for (const v of r === 1 ? [1, 14] : [r]) {
      for (const dr of [-2, -1, 1, 2]) {
        const w = v + dr === 14 ? 1 : v + dr;
        if (w >= 1 && w <= 13) cand.add(`${w}-${s}-9`);
      }
    }
  }
  for (let i = 0; i < ids.length; i++) {
    const rest = ids.filter((_, j) => j !== i);
    for (const y of cand) if (findWinningLayout([...rest, y])) return true;
  }
  return false;
}

// ---------- round scoring ----------
// DIGU caller: 100 bonus + the value of all their cards.
// Everyone else: value of cards in sets (3 or 4) minus value of cards left over.
// No set at all: -100.
export const DIGU_BONUS = 100;
export const NO_SET_PENALTY = -100;
const sum = (ids) => ids.reduce((a, c) => a + points(c), 0);

export function roundScore(cards, winnerSets = null) {
  if (winnerSets) {
    const setPts = sum(winnerSets.flat());
    return { pts: DIGU_BONUS + setPts, setPts, leftPts: 0, sets: winnerSets, leftover: [], digu: true };
  }
  // the arrangement leaving the fewest leftover points also gives the highest score
  const best = bestLayout(cards);
  const setPts = sum(best.sets.flat()), leftPts = best.points;
  if (!best.sets.length) {
    return { pts: NO_SET_PENALTY, setPts: 0, leftPts, sets: [], leftover: best.leftover, noSets: true };
  }
  return { pts: setPts - leftPts, setPts, leftPts, sets: best.sets, leftover: best.leftover };
}

export function sortBySuit(ids) {
  return [...ids].sort((a, b) => {
    const A = parse(a), B = parse(b);
    return SUITS.indexOf(A.s) - SUITS.indexOf(B.s) || A.r - B.r || A.d - B.d;
  });
}

export function sortByRank(ids) {
  return [...ids].sort((a, b) => {
    const A = parse(a), B = parse(b);
    return A.r - B.r || SUITS.indexOf(A.s) - SUITS.indexOf(B.s) || A.d - B.d;
  });
}

// ======================= CALL =======================
// Values: A = 1, 2–10 = face value, J/Q/K = 10. Lowest count wins.
export const CALL_HAND_SIZE = 5;  // CALL deals 5 cards to each player
export const CALL_LIMIT = 7;     // you may CALL when your count is 7 or less ("less than 8")
export const CALL_PENALTY = 50;  // caller's score when someone else had a lower count

export function callValue(id) {
  const r = parse(id).r;
  return r >= 10 ? 10 : r;
}
export const handValue = (ids) => ids.reduce((a, c) => a + callValue(c), 0);

// You may throw one card, or several cards of the same number together.
export function canThrowTogether(ids) {
  if (!ids.length) return false;
  const r = parse(ids[0]).r;
  return ids.every((c) => parse(c).r === r);
}

// Score a CALL round. hands: { uid: [cards] }.
// Caller lowest (or tied lowest): caller 0, everyone else their count.
// Someone strictly lower: caller 50, the lowest player(s) 0, everyone else their count.
export function callScores(hands, callerUid) {
  const counts = Object.fromEntries(Object.entries(hands).map(([u, cards]) => [u, handValue(cards)]));
  const callerCount = counts[callerUid] ?? 0;
  const others = Object.entries(counts).filter(([u]) => u !== callerUid);
  const lowestOther = others.length ? Math.min(...others.map(([, v]) => v)) : Infinity;
  const caught = lowestOther < callerCount;
  const catchers = caught ? others.filter(([, v]) => v === lowestOther).map(([u]) => u) : [];
  const result = {};
  for (const [u, v] of Object.entries(counts)) {
    let pts, how;
    // caught (someone had less than the caller): the caller scores 50, everyone else their count
    if (u === callerUid) { pts = caught ? CALL_PENALTY : 0; how = caught ? "caught" : "won"; }
    else if (catchers.includes(u)) { pts = v; how = "caught-caller"; }
    else { pts = v; how = "count"; }
    result[u] = { count: v, pts, how };
  }
  return { result, caught, catchers, callerCount };
}

// ======================= BONDI =======================
// The whole deck is dealt out. Whoever holds K♠ leads first. Everyone must follow the suit that
// was led. If everyone follows, the cards are set aside and the highest card of that suit leads
// next. If someone can't follow, they play any card and the trick stops there: all the cards
// played so far go to whoever played the highest card of the led suit, and that player leads.
// First player out of cards scores 0, the next 10, then 20…; lowest total wins.
export const BONDI_STEP = 10;
export const BONDI_FIRST = '13-S-0'; // K♠ starts
export const bondiRank = (id) => { const r = parse(id).r; return r === 1 ? 14 : r; }; // A high
export const suitOf = (id) => parse(id).s;

// Cards in my hand I may play now.
export function bondiLegal(hand, trick) {
  if (!trick?.length) return hand;
  const lead = suitOf(trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === lead);
  return follow.length ? follow : hand;
}

// Highest card of the led suit in a trick → that player's uid.
function trickTop(trick) {
  const lead = suitOf(trick[0].card);
  return trick.filter((t) => suitOf(t.card) === lead)
    .reduce((a, b) => (bondiRank(b.card) > bondiRank(a.card) ? b : a)).uid;
}

// Next seat after index `from` whose player still has cards (and isn't in `skip`).
export function nextActive(playerIds, counts, from, skip = []) {
  const n = playerIds.length;
  for (let k = 1; k <= n; k++) {
    const u = playerIds[(from + k) % n];
    if ((counts[u] || 0) > 0 && !skip.includes(u)) return (from + k) % n;
  }
  return -1;
}

// One card played. st = { playerIds, counts, trick, trickSize, out, aside }.
// Returns the room fields to change, plus what happened (for messages).
export function bondiPlay(st, who, card) {
  const counts = { ...st.counts, [who]: (st.counts[who] || 0) - 1 };
  const trick = [...(st.trick || []), { uid: who, card }];
  const cut = trick.length > 1 && suitOf(card) !== suitOf(trick[0].card);
  if (!cut && trick.length < st.trickSize) { // trick carries on
    const turn = nextActive(st.playerIds, counts, st.playerIds.indexOf(who), trick.map((t) => t.uid));
    if (turn >= 0) return { counts, trick, turn, event: null };
  }
  return endTrick(st, counts, trick, cut ? who : null);
}

// A player who is offline is passed over for the rest of this trick.
export function bondiSkip(st, who) {
  const trick = st.trick || [];
  const trickSize = Math.max(1, st.trickSize - 1);
  if (trick.length && trick.length >= trickSize) return endTrick(st, { ...st.counts }, trick, null);
  const turn = nextActive(st.playerIds, st.counts, st.playerIds.indexOf(who), trick.map((t) => t.uid));
  return { trickSize, turn, trick, counts: st.counts, event: null };
}

function endTrick(st, counts, trick, cutBy) {
  const lead = suitOf(trick[0].card);
  const top = trickTop(cutBy ? trick.slice(0, -1) : trick);
  const cards = trick.map((t) => t.card);
  const res = { counts, trick: [] };
  if (cutBy) {
    counts[top] += cards.length;
    res.pickup = { uid: top, cards };
    res.event = { kind: 'cut', by: cutBy, to: top, n: cards.length, suit: lead };
    res.turn = st.playerIds.indexOf(top);
  } else {
    res.aside = (st.aside || 0) + cards.length;
    res.event = { kind: 'clear', top, suit: lead };
    res.turn = counts[top] > 0 ? st.playerIds.indexOf(top) : nextActive(st.playerIds, counts, st.playerIds.indexOf(top));
  }
  res.lastTrick = { cards, players: trick.map((t) => t.uid), to: cutBy ? top : null, cut: cutBy };
  // anyone who has just run out of cards is out, in the order they played
  const out = [...(st.out || [])];
  for (const t of trick) if (counts[t.uid] === 0 && !out.includes(t.uid)) out.push(t.uid);
  res.out = out;
  res.newlyOut = out.slice((st.out || []).length);
  const active = st.playerIds.filter((u) => counts[u] > 0);
  res.trickSize = active.length;
  if (active.length <= 1) {
    res.over = true;
    res.order = [...out, ...active]; // whoever is still holding cards comes last
  }
  return res;
}

// Points this round from the finishing order: 0, 10, 20, …
export function bondiScores(order) {
  return Object.fromEntries(order.map((u, i) => [u, i * BONDI_STEP]));
}

// The computer's choice. ctx (optional) = { later: players still to play this trick,
// voids: { uid: [suits they've run out of] }, me }.
// Leading: a small card in a suit someone has run out of, so they'll cut and the pile goes to
// whoever played highest (not me); otherwise my lowest card.
// Following: if someone after me is likely to cut, stay under the highest card; if I'm last
// (the trick will be set aside), get rid of my biggest card of that suit.
// Cutting: get rid of my biggest card.
export function bondiBotCard(hand, trick, ctx = {}) {
  const legal = bondiLegal(hand, trick);
  if (ctx.level === "easy") return legal[Math.floor(Math.random() * legal.length)];
  const low = (a) => a.reduce((x, y) => (bondiRank(y) < bondiRank(x) ? y : x));
  const high = (a) => a.reduce((x, y) => (bondiRank(y) > bondiRank(x) ? y : x));
  const voids = ctx.voids || {};
  const voidIn = (u, s) => (voids[u] || []).includes(s);
  if (!trick?.length) {
    // Leading: never lead a suit someone has already run out of. They'll cut, and the highest card
    // of that suit (very likely mine, as the leader) picks up the whole pile. Lead a "safe" suit,
    // low, so someone else is likely to go over me.
    const others = (ctx.others || []).filter((u) => u !== ctx.me);
    const risky = (c) => others.filter((u) => voidIn(u, suitOf(c))).length;
    const safe = legal.filter((c) => risky(c) === 0);
    if (ctx.level === "hard") {
      // ATTACK: lead a low card of a suit someone FURTHER ROUND has run out of. The players in
      // between follow (likely with bigger cards), then the void player cuts, and whoever played
      // the biggest card of the suit (not me) picks up the whole pile.
      const order = ctx.later && ctx.later.length ? ctx.later : others;
      const traps = [];
      for (const c of legal) {
        const i = order.findIndex((u) => voidIn(u, suitOf(c)));
        if (i <= 0) continue; // nobody out of it, or the very next player is (then I'd pick up)
        const s = suitOf(c), r = bondiRank(c);
        let higher = 0; for (let k = r + 1; k <= 14; k++) if (!hand.some((h) => suitOf(h) === s && bondiRank(h) === k)) higher++;
        if (higher >= 3 && r <= 9) traps.push({ c, value: i * 10 + higher - r });
      }
      if (traps.length) return traps.sort((a, b) => b.value - a.value)[0].c;
    }
    if (safe.length) return low(safe);
    // Every suit has someone out of it. Where they sit matters: if the very NEXT player is out of
    // the suit, they cut at once and my card is the highest (I pick everything up). If they sit
    // further round, the players in between follow and one of them is likely to go higher than me.
    const order = (ctx.later && ctx.later.length ? ctx.later : others);
    const firstVoid = (c) => { const i = order.findIndex((u) => voidIn(u, suitOf(c))); return i < 0 ? order.length : i; };
    const higherOut = (c) => { // cards of that suit higher than mine that I don't hold
      const s = suitOf(c), r = bondiRank(c);
      let n = 0; for (let k = r + 1; k <= 14; k++) if (!hand.some((h) => suitOf(h) === s && bondiRank(h) === k)) n++;
      return n;
    };
    const score = (c) => firstVoid(c) * 10 + higherOut(c) - risky(c) * 3; // bigger is safer
    const best = Math.max(...legal.map(score));
    return low(legal.filter((c) => score(c) === best));
  }
  const lead = suitOf(trick[0].card);
  if (suitOf(legal[0]) !== lead) return high(legal);
  const later = ctx.later || null;
  if (later && later.length === 0) return high(legal); // last to play: nobody can cut now
  const best = Math.max(...trick.filter((t) => suitOf(t.card) === lead).map((t) => bondiRank(t.card)));
  const under = legal.filter((c) => bondiRank(c) < best);
  const danger = later ? later.some((u) => voidIn(u, lead)) : true;
  if (under.length) return danger ? high(under) : high(under);
  return danger ? low(legal) : high(legal); // must go over: if nobody's likely to cut, go big
}

// Hand order for Bondi: grouped by suit, low to high.
export function sortBondi(ids) {
  const so = { S: 0, H: 1, C: 2, D: 3 };
  return [...ids].sort((a, b) => so[suitOf(a)] - so[suitOf(b)] || bondiRank(a) - bondiRank(b));
}

// ======================= DHIHA (ދިހަ) =======================
// 4 players in 2 teams (teammates sit opposite), 13 cards each. Follow the suit that was led.
// The first player who can't follow sets the Hukum (trump) with the card they play; it stays for
// the round. A trick is won by the highest Hukum in it, otherwise the highest card of the led suit
// (A is high). The trick (a "deck") goes to the winner's team, and the winner leads next.
// After 13 decks: 3 or 4 tens wins; at 2 tens each, 7 or more decks wins.
export const DHIHA_PLAYERS = 4;
const dRank = (id) => { const r = parse(id).r; return r === 1 ? 14 : r; };

export function dhihaLegal(hand, trick) {
  if (!trick?.length) return hand;
  const lead = suitOf(trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === lead);
  return follow.length ? follow : hand;
}

export function dhihaTrickWinner(trick, hukum) {
  const lead = suitOf(trick[0].card);
  const pool = hukum && trick.some((t) => suitOf(t.card) === hukum)
    ? trick.filter((t) => suitOf(t.card) === hukum)
    : trick.filter((t) => suitOf(t.card) === lead);
  return pool.reduce((a, b) => (dRank(b.card) > dRank(a.card) ? b : a)).uid;
}

const tensIn = (cards) => cards.filter((c) => parse(c).r === 10).length;

// st = { playerIds, teams: {uid: "A"|"B"}, trick, hukum, decks: {A: ["c,c,c,c", …], B: […]} }
export function dhihaPlay(st, who, card) {
  const trick = [...(st.trick || []), { uid: who, card }];
  const res = { trick, hukum: st.hukum || null, event: null };
  const lead = suitOf(trick[0].card);
  if (!res.hukum && trick.length > 1 && suitOf(card) !== lead) {
    res.hukum = suitOf(card);
    res.event = { kind: "hukum", by: who, suit: res.hukum };
  }
  if (trick.length < st.playerIds.length) {
    res.turn = (st.playerIds.indexOf(who) + 1) % st.playerIds.length;
    return res;
  }
  // the deck is complete
  const winner = dhihaTrickWinner(trick, res.hukum);
  const team = st.teams[winner];
  const cards = trick.map((t) => t.card);
  const decks = { A: [...(st.decks?.A || [])], B: [...(st.decks?.B || [])] };
  decks[team].push(cards.join(","));
  res.decks = decks;
  res.trick = [];
  res.turn = st.playerIds.indexOf(winner);
  res.won = { winner, team, cards, tens: tensIn(cards) };
  // The round ends once all four 10s have been taken and it's decided: a team with 3 (or 4) tens wins.
  // At 2 tens each, play goes on until a team has 7 decks.
  const tn = (tm) => decks[tm].reduce((n, d) => n + tensIn(d.split(",")), 0);
  const tA = tn("A"), tB = tn("B");
  if (decks.A.length + decks.B.length >= 13
      || (tA + tB === 4 && (tA >= 3 || tB >= 3 || decks.A.length >= 7 || decks.B.length >= 7))) res.over = dhihaResult(decks);
  return res;
}

// Who won the round and how many points each winning player gets.
export function dhihaResult(decks) {
  const t = (team) => decks[team].reduce((n, d) => n + tensIn(d.split(",")), 0);
  const tens = { A: t("A"), B: t("B") }, count = { A: decks.A.length, B: decks.B.length };
  let team, how;
  if (tens.A >= 3 || tens.B >= 3) { team = tens.A >= 3 ? "A" : "B"; how = tens[team] === 4 ? "all4" : "tens"; }
  else { team = count.A >= 7 ? "A" : "B"; how = "decks"; }
  const other = team === "A" ? "B" : "A";
  const points = count[team] === 13 || count[other] === 0 ? 3 : how === "all4" ? 2 : 1; // every deck: 3 · all 4 tens: 2 · otherwise 1
  return { team, how, points, tens, count };
}

// Computer helper (used when a player runs out of time): lowest legal card,
// but if following, try to win a deck that has a 10 in it.
export function dhihaAutoCard(hand, trick, hukum) {
  const legal = dhihaLegal(hand, trick);
  const low = (a) => a.reduce((x, y) => (dRank(y) < dRank(x) ? y : x));
  if (!trick?.length) return low(legal);
  const hasTen = trick.some((t) => parse(t.card).r === 10);
  if (hasTen) {
    const winners = legal.filter((c) => dhihaTrickWinner([...trick, { uid: "_me", card: c }], hukum || (suitOf(c) !== suitOf(trick[0].card) ? suitOf(c) : null)) === "_me");
    if (winners.length) return low(winners);
  }
  return low(legal);
}


// Smarter DHIHA computer player. The goal is decks with 10s in them:
//  - when my teammate is sure to win the deck, give them my 10 (or my lowest card if I have no 10)
//  - when the other team is winning, take the deck if I can (cheaply), otherwise throw a low card and keep my 10s
//  - lead with a card nobody can beat, else a low card (never a 10 unless it's unbeatable)
// ctx: { me, teams: {uid: "A"|"B"}, playerIds, seen: [cards already played this round], voids: {uid: [suits]} }
export function dhihaBotCard(hand, trick, hukum, ctx = {}) {
  const legal = dhihaLegal(hand, trick);
  if (legal.length === 1) return legal[0];
  const low = (a) => a.reduce((x, y) => (dRank(y) < dRank(x) ? y : x));
  const isTen = (c) => parse(c).r === 10;
  const notTen = (a) => (a.filter((c) => !isTen(c)).length ? a.filter((c) => !isTen(c)) : a);
  const seen = new Set([...(ctx.seen || []), ...(trick || []).map((t) => t.card), ...hand]);
  // is card c the highest one still out in its suit (nobody else can follow higher)?
  const boss = (c) => {
    const s = suitOf(c), r = dRank(c);
    for (let k = r + 1; k <= 14; k++) { const id = `${k === 14 ? 1 : k}-${s}-0`; if (!seen.has(id)) return false; }
    return true;
  };
  const team = ctx.teams || {};
  const voidIn = (u, s) => (ctx.voids?.[u] || []).includes(s);
  const ids = ctx.playerIds || [];
  const me = ctx.me;
  if (!trick?.length) {
    // lead: an unbeatable card if the others can still follow (nobody void, or no Hukum yet)
    const opp = ids.filter((u) => team[u] && team[u] !== team[me]);
    // how many cards of a suit are still out with the other players (few left = someone is probably out of it)
    const outLeft = (st) => { let n = 0; for (let r = 1; r <= 13; r++) if (!seen.has(`${r}-${st}-0`)) n++; return n; };
    const minOut = ctx.minOut ?? 0;
    const safeBoss = legal.filter((c) => boss(c) && suitOf(c) !== hukum && !opp.some((u) => voidIn(u, suitOf(c))) && outLeft(suitOf(c)) >= minOut);
    const hukumBoss = legal.filter((c) => hukum && suitOf(c) === hukum && boss(c));
    if (safeBoss.length) return safeBoss.reduce((x, y) => (dRank(y) > dRank(x) ? y : x));
    if (hukumBoss.length) return hukumBoss[0];
    return low(notTen(legal));
  }
  const lead = suitOf(trick[0].card);
  const effHukum = (c) => hukum || (suitOf(c) !== lead ? suitOf(c) : null);
  const winnerNow = dhihaTrickWinner(trick, hukum);
  const partnerWinning = team[winnerNow] && team[winnerNow] === team[me];
  const after = ids.length ? ids.length - 1 - trick.length : 0; // players still to play after me
  const winCard = trick.find((t) => t.uid === winnerNow).card;
  const laterOpp = ids.length ? (() => { const i = ids.indexOf(me); const out = []; for (let k = 1; k <= after; k++) out.push(ids[(i + k) % ids.length]); return out.filter((u) => team[u] !== team[me]); })() : [];
  // my teammate is sure to win: I'm last, or their card is unbeatable and the opponent after me
  // still has to follow suit (or no one can trump over it)
  const winSuit = suitOf(winCard);
  const sure = partnerWinning && (after === 0 || (boss(winCard) && (winSuit === hukum
    || (hukum && laterOpp.every((u) => !voidIn(u, lead))) )));
  if (sure) {
    const tens = legal.filter(isTen);
    if (tens.length) return tens.find((c) => suitOf(c) === lead) || tens.find((c) => suitOf(c) !== hukum) || tens[0];
    return low(legal);
  }
  if (partnerWinning) return low(notTen(legal)); // don't risk a 10, don't waste a big card
  // the other team is winning: can I take it?
  const winners = legal.filter((c) => dhihaTrickWinner([...trick, { uid: "_me", card: c }], effHukum(c)) === "_me");
  if (winners.length) {
    const hasTen = trick.some((t) => isTen(t.card));
    const safeWin = winners.filter((c) => after === 0 || boss(c) || (suitOf(c) === hukum && laterOpp.every((u) => !voidIn(u, lead))));
    const tenWin = safeWin.filter(isTen);
    if (tenWin.length) return tenWin[0];                // win and bank my own 10
    if (safeWin.length) return low(safeWin);            // a sure win, as cheap as possible
    if (hasTen || after === 0) return low(winners);     // worth a try
  }
  return low(notTen(legal)); // can't win: keep the 10s
}

// DIGU premium hints: from the cards a player took from the thrown pile and the cards they threw,
// guess (roughly) what they're collecting. Never names exact cards.
export function diguHints(took = [], threw = []) {
  const SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const name = (r) => ({ 1: "Aces", 11: "Jacks", 12: "Queens", 13: "Kings" }[r] || `${r}s`);
  const cand = new Map();
  const add = (k, label, w) => { const c = cand.get(k) || { label, w: 0 }; c.w += w; cand.set(k, c); };
  for (const id of took) {
    const { r, s } = parse(id);
    add("r" + r, `a set of ${name(r)}`, 2);
    const lo = Math.max(1, r - 2), hi = Math.min(13, r + 2);
    add(`s${s}${Math.round(r / 3)}`, `a ${SYM[s]} run around ${C_LBL(lo)}–${C_LBL(hi)}`, 2);
  }
  for (const id of threw) {
    const { r, s } = parse(id);
    if (cand.has("r" + r)) cand.get("r" + r).w -= 1.5;
    const k = `s${s}${Math.round(r / 3)}`;
    if (cand.has(k)) cand.get(k).w -= 1;
  }
  const want = [...cand.values()].filter((c) => c.w > 0).sort((a, b) => b.w - a.w).slice(0, 2).map((c) => c.label);
  // suits they keep throwing and never take
  const thrownBy = {};
  for (const id of threw) { const s = parse(id).s; thrownBy[s] = (thrownBy[s] || 0) + 1; }
  const tookSuits = new Set(took.map((id) => parse(id).s));
  const avoid = Object.entries(thrownBy).filter(([s, n]) => n >= 2 && !tookSuits.has(s)).map(([s]) => SYM[s]);
  return { want, avoid };
}
const C_LBL = (r) => ({ 1: "A", 11: "J", 12: "Q", 13: "K" }[r] || String(r));

// ---------- Hard DHIHA: think ahead ----------
// Imagine many possible ways the unseen cards could be spread among the other players (keeping to
// what's known: who has run out of which suit), play each choice through to the end of the round,
// and pick the card that wins most often.
export function dhihaHardCard(hand, trick, hukum, ctx = {}, samples = 40) {
  const legal = dhihaLegal(hand, trick);
  if (legal.length === 1) return legal[0];
  const ids = ctx.playerIds, teams = ctx.teams, me = ctx.me;
  if (!ids || !teams) return dhihaBotCard(hand, trick, hukum, ctx);
  const seen = new Set([...(ctx.seen || []), ...(trick || []).map((t) => t.card)]);
  const all = []; for (const s of ['S', 'H', 'D', 'C']) for (let r = 1; r <= 13; r++) all.push(`${r}-${s}-0`);
  const known = ctx.known || {};
  const knownCards = new Set(Object.entries(known).filter(([u]) => u !== me).flatMap(([, c]) => c));
  const unknown = all.filter((c) => !seen.has(c) && !hand.includes(c) && !knownCards.has(c));
  const done = (ctx.decksA || []).length + (ctx.decksB || []).length; // tricks finished
  const inTrick = new Set((trick || []).map((t) => t.uid));
  const need = Object.fromEntries(ids.filter((u) => u !== me).map((u) => [u, 13 - done - (inTrick.has(u) ? 1 : 0)]));
  const voids = ctx.voids || {};
  const deal = () => {
    const pool = [...unknown].sort(() => Math.random() - 0.5);
    const hands = Object.fromEntries(Object.keys(need).map((u) => [u, known[u] ? [...known[u]] : []]));
    for (const c of pool) {
      const open = Object.keys(need).filter((u) => !known[u]);
      const ok = open.filter((u) => hands[u].length < need[u] && !(voids[u] || []).includes(suitOf(c)));
      const any = ok.length ? ok : open.filter((u) => hands[u].length < need[u]);
      if (!any.length) break;
      hands[any[Math.floor(Math.random() * any.length)]].push(c);
    }
    return hands;
  };
  const myTeam = teams[me];
  const score = (cand, hands) => {
    const h = { ...hands, [me]: hand.filter((c) => c !== cand) };
    let st = { playerIds: ids, teams, trick: trick || [], hukum, decks: { A: [...(ctx.decksA || [])], B: [...(ctx.decksB || [])] } };
    let res = dhihaPlay(st, me, cand), who;
    const seenNow = [...seen, cand];
    for (let guard = 0; guard < 60; guard++) {
      st = { ...st, trick: res.trick, hukum: res.hukum, decks: res.decks || st.decks };
      if (res.decks) seenNow.push(...res.won.cards);
      if (res.over) {
        const o = res.over, mine = o.team === myTeam;
        return (mine ? 1 : 0) + 0.15 * ((o.tens[myTeam] || 0) - (o.tens[myTeam === 'A' ? 'B' : 'A'] || 0)) + 0.02 * ((o.count[myTeam] || 0) - (o.count[myTeam === 'A' ? 'B' : 'A'] || 0));
      }
      who = ids[res.turn];
      const c = dhihaBotCard(h[who], st.trick, st.hukum, { me: who, teams, playerIds: ids, seen: seenNow, voids });
      h[who] = h[who].filter((x) => x !== c);
      res = dhihaPlay(st, who, c);
    }
    return 0;
  };
  const totals = new Map(legal.map((c) => [c, 0]));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const until = now() + (ctx.budgetMs ?? 250); // think for about a quarter of a second
  const runs = Object.keys(need).every((u) => known[u]) ? 1 : samples;
  for (let i = 0; i < runs && (i < 3 || now() < until); i++) { const hands = deal(); for (const c of legal) totals.set(c, totals.get(c) + score(c, hands)); }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ---------- Hard computer: thinks ahead with what it knows ----------
const ALL52 = []; for (const s of ['S', 'H', 'D', 'C']) for (let r = 1; r <= 13; r++) ALL52.push(`${r}-${s}-0`);
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function bondiSimCtx(st, who, voids) {
  const counts = st.counts, played = (st.trick || []).map((t) => t.uid);
  const n = st.playerIds.length, seat = st.playerIds.indexOf(who), later = [];
  for (let k = 1; k < n; k++) { const u = st.playerIds[(seat + k) % n]; if (counts[u] > 0 && !played.includes(u) && u !== who) later.push(u); }
  const left = Math.max(0, (st.trickSize || n) - played.length - 1);
  return { me: who, voids, others: st.playerIds.filter((u) => u !== who && counts[u] > 0), later: later.slice(0, left), level: 'hard' };
}
// BONDI, hard: try each card I may play, play the round out to the end many times (the hands it
// knows exactly, the rest guessed), and pick the card that ends best for me, and worst for the
// human players.
// ctx = { known: {uid: cards}, voids, humans: [uids], budgetMs }
export function bondiHardCard(hand, st, me, ctx = {}) {
  const legal = bondiLegal(hand, st.trick);
  if (legal.length === 1) return legal[0];
  const known = { ...(ctx.known || {}), [me]: hand };
  const humans = new Set(ctx.humans || []);
  const live = st.playerIds.filter((u) => (st.counts[u] || 0) > 0);
  const unknownP = live.filter((u) => !known[u]);
  const used = new Set([...Object.values(known).flat(), ...(st.trick || []).map((t) => t.card)]);
  const pool = ALL52.filter((c) => !used.has(c));
  const deal = () => {
    const h = Object.fromEntries(Object.entries(known).map(([u, c]) => [u, [...c]]));
    const p = shuffle(pool);
    for (const u of unknownP) {
      const want = st.counts[u] || 0, bad = ctx.voids?.[u] || [];
      h[u] = [];
      for (let i = 0; i < p.length && h[u].length < want; i++) if (!bad.includes(suitOf(p[i]))) h[u].push(p.splice(i--, 1)[0]);
      while (h[u].length < want && p.length) h[u].push(p.pop());
    }
    return h;
  };
  const n = st.playerIds.length;
  const sim = (cand, h) => {
    const voids = Object.fromEntries(Object.entries(ctx.voids || {}).map(([u, v]) => [u, [...v]]));
    let s = { ...st, counts: { ...st.counts }, trick: [...(st.trick || [])], out: [...(st.out || [])] };
    let who = me, card = cand;
    for (let g = 0; g < 400; g++) {
      h[who] = (h[who] || []).filter((c) => c !== card);
      const res = bondiPlay(s, who, card);
      if (res.pickup) (h[res.pickup.uid] ||= []).push(...res.pickup.cards);
      if (res.event?.kind === 'cut') (voids[res.event.by] ||= []).push(res.event.suit);
      s = { playerIds: s.playerIds, counts: res.counts, trick: res.trick, trickSize: res.trickSize ?? s.trickSize, out: res.out ?? s.out, aside: res.aside ?? s.aside };
      if (res.over) {
        const order = res.order, pos = order.indexOf(me);
        const lastHuman = humans.has(order[order.length - 1]) ? 1 : 0;
        return (1 - pos / Math.max(1, n - 1)) + (humans.has(me) ? 0 : 0.6 * lastHuman);
      }
      who = s.playerIds[res.turn];
      if (!h[who]?.length) return 0.5;
      card = bondiBotCard(h[who], s.trick, bondiSimCtx(s, who, voids));
    }
    return 0.5;
  };
  const totals = new Map(legal.map((c) => [c, 0]));
  const until = clock() + (ctx.budgetMs ?? 300);
  const maxRuns = unknownP.length ? 200 : 1;
  for (let i = 0; i < maxRuns && (i < 2 || clock() < until); i++) {
    const h = deal();
    for (const c of legal) totals.set(c, totals.get(c) + sim(c, Object.fromEntries(Object.entries(h).map(([u, x]) => [u, [...x]]))));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// DIGU, hard: the computer may look at the next card of the middle pile. Which take leaves the
// fewest leftover points after the best throw?
export function diguBestAfter(cards, banned = null) {
  let best = null;
  for (const c of cards) {
    if (c === banned) continue; // the card just taken can't be thrown straight back
    const rest = cards.filter((x) => x !== c);
    if (findWinningLayout(rest)) return { c, rest, pts: -1, win: true };
    const pts = bestLayout(rest).points;
    if (!best || pts < best.pts) best = { c, rest, pts };
  }
  return best;
}

// ======================= BABBUSH =======================
// 2–6 players, 4 face-down cards each in a row. Card values: A = 1, 2–10 = face value except 8 = 0,
// J/Q/K = 10. Lowest count wins. J = look at any one face-down card, Q = switch any two cards,
// K = lock a card face up (or unlock a locked one).
export const BB_HAND = 4;
export const BB_PENALTY = 50;
export function bbValue(id) { const r = parse(id).r; return r === 8 ? 0 : r >= 11 ? 10 : r; }
export const bbCount = (row) => (row || []).reduce((a, c) => a + bbValue(c), 0);
export const bbPower = (id) => ({ 11: "J", 12: "Q", 13: "K" })[parse(id).r] || null;
// The caller scores 0 if nobody has a lower count; if anyone has less, the caller scores 50.
// Everyone else scores their count.
export function babbushScores(rows, callerUid) {
  const counts = Object.fromEntries(Object.entries(rows).map(([u, r]) => [u, bbCount(r)]));
  const callerCount = counts[callerUid] ?? 0;
  const lower = Object.entries(counts).filter(([u, v]) => u !== callerUid && v < callerCount).map(([u]) => u);
  const caught = lower.length > 0;
  const result = {};
  for (const [u, v] of Object.entries(counts)) {
    if (u === callerUid) result[u] = { count: v, pts: caught ? BB_PENALTY : 0, how: caught ? "caught" : "won" };
    else result[u] = { count: v, pts: v, how: lower.includes(u) ? "caught-caller" : "count" };
  }
  return { result, caught, catchers: lower, callerCount };
}
