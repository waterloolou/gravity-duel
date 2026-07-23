// Pure AI for a practice-mode opponent. Deliberately simple -- this is a
// warm body to practice against and to unblock a solo player (Quick Play
// needs MIN_PLAYERS_TO_START real people otherwise), not a tuned esports
// opponent: it aims roughly at its target, steers away from the well once
// it gets dangerously close, and fires once roughly on-target. No I/O, no
// randomness -- a deterministic function of (ships, botId, now), same
// testing discipline as match.js/physics.js.

import * as P from "./physics.js";

const AIM_FIRE_THRESHOLD = 0.15; // radians of angular error still counted as "aimed"
// Starts steering away from the well before actually getting close enough
// to die -- a pure aim-at-target bot would happily fly itself straight
// into the well chasing someone on the far side of it.
const WELL_SAFETY_MARGIN = P.WELL_RADIUS + P.SHIP_RADIUS + 40;

// Nearest other ship by straight-line distance -- reasonable in a 2-4
// player FFA where "nearest" is usually also "most relevant."
export function pickTarget(botId, ships) {
  const botShip = ships[botId];
  if (!botShip) return null;
  let closestId = null;
  let closestDist = Infinity;
  for (const [id, ship] of Object.entries(ships)) {
    if (id === botId) continue;
    const dist = P.vLen(P.vSub(ship.pos, botShip.pos));
    if (dist < closestDist) {
      closestDist = dist;
      closestId = id;
    }
  }
  return closestId;
}

// `now` matches stepMatch's own wall-clock convention (seconds), used only
// to respect the bot's own fireCooldown same as a real player's input would.
export function computeBotInput(botShip, targetShip, now) {
  if (!targetShip) {
    return { aimYaw: botShip.yaw, aimPitch: botShip.pitch, thrusting: false, firing: false };
  }

  const distFromWell = P.vLen(botShip.pos);
  const towardTarget = P.vNormalize(P.vSub(targetShip.pos, botShip.pos));
  const awayFromWell = distFromWell > 0 ? P.vNormalize(botShip.pos) : towardTarget;
  const wellUrgency = distFromWell < WELL_SAFETY_MARGIN ? 1 : 0;
  const desiredFacing = P.vNormalize(P.vAdd(P.vScale(towardTarget, 1 - wellUrgency), P.vScale(awayFromWell, wellUrgency)));
  const { yaw, pitch } = P.yawPitchFromFacing(desiredFacing);

  const currentFacing = P.facingFromYawPitch(botShip.yaw, botShip.pitch);
  const angleError = Math.acos(Math.max(-1, Math.min(1, P.vDot(currentFacing, desiredFacing))));

  // Same instant-snap convention real input already gets (integrateShip sets
  // yaw/pitch directly from input every tick, no turn-rate limit) -- so this
  // isn't the bot cheating with faster-than-human reflexes, just using the
  // same aim model a mouse-look player already has.
  const thrusting = !botShip.overheated;
  const firing = wellUrgency === 0 && angleError < AIM_FIRE_THRESHOLD && now - botShip.lastFireTime >= botShip.stats.fireCooldown;

  return { aimYaw: yaw, aimPitch: pitch, thrusting, firing };
}
