// Pointer-lock mouse-look input (yaw/pitch, no roll) + W-thrust + click-fire,
// plus a touch equivalent (drag-to-aim + on-screen thrust/fire/camera
// buttons, see main.js's touch control overlay) for phones. `applyMouseDelta`
// is kept as a small pure function (no DOM) so it's unit-testable on its
// own, same discipline as physics.js -- touch dragging reuses this exact
// function rather than duplicating the yaw/pitch math.

export const MAX_PITCH = 1.4835; // ~85 degrees, avoids the FPS-camera gimbal issue at the poles
export const MOUSE_SENSITIVITY = 0.0025;
// Higher than mouse sensitivity: pointer-lock mouse movement is effectively
// unbounded (the OS cursor never runs out of room), but a touch drag is
// bounded by the physical screen, so each pixel needs to carry more turn to
// keep a comfortable full-range swipe within thumb's reach.
export const TOUCH_SENSITIVITY = 0.006;

export function applyMouseDelta(state, dx, dy, sensitivity = MOUSE_SENSITIVITY, maxPitch = MAX_PITCH) {
  return {
    yaw: state.yaw - dx * sensitivity,
    pitch: Math.max(-maxPitch, Math.min(maxPitch, state.pitch - dy * sensitivity)),
  };
}

// `options.sensitivityMultiplier` scales MOUSE_SENSITIVITY (Settings'
// sensitivity slider) -- TOUCH_SENSITIVITY is deliberately left alone, a
// touch drag's comfortable range is a screen-size thing, not a player
// preference the way mouse feel is. `options.thrustKey`/`cameraToggleKey`
// let Settings' key rebinding swap which physical key does what, defaulting
// to the original W/C so every existing call site (and every earlier
// Playwright verification pass) keeps working unchanged.
export function createInputController(canvas, options = {}) {
  // Mutable (not just read once at construction) so Settings' sliders/key
  // rebinding can take effect immediately even if a match is already in
  // progress in this tab, rather than requiring a fresh page load --
  // main.js calls the setters below whenever a setting actually changes.
  let sensitivityMultiplier = options.sensitivityMultiplier ?? 1;
  let thrustKey = options.thrustKey ?? "KeyW";
  let cameraToggleKey = options.cameraToggleKey ?? "KeyC";

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
    const next = applyMouseDelta({ yaw: aimYaw, pitch: aimPitch }, e.movementX, e.movementY, MOUSE_SENSITIVITY * sensitivityMultiplier);
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
    if (e.code === thrustKey) thrusting = true;
    // e.repeat guards against the OS's held-key auto-repeat re-firing this
    // every ~30ms -- without it, holding C would flicker between camera
    // modes many times per second instead of toggling once per press.
    if (e.code === cameraToggleKey && !e.repeat) thirdPerson = !thirdPerson;
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === thrustKey) thrusting = false;
  });

  // Touch: dragging anywhere on the canvas aims (same yaw/pitch model as
  // mouse-look, fed touch-move deltas instead of pointer-lock movementX/Y --
  // touch events don't provide a delta natively, so the previous point is
  // tracked by hand). Thrust/fire/camera come from the dedicated on-screen
  // buttons in main.js's touch overlay via setThrusting/setFiring/
  // toggleCamera below, not from this drag -- dragging is aim-only, so a
  // second finger can hold a button while the first keeps aiming.
  let aimTouchId = null;
  let lastTouchX = 0;
  let lastTouchY = 0;

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (aimTouchId !== null) return; // already tracking a drag -- ignore extra touches (they're for the buttons)
      const touch = e.changedTouches[0];
      aimTouchId = touch.identifier;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      e.preventDefault(); // suppresses the synthetic mousedown/click a touch would otherwise also fire
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier !== aimTouchId) continue;
        const dx = touch.clientX - lastTouchX;
        const dy = touch.clientY - lastTouchY;
        lastTouchX = touch.clientX;
        lastTouchY = touch.clientY;
        const next = applyMouseDelta({ yaw: aimYaw, pitch: aimPitch }, dx, dy, TOUCH_SENSITIVITY);
        aimYaw = next.yaw;
        aimPitch = next.pitch;
      }
      e.preventDefault();
    },
    { passive: false }
  );

  function releaseAimTouch(e) {
    for (const touch of e.changedTouches) {
      if (touch.identifier === aimTouchId) aimTouchId = null;
    }
  }
  canvas.addEventListener("touchend", releaseAimTouch);
  canvas.addEventListener("touchcancel", releaseAimTouch);

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

  // Real (not test-only) input sources, used by main.js's touch button
  // overlay -- a held-down THRUST/FIRE button behaves exactly like holding
  // W / left-click, and CAM toggles the same thirdPerson flag as the C key.
  function setThrusting(value) {
    thrusting = !!value;
  }
  function setFiring(value) {
    firing = !!value;
  }
  function toggleCamera() {
    thirdPerson = !thirdPerson;
  }

  function setSensitivityMultiplier(value) {
    sensitivityMultiplier = value;
  }
  function setThrustKey(code) {
    thrustKey = code;
  }
  function setCameraToggleKey(code) {
    cameraToggleKey = code;
  }

  return {
    getState,
    setInitialAim,
    setThrusting,
    setFiring,
    toggleCamera,
    setSensitivityMultiplier,
    setThrustKey,
    setCameraToggleKey,
  };
}
