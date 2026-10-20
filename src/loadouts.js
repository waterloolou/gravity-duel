// Ship/weapon content catalog + stat resolution. Pure, no I/O -- imported by
// both server.js (authoritative resolution before a match starts) and the
// client-side Hangar UI (cost/stat display), the same "shared verbatim by
// both sides" pattern protocol.js already establishes for message types.
//
// Every non-free entry is a LATERAL tradeoff, not a strict upgrade over the
// free starter -- every pairwise comparison trades at least one stat in
// each direction, so currency buys variety/playstyle, not raw power (the
// separate upgrade tree, a later phase, is where real power growth lives).
// Time-to-overheat from empty, holding thrust continuously:
//   Interceptor 2.5s, Juggernaut ~4.1s (endurance), Wraith ~1.56s (burst).
// overheatClearHeat is kept at the same 30%-of-maxHeat ratio as the
// Interceptor for every ship, so the hysteresis gap feels consistent.

import * as P from "./physics.js";

export const DEFAULT_SHIP_ID = "interceptor";
export const DEFAULT_WEAPON_ID = "blaster";

export const SHIPS = {
  interceptor: {
    name: "Interceptor",
    cost: 0,
    thrustAccel: P.SHIP_THRUST_ACCEL,
    maxSpeed: P.SHIP_MAX_SPEED,
    maxHeat: P.MAX_HEAT,
    heatPerSecThrusting: P.HEAT_PER_SEC_THRUSTING,
    heatCoolPerSec: P.HEAT_COOL_PER_SEC,
    overheatClearHeat: P.OVERHEAT_CLEAR_HEAT,
  },
  // Tankier: trades acceleration/top speed for a much bigger heat buffer --
  // can sustain thrust far longer, but is slower to actually get going.
  juggernaut: {
    name: "Juggernaut",
    cost: 400,
    thrustAccel: 260,
    maxSpeed: 640,
    maxHeat: 140,
    heatPerSecThrusting: 34,
    heatCoolPerSec: 25,
    overheatClearHeat: 42,
  },
  // Agile: faster acceleration and top speed for hit-and-run play, at the
  // cost of a much smaller heat buffer -- punished hard for holding thrust.
  wraith: {
    name: "Wraith",
    cost: 400,
    thrustAccel: 345,
    maxSpeed: 760,
    maxHeat: 75,
    heatPerSecThrusting: 48,
    heatCoolPerSec: 30,
    overheatClearHeat: 23,
  },
};

export const WEAPONS = {
  blaster: {
    name: "Blaster",
    cost: 0,
    fireCooldown: P.FIRE_COOLDOWN,
    projectileLaunchSpeed: P.PROJECTILE_LAUNCH_SPEED,
    projectileMaxSpeed: P.PROJECTILE_MAX_SPEED,
  },
  // Slow, hard-hitting-feeling, fast/flat shots -- unforgiving of misses,
  // rewards precision over volume.
  railgun: {
    name: "Railgun",
    cost: 500,
    fireCooldown: 1.4,
    projectileLaunchSpeed: 780,
    projectileMaxSpeed: 1100,
  },
  // High volume of fire, but slow/easy-to-dodge-at-range shots -- rewards
  // getting in close over precision.
  scattergun: {
    name: "Scattergun",
    cost: 500,
    fireCooldown: 0.45,
    projectileLaunchSpeed: 380,
    projectileMaxSpeed: 900,
  },
};

// Purely cosmetic -- engine trail color only, deliberately NOT hull color.
// Hull color is the primary at-a-glance "is this me or an opponent" signal
// (OWN_COLOR vs ENEMY_COLOR in render.js) during fast combat; letting
// players recolor THAT would risk misidentifying a ship mid-fight, or
// picking the same color as an opponent. Engine color carries none of that
// weight, so it's a genuine zero-risk "flex" customization -- visible to
// everyone else in a match, no combat-clarity or pay-to-win tension at all.
export const DEFAULT_COSMETIC_ID = "classic";

export const COSMETICS = {
  classic: { name: "Classic White", cost: 0, engineColor: 0xffffff },
  solar: { name: "Solar Flare", cost: 200, engineColor: 0xffaa33 },
  toxic: { name: "Toxic Green", cost: 200, engineColor: 0x5dff8a },
  royal: { name: "Royal Violet", cost: 200, engineColor: 0xb98bff },
  rose: { name: "Rose Quartz", cost: 200, engineColor: 0xff6fa5 },
};

// Resolves a cosmetic id to its engine color hex -- unknown/missing id falls
// back to the free default, same "never fail to start a match" philosophy
// as resolveShipStats below.
export function resolveEngineColor(cosmeticId) {
  return (COSMETICS[cosmeticId] ?? COSMETICS[DEFAULT_COSMETIC_ID]).engineColor;
}

// Real, accumulating power growth (unlike the lateral ships/weapons above) --
// deliberately modest per level so it compounds slowly rather than dwarfing
// the 15-40% lateral swings between ship classes/weapons. 5 levels each,
// +/-2%/level -> +/-10% at max. `perLevelPct` is negative for fireRate
// because a SMALLER fireCooldown is what "faster" means -- every other stat
// upgrades by growing.
export const UPGRADE_TREE = {
  thrust: { statField: "thrustAccel", maxLevel: 5, perLevelPct: 0.02, label: "Thrust" },
  heat: { statField: "maxHeat", maxLevel: 5, perLevelPct: 0.02, label: "Heat Capacity" },
  fireRate: { statField: "fireCooldown", maxLevel: 5, perLevelPct: -0.02, label: "Fire Rate" },
  projSpeed: { statField: "projectileLaunchSpeed", maxLevel: 5, perLevelPct: 0.02, label: "Shot Speed" },
};

// Quadratic ramp: level 0->1 costs 50, 1->2 costs 200, ... 4->5 costs 1250.
// Maxing one stat costs 2,750 total; all four, 11,000 -- a long grind by
// design, on top of the much cheaper (400-500) lateral ship/weapon unlocks.
export function upgradeCost(currentLevel) {
  return 50 * (currentLevel + 1) ** 2;
}

// Combines a ship class + weapon type + upgrade levels into the single flat
// stats object match.js/physics.js actually consume (see physics.js's
// DEFAULT_SHIP_STATS shape). An unknown/missing ship or weapon id falls back
// to the free starter rather than throwing -- a match should never fail to
// start because of a corrupt or stale profile. `upgradeLevels` defaults to
// empty (every multiplier 1x, i.e. no change), so omitting it entirely --
// as every pre-Phase-4 call site (including every existing test) does --
// stays numerically identical to before.
export function resolveShipStats(shipId, weaponId, upgradeLevels = {}) {
  const ship = SHIPS[shipId] ?? SHIPS[DEFAULT_SHIP_ID];
  const weapon = WEAPONS[weaponId] ?? WEAPONS[DEFAULT_WEAPON_ID];

  function multiplierFor(stat) {
    const tree = UPGRADE_TREE[stat];
    const level = Math.min(upgradeLevels[stat] ?? 0, tree.maxLevel);
    return 1 + level * tree.perLevelPct;
  }
  const thrustMult = multiplierFor("thrust");
  const heatMult = multiplierFor("heat");
  const fireRateMult = multiplierFor("fireRate");
  const projSpeedMult = multiplierFor("projSpeed");

  return {
    thrustAccel: ship.thrustAccel * thrustMult,
    maxSpeed: ship.maxSpeed,
    maxHeat: ship.maxHeat * heatMult,
    heatPerSecThrusting: ship.heatPerSecThrusting,
    heatCoolPerSec: ship.heatCoolPerSec,
    // Scaled by the same factor as maxHeat so the 30%-of-maxHeat hysteresis
    // ratio (see this file's header comment) holds at any heat upgrade level.
    overheatClearHeat: ship.overheatClearHeat * heatMult,
    fireCooldown: weapon.fireCooldown * fireRateMult,
    projectileLaunchSpeed: weapon.projectileLaunchSpeed * projSpeedMult,
    projectileMaxSpeed: weapon.projectileMaxSpeed,
  };
}
