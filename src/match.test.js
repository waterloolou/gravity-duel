import assert from "node:assert/strict";
import * as P from "./physics.js";
import * as M from "./match.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function approx(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ~${expected}, got ${actual}`);
}

const NO_INPUT = { aimYaw: 0, aimPitch: 0, thrusting: false, firing: false };
const THRUST_INPUT = { aimYaw: 0, aimPitch: 0, thrusting: true, firing: false };

check("spawnPositionsFor evenly spreads however many players are in the match around the well, all equidistant", () => {
  for (const n of [2, 3, 4]) {
    const ids = ["p1", "p2", "p3", "p4"].slice(0, n);
    const positions = M.spawnPositionsFor(ids);
    for (const id of ids) {
      const dist = P.vLen(P.vSub(positions[id], P.WELL_POS));
      approx(dist, P.SPAWN_RADIUS, 1e-6, `${id} should sit exactly SPAWN_RADIUS from the well (n=${n})`);
    }
  }
});

check("2-player spawns are antipodal, matching the original 1v1 layout", () => {
  const { p1, p2 } = M.spawnPositionsFor(["p1", "p2"]);
  approx(p1.x + p2.x, 0, 1e-9, "p1 and p2 should sit on exactly opposite sides of the well (x)");
  approx(p1.z + p2.z, 0, 1e-9, "p1 and p2 should sit on exactly opposite sides of the well (z)");
});

check("all spawns are safely outside the well's danger radius and inside the arena, at any player count", () => {
  const positions = M.spawnPositionsFor(["p1", "p2", "p3", "p4"]);
  for (const id of ["p1", "p2", "p3", "p4"]) {
    const dist = P.vLen(P.vSub(positions[id], P.WELL_POS));
    assert.ok(dist > P.WELL_RADIUS + P.SHIP_RADIUS, `${id} spawn must clear the well's danger radius`);
    assert.ok(dist < P.ARENA_RADIUS, `${id} spawn must be inside the arena`);
  }
});

check("a freshly created ship faces toward the well", () => {
  const spawnPos = M.spawnPositionsFor(["p1", "p2"]).p1;
  const ship = M.createShip("p1", spawnPos);
  const facing = P.facingFromYawPitch(ship.yaw, ship.pitch);
  const towardWell = P.vNormalize(P.vSub(P.WELL_POS, ship.pos));
  approx(P.vDot(facing, towardWell), 1, 1e-6, "facing should point exactly toward the well");
});

check("createMatchState builds exactly one ship per requested player id, in a free-for-all roster of any size", () => {
  const state = M.createMatchState(["p1", "p2", "p3"]);
  assert.deepEqual(state.playerIds, ["p1", "p2", "p3"]);
  assert.deepEqual(Object.keys(state.ships).sort(), ["p1", "p2", "p3"]);
});

check("engineColor defaults to white and is otherwise purely a pass-through, per-ship, surviving respawn", () => {
  const defaultState = M.createMatchState(["p1", "p2"]);
  assert.equal(defaultState.ships.p1.engineColor, 0xffffff);

  const customState = M.createMatchState(["p1", "p2"], {}, { p1: 0xff6fa5, p2: 0x5dff8a });
  assert.equal(customState.ships.p1.engineColor, 0xff6fa5);
  assert.equal(customState.ships.p2.engineColor, 0x5dff8a);

  // A lethal hit should respawn p1 without resetting its cosmetic.
  let state = customState;
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.ships.p1.engineColor, 0xff6fa5, "engine color should survive a respawn unchanged");
});

check("removePlayer drops a ship and its own in-flight projectiles, leaving everyone else untouched", () => {
  let state = M.createMatchState(["p1", "p2", "p3"]);
  state.projectiles.push(
    { id: 1, ownerId: "p2", pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 },
    { id: 2, ownerId: "p1", pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 }
  );
  const next = M.removePlayer(state, "p2");
  assert.deepEqual(next.playerIds, ["p1", "p3"]);
  assert.equal(next.ships.p2, undefined);
  assert.ok(next.ships.p1 && next.ships.p3, "remaining ships should be untouched");
  assert.equal(next.projectiles.length, 1, "only p2's own projectile should be removed");
  assert.equal(next.projectiles[0].id, 2);
});

check("removePlayer is a no-op if that id isn't actually in the match", () => {
  const state = M.createMatchState(["p1", "p2"]);
  assert.equal(M.removePlayer(state, "p9"), state, "should return the same state reference, not a needless copy");
});

check("combat and win detection generalize to free-for-all matches of more than 2 players", () => {
  let state = M.createMatchState(["p1", "p2", "p3"]);
  state.ships.p3 = { ...state.ships.p3, kills: P.KILLS_TO_WIN - 1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push({ id: 1, ownerId: "p3", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } }; // sits right where p3's shot already is
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT, p3: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.ships.p3.kills, P.KILLS_TO_WIN);
  assert.equal(next.winner, "p3");
  const overEvent = events.find((e) => e.event === "match_over");
  assert.ok(overEvent, "match_over should fire");
  assert.deepEqual(overEvent.finalScore, { p1: 0, p2: 0, p3: P.KILLS_TO_WIN });
});

check("firing respects the cooldown -- holding fire does not spawn a projectile every tick", () => {
  let state = M.createMatchState();
  const inputs = { p1: { ...NO_INPUT, firing: true }, p2: NO_INPUT };
  ({ state } = M.stepMatch(state, inputs, P.TICK_DT, 0));
  assert.equal(state.projectiles.length, 1, "first tick should fire one projectile");
  ({ state } = M.stepMatch(state, inputs, P.TICK_DT, P.TICK_DT));
  assert.equal(state.projectiles.length, 1, "second tick, still within cooldown, should not fire again");
  ({ state } = M.stepMatch(state, inputs, P.TICK_DT, P.FIRE_COOLDOWN + 0.01));
  assert.equal(state.projectiles.length, 2, "after the cooldown elapses, a new shot should fire");
});

check("shotsFired increments once per actual shot, independent of kills -- a miss still counts as a shot", () => {
  let state = M.createMatchState();
  assert.equal(state.ships.p1.shotsFired, 0);
  const inputs = { p1: { ...NO_INPUT, firing: true }, p2: NO_INPUT };
  ({ state } = M.stepMatch(state, inputs, P.TICK_DT, 0));
  assert.equal(state.ships.p1.shotsFired, 1, "a shot that hits nothing should still count");
  assert.equal(state.ships.p1.kills, 0);
  ({ state } = M.stepMatch(state, inputs, P.TICK_DT, P.FIRE_COOLDOWN + 0.01));
  assert.equal(state.ships.p1.shotsFired, 2, "a second shot after the cooldown should increment again");
});

check("match_over's shotsFired map lines up with finalScore for every player, so accuracy = kills/shotsFired can be computed client-side", () => {
  let state = M.createMatchState();
  // Seed p1 one kill short of winning, with some shots already on the
  // books, then land the final (instant, pre-colocated) hit -- same
  // "win is declared at exactly KILLS_TO_WIN" pattern used elsewhere.
  state.ships.p2 = { ...state.ships.p2, kills: P.KILLS_TO_WIN - 1, shotsFired: 12, pos: { x: 150, y: 0, z: 0 } };
  state.ships.p1 = { ...state.ships.p1, shotsFired: 3, pos: { x: 200, y: 0, z: 0 } };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { x: 200, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  const overEvent = events.find((e) => e.event === "match_over");
  assert.ok(overEvent, "match_over should fire the instant p2's kill count reaches KILLS_TO_WIN");
  assert.equal(overEvent.shotsFired.p2, 12);
  assert.equal(overEvent.shotsFired.p1, 3);
  assert.equal(overEvent.shotsFired.p1, next.ships.p1.shotsFired, "shotsFired in the event should match the final ship state");
  assert.equal(Object.keys(overEvent.shotsFired).sort().join(), Object.keys(overEvent.finalScore).sort().join(), "shotsFired and finalScore should cover exactly the same player ids");
});

check("a projectile can never hit its own owner, even if perfectly co-located", () => {
  let state = M.createMatchState();
  // Force a projectile owned by p1 to start exactly at p1's own ship position.
  state.projectiles.push({ id: 99, ownerId: "p1", pos: { ...state.ships.p1.pos }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  // invulnerableUntil only ever changes via respawn() on the death path, so
  // it staying at its default (0) is definitive proof p1 was never killed.
  assert.equal(next.ships.p1.invulnerableUntil, 0, "p1 should not have been killed by its own projectile");
  assert.equal(next.ships.p1.kills, 0);
});

check("invulnerable ships are excluded from hit detection entirely", () => {
  let state = M.createMatchState();
  // Make p1 invulnerable, then co-locate an opponent projectile with p1's ship.
  state.ships.p1 = { ...state.ships.p1, invulnerableUntil: 100 };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { ...state.ships.p1.pos }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1); // now=1, well within invulnerableUntil=100
  // A respawn always resets invulnerableUntil to now+RESPAWN_INVULN; it staying at the
  // original 100 is definitive proof no death/respawn occurred (position alone isn't a
  // reliable signal here since gravity moves the ship slightly regardless).
  assert.equal(next.ships.p1.invulnerableUntil, 100, "p1 should not have respawned (i.e. not have died)");
  assert.equal(next.ships.p2.kills, 0, "no kill should be credited while the target is invulnerable");
});

check("a lethal hit respawns the victim at their fixed spawn point with a fresh invulnerability window", () => {
  let state = M.createMatchState();
  const originalSpawn = { ...state.ships.p1.pos };
  // Move p1 away from spawn so a respawn is actually observable, then land a hit.
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const now = 5;
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now);
  assert.deepEqual(next.ships.p1.pos, originalSpawn, "victim should respawn at their exact fixed spawn point");
  assert.equal(next.ships.p1.invulnerableUntil, now + P.RESPAWN_INVULN);
  assert.equal(next.ships.p2.kills, 1, "killer should be credited");
  assert.ok(events.some((e) => e.event === "hit" && e.victimId === "p1" && e.killerId === "p2"));
});

check("a hit projectile is removed from play", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push({ id: 42, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.projectiles.find((p) => p.id === 42), undefined, "the projectile that scored the hit should be gone");
});

check("simultaneous mutual kills: both ships die and both killers are credited in the same tick", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.ships.p2 = { ...state.ships.p2, pos: { x: -150, y: 0, z: 0 } };
  state.projectiles.push(
    { id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 }, // hits p1
    { id: 2, ownerId: "p1", pos: { x: -150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 } // hits p2
  );
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.ships.p1.kills, 1, "p1 should be credited for killing p2");
  assert.equal(next.ships.p2.kills, 1, "p2 should be credited for killing p1");
  assert.deepEqual(next.ships.p1.pos, state.ships.p1.spawnPos, "p1 should have respawned");
  assert.deepEqual(next.ships.p2.pos, state.ships.p2.spawnPos, "p2 should have respawned");
  assert.equal(events.filter((e) => e.event === "hit").length, 2, "two independent hit events, no order-dependent suppression");
});

check("two simultaneous hits on the same ship consume both projectiles but grant only one kill", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push(
    { id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 },
    { id: 2, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 }
  );
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.ships.p2.kills, 1, "only one kill should be credited for a double-hit in the same tick");
  assert.equal(next.projectiles.length, 0, "both projectiles that made contact should be consumed");
});

check("flying into the well is lethal, same as being shot", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, pos: { x: P.WELL_RADIUS + P.SHIP_RADIUS - 1, y: 0, z: 0 } };
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.deepEqual(next.ships.p1.pos, state.ships.p1.spawnPos, "p1 should have respawned after flying into the well");
  assert.ok(events.some((e) => e.event === "well_death" && e.victimId === "p1"));
});

check("flying into a moon is lethal, just like the well, but credits no one", () => {
  let state = M.createMatchState();
  // state.tick is 0 for a freshly created match, so stepMatch will compute
  // simTime=0 internally -- moonPosition at t=0 is exactly reproducible here.
  const moonPos = P.moonPosition(P.MOON_SPECS[0], 0);
  state.ships.p1 = { ...state.ships.p1, pos: { ...moonPos } };
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.deepEqual(next.ships.p1.pos, state.ships.p1.spawnPos, "p1 should have respawned after crashing into a moon");
  assert.ok(events.some((e) => e.event === "moon_death" && e.victimId === "p1"));
  assert.equal(next.ships.p2.kills, 0, "a moon death, like a well death, credits no one");
});

check("a projectile flying into a moon is silently consumed, just like the well", () => {
  let state = M.createMatchState();
  const moonPos = P.moonPosition(P.MOON_SPECS[1], 0);
  state.projectiles.push({ id: 7, ownerId: "p1", pos: { ...moonPos }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.projectiles.find((p) => p.id === 7), undefined, "the projectile should have been consumed by the moon");
});

check("sustained thrust builds heat and eventually forces an overheat lockout", () => {
  let state = M.createMatchState();
  let overheatedAtTick = null;
  for (let i = 0; i < 200 && overheatedAtTick === null; i++) {
    ({ state } = M.stepMatch(state, { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, i * P.TICK_DT));
    if (state.ships.p1.overheated) overheatedAtTick = i;
  }
  assert.ok(overheatedAtTick !== null, "continuous thrust should eventually overheat the engine");
  assert.equal(state.ships.p1.heat, P.MAX_HEAT, "heat should cap exactly at MAX_HEAT, not overshoot");

  // Holding thrust down while overheated should be entirely ignored by physics.
  const { state: nextTick } = M.stepMatch(state, { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, (overheatedAtTick + 1) * P.TICK_DT);
  assert.equal(nextTick.ships.p1.thrusting, false, "an overheated engine should not actually fire even with thrust held down");
});

check("overheat only clears once heat cools all the way down to OVERHEAT_CLEAR_HEAT, not just under MAX_HEAT", () => {
  const base = M.createMatchState();

  let stillHot = { ...base, ships: { ...base.ships, p1: { ...base.ships.p1, heat: P.OVERHEAT_CLEAR_HEAT + 1, overheated: true } } };
  ({ state: stillHot } = M.stepMatch(stillHot, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 0));
  assert.equal(stillHot.ships.p1.overheated, true, "should stay locked out while still above the clear threshold");

  let atThreshold = { ...base, ships: { ...base.ships, p1: { ...base.ships.p1, heat: P.OVERHEAT_CLEAR_HEAT, overheated: true } } };
  ({ state: atThreshold } = M.stepMatch(atThreshold, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 0));
  assert.equal(atThreshold.ships.p1.overheated, false, "should clear once heat reaches the threshold");
});

check("a respawn resets heat and clears overheat, giving a fresh engine on death", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 }, heat: 80, overheated: true };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(next.ships.p1.heat, 0, "respawn should reset heat to 0");
  assert.equal(next.ships.p1.overheated, false, "respawn should clear overheat");
});

check("win is declared at exactly KILLS_TO_WIN, not one before", () => {
  let state = M.createMatchState();
  state.ships.p2 = { ...state.ships.p2, kills: P.KILLS_TO_WIN - 2 };
  state.ships.p1 = { ...state.ships.p1, pos: { x: 150, y: 0, z: 0 } };
  state.projectiles.push({ id: 1, ownerId: "p2", pos: { x: 150, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 0 });

  const { state: afterFirst } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(afterFirst.ships.p2.kills, P.KILLS_TO_WIN - 1);
  assert.equal(afterFirst.winner, null, "should not be won one kill short");

  // p1 just respawned from the first hit and is still inside its 2s invulnerability
  // window (invulnerableUntil = now(1) + RESPAWN_INVULN) -- clear it explicitly so
  // this second, independently-constructed hit isn't silently ignored.
  afterFirst.ships.p1 = { ...afterFirst.ships.p1, pos: { x: 200, y: 0, z: 0 }, invulnerableUntil: 0 };
  afterFirst.projectiles.push({ id: 2, ownerId: "p2", pos: { x: 200, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spawnTime: 1 });
  const { state: afterSecond, events } = M.stepMatch(afterFirst, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 4);
  assert.equal(afterSecond.ships.p2.kills, P.KILLS_TO_WIN);
  assert.equal(afterSecond.winner, "p2");
  assert.ok(events.some((e) => e.event === "match_over" && e.winnerId === "p2"));
});

check("createMatchState seeds one active pickup per fixed spawn point, matching physics.js's own positions", () => {
  const state = M.createMatchState();
  assert.equal(state.pickups.length, P.PICKUP_SPAWN_POINTS.length);
  assert.deepEqual(
    state.pickups.map((p) => p.type).sort(),
    ["shield", "speed", "vent"]
  );
  for (const p of state.pickups) {
    assert.equal(p.active, true);
    assert.equal(p.respawnAt, null);
  }
});

check("flying through the speed pickup grants a temporary boost, fires a pickup event, and puts it on cooldown", () => {
  let state = M.createMatchState();
  const spec = P.PICKUP_SPAWN_POINTS.find((s) => s.type === "speed");
  state.ships.p1 = { ...state.ships.p1, pos: { ...spec.pos } };
  const now = 10;
  const { state: next, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now);
  assert.equal(next.ships.p1.speedBoostUntil, now + P.PICKUP_SPEED_BOOST_DURATION);
  const pickup = next.pickups.find((p) => p.id === spec.id);
  assert.equal(pickup.active, false);
  assert.equal(pickup.respawnAt, now + P.PICKUP_RESPAWN_DELAY);
  assert.ok(events.some((e) => e.event === "pickup" && e.playerId === "p1" && e.pickupType === "speed"));
});

check("an active speed boost measurably out-accelerates an otherwise identical unboosted ship", () => {
  const baseline = M.createMatchState();
  const boosted = { ...baseline, ships: { ...baseline.ships, p1: { ...baseline.ships.p1, speedBoostUntil: 100 } } };
  const { state: nextBaseline } = M.stepMatch(baseline, { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, 0);
  const { state: nextBoosted } = M.stepMatch(boosted, { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, 0);
  assert.ok(P.vLen(nextBoosted.ships.p1.vel) > P.vLen(nextBaseline.ships.p1.vel), "a boosted ship should accelerate harder under identical thrust input");
});

check("the speed boost stops applying the instant speedBoostUntil has passed", () => {
  let state = M.createMatchState();
  state.ships.p1 = { ...state.ships.p1, speedBoostUntil: 5 };
  const { state: expired } = M.stepMatch(state, { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, 5); // now === speedBoostUntil: already expired
  const { state: reference } = M.stepMatch(M.createMatchState(), { p1: THRUST_INPUT, p2: NO_INPUT }, P.TICK_DT, 5);
  approx(P.vLen(expired.ships.p1.vel), P.vLen(reference.ships.p1.vel), 1e-9, "an expired boost should apply no multiplier at all");
});

check("flying through the shield pickup grants bonus invulnerability without dying/respawning", () => {
  let state = M.createMatchState();
  const spec = P.PICKUP_SPAWN_POINTS.find((s) => s.type === "shield");
  state.ships.p1 = { ...state.ships.p1, pos: { ...spec.pos } };
  const now = 10;
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now);
  assert.equal(next.ships.p1.invulnerableUntil, now + P.PICKUP_SHIELD_DURATION);
  // A respawn would teleport p1 back to its (far-away) spawnPos -- staying
  // right where the pickup was is proof this didn't go through the death path.
  const dist = P.vLen(P.vSub(next.ships.p1.pos, spec.pos));
  assert.ok(dist < 1, "the ship should still be right where it collected the pickup, not teleported back to spawn");
});

check("a shield pickup only ever raises invulnerability, never shortens an already-longer window", () => {
  let state = M.createMatchState();
  const spec = P.PICKUP_SPAWN_POINTS.find((s) => s.type === "shield");
  const now = 10;
  state.ships.p1 = { ...state.ships.p1, pos: { ...spec.pos }, invulnerableUntil: now + 999 };
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now);
  assert.equal(next.ships.p1.invulnerableUntil, now + 999, "an existing longer invulnerability window should not be shortened");
});

check("flying through the vent pickup instantly clears heat and overheat", () => {
  let state = M.createMatchState();
  const spec = P.PICKUP_SPAWN_POINTS.find((s) => s.type === "vent");
  state.ships.p1 = { ...state.ships.p1, pos: { ...spec.pos }, heat: 95, overheated: true };
  const { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 10);
  assert.equal(next.ships.p1.heat, 0);
  assert.equal(next.ships.p1.overheated, false);
});

check("a collected pickup stays uncollectable through its cooldown, then reactivates instantly once it elapses", () => {
  let state = M.createMatchState();
  const spec = P.PICKUP_SPAWN_POINTS.find((s) => s.type === "vent");
  state.ships.p1 = { ...state.ships.p1, pos: { ...spec.pos }, heat: 50 };
  const now = 10;
  let { state: next } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now);
  const collectedAt = next.pickups.find((p) => p.id === spec.id);
  assert.equal(collectedAt.active, false);

  // Sitting right back on top of it a tick later, while still on cooldown, must not re-trigger.
  next.ships.p1 = { ...next.ships.p1, heat: 50, pos: { ...spec.pos } };
  const { state: stillCooling, events: noEvents } = M.stepMatch(next, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, now + P.TICK_DT);
  assert.notEqual(stillCooling.ships.p1.heat, 0, "should not have re-vented while the pickup is still on cooldown");
  assert.ok(!noEvents.some((e) => e.event === "pickup"), "no pickup event should fire while on cooldown");

  // Once respawnAt has passed, it reactivates and is collectible again the very same tick.
  stillCooling.ships.p1 = { ...stillCooling.ships.p1, heat: 50, pos: { ...spec.pos } };
  const { state: reactivated } = M.stepMatch(stillCooling, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, collectedAt.respawnAt);
  assert.equal(reactivated.ships.p1.heat, 0, "should have vented again now that the pickup is off cooldown");
  assert.equal(reactivated.pickups.find((p) => p.id === spec.id).active, false, "should be back on cooldown immediately after being re-collected");
});

check("stepMatch is a no-op once a winner is set", () => {
  let state = M.createMatchState();
  state.winner = "p1";
  const before = JSON.stringify(state);
  const { state: after, events } = M.stepMatch(state, { p1: NO_INPUT, p2: NO_INPUT }, P.TICK_DT, 1);
  assert.equal(JSON.stringify(after), before, "state should be unchanged after the match is over");
  assert.deepEqual(events, []);
});

console.log(`\n${passed} match.js assertions passed`);
