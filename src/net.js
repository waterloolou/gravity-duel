// Thin WebSocket client wrapper: a tiny pub/sub over incoming message types,
// plus a snapshot ring buffer for interpolated rendering. Deliberately NOT
// client-side prediction -- every entity (including the local player's own
// ship) is rendered from server snapshots, never locally simulated ahead.

import { MSG } from "../protocol.js";

const SNAPSHOT_BUFFER_SIZE = 12;
export const INTERPOLATION_DELAY_MS = 100;
// A separate, much longer-lived buffer of raw (un-interpolated) snapshots,
// purely for the killcam replay (main.js) -- SNAPSHOT_BUFFER_SIZE above only
// holds ~0.4s at 30Hz, enough for live interpolation but nowhere near the
// ~2s look-back a death replay needs. Time-based trimming (not a fixed
// count) so a tick-rate hiccup can't leave the buffer covering less than
// this window.
const KILLCAM_HISTORY_MS = 3000;

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
      engineColor: sb.engineColor, // cosmetic, fixed for a ship's whole lifetime -- snaps like invulnerable/thrusting, no reason to interpolate a color
      speedBoosted: sb.speedBoosted,
    };
  }
  // Projectiles are numerous and transient; rendering the latest snapshot's
  // raw positions (no interpolation) is a reasonable simplification at 30Hz
  // on localhost -- revisit only if this is ever deployed over real internet.
  // Pickups are fixed-position and only ever toggle active/inactive on a
  // multi-second cooldown -- snapping to `b`'s array wholesale is exactly
  // right, there's nothing meaningful to interpolate between two ticks.
  // Debris, like projectiles, is transient and moves under the same
  // gravity -- raw positions from `b`, no interpolation, same reasoning.
  return { tick: b.tick, playerIds: b.playerIds, ships, projectiles: b.projectiles, pickups: b.pickups, debris: b.debris, winner: b.winner };
}

// `url` is a WebSocket URL (dedicated server) or a function returning a
// WebSocket-shaped object (the peer-to-peer transport in p2p.js).
export function createNetClient(url) {
  const listeners = new Map();
  const snapshots = [];
  const killcamHistory = []; // { t, state }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  }
  function emit(type, payload) {
    for (const fn of listeners.get(type) ?? []) fn(payload);
  }

  let ws = null;

  function connect() {
    ws = typeof url === "function" ? url() : new WebSocket(url);
    ws.addEventListener("open", () => emit("_open", {}));
    ws.addEventListener("close", () => emit("_close", {}));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === MSG.MATCH_STATE) {
        const t = performance.now();
        snapshots.push({ t, state: msg });
        if (snapshots.length > SNAPSHOT_BUFFER_SIZE) snapshots.shift();

        killcamHistory.push({ t, state: msg });
        const cutoff = t - KILLCAM_HISTORY_MS;
        while (killcamHistory.length > 0 && killcamHistory[0].t < cutoff) killcamHistory.shift();
      }
      emit(msg.type, msg);
    });
    return ws;
  }

  function send(type, payload = {}) {
    if (ws && ws.readyState === 1 /* WebSocket.OPEN */) ws.send(JSON.stringify({ type, ...payload }));
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

  // Every buffered raw snapshot from the last `durationMs`, oldest first --
  // called right when a death event arrives (see main.js), so `beforeMs`
  // defaults to "now" and this naturally captures the run-up to that exact
  // moment. Deliberately returns the raw (un-interpolated) states rather
  // than reusing interpolateState -- at 30Hz, stepping frame-to-frame
  // through a ~2s replay is already smooth enough that the added complexity
  // of interpolating a REPLAY (as opposed to live render timing, which
  // genuinely needs it to hide network jitter) isn't worth it.
  function getKillcamClip(durationMs, beforeMs = performance.now()) {
    const cutoff = beforeMs - durationMs;
    return killcamHistory.filter((entry) => entry.t >= cutoff && entry.t <= beforeMs).map((entry) => entry.state);
  }

  return { connect, send, on, sampleAt, latest, clearSnapshots, getKillcamClip };
}
