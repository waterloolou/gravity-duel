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

check("purchaseUnlock spends currency and adds the ship/weapon to the unlock list", () => {
  let p = Profile.createDefaultProfile("abc");
  p = Profile.awardCurrency(p, 400);
  const { profile: next, error } = Profile.purchaseUnlock(p, "ship", "juggernaut");
  assert.equal(error, null);
  assert.equal(next.currency, 0);
  assert.deepEqual(next.unlockedShips, ["interceptor", "juggernaut"]);
});

check("purchaseUnlock rejects insufficient currency and leaves the profile unchanged", () => {
  const p = Profile.createDefaultProfile("abc"); // 0 currency
  const { profile: next, error } = Profile.purchaseUnlock(p, "ship", "juggernaut");
  assert.equal(error, "INSUFFICIENT_CURRENCY");
  assert.equal(next, p, "should return the exact same reference on failure");
});

check("purchaseUnlock rejects unlocking something already unlocked", () => {
  const p = Profile.createDefaultProfile("abc");
  const { error } = Profile.purchaseUnlock(p, "ship", "interceptor"); // already owned by default
  assert.equal(error, "ALREADY_UNLOCKED");
});

check("purchaseUnlock rejects an unknown ship/weapon id", () => {
  let p = Profile.createDefaultProfile("abc");
  p = Profile.awardCurrency(p, 9999);
  const { error } = Profile.purchaseUnlock(p, "ship", "not-a-real-ship");
  assert.equal(error, "UNKNOWN_LOADOUT_ID");
});

check("setEquipped switches to an already-unlocked ship/weapon", () => {
  let p = Profile.createDefaultProfile("abc");
  p = Profile.awardCurrency(p, 500);
  ({ profile: p } = Profile.purchaseUnlock(p, "weapon", "railgun"));
  const { profile: next, error } = Profile.setEquipped(p, undefined, "railgun");
  assert.equal(error, null);
  assert.equal(next.equippedWeapon, "railgun");
  assert.equal(next.equippedShip, "interceptor", "the untouched slot (ship) should be left alone");
});

check("setEquipped rejects equipping something not yet unlocked", () => {
  const p = Profile.createDefaultProfile("abc");
  const { profile: next, error } = Profile.setEquipped(p, "wraith", undefined);
  assert.equal(error, "NOT_UNLOCKED");
  assert.equal(next, p);
});

check("setEquipped applies both slots atomically -- an invalid weapon rejects the ship change too", () => {
  let p = Profile.createDefaultProfile("abc");
  p = Profile.awardCurrency(p, 400);
  ({ profile: p } = Profile.purchaseUnlock(p, "ship", "juggernaut")); // ship IS unlocked...
  const { profile: next, error } = Profile.setEquipped(p, "juggernaut", "railgun"); // ...but weapon isn't
  assert.equal(error, "NOT_UNLOCKED");
  assert.equal(next.equippedShip, "interceptor", "ship slot should not have changed either");
});

console.log(`\n${passed} profile.js assertions passed`);
