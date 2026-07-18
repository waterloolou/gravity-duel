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

check("spawn positions are point-symmetric about the well (180-degree rotation maps p1's spawn to p2's)", () => {
  const p1 = M.SPAWN_POSITIONS.p1;
  const p2 = M.SPAWN_POSITIONS.p2;
  const rotated = { x: -p1.x || 0, y: -p1.y || 0, z: -p1.z || 0 }; // `|| 0` avoids a -0 vs 0 false mismatch
  assert.deepEqual(rotated, p2, "180-degree rotation of p1's spawn should exactly equal p2's spawn");

  const distP1 = P.vLen(P.vSub(p1, P.WELL_POS));
  const distP2 = P.vLen(P.vSub(p2, P.WELL_POS));
  approx(distP1, distP2, 1e-9, "both spawns equidistant from the well");
});

check("both spawns are safely outside the well's danger radius and inside the arena", () => {
  for (const id of ["p1", "p2"]) {
    const dist = P.vLen(P.vSub(M.SPAWN_POSITIONS[id], P.WELL_POS));
    assert.ok(dist > P.WELL_RADIUS + P.SHIP_RADIUS, `${id} spawn must clear the well's danger radius`);
    assert.ok(dist < P.ARENA_RADIUS, `${id} spawn must be inside the arena`);
  }
});

check("a freshly created ship faces toward the well", () => {
  const ship = M.createShip("p1");
  const facing = P.facingFromYawPitch(ship.yaw, ship.pitch);
  const towardWell = P.vNormalize(P.vSub(P.WELL_POS, ship.pos));
  approx(P.vDot(facing, towardWell), 1, 1e-6, "facing should point exactly toward the well");
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
  assert.ok(events.some((e) => e.type === "hit" && e.victimId === "p1" && e.killerId === "p2"));
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
  assert.deepEqual(next.ships.p1.pos, M.SPAWN_POSITIONS.p1, "p1 should have respawned");
  assert.deepEqual(next.ships.p2.pos, M.SPAWN_POSITIONS.p2, "p2 should have respawned");
  assert.equal(events.filter((e) => e.type === "hit").length, 2, "two independent hit events, no order-dependent suppression");
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
  assert.deepEqual(next.ships.p1.pos, M.SPAWN_POSITIONS.p1, "p1 should have respawned after flying into the well");
  assert.ok(events.some((e) => e.type === "well_death" && e.victimId === "p1"));
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
  assert.ok(events.some((e) => e.type === "match_over" && e.winnerId === "p2"));
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
