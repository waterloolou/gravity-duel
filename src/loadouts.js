// Ship/weapon content catalog + stat resolution. Pure, no I/O -- imported by
// both server.js (authoritative resolution before a match starts) and a
// later phase's client-side Hangar UI (cost/stat display), the same
// "shared verbatim by both sides" pattern protocol.js already establishes
// for message types.
//
// Only the free starter ship/weapon exist so far -- this proves the
// profile -> loadout -> match-physics pipeline end to end (a real profile's
// equippedShip/equippedWeapon now genuinely drive match physics, not just
// sit unused in storage) without yet adding anything actually purchasable.
// More ships/weapons, plus the upgrade tree, are later phases.

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
};

export const WEAPONS = {
  blaster: {
    name: "Blaster",
    cost: 0,
    fireCooldown: P.FIRE_COOLDOWN,
    projectileLaunchSpeed: P.PROJECTILE_LAUNCH_SPEED,
    projectileMaxSpeed: P.PROJECTILE_MAX_SPEED,
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
