// Pure permanent-achievement catalog + unlock logic. Distinct from
// challenges.js's daily rotation: an achievement is checked against a
// player's LIFETIME stats (never resets) and, once unlocked, stays
// unlocked forever -- there's no equivalent of a challenge's "claim" step
// since there's no currency payout, just a permanent badge. No I/O --
// profile-store.js owns persisting which ids are unlocked.

export const ACHIEVEMENTS = {
  first_blood: { id: "first_blood", label: "First Blood", description: "Get your first kill", check: (p) => (p.stats?.kills ?? 0) >= 1 },
  sharpshooter: { id: "sharpshooter", label: "Sharpshooter", description: "Get 50 kills", check: (p) => (p.stats?.kills ?? 0) >= 50 },
  centurion: { id: "centurion", label: "Centurion", description: "Get 100 kills", check: (p) => (p.stats?.kills ?? 0) >= 100 },
  veteran: { id: "veteran", label: "Veteran", description: "Play 25 matches", check: (p) => (p.stats?.matchesPlayed ?? 0) >= 25 },
  champion: { id: "champion", label: "Champion", description: "Win 10 matches", check: (p) => (p.stats?.wins ?? 0) >= 10 },
  ranked_contender: { id: "ranked_contender", label: "Ranked Contender", description: "Play a Ranked match", check: (p) => (p.rankedMatchesPlayed ?? 0) >= 1 },
  rising_star: { id: "rising_star", label: "Rising Star", description: "Reach 1100 Ranked rating", check: (p) => (p.rating ?? 0) >= 1100 },
};

// Every achievement not already in `profile.achievementsUnlocked` whose
// check() now passes against the profile's CURRENT stats -- called after
// any stat-affecting event (a kill, a match ending) so a newly-crossed
// threshold is caught the moment it happens, not on some later poll.
export function checkNewlyUnlocked(profile) {
  const unlocked = profile.achievementsUnlocked ?? [];
  return Object.values(ACHIEVEMENTS)
    .filter((a) => !unlocked.includes(a.id) && a.check(profile))
    .map((a) => a.id);
}
