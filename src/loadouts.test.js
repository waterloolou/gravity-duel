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

check("omitting upgradeLevels entirely (every pre-Phase-4 call site) is numerically identical to all-zero levels", () => {
  const withNone = Loadouts.resolveShipStats("juggernaut", "railgun");
  const withZeros = Loadouts.resolveShipStats("juggernaut", "railgun", { thrust: 0, heat: 0, fireRate: 0, projSpeed: 0 });
  assert.deepEqual(withNone, withZeros);
});

check("upgradeCost follows the quadratic ramp: 50, 200, 450, 800, 1250 for levels 0-4", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(Loadouts.upgradeCost), [50, 200, 450, 800, 1250]);
});

check("thrust/heat/projSpeed upgrades grow their stat; fireRate upgrades shrink fireCooldown (i.e. fire faster)", () => {
  const base = Loadouts.resolveShipStats("interceptor", "blaster");
  const upgraded = Loadouts.resolveShipStats("interceptor", "blaster", { thrust: 3, heat: 3, fireRate: 3, projSpeed: 3 });
  assert.ok(upgraded.thrustAccel > base.thrustAccel);
  assert.ok(upgraded.maxHeat > base.maxHeat);
  assert.ok(upgraded.projectileLaunchSpeed > base.projectileLaunchSpeed);
  assert.ok(upgraded.fireCooldown < base.fireCooldown, "higher fireRate level should mean a SMALLER cooldown");
});

check("a maxed-out stat (level 5) is exactly +/-10% off base, and levels beyond max don't over-apply", () => {
  const base = Loadouts.resolveShipStats("interceptor", "blaster");
  const maxed = Loadouts.resolveShipStats("interceptor", "blaster", { thrust: 5 });
  const overMaxed = Loadouts.resolveShipStats("interceptor", "blaster", { thrust: 99 });
  assert.ok(Math.abs(maxed.thrustAccel - base.thrustAccel * 1.1) < 1e-9);
  assert.deepEqual(overMaxed, maxed, "a level beyond maxLevel should clamp, not keep compounding");
});

check("heat upgrades scale overheatClearHeat by the same factor as maxHeat, preserving the ~30% ratio", () => {
  const stats = Loadouts.resolveShipStats("wraith", "blaster", { heat: 5 });
  const ratio = stats.overheatClearHeat / stats.maxHeat;
  assert.ok(Math.abs(ratio - Loadouts.SHIPS.wraith.overheatClearHeat / Loadouts.SHIPS.wraith.maxHeat) < 1e-9);
});

check("resolveEngineColor returns the free default's color for the default id", () => {
  assert.equal(Loadouts.resolveEngineColor(Loadouts.DEFAULT_COSMETIC_ID), Loadouts.COSMETICS.classic.engineColor);
});

check("resolveEngineColor falls back to the free default for an unknown/missing cosmetic id", () => {
  assert.equal(Loadouts.resolveEngineColor("not-a-real-cosmetic"), Loadouts.COSMETICS.classic.engineColor);
  assert.equal(Loadouts.resolveEngineColor(undefined), Loadouts.COSMETICS.classic.engineColor);
});

check("every cosmetic has a distinct engine color (no accidental duplicates in the catalog)", () => {
  const colors = Object.values(Loadouts.COSMETICS).map((c) => c.engineColor);
  assert.equal(new Set(colors).size, colors.length);
});

console.log(`\n${passed} loadouts.js assertions passed`);
