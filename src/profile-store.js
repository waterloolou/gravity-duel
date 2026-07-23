// Server-side persistence for anonymous player profiles: an in-memory Map is
// the source of truth for every read (so gameplay-path lookups are always
// synchronous and never block on disk), with a debounced, atomic
// write-through to a JSON file so progress survives a normal server restart.
//
// This file is I/O-heavy server orchestration, not the pure/unit-tested
// style used elsewhere (room.js, profile.js) -- held to the same lower
// rigor bar as server.js itself, deliberately not a *.test.js target.
//
// Known limitation: hosts with ephemeral disk (e.g. Render's free tier)
// wipe data/players.json on every redeploy, and likely on idle-sleep/wake
// too. "Persists across sessions" holds during normal uptime, not across a
// deploy -- surfaced to players in the Hangar UI, not hidden here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Profile from "./profile.js";
import * as Challenges from "./challenges.js";
import * as Elo from "./elo.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DATA_PATH = path.join(DATA_DIR, "players.json");
const FLUSH_DELAY_MS = 3000; // coalesces bursts (e.g. several kills in a row) into one write

const profiles = new Map(); // playerId -> profile
let dirty = false;
let writeTimer = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    for (const [id, profile] of Object.entries(raw)) profiles.set(id, profile);
    console.log(`profile-store: loaded ${profiles.size} player profile(s) from ${DATA_PATH}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`profile-store: couldn't read ${DATA_PATH}, starting with an empty store (${err.message})`);
    }
  }
}

function markDirty() {
  dirty = true;
  if (!writeTimer) writeTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  writeTimer = null;
  if (!dirty) return;
  dirty = false;
  const tmpPath = `${DATA_PATH}.tmp`;
  const json = JSON.stringify(Object.fromEntries(profiles));
  try {
    await fs.promises.writeFile(tmpPath, json, "utf8");
    // rename is atomic on the same filesystem -- a reader (or a crash mid-write)
    // only ever sees the fully-old or fully-new file, never a torn one.
    await fs.promises.rename(tmpPath, DATA_PATH);
  } catch (err) {
    console.warn(`profile-store: failed to persist ${DATA_PATH} (${err.message})`);
    dirty = true; // retry on the next markDirty-triggered flush
  }
  if (dirty) writeTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

// Synchronous and best-effort -- used only on process shutdown, where
// blocking briefly to avoid losing the last few seconds of currency is
// worth it (the async flush() above is for the normal hot path).
export function flushSync() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(Object.fromEntries(profiles)), "utf8");
  } catch (err) {
    console.warn(`profile-store: shutdown flush failed (${err.message})`);
  }
}

// Creates a fresh profile on first sight of a playerId -- callers are
// responsible for never calling this with a null/undefined id (a socket
// that hasn't IDENTIFY'd yet has nothing real to key a stored profile by;
// see server.js's inline default-profile fallback for that case).
export function get(playerId) {
  let profile = profiles.get(playerId);
  if (!profile) {
    profile = Profile.createDefaultProfile(playerId);
    profiles.set(playerId, profile);
    markDirty();
  }
  return profile;
}

export function awardCurrency(playerId, amount) {
  const profile = Profile.awardCurrency(get(playerId), amount);
  profiles.set(playerId, profile);
  markDirty();
  return profile;
}

export function addStats(playerId, delta) {
  const profile = Profile.addStats(get(playerId), delta);
  profiles.set(playerId, profile);
  markDirty();
  return profile;
}

// Advances `playerId`'s progress on today's active daily challenges that
// track `trackKey` (see challenges.js's CHALLENGE_POOL), auto-pays out
// currency for anything that just crossed its target, and marks those
// claimed so the same completion can never be paid out twice. Returns
// `completed`/`reward` (both empty/0 on an ordinary progress tick) so
// server.js knows whether to also send a completion notification.
export function recordChallengeProgress(playerId, trackKey, amount = 1) {
  const current = get(playerId);
  const nextChallenges = Challenges.recordProgress(current.challenges, trackKey, amount);
  const completed = Challenges.newlyCompleted(nextChallenges);
  let profile = { ...current, challenges: nextChallenges };
  let reward = 0;
  if (completed.length > 0) {
    reward = completed.reduce((sum, id) => sum + Challenges.CHALLENGE_POOL[id].reward, 0);
    profile = Profile.awardCurrency({ ...profile, challenges: Challenges.claim(nextChallenges, completed) }, reward);
  }
  profiles.set(playerId, profile);
  markDirty();
  return { profile, completed, reward };
}

// Applies a ranked match's result to every profile in `profileIds` (already
// resolved from room seats to persistent profileIds by the caller -- see
// server.js's creditRankedResult, which also decides who's eligible to be
// in this list in the first place, e.g. excluding any seat with no
// identified profile). Uses each player's CURRENT stored rating as Elo's
// input, so the pairwise math in elo.js only ever needs to know about
// this one match. Returns the new { playerId: rating } map.
export function applyRankedResult(profileIds, winnerId) {
  const currentRatings = {};
  for (const id of profileIds) currentRatings[id] = get(id).rating ?? Elo.DEFAULT_RATING;
  const nextRatings = Elo.applyMatchResult(currentRatings, profileIds, winnerId);
  for (const id of profileIds) {
    const profile = get(id);
    profiles.set(id, { ...profile, rating: nextRatings[id], rankedMatchesPlayed: (profile.rankedMatchesPlayed ?? 0) + 1 });
  }
  markDirty();
  return nextRatings;
}

// Overwrites the stored profile outright -- used after a pure profile.js
// mutation (purchaseUnlock/setEquipped/setDisplayName) has already produced
// the next profile object; this just commits it and schedules a flush.
export function set(playerId, profile) {
  profiles.set(playerId, profile);
  markDirty();
  return profile;
}

// Top N by wins (kills as a tiebreaker), server-side ranked so raw
// playerIds never have to leave the server -- see server.js's IDENTIFY
// handler for why that id must never be exposed to other clients. `self`
// is the requester's own rank/stats even when they're outside the top N
// (or null if they've never finished a match), computed here rather than
// left for the client to infer, since the client is never given anyone
// else's playerId to match against in the first place.
export function getLeaderboard(requestingPlayerId, limit = 10) {
  const ranked = Array.from(profiles.values())
    .filter((p) => p.stats?.matchesPlayed > 0)
    .sort((a, b) => b.stats.wins - a.stats.wins || b.stats.kills - a.stats.kills);

  const toRow = (p, rank) => ({ rank, displayName: p.displayName || "Unnamed Pilot", stats: p.stats, isYou: p.playerId === requestingPlayerId });

  const top = ranked.slice(0, limit).map((p, i) => toRow(p, i + 1));
  const selfIndex = ranked.findIndex((p) => p.playerId === requestingPlayerId);
  const self = selfIndex >= 0 ? toRow(ranked[selfIndex], selfIndex + 1) : null;

  return { top, self };
}

// Same shape/philosophy as getLeaderboard, ranked by Elo rating instead of
// wins. Filtered to rankedMatchesPlayed > 0 -- every profile starts at
// DEFAULT_RATING, so without this filter, anyone who's never queued Ranked
// at all would clutter the list tied at the default.
export function getRankedLeaderboard(requestingPlayerId, limit = 10) {
  const ranked = Array.from(profiles.values())
    .filter((p) => p.rankedMatchesPlayed > 0)
    .sort((a, b) => b.rating - a.rating);

  const toRow = (p, rank) => ({ rank, displayName: p.displayName || "Unnamed Pilot", rating: p.rating, rankedMatchesPlayed: p.rankedMatchesPlayed, isYou: p.playerId === requestingPlayerId });

  const top = ranked.slice(0, limit).map((p, i) => toRow(p, i + 1));
  const selfIndex = ranked.findIndex((p) => p.playerId === requestingPlayerId);
  const self = selfIndex >= 0 ? toRow(ranked[selfIndex], selfIndex + 1) : null;

  return { top, self };
}
