// Pure player-profile logic: currency balance, ship/weapon unlocks +
// equipped loadout, and (a later phase) upgrade levels. No I/O --
// src/profile-store.js owns reading/writing this to disk; this module only
// knows how to create and mutate a single profile object. Same pure/impure
// split as room.js/server.js. Unlock/equip mutations are validated against
// src/loadouts.js's catalog, so a profile can never end up unlocked-but-
// nonexistent or equipped-but-not-unlocked.

import { SHIPS, WEAPONS, DEFAULT_SHIP_ID, DEFAULT_WEAPON_ID } from "./loadouts.js";

export function createDefaultProfile(playerId) {
  const now = Date.now();
  return {
    playerId,
    currency: 0,
    createdAt: now,
    lastSeenAt: now,
    unlockedShips: [DEFAULT_SHIP_ID],
    unlockedWeapons: [DEFAULT_WEAPON_ID],
    equippedShip: DEFAULT_SHIP_ID,
    equippedWeapon: DEFAULT_WEAPON_ID,
    upgrades: { thrust: 0, heat: 0, fireRate: 0, projSpeed: 0 },
  };
}

export function awardCurrency(profile, amount) {
  if (amount <= 0) return profile;
  return { ...profile, currency: profile.currency + amount };
}

export function touchLastSeen(profile, now = Date.now()) {
  return { ...profile, lastSeenAt: now };
}

const CATALOG_BY_KIND = { ship: SHIPS, weapon: WEAPONS };
const UNLOCKED_FIELD_BY_KIND = { ship: "unlockedShips", weapon: "unlockedWeapons" };

// Spends currency to add `id` (a ship or weapon id) to the profile's unlock
// list. Returns { profile, error } -- error is null on success, otherwise
// one of "UNKNOWN_LOADOUT_ID" / "ALREADY_UNLOCKED" / "INSUFFICIENT_CURRENCY",
// and `profile` is returned unchanged (never partially applied).
export function purchaseUnlock(profile, kind, id) {
  const catalog = CATALOG_BY_KIND[kind];
  const def = catalog?.[id];
  if (!def) return { profile, error: "UNKNOWN_LOADOUT_ID" };
  const field = UNLOCKED_FIELD_BY_KIND[kind];
  if (profile[field].includes(id)) return { profile, error: "ALREADY_UNLOCKED" };
  if (profile.currency < def.cost) return { profile, error: "INSUFFICIENT_CURRENCY" };
  return {
    profile: { ...profile, currency: profile.currency - def.cost, [field]: [...profile[field], id] },
    error: null,
  };
}

// Sets the equipped ship and/or weapon (either may be omitted to leave that
// slot as-is). Rejects equipping anything not already unlocked -- purchase
// first via purchaseUnlock. Applies both changes atomically: if either id is
// invalid/not-unlocked, neither slot changes.
export function setEquipped(profile, shipId, weaponId) {
  if (shipId !== undefined) {
    if (!SHIPS[shipId]) return { profile, error: "UNKNOWN_LOADOUT_ID" };
    if (!profile.unlockedShips.includes(shipId)) return { profile, error: "NOT_UNLOCKED" };
  }
  if (weaponId !== undefined) {
    if (!WEAPONS[weaponId]) return { profile, error: "UNKNOWN_LOADOUT_ID" };
    if (!profile.unlockedWeapons.includes(weaponId)) return { profile, error: "NOT_UNLOCKED" };
  }
  return {
    profile: {
      ...profile,
      equippedShip: shipId !== undefined ? shipId : profile.equippedShip,
      equippedWeapon: weaponId !== undefined ? weaponId : profile.equippedWeapon,
    },
    error: null,
  };
}
