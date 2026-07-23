// Pure player-profile logic: currency balance, ship/weapon unlocks +
// equipped loadout, and upgrade levels. No I/O -- src/profile-store.js owns
// reading/writing this to disk; this module only knows how to create and
// mutate a single profile object. Same pure/impure split as
// room.js/server.js. All mutations are validated against src/loadouts.js's
// catalog, so a profile can never end up unlocked-but-nonexistent,
// equipped-but-not-unlocked, or upgraded-past-maxLevel.

import { SHIPS, WEAPONS, COSMETICS, DEFAULT_SHIP_ID, DEFAULT_WEAPON_ID, DEFAULT_COSMETIC_ID, UPGRADE_TREE, upgradeCost } from "./loadouts.js";
import { createDefaultChallengeState } from "./challenges.js";

const DEFAULT_STATS = { wins: 0, losses: 0, matchesPlayed: 0, kills: 0, deaths: 0 };
const DISPLAY_NAME_MAX_LENGTH = 16;

export function createDefaultProfile(playerId) {
  const now = Date.now();
  return {
    playerId,
    currency: 0,
    createdAt: now,
    lastSeenAt: now,
    unlockedShips: [DEFAULT_SHIP_ID],
    unlockedWeapons: [DEFAULT_WEAPON_ID],
    unlockedCosmetics: [DEFAULT_COSMETIC_ID],
    equippedShip: DEFAULT_SHIP_ID,
    equippedWeapon: DEFAULT_WEAPON_ID,
    equippedCosmetic: DEFAULT_COSMETIC_ID,
    upgrades: { thrust: 0, heat: 0, fireRate: 0, projSpeed: 0 },
    displayName: null, // shown on the leaderboard once set; null renders as an anonymous placeholder
    stats: { ...DEFAULT_STATS },
    challenges: createDefaultChallengeState(),
  };
}

export function awardCurrency(profile, amount) {
  if (amount <= 0) return profile;
  return { ...profile, currency: profile.currency + amount };
}

export function touchLastSeen(profile, now = Date.now()) {
  return { ...profile, lastSeenAt: now };
}

// `delta` is a partial stats object to ADD (e.g. { kills: 1 }), not a
// replacement -- lets every call site stay a one-liner instead of reading
// the current value first. Defensive against `profile.stats` being absent
// (a profile persisted before this field existed) rather than assuming
// every stored profile already has the current shape.
export function addStats(profile, delta) {
  const stats = { ...DEFAULT_STATS, ...profile.stats };
  for (const [key, amount] of Object.entries(delta)) {
    stats[key] = (stats[key] ?? 0) + amount;
  }
  return { ...profile, stats };
}

// Player-chosen, shown on the leaderboard instead of the raw persistent id
// (which must never be exposed to other clients -- it's effectively a
// credential, see server.js's IDENTIFY handler comment). Trimmed and
// length-capped server-side; still gets HTML-escaped again at render time
// on the client since this is free-text user input rendered to OTHER
// players, a real stored-XSS surface if that step were ever skipped.
export function setDisplayName(profile, name) {
  const trimmed = String(name ?? "").trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
  if (!trimmed) return { profile, error: "INVALID_NAME" };
  return { profile: { ...profile, displayName: trimmed }, error: null };
}

const CATALOG_BY_KIND = { ship: SHIPS, weapon: WEAPONS, cosmetic: COSMETICS };
const UNLOCKED_FIELD_BY_KIND = { ship: "unlockedShips", weapon: "unlockedWeapons", cosmetic: "unlockedCosmetics" };

// Spends currency to add `id` (a ship, weapon, or cosmetic id) to the
// profile's unlock list. Returns { profile, error } -- error is null on
// success, otherwise one of "UNKNOWN_LOADOUT_ID" / "ALREADY_UNLOCKED" /
// "INSUFFICIENT_CURRENCY", and `profile` is returned unchanged (never
// partially applied).
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

// Sets the equipped ship/weapon/cosmetic (any may be omitted to leave that
// slot as-is). Rejects equipping anything not already unlocked -- purchase
// first via purchaseUnlock. Applies every change atomically: if ANY given id
// is invalid/not-unlocked, NO slot changes.
export function setEquipped(profile, shipId, weaponId, cosmeticId) {
  if (shipId !== undefined) {
    if (!SHIPS[shipId]) return { profile, error: "UNKNOWN_LOADOUT_ID" };
    if (!profile.unlockedShips.includes(shipId)) return { profile, error: "NOT_UNLOCKED" };
  }
  if (weaponId !== undefined) {
    if (!WEAPONS[weaponId]) return { profile, error: "UNKNOWN_LOADOUT_ID" };
    if (!profile.unlockedWeapons.includes(weaponId)) return { profile, error: "NOT_UNLOCKED" };
  }
  if (cosmeticId !== undefined) {
    if (!COSMETICS[cosmeticId]) return { profile, error: "UNKNOWN_LOADOUT_ID" };
    if (!profile.unlockedCosmetics.includes(cosmeticId)) return { profile, error: "NOT_UNLOCKED" };
  }
  return {
    profile: {
      ...profile,
      equippedShip: shipId !== undefined ? shipId : profile.equippedShip,
      equippedWeapon: weaponId !== undefined ? weaponId : profile.equippedWeapon,
      equippedCosmetic: cosmeticId !== undefined ? cosmeticId : profile.equippedCosmetic,
    },
    error: null,
  };
}

// Spends currency to raise one upgrade stat by a single level. `stat` is one
// of UPGRADE_TREE's keys (thrust/heat/fireRate/projSpeed). Cost is read from
// the CURRENT level (upgradeCost(currentLevel)), so each purchase only ever
// buys the next level, never lets a client name an arbitrary target level.
export function purchaseUpgrade(profile, stat) {
  const tree = UPGRADE_TREE[stat];
  if (!tree) return { profile, error: "UNKNOWN_LOADOUT_ID" };
  const currentLevel = profile.upgrades[stat] ?? 0;
  if (currentLevel >= tree.maxLevel) return { profile, error: "MAX_LEVEL_REACHED" };
  const cost = upgradeCost(currentLevel);
  if (profile.currency < cost) return { profile, error: "INSUFFICIENT_CURRENCY" };
  return {
    profile: {
      ...profile,
      currency: profile.currency - cost,
      upgrades: { ...profile.upgrades, [stat]: currentLevel + 1 },
    },
    error: null,
  };
}
