// Thin WebSocket client wrapper: a tiny pub/sub over incoming message types,
// plus a snapshot ring buffer for interpolated rendering. Deliberately NOT
// client-side prediction -- every entity (including the local player's own
// ship) is rendered from server snapshots, never locally simulated ahead.

import { MSG } from "../protocol.js";

const SNAPSHOT_BUFFER_SIZE = 12;
export const INTERPOLATION_DELAY_MS = 100;

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
// Shortest-path angle interpolation, wrap-safe at +/-PI -- correct for our
// restricted yaw/pitch (no roll) orientation model without needing full
// quaternion slerp, which would only matter if roll were also in play.
function lerpAngle(a, b, t) {
  let delta = (b - a) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * t;
}

function interpolateState(a, b, t) {
  const ships = {};
  // Iterate `b` (the newer/target snapshot)'s roster, not `a`'s -- a player
  // can disconnect mid-match now (free-for-all continues without them), and
  // building this map from the OLDER snapshot's keys would keep a departed
  // player's ship rendering forever (frozen at its last known position,
  // never dropped) since it'd never stop appearing in that key set.
  for (const id of Object.keys(b.ships)) {
    const sb = b.ships[id];
    const sa = a.ships[id] ?? sb; // a ship with no prior snapshot (just spawned) has nothing to interpolate from
    ships[id] = {
      pos: lerp3(sa.pos, sb.pos, t),
      vel: lerp3(sa.vel, sb.vel, t),
      yaw: lerpAngle(sa.yaw, sb.yaw, t),
      pitch: lerp(sa.pitch, sb.pitch, t),
      kills: sb.kills, // scores snap immediately, never interpolate
      invulnerable: sb.invulnerable,
      thrusting: sb.thrusting,
      heat: lerp(sa.heat, sb.heat, t), // smoothed, so the HUD gauge doesn't visibly step at 30Hz
      overheated: sb.overheated,
    };
  }
  // Projectiles are numerous and transient; rendering the latest snapshot's
  // raw positions (no interpolation) is a reasonable simplification at 30Hz
  // on localhost -- revisit only if this is ever deployed over real internet.
  return { tick: b.tick, playerIds: b.playerIds, ships, projectiles: b.projectiles, winner: b.winner };
}

export function createNetClient(url) {
  const listeners = new Map();
  const snapshots = [];

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  }
  function emit(type, payload) {
    for (const fn of listeners.get(type) ?? []) fn(payload);
  }

  let ws = null;

  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => emit("_open", {}));
    ws.addEventListener("close", () => emit("_close", {}));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === MSG.MATCH_STATE) {
        snapshots.push({ t: performance.now(), state: msg });
        if (snapshots.length > SNAPSHOT_BUFFER_SIZE) snapshots.shift();
      }
      emit(msg.type, msg);
    });
    return ws;
  }

  function send(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  }

  // Finds the two buffered snapshots bracketing `renderTime` and returns a
  // linearly-interpolated state between them. If renderTime is newer than
  // everything buffered (a delayed/dropped packet), just holds the latest
  // snapshot rather than extrapolating -- fine for near-zero-loss localhost,
  // revisit only for a real-internet deployment phase.
  function sampleAt(renderTime) {
    if (snapshots.length === 0) return null;
    if (snapshots.length === 1) return snapshots[0].state;

    let i = snapshots.length - 1;
    while (i > 0 && snapshots[i].t > renderTime) i--;
    const a = snapshots[i];
    const b = snapshots[Math.min(i + 1, snapshots.length - 1)];
    if (a === b) return a.state;

    const span = b.t - a.t;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.t) / span)) : 1;
    return interpolateState(a.state, b.state, t);
  }

  function latest() {
    return snapshots.length ? snapshots[snapshots.length - 1].state : null;
  }

  function clearSnapshots() {
    snapshots.length = 0;
  }

  return { connect, send, on, sampleAt, latest, clearSnapshots };
}
