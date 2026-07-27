import assert from "node:assert/strict";
import * as Settings from "./settings.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("clampVolume clamps into [0,1] and falls back to the default for garbage input", () => {
  assert.equal(Settings.clampVolume(0.5), 0.5);
  assert.equal(Settings.clampVolume(-1), 0);
  assert.equal(Settings.clampVolume(2), 1);
  assert.equal(Settings.clampVolume("not a number"), Settings.DEFAULT_SETTINGS.masterVolume);
  assert.equal(Settings.clampVolume(NaN), Settings.DEFAULT_SETTINGS.masterVolume);
});

check("clampSensitivity clamps into its own range and falls back for garbage input", () => {
  assert.equal(Settings.clampSensitivity(1), 1);
  assert.equal(Settings.clampSensitivity(0), 0.25);
  assert.equal(Settings.clampSensitivity(10), 3);
  assert.equal(Settings.clampSensitivity(undefined), Settings.DEFAULT_SETTINGS.sensitivity);
});

check("normalizeSettings fills in every field's default for a completely empty/missing object", () => {
  assert.deepEqual(Settings.normalizeSettings(null), Settings.DEFAULT_SETTINGS);
  assert.deepEqual(Settings.normalizeSettings(undefined), Settings.DEFAULT_SETTINGS);
  assert.deepEqual(Settings.normalizeSettings({}), Settings.DEFAULT_SETTINGS);
});

check("normalizeSettings preserves valid fields from a partial object, defaulting the rest", () => {
  const result = Settings.normalizeSettings({ masterVolume: 0.2, colorblindMode: true });
  assert.equal(result.masterVolume, 0.2);
  assert.equal(result.colorblindMode, true);
  assert.equal(result.sensitivity, Settings.DEFAULT_SETTINGS.sensitivity);
  assert.equal(result.thrustKey, Settings.DEFAULT_SETTINGS.thrustKey);
});

check("normalizeSettings tolerates a stored blob from a future/unrelated format (garbage-in, defaults-out)", () => {
  const result = Settings.normalizeSettings({ masterVolume: "loud", thrustKey: 123, unrelatedJunk: true });
  assert.equal(result.masterVolume, Settings.DEFAULT_SETTINGS.masterVolume);
  assert.equal(result.thrustKey, Settings.DEFAULT_SETTINGS.thrustKey);
  assert.equal(result.unrelatedJunk, undefined, "unknown fields should not leak through");
});

check("normalizeSettings preserves a valid custom key binding", () => {
  const result = Settings.normalizeSettings({ thrustKey: "Space", cameraToggleKey: "KeyV" });
  assert.equal(result.thrustKey, "Space");
  assert.equal(result.cameraToggleKey, "KeyV");
});

console.log(`\n${passed} settings.js assertions passed`);
