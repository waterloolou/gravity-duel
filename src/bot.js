// Pure AI for a practice-mode opponent. Deliberately simple -- this is a
// warm body to practice against and to unblock a solo player (Quick Play
// needs MIN_PLAYERS_TO_START real people otherwise), not a tuned esports
// opponent: it aims roughly at its target, steers away from the well once
// it gets dangerously close, and fires once roughly on-target. No I/O, no
// randomness -- a deterministic function of (ships, botId, now), same
// testing discipline as match.js/physics.js.

import * as P from "./physics.js";

// Difficulty only tunes two knobs, both already present in the "medium"
// bot: how precisely it needs to be aimed before it'll pull the trigger
// (a wider tolerance means more shots fired with worse aim, i.e. more
// misses) and how early it starts evading the well (a smaller buffer means
// it cuts things closer and dies to the well more often). Deliberately NOT
// randomness-based (a "miss chance" etc.) -- computeBotInput stays a pure,
// deterministic function of its inputs either way, same testing discipline
// as the rest of this file.
export const BOT_DIFFICULTIES = {
  easy: { id: "easy", label: "Easy", aimFireThreshold: 0.35, wellSafetyBuffer: 10 },
  medium: { id: "medium", label: "Medium", aimFireThreshold: 0.15, wellSafetyBuffer: 40 },
  hard: { id: "hard", label: "Hard", aimFireThreshold: 0.06, wellSafetyBuffer: 70 },
};
export const DEFAULT_BOT_DIFFICULTY = "medium";

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
// `difficulty` defaults to medium so every existing call site (including
// every test written before difficulty existed) keeps its exact prior
// behavior unless a caller explicitly opts into easy/hard.
export function computeBotInput(botShip, targetShip, now, difficulty = BOT_DIFFICULTIES.medium) {
  if (!targetShip) {
    return { aimYaw: botShip.yaw, aimPitch: botShip.pitch, thrusting: false, firing: false };
  }

  const wellSafetyMargin = P.WELL_RADIUS + P.SHIP_RADIUS + difficulty.wellSafetyBuffer;
  const distFromWell = P.vLen(botShip.pos);
  const towardTarget = P.vNormalize(P.vSub(targetShip.pos, botShip.pos));
  const awayFromWell = distFromWell > 0 ? P.vNormalize(botShip.pos) : towardTarget;
  const wellUrgency = distFromWell < wellSafetyMargin ? 1 : 0;
  const desiredFacing = P.vNormalize(P.vAdd(P.vScale(towardTarget, 1 - wellUrgency), P.vScale(awayFromWell, wellUrgency)));
  const { yaw, pitch } = P.yawPitchFromFacing(desiredFacing);

  const currentFacing = P.facingFromYawPitch(botShip.yaw, botShip.pitch);
  const angleError = Math.acos(Math.max(-1, Math.min(1, P.vDot(currentFacing, desiredFacing))));

  // Same instant-snap convention real input already gets (integrateShip sets
  // yaw/pitch directly from input every tick, no turn-rate limit) -- so this
  // isn't the bot cheating with faster-than-human reflexes, just using the
  // same aim model a mouse-look player already has.
  const thrusting = !botShip.overheated;
  const firing = wellUrgency === 0 && angleError < difficulty.aimFireThreshold && now - botShip.lastFireTime >= botShip.stats.fireCooldown;

  return { aimYaw: yaw, aimPitch: pitch, thrusting, firing };
}
