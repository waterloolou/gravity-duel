import assert from "node:assert/strict";
import * as P from "./physics.js";
import * as Loadouts from "./loadouts.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("the default ship+weapon resolve to exactly physics.js's DEFAULT_SHIP_STATS", () => {
  const stats = Loadouts.resolveShipStats(Loadouts.DEFAULT_SHIP_ID, Loadouts.DEFAULT_WEAPON_ID);
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

check("an unknown ship or weapon id falls back to the free starter instead of throwing", () => {
  const stats = Loadouts.resolveShipStats("not-a-real-ship", "not-a-real-weapon");
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

check("missing/undefined ids also fall back to the free starter", () => {
  const stats = Loadouts.resolveShipStats(undefined, undefined);
  assert.deepEqual(stats, P.DEFAULT_SHIP_STATS);
});

console.log(`\n${passed} loadouts.js assertions passed`);
