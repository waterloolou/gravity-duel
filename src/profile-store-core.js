// The in-memory profile store shared by the Node server (profile-store.js,
// which adds JSON-file persistence) and the in-browser peer-to-peer host
// (p2p.js, which adds localStorage persistence). No I/O in here: callers
// pass `onChange`, called after every mutation, to persist however suits them.

import * as Profile from "./profile.js";
import * as Challenges from "./challenges.js";
import * as Elo from "./elo.js";
import * as Achievements from "./achievements.js";

export function createProfileStore({ onChange = () => {} } = {}) {
  const profiles = new Map(); // playerId -> profile
  const markDirty = onChange;

  // Creates a fresh profile on first sight of a playerId -- callers are
  // responsible for never calling this with a null/undefined id (a socket
  // that hasn't IDENTIFY'd yet has nothing real to key a stored profile by;
  // see server.js's inline default-profile fallback for that case).
  function get(playerId) {
    let profile = profiles.get(playerId);
    if (!profile) {
      profile = Profile.createDefaultProfile(playerId);
      profiles.set(playerId, profile);
      markDirty();
    }
    return profile;
  }

  function awardCurrency(playerId, amount) {
    const profile = Profile.awardCurrency(get(playerId), amount);
    profiles.set(playerId, profile);
    markDirty();
    return profile;
  }

  function addStats(playerId, delta) {
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
  function recordChallengeProgress(playerId, trackKey, amount = 1) {
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
  // server.js's settleMatch, which also decides who's eligible to be in this
  // list in the first place, e.g. excluding any seat with no identified
  // profile). Uses each player's CURRENT stored rating as Elo's input, so
  // the pairwise math in elo.js only ever needs to know about this one
  // match. Returns { playerId: { before, after } } -- the raw new rating
  // alone isn't enough for settleMatch's match-history entry, which wants
  // the signed delta.
  function applyRankedResult(profileIds, winnerId) {
    const currentRatings = {};
    for (const id of profileIds) currentRatings[id] = get(id).rating ?? Elo.DEFAULT_RATING;
    const nextRatings = Elo.applyMatchResult(currentRatings, profileIds, winnerId);
    const changes = {};
    for (const id of profileIds) {
      const profile = get(id);
      profiles.set(id, { ...profile, rating: nextRatings[id], rankedMatchesPlayed: (profile.rankedMatchesPlayed ?? 0) + 1 });
      changes[id] = { before: currentRatings[id], after: nextRatings[id] };
    }
    markDirty();
    return changes;
  }

  // Records one match-history entry (see profile.js's own comment on the
  // shape) for `playerId`, newest first, capped at 10.
  function addMatchHistoryEntry(playerId, entry) {
    const profile = Profile.recordMatchHistory(get(playerId), entry);
    profiles.set(playerId, profile);
    markDirty();
    return profile;
  }

  // Re-checks `playerId`'s CURRENT stats against every achievement not yet
  // unlocked, permanently marks any newly-crossed ones, and returns just the
  // ids unlocked THIS call (empty on an ordinary check with nothing new) --
  // called from server.js right after any event that could cross a
  // threshold (a kill, a match ending), same shape as recordChallengeProgress's
  // completed/reward split.
  function checkAchievements(playerId) {
    const profile = get(playerId);
    const unlocked = Achievements.checkNewlyUnlocked(profile);
    if (unlocked.length === 0) return { profile, unlocked };
    const nextProfile = { ...profile, achievementsUnlocked: [...(profile.achievementsUnlocked ?? []), ...unlocked] };
    profiles.set(playerId, nextProfile);
    markDirty();
    return { profile: nextProfile, unlocked };
  }

  // Overwrites the stored profile outright -- used after a pure profile.js
  // mutation (purchaseUnlock/setEquipped/setDisplayName) has already produced
  // the next profile object; this just commits it and schedules a flush.
  function set(playerId, profile) {
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
  function getLeaderboard(requestingPlayerId, limit = 10) {
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
  function getRankedLeaderboard(requestingPlayerId, limit = 10) {
    const ranked = Array.from(profiles.values())
      .filter((p) => p.rankedMatchesPlayed > 0)
      .sort((a, b) => b.rating - a.rating);

    const toRow = (p, rank) => ({ rank, displayName: p.displayName || "Unnamed Pilot", rating: p.rating, rankedMatchesPlayed: p.rankedMatchesPlayed, isYou: p.playerId === requestingPlayerId });

    const top = ranked.slice(0, limit).map((p, i) => toRow(p, i + 1));
    const selfIndex = ranked.findIndex((p) => p.playerId === requestingPlayerId);
    const self = selfIndex >= 0 ? toRow(ranked[selfIndex], selfIndex + 1) : null;

    return { top, self };
  }

  return {
    profiles,
    get,
    awardCurrency,
    addStats,
    recordChallengeProgress,
    applyRankedResult,
    addMatchHistoryEntry,
    checkAchievements,
    set,
    getLeaderboard,
    getRankedLeaderboard,
  };
}
