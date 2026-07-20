import assert from "node:assert/strict";
import * as P from "./physics.js";
import * as Loadouts from "./loadouts.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("the default ship+weapon resolve to exactly physics.js's DEFAULT_SHIP_STATS", () => {
  const stats = Loadouts.resolveShipStats(Loadouts.DEFAULT_SHIP_ID, Loadouts.DEFAULT_WEAPON_ID);
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

check("an unknown ship or weapon id falls back to the free starter instead of throwing", () => {
  const stats = Loadouts.resolveShipStats("not-a-real-ship", "not-a-real-weapon");
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

check("missing/undefined ids also fall back to the free starter", () => {
  const stats = Loadouts.resolveShipStats(undefined, undefined);
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

check("Juggernaut trades slower acceleration/top speed for a much bigger heat buffer than the Interceptor", () => {
  const base = Loadouts.SHIPS.interceptor;
  const jug = Loadouts.SHIPS.juggernaut;
  assert.ok(jug.thrustAccel < base.thrustAccel, "should accelerate slower");
  assert.ok(jug.maxSpeed < base.maxSpeed, "should have a lower top speed");
  assert.ok(jug.maxHeat > base.maxHeat, "should have more heat capacity");
});

check("Wraith trades a much smaller heat buffer for faster acceleration/top speed than the Interceptor", () => {
  const base = Loadouts.SHIPS.interceptor;
  const wraith = Loadouts.SHIPS.wraith;
  assert.ok(wraith.thrustAccel > base.thrustAccel, "should accelerate faster");
  assert.ok(wraith.maxSpeed > base.maxSpeed, "should have a higher top speed");
  assert.ok(wraith.maxHeat < base.maxHeat, "should have less heat capacity");
});

check("every ship keeps roughly the same overheatClearHeat/maxHeat ratio, for a consistent hysteresis feel", () => {
  for (const ship of Object.values(Loadouts.SHIPS)) {
    const ratio = ship.overheatClearHeat / ship.maxHeat;
    assert.ok(Math.abs(ratio - 0.3) < 0.02, `${ship.name}: expected ~30% clear threshold, got ${(ratio * 100).toFixed(1)}%`);
  }
});

check("Railgun trades fire rate for shot speed vs. the Blaster; Scattergun trades shot speed for fire rate", () => {
  const base = Loadouts.WEAPONS.blaster;
  const rail = Loadouts.WEAPONS.railgun;
  const scatter = Loadouts.WEAPONS.scattergun;
  assert.ok(rail.fireCooldown > base.fireCooldown, "railgun should fire slower");
  assert.ok(rail.projectileLaunchSpeed > base.projectileLaunchSpeed, "railgun shots should be faster");
  assert.ok(scatter.fireCooldown < base.fireCooldown, "scattergun should fire faster");
  assert.ok(scatter.projectileLaunchSpeed < base.projectileLaunchSpeed, "scattergun shots should be slower");
});

check("resolveShipStats mixes any ship with any weapon independently", () => {
  const stats = Loadouts.resolveShipStats("wraith", "railgun");
  assert.equal(stats.thrustAccel, Loadouts.SHIPS.wraith.thrustAccel);
  assert.equal(stats.maxHeat, Loadouts.SHIPS.wraith.maxHeat);
  assert.equal(stats.fireCooldown, Loadouts.WEAPONS.railgun.fireCooldown);
  assert.equal(stats.projectileLaunchSpeed, Loadouts.WEAPONS.railgun.projectileLaunchSpeed);
});

console.log(`\n${passed} loadouts.js assertions passed`);
