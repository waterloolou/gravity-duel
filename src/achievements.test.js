import assert from "node:assert/strict";
import * as Achievements from "./achievements.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function baseProfile(overrides = {}) {
  return {
    stats: { wins: 0, losses: 0, matchesPlayed: 0, kills: 0, deaths: 0 },
    rankedMatchesPlayed: 0,
    rating: 1000,
    achievementsUnlocked: [],
    ...overrides,
  };
}

check("checkNewlyUnlocked reports nothing for a fresh profile", () => {
  assert.deepEqual(Achievements.checkNewlyUnlocked(baseProfile()), []);
});

check("checkNewlyUnlocked reports first_blood the instant kills reaches 1", () => {
  const profile = baseProfile({ stats: { wins: 0, losses: 0, matchesPlayed: 0, kills: 1, deaths: 0 } });
  const unlocked = Achievements.checkNewlyUnlocked(profile);
  assert.ok(unlocked.includes("first_blood"));
});

check("checkNewlyUnlocked never re-reports an already-unlocked achievement", () => {
  const profile = baseProfile({
    stats: { wins: 0, losses: 0, matchesPlayed: 0, kills: 1, deaths: 0 },
    achievementsUnlocked: ["first_blood"],
  });
  const unlocked = Achievements.checkNewlyUnlocked(profile);
  assert.ok(!unlocked.includes("first_blood"), "should not report a fresh unlock for something already claimed");
});

check("checkNewlyUnlocked can report multiple achievements crossed at once", () => {
  // A single big jump (e.g. importing a profile, or an admin-adjusted
  // value) that crosses several thresholds simultaneously should report
  // all of them, not just the first one found.
  const profile = baseProfile({ stats: { wins: 10, losses: 0, matchesPlayed: 25, kills: 100, deaths: 0 } });
  const unlocked = Achievements.checkNewlyUnlocked(profile);
  assert.ok(unlocked.includes("first_blood"));
  assert.ok(unlocked.includes("sharpshooter"));
  assert.ok(unlocked.includes("centurion"));
  assert.ok(unlocked.includes("veteran"));
  assert.ok(unlocked.includes("champion"));
});

check("checkNewlyUnlocked's ranked achievements key off rankedMatchesPlayed and rating specifically", () => {
  const notYet = baseProfile({ rankedMatchesPlayed: 0, rating: 1000 });
  assert.deepEqual(Achievements.checkNewlyUnlocked(notYet), []);

  const playedRanked = baseProfile({ rankedMatchesPlayed: 1, rating: 1000 });
  assert.deepEqual(Achievements.checkNewlyUnlocked(playedRanked), ["ranked_contender"]);

  const highRated = baseProfile({ rankedMatchesPlayed: 1, rating: 1150, achievementsUnlocked: ["ranked_contender"] });
  assert.deepEqual(Achievements.checkNewlyUnlocked(highRated), ["rising_star"]);
});

check("checkNewlyUnlocked tolerates a profile with no stats field at all", () => {
  const legacyProfile = { achievementsUnlocked: [] };
  assert.deepEqual(Achievements.checkNewlyUnlocked(legacyProfile), []);
});

console.log(`\n${passed} achievements.js assertions passed`);
