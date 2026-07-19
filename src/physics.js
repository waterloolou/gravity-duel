// Pure physics engine for Gravity Duel. No I/O, no Node/browser APIs — a
// deterministic function of (state, inputs, dt) so it's identically testable
// here and runnable unmodified inside the server's tick loop.

export const ARENA_RADIUS = 500;
export const WELL_POS = { x: 0, y: 0, z: 0 };
export const WELL_RADIUS = 40;
export const G_MU = 1_000_000; // gravitational parameter (G*M), tuned for feel not realism

export const SHIP_RADIUS = 8;
export const SHIP_THRUST_ACCEL = 300;
export const SHIP_DRAG = 1.0; // dv/dt includes -SHIP_DRAG * v; terminal speed = SHIP_THRUST_ACCEL / SHIP_DRAG
export const SHIP_MAX_SPEED = 700;
export const BOUNDARY_RESTITUTION = 0.6;

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

// Two moons on fixed circular orbits around the well, each an additional
// gravity source (and collision hazard) -- not just decoration. Orbits are
// kinematic (a pure function of simTime), not mutually N-body-simulated:
// real enough to matter tactically (slingshot around a moon, or get pulled
// off course by one) without the instability of actually integrating
// multiple massive bodies against each other. orbitRadius is deliberately
// kept clear of SPAWN_RADIUS (350) by a comfortable margin on both sides --
// a moon's orbit crosses the well-ship axis exactly twice per revolution
// (at inclination-tilt angle 0 and pi), and if that crossing point ever
// landed close to 350, a freshly (re)spawned ship could momentarily overlap
// a moon.
export const MOON_SPECS = [
  { name: "moonA", orbitRadius: 190, period: 34, radius: 16, mu: 160_000, phase: Math.PI / 2, inclination: 0.32 },
  { name: "moonB", orbitRadius: 300, period: 68, radius: 24, mu: 300_000, phase: Math.PI * 1.35, inclination: -0.46 },
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
// when MOON_SPECS was chosen.
export function integrateShip(ship, dt, input, simTime = 0) {
  const facing = facingFromYawPitch(input.aimYaw, input.aimPitch);
  const gravity = totalGravityAt(ship.pos, simTime);
  const thrust = input.thrusting ? vScale(facing, SHIP_THRUST_ACCEL) : { x: 0, y: 0, z: 0 };
  const drag = vScale(ship.vel, -SHIP_DRAG);
  const accel = vAdd(vAdd(gravity, thrust), drag);

  let newVel = clampSpeed(vAdd(ship.vel, vScale(accel, dt)), SHIP_MAX_SPEED);
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
// arena instead). See integrateShip for why simTime defaults to 0.
export function integrateProjectile(proj, dt, simTime = 0) {
  const gravity = totalGravityAt(proj.pos, simTime);
  const newVel = clampSpeed(vAdd(proj.vel, vScale(gravity, dt)), PROJECTILE_MAX_SPEED);
  const newPos = vAdd(proj.pos, vScale(newVel, dt));
  return { pos: newPos, vel: newVel };
}

// A freshly-fired projectile inherits the ship's own velocity plus muzzle
// speed along its facing — a fast-moving ship's shots are correspondingly
// faster, not a fixed speed regardless of the ship's own motion.
export function launchProjectile(ship, ownerId, id) {
  const facing = facingFromYawPitch(ship.yaw, ship.pitch);
  const vel = clampSpeed(vAdd(ship.vel, vScale(facing, PROJECTILE_LAUNCH_SPEED)), PROJECTILE_MAX_SPEED);
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
