// Client-side, localStorage-persisted user preferences: master volume/mute,
// mouse sensitivity, a colorblind-safe hull color option, and rebindable
// thrust/camera-toggle keys. Defaults/validation are pure and unit-tested
// below; loadSettings/saveSettings are the one clearly impure part (actual
// localStorage I/O), kept to two small functions, same pure/impure split
// used throughout this codebase (room.js vs. server.js, profile.js vs.
// profile-store.js).

export const DEFAULT_SETTINGS = {
  masterVolume: 0.55, // matches audio.js's own DEFAULT_VOLUME
  muted: false,
  sensitivity: 1, // multiplier on input.js's MOUSE_SENSITIVITY
  colorblindMode: false,
  thrustKey: "KeyW",
  cameraToggleKey: "KeyC",
};

const MIN_SENSITIVITY = 0.25;
const MAX_SENSITIVITY = 3;

export function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_SETTINGS.masterVolume;
}

export function clampSensitivity(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(MIN_SENSITIVITY, Math.min(MAX_SENSITIVITY, n)) : DEFAULT_SETTINGS.sensitivity;
}

// Merges a partial/legacy/corrupt stored object over the defaults field by
// field -- never trusts the stored shape wholesale. A settings field added
// after some players already have a saved blob must come back as ITS
// default (not undefined), and a stray/malformed stored value (a future
// format change, manual localStorage tampering) must fall back cleanly
// rather than propagate NaN/garbage into audio.js/input.js/render.js.
export function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    masterVolume: clampVolume(r.masterVolume ?? DEFAULT_SETTINGS.masterVolume),
    muted: !!r.muted,
    sensitivity: clampSensitivity(r.sensitivity ?? DEFAULT_SETTINGS.sensitivity),
    colorblindMode: !!r.colorblindMode,
    thrustKey: typeof r.thrustKey === "string" && r.thrustKey ? r.thrustKey : DEFAULT_SETTINGS.thrustKey,
    cameraToggleKey: typeof r.cameraToggleKey === "string" && r.cameraToggleKey ? r.cameraToggleKey : DEFAULT_SETTINGS.cameraToggleKey,
  };
}

const STORAGE_KEY = "gravityDuel.settings";

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return normalizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
}
