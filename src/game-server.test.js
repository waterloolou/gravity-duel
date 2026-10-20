// End-to-end test of the transport-agnostic game server (game-server.js)
// with fake in-memory sockets: two players identify, one creates a room,
// the other joins by code, both ready up, and the match must start and
// stream snapshots. Also checks the peer-to-peer-only profile hand-off.

import assert from "node:assert/strict";
import { MSG } from "../protocol.js";
import { createGameServer } from "./game-server.js";
import { createProfileStore } from "./profile-store-core.js";
import * as Profile from "./profile.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

function fakeClient(server) {
  const inbox = [];
  const id = server.connect((data) => inbox.push(JSON.parse(data)));
  return {
    id,
    inbox,
    send: (type, payload = {}) => server.message(id, { type, ...payload }),
    last: (type) => [...inbox].reverse().find((m) => m.type === type),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- create, join, ready, play -------------------------------------------
{
  const server = createGameServer({ store: createProfileStore() });
  const a = fakeClient(server);
  const b = fakeClient(server);
  a.send(MSG.IDENTIFY, { playerId: "player-a" });
  b.send(MSG.IDENTIFY, { playerId: "player-b" });
  assert.equal(a.last(MSG.PROFILE_STATE).profile.playerId, "player-a");
  ok("IDENTIFY answers with the player's profile");

  a.send(MSG.CREATE_ROOM);
  const created = a.last(MSG.ROOM_CREATED);
  assert.ok(created?.code, "room code issued");
  assert.equal(server.roomSummary(created.code).playerCount, 1);
  ok("CREATE_ROOM issues a code and seats the creator as p1");

  b.send(MSG.JOIN_ROOM, { code: created.code.toLowerCase() });
  assert.equal(b.last(MSG.ROOM_JOINED).playerNumber, "p2");
  assert.equal(server.roomSummary(created.code).playerCount, 2);
  ok("JOIN_ROOM by code (case-insensitive) seats the second player");

  a.send(MSG.SET_READY, { ready: true });
  b.send(MSG.SET_READY, { ready: true });
  assert.ok(a.last(MSG.MATCH_STARTING), "countdown broadcast");
  await wait(3600); // MATCH_STARTING_COUNTDOWN_MS + a few ticks
  const snap = b.last(MSG.MATCH_STATE);
  assert.ok(snap && snap.ships.p1 && snap.ships.p2, "both ships in the live snapshot");
  ok("both ready -> countdown -> live match snapshots reach every player");

  a.send(MSG.PLAYER_INPUT, { aimYaw: 0.5, aimPitch: 0, thrusting: true, firing: true });
  await wait(200);
  assert.ok(a.last(MSG.MATCH_STATE).tick > snap.tick, "ticks advance");
  ok("player input is accepted mid-match and the simulation keeps ticking");

  server.disconnect(b.id);
  await wait(100);
  assert.ok(a.inbox.some((m) => m.type === MSG.MATCH_EVENT && (m.event === "match_over" || m.event === "player_left")));
  ok("a player disconnecting mid-match is reported to the others");
  server.disconnect(a.id); // stops the tick loop
}

// --- unknown room ----------------------------------------------------------
{
  const server = createGameServer({ store: createProfileStore() });
  const c = fakeClient(server);
  c.send(MSG.JOIN_ROOM, { code: "ZZZZ" });
  assert.equal(c.last(MSG.ERROR).code, "ROOM_NOT_FOUND");
  ok("joining a code that doesn't exist is an error, not a crash");
}

// --- profile hand-off is opt-in ---------------------------------------------
{
  const rich = Profile.awardCurrency(Profile.createDefaultProfile("player-r"), 999);
  const strict = createGameServer({ store: createProfileStore() });
  const s = fakeClient(strict);
  s.send(MSG.IDENTIFY, { playerId: "player-r", profile: rich });
  assert.equal(s.last(MSG.PROFILE_STATE).profile.currency, Profile.createDefaultProfile("player-r").currency);
  ok("the dedicated server ignores client-sent profiles");

  const p2p = createGameServer({ store: createProfileStore(), trustClientProfiles: true });
  const t = fakeClient(p2p);
  t.send(MSG.IDENTIFY, { playerId: "player-r", profile: rich });
  assert.equal(t.last(MSG.PROFILE_STATE).profile.currency, rich.currency);
  const u = fakeClient(p2p);
  u.send(MSG.IDENTIFY, { playerId: "someone-else", profile: rich });
  assert.notEqual(u.last(MSG.PROFILE_STATE).profile.currency, rich.currency);
  ok("a peer-to-peer host accepts a player's own saved profile, but only under that player's id");
}

// --- ranked room via CREATE_ROOM -------------------------------------------
{
  const server = createGameServer({ store: createProfileStore() });
  const h = fakeClient(server);
  h.send(MSG.CREATE_ROOM, { ranked: true });
  assert.equal(server.roomSummary(h.last(MSG.ROOM_CREATED).code).ranked, true);
  ok("CREATE_ROOM can open a ranked room (used by peer-to-peer matchmaking)");
}

console.log(`\n${passed} game-server.js assertions passed`);
