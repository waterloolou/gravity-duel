import assert from "node:assert/strict";
import { applyMouseDelta, MAX_PITCH } from "./input.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("applyMouseDelta moves yaw/pitch proportionally to mouse delta and sensitivity", () => {
  const result = applyMouseDelta({ yaw: 0, pitch: 0 }, 100, -50, 0.01, MAX_PITCH);
  assert.equal(result.yaw, -1); // -dx * sensitivity
  assert.equal(result.pitch, 0.5); // -dy * sensitivity, dy negative -> pitch increases
});

check("applyMouseDelta clamps pitch to +/-maxPitch and never clamps yaw", () => {
  const up = applyMouseDelta({ yaw: 0, pitch: 0 }, 0, -100000, 0.01, MAX_PITCH);
  assert.equal(up.pitch, MAX_PITCH);
  const down = applyMouseDelta({ yaw: 0, pitch: 0 }, 0, 100000, 0.01, MAX_PITCH);
  assert.equal(down.pitch, -MAX_PITCH);
  const spun = applyMouseDelta({ yaw: 0, pitch: 0 }, 100000, 0, 0.01, MAX_PITCH);
  assert.equal(spun.yaw, -1000, "yaw should accumulate freely, never clamped");
});

check("zero delta is a no-op", () => {
  const result = applyMouseDelta({ yaw: 1.23, pitch: 0.45 }, 0, 0);
  assert.equal(result.yaw, 1.23);
  assert.equal(result.pitch, 0.45);
});

console.log(`\n${passed} input.js assertions passed`);
