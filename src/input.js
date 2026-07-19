// Pointer-lock mouse-look input (yaw/pitch, no roll) + W-thrust + click-fire.
// `applyMouseDelta` is kept as a small pure function (no DOM) so it's
// unit-testable on its own, same discipline as physics.js.

export const MAX_PITCH = 1.4835; // ~85 degrees, avoids the FPS-camera gimbal issue at the poles
export const MOUSE_SENSITIVITY = 0.0025;

export function applyMouseDelta(state, dx, dy, sensitivity = MOUSE_SENSITIVITY, maxPitch = MAX_PITCH) {
  return {
    yaw: state.yaw - dx * sensitivity,
    pitch: Math.max(-maxPitch, Math.min(maxPitch, state.pitch - dy * sensitivity)),
  };
}

export function createInputController(canvas) {
  let aimYaw = 0;
  let aimPitch = 0;
  let thrusting = false;
  let firing = false;
  let thirdPerson = false;

  canvas.addEventListener("click", () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });

  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    const next = applyMouseDelta({ yaw: aimYaw, pitch: aimPitch }, e.movementX, e.movementY);
    aimYaw = next.yaw;
    aimPitch = next.pitch;
  });

  document.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement !== canvas || e.button !== 0) return;
    firing = true;
  });
  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    firing = false;
  });

  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyW") thrusting = true;
    // e.repeat guards against the OS's held-key auto-repeat re-firing this
    // every ~30ms -- without it, holding C would flicker between camera
    // modes many times per second instead of toggling once per press.
    if (e.code === "KeyC" && !e.repeat) thirdPerson = !thirdPerson;
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "KeyW") thrusting = false;
  });

  // Test-only escape hatch: Playwright drives this directly via page.evaluate(),
  // bypassing native pointer-lock/mouse-event simulation entirely (a known
  // source of flakiness for headless browser automation). applyMouseDelta's
  // correctness is already covered by its own unit test, so nothing here
  // duplicates that coverage -- this just lets end-to-end tests drive real
  // server/network/render convergence without fighting input simulation.
  window.__testHooks = {
    setAim(yaw, pitch) {
      aimYaw = yaw;
      aimPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    },
    setInput({ thrusting: t, firing: f }) {
      if (t !== undefined) thrusting = t;
      if (f !== undefined) firing = f;
    },
    setCameraMode(isThirdPerson) {
      thirdPerson = !!isThirdPerson;
    },
  };

  function getState() {
    return { aimYaw, aimPitch, thrusting, firing, thirdPerson };
  }

  function setInitialAim(yaw, pitch) {
    aimYaw = yaw;
    aimPitch = pitch;
  }

  return { getState, setInitialAim };
}
