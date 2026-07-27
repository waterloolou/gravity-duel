import assert from "node:assert/strict";
import * as Killstreak from "./killstreak.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("a lone kill produces no label", () => {
  const { timestamps, label } = Killstreak.recordKill([], 10);
  assert.deepEqual(timestamps, [10]);
  assert.equal(label, null);
});

check("a second kill within the window announces Double Kill!", () => {
  const { timestamps, label } = Killstreak.recordKill([10], 11.5);
  assert.deepEqual(timestamps, [10, 11.5]);
  assert.equal(label, "Double Kill!");
});

check("a third and fourth kill within the window escalate to Triple then Quad", () => {
  const third = Killstreak.recordKill([10, 11.5], 12.9);
  assert.equal(third.label, "Triple Kill!");
  const fourth = Killstreak.recordKill(third.timestamps, 13.8);
  assert.equal(fourth.label, "Quad Kill!");
});

check("a fifth kill within the window falls back to the generic Mega Kill! label", () => {
  const { label } = Killstreak.recordKill([10, 11, 12, 13], 13.9);
  assert.equal(label, "Mega Kill!");
});

check("a kill outside the window prunes stale timestamps and restarts the streak at null", () => {
  const { timestamps, label } = Killstreak.recordKill([10, 11], 20);
  assert.deepEqual(timestamps, [20]);
  assert.equal(label, null);
});

check("a kill exactly at the window boundary is pruned (strict less-than, not less-or-equal)", () => {
  const { timestamps } = Killstreak.recordKill([10], 10 + Killstreak.KILLSTREAK_WINDOW);
  assert.deepEqual(timestamps, [10 + Killstreak.KILLSTREAK_WINDOW], "the stale timestamp should have been pruned");
});

console.log(`\n${passed} killstreak.js assertions passed`);
