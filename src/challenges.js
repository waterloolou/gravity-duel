// Pure daily-challenge catalog + progress logic. "Daily" is server-wide, not
// per-player: everyone sees the same rotating set of challenges on a given
// UTC date, deterministically picked from CHALLENGE_POOL so no scheduling/
// cron job is needed anywhere -- the active set is just a function of
// today's date string, recomputed on demand. No I/O -- profile-store.js
// owns persisting a profile's own progress against this catalog, same
// pure/impure split as profile.js/room.js.

export const CHALLENGE_POOL = {
  kills_3: { id: "kills_3", label: "Get 3 kills", target: 3, reward: 40, track: "kills" },
  kills_6: { id: "kills_6", label: "Get 6 kills", target: 6, reward: 70, track: "kills" },
  pickups_3: { id: "pickups_3", label: "Collect 3 arena pickups", target: 3, reward: 30, track: "pickups" },
  pickups_6: { id: "pickups_6", label: "Collect 6 arena pickups", target: 6, reward: 55, track: "pickups" },
  wins_1: { id: "wins_1", label: "Win a match", target: 1, reward: 50, track: "wins" },
  wins_2: { id: "wins_2", label: "Win 2 matches", target: 2, reward: 90, track: "wins" },
  deathless_win: { id: "deathless_win", label: "Win a match without dying", target: 1, reward: 80, track: "deathlessWins" },
  matches_3: { id: "matches_3", label: "Play 3 matches", target: 3, reward: 35, track: "matches" },
};

const DAILY_COUNT = 3;

// Today's UTC date as YYYY-MM-DD -- the rotation key. UTC, not local time,
// so every player sees the same set flip over at the same instant,
// regardless of where they are.
export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// A small deterministic integer hash+PRNG (mulberry32-style) seeded from
// the date string -- doesn't need to be cryptographically random, just
// repeatable: every server tick/request on the same day must derive the
// exact same shuffle.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// The same DAILY_COUNT challenge ids for every player on a given date -- a
// seeded Fisher-Yates shuffle of the whole pool, truncated.
export function dailyChallengeIds(dateKey = todayKey()) {
  const ids = Object.keys(CHALLENGE_POOL);
  const rand = seededRandom(dateKey);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, DAILY_COUNT);
}

export function createDefaultChallengeState(dateKey = todayKey()) {
  return { date: dateKey, progress: {}, claimed: [] };
}

// Returns a fresh challenge state if the stored one is from a previous
// day's rotation, otherwise returns it unchanged (same reference, so a
// caller can cheaply tell "did the day roll over" via ===).
export function ensureCurrentDay(challengeState, dateKey = todayKey()) {
  if (challengeState?.date === dateKey) return challengeState;
  return createDefaultChallengeState(dateKey);
}

// Increments every one of TODAY's active challenges that tracks `trackKey`
// by `amount` (default 1), clamped to each challenge's own target. Already-
// claimed challenges are left alone (no point tracking past a payout).
// Called from server.js whenever a relevant event happens (a kill, a
// pickup, a win) -- always for the CURRENT day, so a stale challengeState
// from yesterday is transparently reset first via ensureCurrentDay.
export function recordProgress(challengeState, trackKey, amount = 1, dateKey = todayKey()) {
  const state = ensureCurrentDay(challengeState, dateKey);
  const activeIds = dailyChallengeIds(dateKey);
  const progress = { ...state.progress };
  let changed = false;
  for (const id of activeIds) {
    const def = CHALLENGE_POOL[id];
    if (def.track !== trackKey || state.claimed.includes(id)) continue;
    const current = progress[id] ?? 0;
    if (current >= def.target) continue;
    progress[id] = Math.min(def.target, current + amount);
    changed = true;
  }
  return changed ? { ...state, progress } : state;
}

// Today's active challenges that have just reached their target but haven't
// been paid out yet -- server.js calls this right after recordProgress to
// know what currency to award, then claim() to mark them paid so the same
// completion can never be double-counted.
export function newlyCompleted(challengeState, dateKey = todayKey()) {
  const state = ensureCurrentDay(challengeState, dateKey);
  return dailyChallengeIds(dateKey).filter((id) => !state.claimed.includes(id) && (state.progress[id] ?? 0) >= CHALLENGE_POOL[id].target);
}

export function claim(challengeState, ids, dateKey = todayKey()) {
  const state = ensureCurrentDay(challengeState, dateKey);
  return { ...state, claimed: [...new Set([...state.claimed, ...ids])] };
}
