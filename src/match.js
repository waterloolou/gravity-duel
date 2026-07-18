// Pure match/combat state machine for Gravity Duel: ties the physics
// primitives together into a full tick (integrate -> detect -> resolve),
// respawn/invulnerability, scoring, and win detection. No I/O.

import * as P from "./physics.js";

const PLAYER_IDS = ["p1", "p2"];

export const SPAWN_POSITIONS = {
  p1: { x: P.SPAWN_RADIUS, y: 0, z: 0 },
  p2: { x: -P.SPAWN_RADIUS, y: 0, z: 0 },
};

function facingTowardWell(spawnPos) {
  return P.vNormalize(P.vSub(P.WELL_POS, spawnPos));
}

export function createShip(id) {
  const pos = { ...SPAWN_POSITIONS[id] };
  const { yaw, pitch } = P.yawPitchFromFacing(facingTowardWell(pos));
  return {
    id,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch,
    kills: 0,
    invulnerableUntil: 0,
    lastFireTime: -Infinity,
  };
}

export function createMatchState() {
  return {
    tick: 0,
    ships: { p1: createShip("p1"), p2: createShip("p2") },
    projectiles: [],
    nextProjectileId: 1,
    winner: null,
  };
}

function respawn(ship, now) {
  const pos = { ...SPAWN_POSITIONS[ship.id] };
  const { yaw, pitch } = P.yawPitchFromFacing(facingTowardWell(pos));
  return {
    ...ship,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch,
    invulnerableUntil: now + P.RESPAWN_INVULN,
  };
}

// Advances the match by one tick. `inputs` is { p1: {aimYaw,aimPitch,thrusting,firing}, p2: {...} }.
// `now` is the authoritative server clock (seconds), used for cooldowns/invulnerability so
// they're wall-clock-based rather than tick-count-based (robust to a paused/resumed loop).
export function stepMatch(state, inputs, dt, now) {
  if (state.winner) return { state, events: [] };

  // 1. Integrate ships.
  const prevShipPos = {};
  const movedShips = {};
  for (const id of PLAYER_IDS) {
    const ship = state.ships[id];
    prevShipPos[id] = ship.pos;
    const input = inputs[id] ?? { aimYaw: ship.yaw, aimPitch: ship.pitch, thrusting: false, firing: false };
    movedShips[id] = { ...ship, ...P.integrateShip(ship, dt, input) };
  }

  // 2. Fire (after movement, from each ship's new position/orientation).
  let nextProjectileId = state.nextProjectileId;
  const spawnedProjectiles = [];
  for (const id of PLAYER_IDS) {
    const ship = movedShips[id];
    const input = inputs[id];
    if (!input?.firing || now - ship.lastFireTime < P.FIRE_COOLDOWN) continue;
    const proj = P.launchProjectile(ship, id, nextProjectileId++);
    spawnedProjectiles.push({ ...proj, spawnTime: now, prevPos: proj.pos });
    movedShips[id] = { ...ship, lastFireTime: now };
  }

  // 3. Integrate projectiles (existing + newly spawned this tick, which
  //    start already-integrated-zero-distance so a hit can't register before
  //    they've actually existed for any time).
  const projStates = [...state.projectiles, ...spawnedProjectiles].map((p) => {
    const prevPos = p.prevPos ?? p.pos;
    const stepped = P.integrateProjectile(p, dt);
    return { ...p, prevPos, pos: stepped.pos, vel: stepped.vel };
  });

  // 4. Detect (frozen snapshot: reads prevShipPos/movedShips/projStates only, never mutates).
  const deadShipIds = new Set();
  const hitProjectileIds = new Set();
  const events = [];

  for (const id of PLAYER_IDS) {
    const ship = movedShips[id];
    if (now < ship.invulnerableUntil) continue;
    let diedThisTick = false;

    if (P.sweptSphereHit(prevShipPos[id], ship.pos, P.SHIP_RADIUS, P.WELL_POS, P.WELL_POS, P.WELL_RADIUS)) {
      deadShipIds.add(id);
      events.push({ event: "well_death", victimId: id });
      diedThisTick = true;
    }

    for (const proj of projStates) {
      if (proj.ownerId === id) continue; // a shot never hits its own owner
      if (!P.sweptSphereHit(prevShipPos[id], ship.pos, P.SHIP_RADIUS, proj.prevPos, proj.pos, P.PROJECTILE_RADIUS)) continue;
      hitProjectileIds.add(proj.id); // always consumed on contact...
      if (!diedThisTick) {
        // ...but only the first cause of death this tick grants a kill.
        deadShipIds.add(id);
        events.push({ event: "hit", victimId: id, killerId: proj.ownerId });
        diedThisTick = true;
      }
    }
  }

  for (const proj of projStates) {
    if (hitProjectileIds.has(proj.id)) continue;
    if (P.sweptSphereHit(proj.prevPos, proj.pos, P.PROJECTILE_RADIUS, P.WELL_POS, P.WELL_POS, P.WELL_RADIUS)) {
      hitProjectileIds.add(proj.id);
    }
  }

  // 5. Resolve.
  const resolvedShips = {};
  for (const id of PLAYER_IDS) {
    resolvedShips[id] = deadShipIds.has(id) ? respawn(movedShips[id], now) : movedShips[id];
  }
  for (const e of events) {
    if (e.event === "hit" && resolvedShips[e.killerId]) {
      resolvedShips[e.killerId] = { ...resolvedShips[e.killerId], kills: resolvedShips[e.killerId].kills + 1 };
    }
  }

  const survivingProjectiles = projStates
    .filter((p) => !hitProjectileIds.has(p.id))
    .filter((p) => now - p.spawnTime < P.PROJECTILE_LIFETIME)
    .filter((p) => P.vLen(p.pos) <= P.ARENA_RADIUS)
    .map(({ prevPos, ...rest }) => rest);

  // 6. Win check.
  let winner = state.winner;
  for (const id of PLAYER_IDS) {
    if (resolvedShips[id].kills >= P.KILLS_TO_WIN) winner = id;
  }
  if (winner && !state.winner) {
    events.push({
      event: "match_over",
      winnerId: winner,
      finalScore: { p1: resolvedShips.p1.kills, p2: resolvedShips.p2.kills },
    });
  }

  return {
    state: {
      tick: state.tick + 1,
      ships: resolvedShips,
      projectiles: survivingProjectiles,
      nextProjectileId,
      winner,
    },
    events,
  };
}
