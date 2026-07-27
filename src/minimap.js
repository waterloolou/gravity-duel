// Draws a small top-down radar onto a 2D canvas -- ships, pickups, moons,
// and the well, all projected onto the X/Z plane (Y, the vertical axis in
// physics.js's yaw/pitch convention, is deliberately ignored -- a radar is
// a 2D reading of a 3D fight, not a second 3D view) and scaled down from
// world units to the canvas's own radius. Pure rendering only, no state of
// its own -- main.js calls draw() every frame with the current snapshot.

import * as P from "./physics.js";

const SHIP_DOT_RADIUS = 3;
const WELL_DOT_RADIUS = 4;
const MOON_DOT_RADIUS = 2.5;
const PICKUP_DOT_RADIUS = 2;
const OWN_COLOR = "#5be8ff";
const ENEMY_COLOR = "#ff3d5a";
const MOON_COLOR = "#9c9aa8";
const WELL_COLOR = "#ffb454";
// Mirrors render.js's own PICKUP_COLORS -- kept as a separate small copy
// rather than imported, same reasoning as main.js's own PICKUP_EVENT_COLORS:
// render.js doesn't export its internal palette, and this is the only
// piece of it the minimap needs.
const PICKUP_COLORS = { speed: "#ffe066", shield: "#4fd1ff", vent: "#ff7a3d" };

export function createMinimap(canvas) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width; // a square canvas is assumed throughout
  const center = size / 2;
  const scale = (center - 6) / P.ARENA_RADIUS; // 6px margin so an edge-hugging dot never clips the rim

  function project(pos) {
    return { x: center + pos[0] * scale, y: center + pos[2] * scale };
  }

  function dot(pos, radius, color) {
    const p = project(pos);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // `snap` is the same interpolated MATCH_STATE shape the main render loop
  // already consumes -- `selfId` is whichever ship should render in the
  // "own" color (the real self, or the spectator/killcam-tracked ship,
  // same renderId concept main.js already computes for the 3D view).
  function draw(snap, selfId) {
    ctx.clearRect(0, 0, size, size);
    if (!snap) return;

    ctx.beginPath();
    ctx.arc(center, center, center - 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(91, 232, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    dot([0, 0, 0], WELL_DOT_RADIUS, WELL_COLOR);

    const simTime = (snap.tick ?? 0) * P.TICK_DT;
    for (const spec of P.MOON_SPECS) {
      const pos = P.moonPosition(spec, simTime);
      dot([pos.x, pos.y, pos.z], MOON_DOT_RADIUS, MOON_COLOR);
    }

    for (const p of snap.pickups ?? []) {
      if (!p.active) continue; // a pickup on cooldown isn't there to route toward
      dot(p.pos, PICKUP_DOT_RADIUS, PICKUP_COLORS[p.type] ?? "#ffffff");
    }

    for (const [id, ship] of Object.entries(snap.ships ?? {})) {
      dot(ship.pos, SHIP_DOT_RADIUS, id === selfId ? OWN_COLOR : ENEMY_COLOR);
    }
  }

  return { draw };
}
