import assert from "node:assert/strict";
import * as Profile from "./profile.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("createDefaultProfile starts with zero currency and the free starter loadout", () => {
  const p = Profile.createDefaultProfile("abc");
  assert.equal(p.playerId, "abc");
  assert.equal(p.currency, 0);
  assert.deepEqual(p.unlockedShips, ["interceptor"]);
  assert.deepEqual(p.unlockedWeapons, ["blaster"]);
  assert.equal(p.equippedShip, "interceptor");
  assert.equal(p.equippedWeapon, "blaster");
  assert.deepEqual(p.upgrades, { thrust: 0, heat: 0, fireRate: 0, projSpeed: 0 });
});

check("awardCurrency adds to the balance without mutating the original profile", () => {
  const p = Profile.createDefaultProfile("abc");
  const next = Profile.awardCurrency(p, 10);
  assert.equal(next.currency, 10);
  assert.equal(p.currency, 0, "the original profile object should be untouched");
});

check("awardCurrency ignores non-positive amounts", () => {
  const p = Profile.createDefaultProfile("abc");
  assert.equal(Profile.awardCurrency(p, 0), p, "should return the same reference, not a needless copy");
  assert.equal(Profile.awardCurrency(p, -5), p);
});

check("touchLastSeen updates the timestamp without touching anything else", () => {
  const p = Profile.createDefaultProfile("abc");
  const next = Profile.touchLastSeen(p, 123456);
  assert.equal(next.lastSeenAt, 123456);
  assert.equal(next.currency, p.currency);
});

console.log(`\n${passed} profile.js assertions passed`);
