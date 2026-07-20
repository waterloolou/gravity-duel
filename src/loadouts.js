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

// Combines a ship class + weapon type into the single flat stats object
// match.js/physics.js actually consume (see physics.js's DEFAULT_SHIP_STATS
// shape). An unknown/missing id falls back to the free starter rather than
// throwing -- a match should never fail to start because of a corrupt or
// stale profile.
export function resolveShipStats(shipId, weaponId) {
  const ship = SHIPS[shipId] ?? SHIPS[DEFAULT_SHIP_ID];
  const weapon = WEAPONS[weaponId] ?? WEAPONS[DEFAULT_WEAPON_ID];
  return {
    thrustAccel: ship.thrustAccel,
    maxSpeed: ship.maxSpeed,
    maxHeat: ship.maxHeat,
    heatPerSecThrusting: ship.heatPerSecThrusting,
    heatCoolPerSec: ship.heatCoolPerSec,
    overheatClearHeat: ship.overheatClearHeat,
    fireCooldown: weapon.fireCooldown,
    projectileLaunchSpeed: weapon.projectileLaunchSpeed,
    projectileMaxSpeed: weapon.projectileMaxSpeed,
  };
}
