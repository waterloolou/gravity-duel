import assert from "node:assert/strict";
import * as Elo from "./elo.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("a 1v1 between equal ratings splits the K-factor evenly (+16/-16)", () => {
  const next = Elo.applyMatchResult({ p1: 1000, p2: 1000 }, ["p1", "p2"], "p1");
  assert.equal(next.p1, 1016);
  assert.equal(next.p2, 984);
});

check("missing ratings default to DEFAULT_RATING, same as an explicit 1000v1000", () => {
  const next = Elo.applyMatchResult({}, ["p1", "p2"], "p1");
  assert.equal(next.p1, 1016);
  assert.equal(next.p2, 984);
});

check("beating a much higher-rated opponent gains far more than beating an equal one", () => {
  const equalMatch = Elo.applyMatchResult({ p1: 1000, p2: 1000 }, ["p1", "p2"], "p1");
  const upsetMatch = Elo.applyMatchResult({ p1: 1000, p2: 1400 }, ["p1", "p2"], "p1");
  assert.ok(upsetMatch.p1 - 1000 > equalMatch.p1 - 1000, "an upset win should gain more rating than an even one");
});

check("beating a much lower-rated opponent gains far less than beating an equal one", () => {
  const equalMatch = Elo.applyMatchResult({ p1: 1000, p2: 1000 }, ["p1", "p2"], "p1");
  const stompMatch = Elo.applyMatchResult({ p1: 1400, p2: 1000 }, ["p1", "p2"], "p1");
  assert.ok(stompMatch.p1 - 1400 < equalMatch.p1 - 1000, "beating a much weaker opponent should gain less rating than an even match");
});

check("every player's rating change is zero-sum in a 1v1 (winner's gain equals loser's loss)", () => {
  const before = { p1: 1200, p2: 950 };
  const after = Elo.applyMatchResult(before, ["p1", "p2"], "p1");
  const winnerDelta = after.p1 - before.p1;
  const loserDelta = after.p2 - before.p2;
  assert.equal(winnerDelta, -loserDelta);
});

check("a 3-player FFA treats the win as two independent pairwise victories, roughly doubling the equal-opponent gain", () => {
  const oneOnOne = Elo.applyMatchResult({ p1: 1000, p2: 1000 }, ["p1", "p2"], "p1");
  const singleGain = oneOnOne.p1 - 1000;

  const ffa = Elo.applyMatchResult({ p1: 1000, p2: 1000, p3: 1000 }, ["p1", "p2", "p3"], "p1");
  assert.equal(ffa.p1 - 1000, singleGain * 2, "beating two equally-rated opponents should be worth exactly two pairwise wins");
  assert.equal(ffa.p2, oneOnOne.p2, "each individual loser's own rating change should match their own 1v1 pairwise result");
  assert.equal(ffa.p3, oneOnOne.p2);
});

check("returns a rating for every playerId given, including ones absent from the input ratings map", () => {
  const next = Elo.applyMatchResult({ p1: 1100 }, ["p1", "p2", "p3"], "p1");
  assert.ok(Number.isFinite(next.p2));
  assert.ok(Number.isFinite(next.p3));
});

check("never mutates the input ratings object", () => {
  const before = { p1: 1000, p2: 1000 };
  const beforeCopy = { ...before };
  Elo.applyMatchResult(before, ["p1", "p2"], "p1");
  assert.deepEqual(before, beforeCopy);
});

check("ratings are always rounded to whole numbers", () => {
  const next = Elo.applyMatchResult({ p1: 987, p2: 1123 }, ["p1", "p2"], "p1");
  assert.ok(Number.isInteger(next.p1));
  assert.ok(Number.isInteger(next.p2));
});

console.log(`\n${passed} elo.js assertions passed`);
