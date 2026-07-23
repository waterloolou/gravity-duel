import assert from "node:assert/strict";
import * as C from "./challenges.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("dailyChallengeIds picks exactly 3 distinct ids from the pool, deterministically for a given date", () => {
  const a = C.dailyChallengeIds("2026-07-20");
  const b = C.dailyChallengeIds("2026-07-20");
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3, "should be 3 distinct challenges, no duplicates");
  assert.deepEqual(a, b, "the same date should always produce the same set");
  for (const id of a) assert.ok(C.CHALLENGE_POOL[id], `${id} should be a real pool entry`);
});

check("dailyChallengeIds varies across different dates", () => {
  const days = ["2026-01-01", "2026-03-15", "2026-07-20", "2026-11-30", "2027-02-14"];
  const sets = days.map((d) => C.dailyChallengeIds(d).join(","));
  assert.ok(new Set(sets).size > 1, "at least some different dates should produce different rotations");
});

check("createDefaultChallengeState starts empty for today", () => {
  const state = C.createDefaultChallengeState("2026-07-20");
  assert.equal(state.date, "2026-07-20");
  assert.deepEqual(state.progress, {});
  assert.deepEqual(state.claimed, []);
});

check("ensureCurrentDay resets stale progress from a previous day, leaves today's alone", () => {
  const stale = { date: "2026-07-19", progress: { kills_3: 2 }, claimed: ["wins_1"] };
  const reset = C.ensureCurrentDay(stale, "2026-07-20");
  assert.equal(reset.date, "2026-07-20");
  assert.deepEqual(reset.progress, {}, "yesterday's progress should not carry over");
  assert.deepEqual(reset.claimed, []);

  const current = { date: "2026-07-20", progress: { kills_3: 1 }, claimed: [] };
  assert.equal(C.ensureCurrentDay(current, "2026-07-20"), current, "today's own state should be returned unchanged");
});

check("recordProgress only increments today's active challenges that track the given key", () => {
  const dateKey = "2026-07-20";
  const activeIds = C.dailyChallengeIds(dateKey);
  const killsId = activeIds.find((id) => C.CHALLENGE_POOL[id].track === "kills");
  if (!killsId) return; // this particular date's rotation has no kills challenge -- nothing to assert
  let state = C.createDefaultChallengeState(dateKey);
  state = C.recordProgress(state, "kills", 1, dateKey);
  assert.equal(state.progress[killsId], 1);
  // A track this rotation doesn't include today should never appear.
  for (const [id, def] of Object.entries(C.CHALLENGE_POOL)) {
    if (!activeIds.includes(id)) continue;
    if (def.track !== "kills") assert.equal(state.progress[id] ?? 0, 0, `${id} tracks ${def.track}, not kills -- should be untouched`);
  }
});

check("recordProgress clamps at each challenge's own target and never lets it overshoot", () => {
  const dateKey = "2026-07-20";
  const activeIds = C.dailyChallengeIds(dateKey);
  const killsId = activeIds.find((id) => C.CHALLENGE_POOL[id].track === "kills");
  if (!killsId) return;
  const target = C.CHALLENGE_POOL[killsId].target;
  let state = C.createDefaultChallengeState(dateKey);
  state = C.recordProgress(state, "kills", target + 50, dateKey);
  assert.equal(state.progress[killsId], target, "a single huge jump should still clamp at the target, not overshoot");
});

check("recordProgress is a no-op (same reference) when nothing active tracks that key", () => {
  const dateKey = "2026-07-20";
  const state = C.createDefaultChallengeState(dateKey);
  const activeTracks = new Set(C.dailyChallengeIds(dateKey).map((id) => C.CHALLENGE_POOL[id].track));
  const unusedTrack = Object.values(C.CHALLENGE_POOL).map((d) => d.track).find((t) => !activeTracks.has(t));
  if (!unusedTrack) return; // today's rotation happens to cover every track -- nothing to assert
  const after = C.recordProgress(state, unusedTrack, 1, dateKey);
  assert.equal(after, state, "should return the exact same reference, not a needless copy");
});

check("newlyCompleted reports a challenge exactly once it hits target, and stops after being claimed", () => {
  const dateKey = "2026-07-20";
  const activeIds = C.dailyChallengeIds(dateKey);
  const killsId = activeIds.find((id) => C.CHALLENGE_POOL[id].track === "kills");
  if (!killsId) return;
  const target = C.CHALLENGE_POOL[killsId].target;
  let state = C.createDefaultChallengeState(dateKey);

  state = C.recordProgress(state, "kills", target - 1, dateKey);
  assert.deepEqual(C.newlyCompleted(state, dateKey).includes(killsId), false, "should not report complete one short of target");

  state = C.recordProgress(state, "kills", 1, dateKey);
  assert.ok(C.newlyCompleted(state, dateKey).includes(killsId), "should report complete exactly at target");

  state = C.claim(state, [killsId], dateKey);
  assert.deepEqual(C.newlyCompleted(state, dateKey), [], "a claimed challenge should never be reported as newly-completed again");

  // Further progress past a claimed challenge's target shouldn't do anything either.
  const beforeFurther = state;
  state = C.recordProgress(state, "kills", 5, dateKey);
  assert.equal(state, beforeFurther, "recordProgress should no-op on an already-claimed challenge");
});

check("claim is idempotent and merges without duplicating ids", () => {
  const dateKey = "2026-07-20";
  let state = C.createDefaultChallengeState(dateKey);
  state = C.claim(state, ["kills_3"], dateKey);
  state = C.claim(state, ["kills_3", "wins_1"], dateKey);
  assert.deepEqual([...state.claimed].sort(), ["kills_3", "wins_1"]);
});

check("recordProgress transparently rolls a stale (previous-day) state over before applying progress", () => {
  const stale = { date: "2026-07-19", progress: { kills_3: 999 }, claimed: ["kills_3", "kills_6", "wins_1", "wins_2", "pickups_3", "pickups_6", "deathless_win", "matches_3"] };
  const dateKey = "2026-07-20";
  const activeIds = C.dailyChallengeIds(dateKey);
  const killsId = activeIds.find((id) => C.CHALLENGE_POOL[id].track === "kills");
  if (!killsId) return;
  const next = C.recordProgress(stale, "kills", 1, dateKey);
  assert.equal(next.date, dateKey);
  assert.equal(next.progress[killsId], 1, "should start counting fresh for the new day, not add onto yesterday's stale progress");
  assert.deepEqual(next.claimed, [], "yesterday's claims should not carry over -- today's challenges haven't been earned yet");
});

console.log(`\n${passed} challenges.js assertions passed`);
