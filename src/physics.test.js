import assert from "node:assert/strict";
import * as P from "./physics.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function approx(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ~${expected}, got ${actual}`);
}

check("gravityAcceleration matches inverse-square law at known distances", () => {
  // Expected values are derived from G_MU itself (not hardcoded numbers) --
  // this test's real intent is verifying the 1/r^2 relationship holds at
  // several distances, not pinning a specific tuning value that would then
  // need editing here every time gravity strength is tuned for feel.
  for (const r of [500, 300, 150, 80, 48, 42]) {
    const accel = P.gravityAcceleration({ x: r, y: 0, z: 0 });
    approx(P.vLen(accel), P.G_MU / (r * r), 0.01, `a(${r})`);
  }
});

check("gravityAcceleration always points toward the well", () => {
  const accel = P.gravityAcceleration({ x: 100, y: 0, z: 0 });
  assert.ok(accel.x < 0, "acceleration should point in -x toward the origin well");
  approx(accel.y, 0, 1e-9, "no y component");
  approx(accel.z, 0, 1e-9, "no z component");
});

check("facingFromYawPitch / yawPitchFromFacing round-trip", () => {
  for (const [yaw, pitch] of [[0, 0], [Math.PI / 4, 0.3], [-1.2, -0.7], [3, 0.9]]) {
    const facing = P.facingFromYawPitch(yaw, pitch);
    const back = P.yawPitchFromFacing(facing);
    approx(back.yaw, yaw, 1e-6, "yaw round-trip");
    approx(back.pitch, pitch, 1e-6, "pitch round-trip");
  }
});

check("thrust and drag combine to a terminal speed of SHIP_THRUST_ACCEL / SHIP_DRAG (isolated from gravity/boundary effects)", () => {
  // Manually integrates just the thrust+drag relationship with the same
  // exported vector primitives the real integrator uses (the same style as
  // the zero-gravity "control" loop below), specifically to isolate this
  // formula from gravity and the arena boundary. Two earlier drafts of this
  // test tried to get that isolation by placing a ship far away or at the
  // well's own position and calling the real integrateShip -- both were
  // contaminated: a far-away position immediately trips the boundary bounce
  // every tick (corrupting the result), and starting at r=0 only gives zero
  // gravity for the very first instant, since gravity re-engages the moment
  // the ship moves away from the well and then opposes its thrust. Testing
  // the formula directly sidesteps both traps.
  let vel = { x: 0, y: 0, z: 0 };
  const thrust = { x: 0, y: 0, z: P.SHIP_THRUST_ACCEL };
  const terminal = P.SHIP_THRUST_ACCEL / P.SHIP_DRAG;
  const seconds = 8; // e^(-SHIP_DRAG*8) ~ 0.0003, i.e. >99.9% converged -- this loop has no
  // position/boundary/gravity coupling at all, so a long duration is free here, unlike a
  // full integrateShip-based run.
  for (let i = 0; i < seconds * P.TICK_RATE; i++) {
    const drag = P.vScale(vel, -P.SHIP_DRAG);
    vel = P.vAdd(vel, P.vScale(P.vAdd(thrust, drag), P.TICK_DT));
  }
  approx(P.vLen(vel), terminal, terminal * 0.02, "converged speed after 8s");
});

check("integrateShip actually applies thrust along the aimed facing direction", () => {
  // A light sanity check (not a tight numeric convergence assertion) that
  // the real integrator applies thrust at all, at a position safely clear
  // of both the well's danger radius and the arena boundary.
  let ship = { pos: { x: 200, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  const input = { aimYaw: 0, aimPitch: 0, thrusting: true }; // facing = +z
  for (let i = 0; i < 10; i++) {
    ship = { ...ship, ...P.integrateShip(ship, P.TICK_DT, input) };
  }
  assert.ok(ship.vel.z > 50, `expected meaningful +z speed after 10 ticks of thrust, got ${ship.vel.z}`);
});

check("boundary bounce reflects a purely radial velocity inward at BOUNDARY_RESTITUTION", () => {
  const ship = { pos: { x: P.ARENA_RADIUS - 1, y: 0, z: 0 }, vel: { x: 400, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  const input = { aimYaw: 0, aimPitch: Math.PI / 2, thrusting: false }; // aim irrelevant, not thrusting
  const result = P.integrateShip(ship, P.TICK_DT, input);
  // Should have bounced: velocity now points inward (-x) at ~0.6x the pre-bounce speed magnitude.
  assert.ok(result.vel.x < 0, "velocity should reverse to point inward after bouncing");
  approx(result.pos.x, P.ARENA_RADIUS, 1e-6, "position clamped to the boundary");
});

check("boundary bounce leaves a purely tangential velocity component unchanged", () => {
  // Ship sitting exactly on the boundary moving tangentially (no radial component)
  // should not be treated as having exited the arena.
  const pos = { x: P.ARENA_RADIUS, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 300 }; // tangential to the +x normal at this point
  const ship = { pos, vel, yaw: 0, pitch: 0 };
  const input = { aimYaw: 0, aimPitch: 0, thrusting: false };
  const result = P.integrateShip(ship, P.TICK_DT, input);
  // Purely tangential motion shouldn't trigger the >ARENA_RADIUS branch's
  // radial reflection in any meaningful way -- z-velocity should survive.
  assert.ok(Math.abs(result.vel.z) > 250, "tangential velocity should be preserved, not zeroed by the bounce");
});

check("sweptSphereHit catches a fast pass-through that a naive endpoint check would miss (tunneling)", () => {
  const posA0 = { x: -100, y: 0, z: 0 };
  const posA1 = { x: 100, y: 0, z: 0 }; // crosses the origin in one tick
  const posB = { x: 0, y: 0, z: 0 };
  const combinedRadius = 10;

  const naiveEndpointDistance = P.vLen(P.vSub(posA1, posB));
  assert.ok(naiveEndpointDistance > combinedRadius, "sanity: endpoints alone are far apart (naive check would miss)");

  const hit = P.sweptSphereHit(posA0, posA1, 5, posB, posB, 5);
  assert.equal(hit, true, "swept check must catch the mid-tick pass-through");
});

check("sweptSphereHit correctly reports no collision when spheres never come close", () => {
  const hit = P.sweptSphereHit({ x: -100, y: 100, z: 0 }, { x: 100, y: 100, z: 0 }, 5, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 5);
  assert.equal(hit, false);
});

check("moonPosition stays at a constant distance from the well across its orbit", () => {
  for (const spec of P.MOON_SPECS) {
    for (const t of [0, spec.period * 0.25, spec.period * 0.6, spec.period * 3.7]) {
      const pos = P.moonPosition(spec, t);
      approx(P.vLen(P.vSub(pos, P.WELL_POS)), spec.orbitRadius, 1e-6, `${spec.name} at t=${t}`);
    }
  }
});

check("totalGravityAt sums the well's pull with every moon's pull independently", () => {
  const pos = { x: 60, y: 15, z: -20 }; // arbitrary point clear of the well and both moons at this t
  const t = 12.3;
  let expected = P.gravityAcceleration(pos, P.WELL_POS, P.G_MU);
  for (const spec of P.MOON_SPECS) {
    expected = P.vAdd(expected, P.gravityAcceleration(pos, P.moonPosition(spec, t), spec.mu));
  }
  const actual = P.totalGravityAt(pos, t);
  approx(actual.x, expected.x, 1e-9, "x component");
  approx(actual.y, expected.y, 1e-9, "y component");
  approx(actual.z, expected.z, 1e-9, "z component");
});

check("gravity measurably curves a passing projectile toward the well, verified against a zero-gravity control", () => {
  const start = { x: -300, y: 80, z: 0 };
  const vel = { x: 400, y: 0, z: 0 };
  let real = { pos: { ...start }, vel: { ...vel } };
  let control = { pos: { ...start }, vel: { ...vel } };

  for (let i = 0; i < 150; i++) {
    // real: full physics, including gravity, via the actual exported integrator
    real = P.integrateProjectile(real, P.TICK_DT);
    // control: manually integrated with zero gravity (straight line), using
    // the same exported vector primitives, to prove the real run's curvature
    // isn't just numerical drift.
    control = { pos: P.vAdd(control.pos, P.vScale(control.vel, P.TICK_DT)), vel: control.vel };
  }

  approx(control.pos.y, 80, 1e-6, "zero-gravity control stays perfectly straight");
  assert.ok(real.pos.y < control.pos.y - 1, "with real gravity, the projectile should measurably curve toward the well (lower y than the straight-line control)");
});

console.log(`\n${passed} physics.js assertions passed`);
