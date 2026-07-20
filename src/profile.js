// Pure player-profile logic: currency balance today, ship/weapon unlocks and
// upgrade levels in later phases. No I/O -- src/profile-store.js owns
// reading/writing this to disk; this module only knows how to create and
// mutate a single profile object. Same pure/impure split as room.js/server.js.

export function createDefaultProfile(playerId) {
  const now = Date.now();
  return {
    playerId,
    currency: 0,
    createdAt: now,
    lastSeenAt: now,
    unlockedShips: ["interceptor"],
    unlockedWeapons: ["blaster"],
    equippedShip: "interceptor",
    equippedWeapon: "blaster",
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
