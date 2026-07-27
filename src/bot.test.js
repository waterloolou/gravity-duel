import assert from "node:assert/strict";
import * as P from "./physics.js";
import * as M from "./match.js";
import * as Bot from "./bot.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function approx(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ~${expected}, got ${actual}`);
}

check("pickTarget picks the nearest other ship, ignoring itself", () => {
  const state = M.createMatchState(["p1", "p2", "p3"]);
  state.ships.p1 = { ...state.ships.p1, pos: { x: 0, y: 0, z: 0 } };
  state.ships.p2 = { ...state.ships.p2, pos: { x: 10, y: 0, z: 0 } };
  state.ships.p3 = { ...state.ships.p3, pos: { x: 500, y: 0, z: 0 } };
  assert.equal(Bot.pickTarget("p1", state.ships), "p2");
});

check("pickTarget returns null when the bot is alone", () => {
  const state = M.createMatchState(["p1"]);
  assert.equal(Bot.pickTarget("p1", state.ships), null);
});

check("computeBotInput with no target holds still and doesn't fire", () => {
  const state = M.createMatchState(["p1", "p2"]);
  const input = Bot.computeBotInput(state.ships.p1, null, 0);
  assert.equal(input.thrusting, false);
  assert.equal(input.firing, false);
  assert.equal(input.aimYaw, state.ships.p1.yaw);
  assert.equal(input.aimPitch, state.ships.p1.pitch);
});

check("computeBotInput aims roughly toward a safely-distant target and thrusts", () => {
  const bot = { pos: { x: 300, y: 0, z: 0 }, yaw: 0, pitch: 0, overheated: false, lastFireTime: -Infinity, stats: P.DEFAULT_SHIP_STATS };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  const input = Bot.computeBotInput(bot, target, 0);
  const facing = P.facingFromYawPitch(input.aimYaw, input.aimPitch);
  const towardTarget = P.vNormalize(P.vSub(target.pos, bot.pos));
  approx(P.vDot(facing, towardTarget), 1, 1e-6, "should aim directly at a target far from the well");
  assert.equal(input.thrusting, true, "an un-overheated bot should always thrust toward its objective");
});

check("computeBotInput steers away from the well instead of chasing a target through it", () => {
  // Bot sitting right at the well's danger radius, target on the far side --
  // a pure aim-at-target bot would point straight at (and through) the well.
  const bot = {
    pos: { x: P.WELL_RADIUS + P.SHIP_RADIUS + 10, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    overheated: false,
    lastFireTime: -Infinity,
    stats: P.DEFAULT_SHIP_STATS,
  };
  const target = { pos: { x: -300, y: 0, z: 0 } }; // straight through the well from the bot's position
  const input = Bot.computeBotInput(bot, target, 0);
  const facing = P.facingFromYawPitch(input.aimYaw, input.aimPitch);
  const towardWell = P.vNormalize(P.vSub(P.WELL_POS, bot.pos));
  assert.ok(P.vDot(facing, towardWell) < 0, "should steer away from the well, not toward it, despite the target being that direction");
  assert.equal(input.firing, false, "should not be firing while its priority is escaping the well");
});

check("computeBotInput doesn't fire until roughly aimed at the target", () => {
  const bot = {
    pos: { x: 300, y: 0, z: 0 },
    yaw: Math.PI, // facing directly away from the target
    pitch: 0,
    overheated: false,
    lastFireTime: -Infinity,
    stats: P.DEFAULT_SHIP_STATS,
  };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  const input = Bot.computeBotInput(bot, target, 0);
  assert.equal(input.firing, false, "should not fire on the very first tick before its aim has caught up");
});

check("computeBotInput fires once aimed and past its own cooldown, respects the cooldown otherwise", () => {
  const bot = {
    pos: { x: 300, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    overheated: false,
    lastFireTime: -Infinity,
    stats: P.DEFAULT_SHIP_STATS,
  };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  // Bot's own yaw already points roughly at the target (computed facing matches).
  const facing = P.facingFromYawPitch(bot.yaw, bot.pitch);
  const towardTarget = P.vNormalize(P.vSub(target.pos, bot.pos));
  assert.ok(P.vDot(facing, towardTarget) > 0.98, "test setup sanity: bot should already be nearly aimed");

  const readyInput = Bot.computeBotInput(bot, target, 10);
  assert.equal(readyInput.firing, true, "should fire once aimed and with no cooldown in the way");

  const onCooldown = { ...bot, lastFireTime: 9.9 };
  const cooldownInput = Bot.computeBotInput(onCooldown, target, 10);
  assert.equal(cooldownInput.firing, false, "should respect its own weapon's fireCooldown, same as a real player");
});

check("computeBotInput never thrusts while overheated", () => {
  const bot = {
    pos: { x: 300, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    overheated: true,
    lastFireTime: -Infinity,
    stats: P.DEFAULT_SHIP_STATS,
  };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  const input = Bot.computeBotInput(bot, target, 0);
  assert.equal(input.thrusting, false);
});

check("easy difficulty fires with a much looser aim tolerance than hard", () => {
  // Aimed 0.2 radians off -- well within easy's 0.35 tolerance, well outside hard's 0.06.
  const bot = { pos: { x: 300, y: 0, z: 0 }, yaw: 0.2, pitch: 0, overheated: false, lastFireTime: -Infinity, stats: P.DEFAULT_SHIP_STATS };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  const easyInput = Bot.computeBotInput(bot, target, 0, Bot.BOT_DIFFICULTIES.easy);
  const hardInput = Bot.computeBotInput(bot, target, 0, Bot.BOT_DIFFICULTIES.hard);
  assert.equal(easyInput.firing, true, "easy should fire even with fairly sloppy aim");
  assert.equal(hardInput.firing, false, "hard should hold fire until much more precisely aimed");
});

check("hard difficulty starts evading the well from farther away than easy", () => {
  // A distance where hard's (larger) safety margin has already kicked in but easy's (smaller) one hasn't yet.
  const dist = P.WELL_RADIUS + P.SHIP_RADIUS + 50;
  const bot = { pos: { x: dist, y: 0, z: 0 }, yaw: 0, pitch: 0, overheated: false, lastFireTime: -Infinity, stats: P.DEFAULT_SHIP_STATS };
  const target = { pos: { x: -300, y: 0, z: 0 } }; // straight through the well from the bot's position
  const towardWell = P.vNormalize(P.vSub(P.WELL_POS, bot.pos));

  const easyInput = Bot.computeBotInput(bot, target, 0, Bot.BOT_DIFFICULTIES.easy);
  const easyFacing = P.facingFromYawPitch(easyInput.aimYaw, easyInput.aimPitch);
  assert.ok(P.vDot(easyFacing, towardWell) > 0, "easy shouldn't be evading yet at this distance, so it still aims toward the target (and the well)");

  const hardInput = Bot.computeBotInput(bot, target, 0, Bot.BOT_DIFFICULTIES.hard);
  const hardFacing = P.facingFromYawPitch(hardInput.aimYaw, hardInput.aimPitch);
  assert.ok(P.vDot(hardFacing, towardWell) < 0, "hard should already be evading at this distance, steering away from the well");
});

check("computeBotInput defaults to medium difficulty when none is given", () => {
  const bot = { pos: { x: 300, y: 0, z: 0 }, yaw: 0.2, pitch: 0, overheated: false, lastFireTime: -Infinity, stats: P.DEFAULT_SHIP_STATS };
  const target = { pos: { x: 300, y: 0, z: 100 } };
  const defaultInput = Bot.computeBotInput(bot, target, 0);
  const explicitMediumInput = Bot.computeBotInput(bot, target, 0, Bot.BOT_DIFFICULTIES.medium);
  assert.deepEqual(defaultInput, explicitMediumInput);
});

console.log(`\n${passed} bot.js assertions passed`);
