// Pure physics engine for Gravity Duel. No I/O, no Node/browser APIs — a
// deterministic function of (state, inputs, dt) so it's identically testable
// here and runnable unmodified inside the server's tick loop.

export const ARENA_RADIUS = 500;
export const WELL_POS = { x: 0, y: 0, z: 0 };
export const WELL_RADIUS = 40;
export const G_MU = 2_000_000; // gravitational parameter (G*M), tuned for feel not realism

export const SHIP_RADIUS = 8;
export const SHIP_THRUST_ACCEL = 300;
export const SHIP_DRAG = 1.0; // dv/dt includes -SHIP_DRAG * v; terminal speed = SHIP_THRUST_ACCEL / SHIP_DRAG
export const SHIP_MAX_SPEED = 700;
export const BOUNDARY_RESTITUTION = 0.6;

// Thrust engine heat: 0-100, rises while thrusting, falls whenever not.
// Hitting MAX_HEAT force-cuts thrust (held-down W is simply ignored) until
// heat bleeds back down to OVERHEAT_CLEAR_HEAT -- a hysteresis gap rather
// than "clears the instant it dips below max" so a ship sitting right at the
// threshold doesn't flicker in and out of overheat tick to tick. At
// HEAT_PER_SEC_THRUSTING, continuous thrust maxes out in 2.5s; at
// HEAT_COOL_PER_SEC, a full cooldown from max takes 4s idle.
export const MAX_HEAT = 100;
export const HEAT_PER_SEC_THRUSTING = 40;
export const HEAT_COOL_PER_SEC = 25;
export const OVERHEAT_CLEAR_HEAT = 30;

export const PROJECTILE_RADIUS = 2;
export const PROJECTILE_LAUNCH_SPEED = 500;
export const PROJECTILE_MAX_SPEED = 900;
export const PROJECTILE_LIFETIME = 6; // seconds
export const FIRE_COOLDOWN = 0.8; // seconds

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const RESPAWN_INVULN = 2.0; // seconds
export const KILLS_TO_WIN = 5;
export const SPAWN_RADIUS = 350;

// The subset of tuning constants above that vary per ship class/weapon type
// (src/loadouts.js), bundled into one object so match.js can stash it on
// each ship at creation time instead of every physics function reaching for
// module-level globals. This exact bundle IS what "no ship/weapon chosen
// yet" (an un-identified player, or any physics.test.js call written before
// loadouts existed) resolves to -- every function below defaults to it, so
// behavior is byte-for-byte identical to the pre-loadout constants unless a
// caller explicitly passes a different stats object.
export const DEFAULT_SHIP_STATS = {
  thrustAccel: SHIP_THRUST_ACCEL,
  maxSpeed: SHIP_MAX_SPEED,
  maxHeat: MAX_HEAT,
  heatPerSecThrusting: HEAT_PER_SEC_THRUSTING,
  heatCoolPerSec: HEAT_COOL_PER_SEC,
  overheatClearHeat: OVERHEAT_CLEAR_HEAT,
  fireCooldown: FIRE_COOLDOWN,
  projectileLaunchSpeed: PROJECTILE_LAUNCH_SPEED,
  projectileMaxSpeed: PROJECTILE_MAX_SPEED,
};

// Three moons on fixed circular orbits around the well, each an additional
// gravity source (and collision hazard) -- not just decoration. Orbits are
// kinematic (a pure function of simTime), not mutually N-body-simulated:
// real enough to matter tactically (slingshot around a moon, or get pulled
// off course by one) without the instability of actually integrating
// multiple massive bodies against each other. orbitRadius is deliberately
// kept clear of SPAWN_RADIUS (350) by a comfortable margin on every side --
// a moon's orbit crosses the well-ship axis exactly twice per revolution
// (at inclination-tilt angle 0 and pi), and if that crossing point ever
// landed close to 350, a freshly (re)spawned ship could momentarily overlap
// a moon. moonA/moonB sit inside that radius, moonC sits outside it (with
// ARENA_RADIUS=500 clearance to spare), giving the map an outer hazard ring
// distinct from the two inner ones.
export const MOON_SPECS = [
  { name: "moonA", orbitRadius: 190, period: 34, radius: 16, mu: 320_000, phase: Math.PI / 2, inclination: 0.32 },
  { name: "moonB", orbitRadius: 300, period: 68, radius: 24, mu: 600_000, phase: Math.PI * 1.35, inclination: -0.46 },
  { name: "moonC", orbitRadius: 420, period: 96, radius: 20, mu: 450_000, phase: Math.PI * 0.15, inclination: 0.6 },
];

// Arena pickups: fixed-position collectibles (not orbiting, unlike moons)
// that grant a temporary tactical buff on contact, then go on cooldown
// before reappearing at the same spot. Three types, one fixed spawn point
// each -- a player learns the map ("shield sits north of the well") rather
// than chasing something that moves or reshuffles every match.
export const PICKUP_RADIUS = 12;
export const PICKUP_RESPAWN_DELAY = 14; // seconds after being collected before it reappears
export const PICKUP_SPEED_BOOST_DURATION = 5; // seconds
export const PICKUP_SPEED_BOOST_MULT = 1.6; // multiplies thrustAccel AND maxSpeed while active
export const PICKUP_SHIELD_DURATION = 4; // seconds of bonus invulnerability (extends the ship's existing invulnerableUntil)

// Placed at radius 130 from the well: well outside WELL_RADIUS (40, so no
// risk of overlapping the kill sphere) but comfortably inside the nearest
// moon's orbit (moonA at a constant 190 from the well, see moonPosition's
// own comment on why that distance never varies) -- reaching one means
// diving toward the gravity well's danger zone, not hugging the safe outer
// arena edge where ships spawn (SPAWN_RADIUS 350).
export const PICKUP_SPAWN_POINTS = [
  { id: "pickupSpeed", type: "speed", pos: { x: 130, y: 0, z: 0 } },
  { id: "pickupShield", type: "shield", pos: { x: -65, y: 0, z: 112.583 } },
  { id: "pickupVent", type: "vent", pos: { x: -65, y: 0, z: -112.583 } },
];

// --- vec3 helpers -----------------------------------------------------

export function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function vScale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function vLen(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}
export function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function vNormalize(a) {
  const l = vLen(a);
  return l > 0 ? vScale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}
export function clampSpeed(vel, maxSpeed) {
  const l = vLen(vel);
  return l > maxSpeed && l > 0 ? vScale(vel, maxSpeed / l) : vel;
}

// Standard FPS-style yaw/pitch -> forward-facing unit vector, and its
// inverse. yaw rotates around Y (0 = +Z), pitch tilts toward +Y.
export function facingFromYawPitch(yaw, pitch) {
  return {
    x: Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.cos(yaw),
  };
}
export function yawPitchFromFacing(facing) {
  const f = vNormalize(facing);
  return { yaw: Math.atan2(f.x, f.z), pitch: Math.asin(Math.max(-1, Math.min(1, f.y))) };
}

// --- gravity / integration ---------------------------------------------

export function gravityAcceleration(pos, wellPos = WELL_POS, mu = G_MU) {
  const toWell = vSub(wellPos, pos);
  const r = vLen(toWell);
  if (r === 0) return { x: 0, y: 0, z: 0 };
  return vScale(vNormalize(toWell), mu / (r * r));
}

// A moon's position on its fixed circular orbit at a given simulation time
// (seconds of simulated tick-time, NOT wall-clock -- see stepMatch/render.js
// for why: orbital motion should only advance while the sim is actually
// ticking, unlike the wall-clock-based cooldown/invulnerability timers
// elsewhere in this file). The orbit lies in a plane tilted by `inclination`
// off the well's XZ plane around the X axis, so each moon crosses the well's
// own XZ plane (and the ship spawn axis) at exactly two points per orbit.
export function moonPosition(spec, simTime) {
  const angle = spec.phase + (simTime / spec.period) * 2 * Math.PI;
  const xFlat = spec.orbitRadius * Math.cos(angle);
  const zFlat = spec.orbitRadius * Math.sin(angle);
  return {
    x: xFlat,
    y: zFlat * Math.sin(spec.inclination),
    z: zFlat * Math.cos(spec.inclination),
  };
}

// The full "realistic gravity" field at a point: the well's pull plus every
// moon's pull, summed -- real inverse-square superposition, not just a
// single dominant source. Moons themselves are NOT gravitationally
// simulated (they move on fixed rails via moonPosition) -- only ships and
// projectiles feel the combined field.
export function totalGravityAt(pos, simTime) {
  let accel = gravityAcceleration(pos, WELL_POS, G_MU);
  for (const spec of MOON_SPECS) {
    accel = vAdd(accel, gravityAcceleration(pos, moonPosition(spec, simTime), spec.mu));
  }
  return accel;
}

// One semi-implicit Euler step for a ship: gravity (well + moons) + optional
// thrust along the aimed facing + linear drag, then boundary-sphere bounce.
// `simTime` defaults to 0 so every existing direct call in physics.test.js
// (which predates moons) keeps testing exactly what it always tested --
// at simTime=0 both moons sit far enough from every coordinate those tests
// use that their pull is negligible next to the well's, verified by hand
// when MOON_SPECS was chosen. `stats` defaults to DEFAULT_SHIP_STATS for the
// same reason: every pre-loadout call site (including every existing test)
// keeps getting exactly today's SHIP_THRUST_ACCEL/SHIP_MAX_SPEED behavior
// unless a caller explicitly passes a ship's own resolved stats.
export function integrateShip(ship, dt, input, simTime = 0, stats = DEFAULT_SHIP_STATS) {
  const facing = facingFromYawPitch(input.aimYaw, input.aimPitch);
  const gravity = totalGravityAt(ship.pos, simTime);
  const thrust = input.thrusting ? vScale(facing, stats.thrustAccel) : { x: 0, y: 0, z: 0 };
  const drag = vScale(ship.vel, -SHIP_DRAG);
  const accel = vAdd(vAdd(gravity, thrust), drag);

  let newVel = clampSpeed(vAdd(ship.vel, vScale(accel, dt)), stats.maxSpeed);
  let newPos = vAdd(ship.pos, vScale(newVel, dt));

  const dist = vLen(newPos);
  if (dist > ARENA_RADIUS) {
    const normal = vNormalize(newPos);
    newPos = vScale(normal, ARENA_RADIUS);
    const vDotN = vDot(newVel, normal);
    newVel = vSub(newVel, vScale(normal, (1 + BOUNDARY_RESTITUTION) * vDotN));
  }

  return { pos: newPos, vel: newVel, yaw: input.aimYaw, pitch: input.aimPitch };
}

// One semi-implicit Euler step for a projectile: gravity (well + moons)
// only, no thrust, no boundary bounce (projectiles despawn on exiting the
// arena instead). See integrateShip for why simTime/maxSpeed default the way
// they do -- a projectile's max speed comes from whoever fired it (see
// launchProjectile), not necessarily PROJECTILE_MAX_SPEED, so it has to be
// threaded through per-projectile rather than read from the ship each tick
// (the owner might respawn with different stats, or disconnect, before an
// already-in-flight shot resolves).
export function integrateProjectile(proj, dt, simTime = 0, maxSpeed = PROJECTILE_MAX_SPEED) {
  const gravity = totalGravityAt(proj.pos, simTime);
  const newVel = clampSpeed(vAdd(proj.vel, vScale(gravity, dt)), maxSpeed);
  const newPos = vAdd(proj.pos, vScale(newVel, dt));
  return { pos: newPos, vel: newVel };
}

// A freshly-fired projectile inherits the ship's own velocity plus muzzle
// speed along its facing — a fast-moving ship's shots are correspondingly
// faster, not a fixed speed regardless of the ship's own motion.
export function launchProjectile(ship, ownerId, id, stats = DEFAULT_SHIP_STATS) {
  const facing = facingFromYawPitch(ship.yaw, ship.pitch);
  const vel = clampSpeed(vAdd(ship.vel, vScale(facing, stats.projectileLaunchSpeed)), stats.projectileMaxSpeed);
  return { id, ownerId, pos: { ...ship.pos }, vel };
}

// Swept sphere-vs-sphere collision test over one tick's motion, using the
// closed-form closest-approach-of-two-segments solution. A plain endpoint
// distance check misses fast-moving objects that pass through each other
// within a single tick ("tunneling") — this is the one collision primitive
// used uniformly for every pair (ship-projectile, ship-well, projectile-well).
export function sweptSphereHit(posA0, posA1, radiusA, posB0, posB1, radiusB) {
  const d0 = vSub(posA0, posB0);
  const dv = vSub(vSub(posA1, posA0), vSub(posB1, posB0));
  const dvLenSq = vDot(dv, dv);
  const combined = radiusA + radiusB;

  let t = 0;
  if (dvLenSq > 1e-9) {
    t = Math.max(0, Math.min(1, -vDot(d0, dv) / dvLenSq));
  }
  const closest = vAdd(d0, vScale(dv, t));
  return vLen(closest) <= combined;
}
