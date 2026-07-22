// Pure match/combat state machine for Gravity Duel: ties the physics
// primitives together into a full tick (integrate -> detect -> resolve),
// respawn/invulnerability, scoring, and win detection. No I/O.

import * as P from "./physics.js";

// Spawn points are computed from whoever's actually in the match (2-4
// players), evenly spaced around the well on the same ring used since the
// original 1v1 design -- not a fixed per-slot table. 2 players land exactly
// antipodal (the original duel layout), 3 form a triangle, 4 a cross, all
// maximally separated from their neighbors for the given headcount.
export function spawnPositionsFor(playerIds) {
  const n = playerIds.length;
  const positions = {};
  playerIds.forEach((id, i) => {
    const angle = (i / n) * 2 * Math.PI;
    positions[id] = { x: P.SPAWN_RADIUS * Math.cos(angle), y: 0, z: P.SPAWN_RADIUS * Math.sin(angle) };
  });
  return positions;
}

function facingTowardWell(spawnPos) {
  return P.vNormalize(P.vSub(P.WELL_POS, spawnPos));
}

// `spawnPos` and `stats` are both baked onto the ship itself (not re-derived
// from `id`/a loadout lookup later) so respawn() keeps working correctly
// even if a player disconnects mid-match and the surviving roster no longer
// matches whatever roster the spawn ring was originally computed from, and
// so a ship's stats stay fixed for the ship's lifetime even if the owning
// player changes their loadout mid-match (takes effect next match, not
// retroactively). `stats` defaults to physics.js's DEFAULT_SHIP_STATS,
// which is numerically identical to the pre-loadout global constants -- see
// that constant's own comment. `engineColor` is purely cosmetic (a hex
// number, see loadouts.js's COSMETICS) -- never read by physics.js, only
// carried through to the wire format for render.js to pick up.
export function createShip(id, spawnPos, stats = P.DEFAULT_SHIP_STATS, engineColor = 0xffffff) {
  const pos = { ...spawnPos };
  const { yaw, pitch } = P.yawPitchFromFacing(facingTowardWell(pos));
  return {
    id,
    pos,
    spawnPos: { ...spawnPos },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch,
    kills: 0,
    invulnerableUntil: 0,
    lastFireTime: -Infinity,
    thrusting: false,
    heat: 0,
    overheated: false,
    stats,
    engineColor,
    speedBoostUntil: 0,
  };
}

// One state entry per physics.js's PICKUP_SPAWN_POINTS, all active at match
// start. `type`/`pos` never change over a pickup's lifetime -- only
// `active`/`respawnAt` toggle, as ships collect and it cools down.
function createPickups() {
  return P.PICKUP_SPAWN_POINTS.map((spec) => ({ id: spec.id, type: spec.type, pos: spec.pos, active: true, respawnAt: null }));
}

// `loadouts` is an optional { [playerId]: statsObject } map and `cosmetics`
// an optional { [playerId]: engineColorHex } map -- a player absent from
// either (or the whole argument omitted, as every existing test and every
// pre-loadout/pre-cosmetics call site does) gets createShip's own defaults,
// so this stays fully backward compatible.
export function createMatchState(playerIds = ["p1", "p2"], loadouts = {}, cosmetics = {}) {
  const spawnPositions = spawnPositionsFor(playerIds);
  const ships = {};
  for (const id of playerIds) {
    const stats = loadouts[id] ?? P.DEFAULT_SHIP_STATS;
    const engineColor = cosmetics[id];
    ships[id] = engineColor !== undefined ? createShip(id, spawnPositions[id], stats, engineColor) : createShip(id, spawnPositions[id], stats);
  }
  return {
    tick: 0,
    playerIds,
    ships,
    projectiles: [],
    nextProjectileId: 1,
    pickups: createPickups(),
    winner: null,
  };
}

// Called when a connected player disconnects mid-match: drops their ship and
// any of their own still-in-flight projectiles from the live simulation.
// Whether losing a player actually ends the WHOLE match (down to one left)
// is a lobby-level decision made by room.js/server.js, not here -- this just
// keeps the physics state in sync with who's still actually playing.
export function removePlayer(state, id) {
  if (!state.ships[id]) return state;
  const { [id]: _removed, ...ships } = state.ships;
  return {
    ...state,
    playerIds: state.playerIds.filter((pid) => pid !== id),
    ships,
    projectiles: state.projectiles.filter((p) => p.ownerId !== id),
  };
}

function respawn(ship, now) {
  const pos = { ...ship.spawnPos };
  const { yaw, pitch } = P.yawPitchFromFacing(facingTowardWell(pos));
  return {
    ...ship,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch,
    invulnerableUntil: now + P.RESPAWN_INVULN,
    thrusting: false,
    heat: 0,
    overheated: false,
    speedBoostUntil: 0,
  };
}

// A speed pickup temporarily scales thrustAccel/maxSpeed together (not just
// top speed alone) so the burst actually feels like an acceleration surge,
// not just a higher speed cap the ship might not reach in time to matter.
// Heat mechanics are untouched -- effectiveStats is only ever passed to
// integrateShip, never to updateHeat below.
function effectiveStats(ship, now) {
  if (now >= ship.speedBoostUntil) return ship.stats;
  return { ...ship.stats, thrustAccel: ship.stats.thrustAccel * P.PICKUP_SPEED_BOOST_MULT, maxSpeed: ship.stats.maxSpeed * P.PICKUP_SPEED_BOOST_MULT };
}

// Heat rises while the engine is actually firing (thrust request AND not
// already overheated), falls whenever it isn't. Clearing overheat requires
// dropping all the way to this ship's own overheatClearHeat, not just under
// maxHeat -- see physics.js's MAX_HEAT comment for why that hysteresis gap
// exists. Reads ship.stats (a ship class's heat profile) rather than
// physics.js's module-level heat constants directly, same reasoning as
// integrateShip taking a stats argument.
function updateHeat(ship, requestedThrusting, dt) {
  const { maxHeat, heatPerSecThrusting, heatCoolPerSec, overheatClearHeat } = ship.stats;
  const effectiveThrusting = requestedThrusting && !ship.overheated;
  const heat = Math.max(0, Math.min(maxHeat, ship.heat + (effectiveThrusting ? heatPerSecThrusting : -heatCoolPerSec) * dt));
  let overheated = ship.overheated;
  if (!overheated && heat >= maxHeat) overheated = true;
  else if (overheated && heat <= overheatClearHeat) overheated = false;
  return { effectiveThrusting, heat, overheated };
}

// Advances the match by one tick. `inputs` is { p1: {aimYaw,aimPitch,thrusting,firing}, p2: {...} }.
// `now` is the authoritative server clock (seconds), used for cooldowns/invulnerability so
// they're wall-clock-based rather than tick-count-based (robust to a paused/resumed loop).
export function stepMatch(state, inputs, dt, now) {
  if (state.winner) return { state, events: [] };

  // Simulation time (used only for moon orbital position/gravity) is
  // tick-count-based, not wall-clock -- deliberately distinct from `now`,
  // which stays wall-clock for cooldowns/invulnerability (see those fields'
  // own comments). A moon's orbit should only advance while the sim is
  // actually ticking.
  const simTime = state.tick * dt;
  const prevSimTime = simTime - dt;

  // 1. Integrate ships.
  const prevShipPos = {};
  const movedShips = {};
  for (const id of state.playerIds) {
    const ship = state.ships[id];
    prevShipPos[id] = ship.pos;
    const input = inputs[id] ?? { aimYaw: ship.yaw, aimPitch: ship.pitch, thrusting: false, firing: false };
    // An overheated engine ignores a held-down thrust key entirely -- the
    // requested input is downgraded to non-thrusting BEFORE integration, not
    // just cosmetically after, so overheat actually stops acceleration.
    const { effectiveThrusting, heat, overheated } = updateHeat(ship, !!input.thrusting, dt);
    const gatedInput = { ...input, thrusting: effectiveThrusting };
    movedShips[id] = { ...ship, ...P.integrateShip(ship, dt, gatedInput, simTime, effectiveStats(ship, now)), thrusting: effectiveThrusting, heat, overheated };
  }

  // 2. Fire (after movement, from each ship's new position/orientation).
  let nextProjectileId = state.nextProjectileId;
  const spawnedProjectiles = [];
  for (const id of state.playerIds) {
    const ship = movedShips[id];
    const input = inputs[id];
    if (!input?.firing || now - ship.lastFireTime < ship.stats.fireCooldown) continue;
    const proj = P.launchProjectile(ship, id, nextProjectileId++, ship.stats);
    // maxSpeed travels WITH the projectile (not re-read from the owner's
    // ship each tick) -- the owner can respawn with different stats, or
    // disconnect entirely, before an already-in-flight shot resolves.
    spawnedProjectiles.push({ ...proj, spawnTime: now, prevPos: proj.pos, maxSpeed: ship.stats.projectileMaxSpeed });
    movedShips[id] = { ...ship, lastFireTime: now };
  }

  // 3. Integrate projectiles (existing + newly spawned this tick, which
  //    start already-integrated-zero-distance so a hit can't register before
  //    they've actually existed for any time).
  const projStates = [...state.projectiles, ...spawnedProjectiles].map((p) => {
    const prevPos = p.prevPos ?? p.pos;
    const stepped = P.integrateProjectile(p, dt, simTime, p.maxSpeed);
    return { ...p, prevPos, pos: stepped.pos, vel: stepped.vel };
  });

  // Each moon's position at both ends of this tick's motion interval --
  // sweptSphereHit already supports a moving target B, so a moving hazard
  // costs nothing extra here beyond computing its two endpoint positions.
  const moonSweeps = P.MOON_SPECS.map((spec) => ({
    spec,
    prevPos: P.moonPosition(spec, prevSimTime),
    pos: P.moonPosition(spec, simTime),
  }));

  // 4. Detect (frozen snapshot: reads prevShipPos/movedShips/projStates only, never mutates).
  const deadShipIds = new Set();
  const hitProjectileIds = new Set();
  const events = [];

  for (const id of state.playerIds) {
    const ship = movedShips[id];
    if (now < ship.invulnerableUntil) continue;
    let diedThisTick = false;

    if (P.sweptSphereHit(prevShipPos[id], ship.pos, P.SHIP_RADIUS, P.WELL_POS, P.WELL_POS, P.WELL_RADIUS)) {
      deadShipIds.add(id);
      events.push({ event: "well_death", victimId: id });
      diedThisTick = true;
    }

    if (!diedThisTick) {
      for (const { spec, prevPos: moonPrevPos, pos: moonPos } of moonSweeps) {
        if (!P.sweptSphereHit(prevShipPos[id], ship.pos, P.SHIP_RADIUS, moonPrevPos, moonPos, spec.radius)) continue;
        deadShipIds.add(id);
        events.push({ event: "moon_death", victimId: id });
        diedThisTick = true;
        break;
      }
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
      continue;
    }
    for (const { spec, prevPos: moonPrevPos, pos: moonPos } of moonSweeps) {
      if (P.sweptSphereHit(proj.prevPos, proj.pos, P.PROJECTILE_RADIUS, moonPrevPos, moonPos, spec.radius)) {
        hitProjectileIds.add(proj.id);
        break;
      }
    }
  }

  // 4b. Pickups. Reactivate anything whose cooldown has elapsed BEFORE
  // testing collisions this tick, so a pickup can be collected the instant
  // it reappears rather than one tick late. Detection-only here, same as
  // step 4 above -- reads prevShipPos/movedShips/state.pickups, never
  // mutates; step 5 applies the effects.
  const readyPickups = state.pickups.map((p) => (!p.active && p.respawnAt !== null && now >= p.respawnAt ? { ...p, active: true, respawnAt: null } : p));
  const collectedPickupIds = new Set();
  const pickupEffects = {}; // shipId -> pickup type
  for (const id of state.playerIds) {
    const ship = movedShips[id];
    for (const pickup of readyPickups) {
      if (!pickup.active || collectedPickupIds.has(pickup.id)) continue;
      if (!P.sweptSphereHit(prevShipPos[id], ship.pos, P.SHIP_RADIUS, pickup.pos, pickup.pos, P.PICKUP_RADIUS)) continue;
      collectedPickupIds.add(pickup.id);
      pickupEffects[id] = pickup.type;
      events.push({ event: "pickup", playerId: id, pickupId: pickup.id, pickupType: pickup.type });
    }
  }
  const resolvedPickups = readyPickups.map((p) => (collectedPickupIds.has(p.id) ? { ...p, active: false, respawnAt: now + P.PICKUP_RESPAWN_DELAY } : p));

  // 5. Resolve.
  const resolvedShips = {};
  for (const id of state.playerIds) {
    resolvedShips[id] = deadShipIds.has(id) ? respawn(movedShips[id], now) : movedShips[id];
  }
  for (const e of events) {
    if (e.event === "hit" && resolvedShips[e.killerId]) {
      resolvedShips[e.killerId] = { ...resolvedShips[e.killerId], kills: resolvedShips[e.killerId].kills + 1 };
    }
  }

  // Applied AFTER death/respawn resolution, not before -- a pickup grabbed
  // in the same tick a ship would otherwise have died wins (e.g. diving
  // through the shield right as you'd clip the well), which reads as a
  // satisfying last-instant save rather than a wasted pickup.
  for (const [id, type] of Object.entries(pickupEffects)) {
    if (!resolvedShips[id]) continue;
    if (type === "speed") {
      resolvedShips[id] = { ...resolvedShips[id], speedBoostUntil: now + P.PICKUP_SPEED_BOOST_DURATION };
    } else if (type === "shield") {
      resolvedShips[id] = { ...resolvedShips[id], invulnerableUntil: Math.max(resolvedShips[id].invulnerableUntil, now + P.PICKUP_SHIELD_DURATION) };
    } else if (type === "vent") {
      resolvedShips[id] = { ...resolvedShips[id], heat: 0, overheated: false };
    }
  }

  const survivingProjectiles = projStates
    .filter((p) => !hitProjectileIds.has(p.id))
    .filter((p) => now - p.spawnTime < P.PROJECTILE_LIFETIME)
    .filter((p) => P.vLen(p.pos) <= P.ARENA_RADIUS)
    .map(({ prevPos, ...rest }) => rest);

  // 6. Win check.
  let winner = state.winner;
  for (const id of state.playerIds) {
    if (resolvedShips[id].kills >= P.KILLS_TO_WIN) winner = id;
  }
  if (winner && !state.winner) {
    events.push({
      event: "match_over",
      winnerId: winner,
      finalScore: Object.fromEntries(state.playerIds.map((id) => [id, resolvedShips[id].kills])),
    });
  }

  return {
    state: {
      tick: state.tick + 1,
      playerIds: state.playerIds,
      ships: resolvedShips,
      projectiles: survivingProjectiles,
      nextProjectileId,
      pickups: resolvedPickups,
      winner,
    },
    events,
  };
}
