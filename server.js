#!/usr/bin/env node
// Static file server (same zero-dependency pattern as splice/pocket-orrery)
// plus a stateful `ws` WebSocket layer -- Gravity Duel's first real
// dependency and first-ever networked game this session, since a static
// file server alone can't host a live match.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { MSG, ERROR_CODES, MATCH_STARTING_COUNTDOWN_MS } from "./protocol.js";
import * as R from "./src/room.js";
import * as M from "./src/match.js";
import * as P from "./src/physics.js";
import * as Profile from "./src/profile.js";
import * as ProfileStore from "./src/profile-store.js";
import * as Loadouts from "./src/loadouts.js";
import * as Bot from "./src/bot.js";
import * as Challenges from "./src/challenges.js";
import * as Pings from "./src/pings.js";
import * as Achievements from "./src/achievements.js";
import * as Killstreak from "./src/killstreak.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8892;

// Currency rewards -- tunable, not balanced-forever constants. Every other
// SURVIVING participant (not just the winner) still gets something so a
// loss isn't a total dead end for progress.
const KILL_CURRENCY_REWARD = 10;
const MATCH_WIN_CURRENCY_REWARD = 50;
const MATCH_PARTICIPATION_CURRENCY_REWARD = 15;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function isInsideRoot(filePath) {
  return filePath === ROOT || filePath.startsWith(ROOT + path.sep);
}

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(ROOT, urlPath);
  if (!isInsideRoot(filePath)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// --- WebSocket / room layer --------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const rooms = new Map(); // code -> { room, matchState, inputs, tickTimer, startTimer }
const sockets = new Map(); // socketId -> { ws, roomCode, playerId }

function send(ws, type, payload = {}) {
  // `type` spread LAST so the envelope's own type always wins, even if a
  // caller's payload happens to carry its own `type`-named field (exactly
  // what broke MATCH_EVENT dispatch: match.js's event objects use `type` for
  // their own hit/well_death/match_over sub-type, which used to silently
  // clobber the "match_event" envelope type when spread first). Renaming
  // that field to `event` (see match.js) fixes the one instance found; this
  // ordering makes the whole class of bug structurally impossible going
  // forward, not just this occurrence of it.
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...payload, type }));
}

function broadcastToRoom(entry, type, payload = {}) {
  for (const pid of R.PLAYER_SLOTS) {
    const player = entry.room.players[pid];
    if (!player?.connected) continue;
    const sock = sockets.get(player.socketId);
    if (sock) send(sock.ws, type, payload);
  }
  for (const socketId of entry.room.spectators) {
    const sock = sockets.get(socketId);
    if (sock) send(sock.ws, type, payload);
  }
}

// Pulls any waiting spectators into seats that just opened up (a pre-match
// disconnect compacting the roster, or a rematch resetting the lobby) --
// see room.js's promoteSpectators for the FIFO/phase rules. Callers are
// responsible for broadcasting the resulting LOBBY_STATE afterward; this
// only updates each promoted socket's own playerId and tells them directly.
function promoteWaitingSpectators(code) {
  const entry = rooms.get(code);
  if (!entry) return;
  const { room, promoted } = R.promoteSpectators(entry.room);
  entry.room = room;
  for (const { socketId, playerId } of promoted) {
    const sock = sockets.get(socketId);
    if (!sock) continue;
    sock.playerId = playerId;
    send(sock.ws, MSG.ROOM_JOINED, { code, playerNumber: playerId });
  }
}

function lobbyStatePayload(room) {
  return {
    code: room.code,
    ranked: !!room.ranked,
    players: R.activePlayerIds(room).map((pid) => ({
      playerNumber: pid,
      connected: room.players[pid].connected,
      ready: room.players[pid].ready,
      isBot: !!room.players[pid].isBot,
      botDifficulty: room.players[pid].botDifficulty ?? null,
    })),
  };
}

// A pre-match disconnect can renumber the remaining players' slots (room.js
// compacts them down to a contiguous p1... prefix) -- without this, a
// remaining socket's own `sock.playerId` would go stale, and its next
// SET_READY/PLAYER_INPUT would be keyed to a slot that's no longer theirs
// (or is now someone else's). Cheap to just recompute for every seat after
// any disconnect, active match or not.
function reconcilePlayerIdsForRoom(code) {
  const entry = rooms.get(code);
  if (!entry) return;
  for (const pid of R.activePlayerIds(entry.room)) {
    const sock = sockets.get(entry.room.players[pid].socketId);
    if (sock) sock.playerId = pid;
  }
}

function broadcastLobbyState(code) {
  const entry = rooms.get(code);
  if (entry) broadcastToRoom(entry, MSG.LOBBY_STATE, lobbyStatePayload(entry.room));
}

function neutralInput(ship) {
  return { aimYaw: ship.yaw, aimPitch: ship.pitch, thrusting: false, firing: false };
}

// Applies one or more ProfileStore mutations to whoever holds a given room
// seat (e.g. "p2"), keyed through to their persistent profile via their
// socket's profileId -- not everyone identifies before playing (or plays in
// a second tab), so this is a no-op rather than an error when there's
// nothing to credit. `mutate` may call multiple ProfileStore functions
// (e.g. awardCurrency AND addStats for a kill); only one PROFILE_STATE is
// sent afterward, reflecting all of them together, not one per call.
function updateProfileForSeat(entry, seatId, mutate) {
  const seat = entry.room.players[seatId];
  if (!seat) return;
  const sock = sockets.get(seat.socketId);
  if (!sock?.profileId) return;
  mutate(sock.profileId);
  send(sock.ws, MSG.PROFILE_STATE, { profile: ProfileStore.get(sock.profileId) });
}

// Same no-op-for-a-bot/unidentified-seat philosophy as updateProfileForSeat,
// but for daily-challenge progress specifically -- kept separate rather
// than folded into that function's `mutate` callback since a completion
// needs its own CHALLENGE_COMPLETED notification on top of the ordinary
// PROFILE_STATE, not just another ProfileStore call bundled in silently.
function creditChallengeProgress(entry, seatId, trackKey, amount = 1) {
  const seat = entry.room.players[seatId];
  if (!seat) return;
  const sock = sockets.get(seat.socketId);
  if (!sock?.profileId) return;
  const { profile, completed, reward } = ProfileStore.recordChallengeProgress(sock.profileId, trackKey, amount);
  send(sock.ws, MSG.PROFILE_STATE, { profile });
  if (completed.length > 0) {
    send(sock.ws, MSG.CHALLENGE_COMPLETED, {
      reward,
      labels: completed.map((id) => Challenges.CHALLENGE_POOL[id].label),
    });
  }
}

// Re-checks a seat's lifetime stats against achievements.js's catalog and
// notifies them of anything newly unlocked. Called right after any event
// that could cross a threshold (a kill; see settleMatch for the other
// call site, match end, which resolves profileId itself since a forfeit's
// loser may have no live seat left by then).
function creditAchievementCheck(entry, seatId) {
  const seat = entry.room.players[seatId];
  if (!seat) return;
  const sock = sockets.get(seat.socketId);
  if (!sock?.profileId) return;
  const { profile, unlocked } = ProfileStore.checkAchievements(sock.profileId);
  if (unlocked.length === 0) return;
  send(sock.ws, MSG.PROFILE_STATE, { profile });
  send(sock.ws, MSG.ACHIEVEMENT_UNLOCKED, { labels: unlocked.map((id) => Achievements.ACHIEVEMENTS[id].label) });
}

// Called for EVERY match's end (both paths -- a natural kills-based win in
// startTickLoop, or a forfeit-by-disconnect win in handleDisconnectSocket),
// casual or ranked. Resolves each seat to its persistent profileId
// (skipping any seat with no identified profile -- an anonymous player's
// history/rating just never gets touched, same graceful-degradation
// philosophy as currency/stats elsewhere), records a match-history entry
// for every identified player, and -- ranked rooms only -- also runs the
// whole match through elo.js as one pairwise-FFA result.
//
// `extraProfileIdBySeat` covers a seat whose room.players entry has
// ALREADY been cleared by the time this runs -- specifically the forfeit
// path: room.js's handleDisconnect nulls the disconnecting player's slot
// immediately (so a later rematch doesn't wait forever on a ready-up from
// a socket that's already gone), which means the normal seat -> socket ->
// profileId lookup below can no longer find them. handleDisconnectSocket
// passes their profileId through this side channel instead, resolved from
// its own still-valid `sock` reference before that socket is torn down.
function settleMatch(entry, playerIds, winnerId, extraProfileIdBySeat = {}) {
  const profileIdBySeat = { ...extraProfileIdBySeat };
  for (const seatId of playerIds) {
    if (profileIdBySeat[seatId]) continue;
    const seat = entry.room.players[seatId];
    const sock = seat && sockets.get(seat.socketId);
    if (sock?.profileId) profileIdBySeat[seatId] = sock.profileId;
  }
  const identifiedProfileIds = Object.values(profileIdBySeat);
  const winnerProfileId = profileIdBySeat[winnerId];
  if (identifiedProfileIds.length === 0) return;

  // Need the winner AND at least one opponent identified for an Elo update
  // to mean anything -- otherwise this is skipped rather than rating a
  // "match" against phantom opponents. Match history still records below
  // regardless (a solo-identified player in a room full of bots/anonymous
  // opponents still gets their own win/loss logged).
  let ratingChanges = {};
  if (entry.room.ranked && winnerProfileId && identifiedProfileIds.length >= 2) {
    ratingChanges = ProfileStore.applyRankedResult(identifiedProfileIds, winnerProfileId);
  }

  for (const [seatId, profileId] of Object.entries(profileIdBySeat)) {
    const change = ratingChanges[profileId];
    ProfileStore.addMatchHistoryEntry(profileId, {
      timestamp: Date.now(),
      result: profileId === winnerProfileId ? "win" : "loss",
      ranked: !!entry.room.ranked,
      opponentCount: playerIds.length - 1,
      ratingChange: change ? change.after - change.before : null,
    });
    const { unlocked } = ProfileStore.checkAchievements(profileId);
    // A seat resolved only via extraProfileIdBySeat has no live room slot
    // (and often no live socket either, e.g. the disconnecting player in
    // the forfeit path) -- history/rating/achievements are already
    // persisted regardless, this just skips telling someone who isn't
    // there to hear it.
    const seat = entry.room.players[seatId];
    const sock = seat && sockets.get(seat.socketId);
    if (sock) {
      send(sock.ws, MSG.PROFILE_STATE, { profile: ProfileStore.get(profileId) });
      if (unlocked.length > 0) {
        send(sock.ws, MSG.ACHIEVEMENT_UNLOCKED, { labels: unlocked.map((id) => Achievements.ACHIEVEMENTS[id].label) });
      }
    }
  }
}

function beginMatch(code) {
  const entry = rooms.get(code);
  if (!entry) return;
  entry.room = R.beginMatch(entry.room);
  // A player can disconnect during the 3s starting countdown (reverting the
  // room to "waiting") and a NEW pair can ready up before the original
  // setTimeout fires -- R.beginMatch is correctly a no-op when phase isn't
  // "starting", but without this check the rest of this function would run
  // anyway, force-starting an illegitimate match or, on the stale timer's
  // later firing, wiping an already-in-progress match back to a fresh 0-0
  // state. Confirmed reachable via a real disconnect-during-countdown case,
  // not just a hypothetical race.
  if (entry.room.phase !== "active") return;
  const activeIds = R.activePlayerIds(entry.room);
  const loadouts = {};
  const cosmetics = {};
  for (const id of activeIds) {
    loadouts[id] = resolveLoadoutForSeat(entry, id);
    cosmetics[id] = resolveCosmeticForSeat(entry, id);
  }
  // Wreckage (unlike ships/projectiles/pickups) survives a Rematch in this
  // same room -- see match.js's own comment on createMatchState's
  // debris/nextDebrisId params for why. entry.matchState still holds the
  // PREVIOUS match's state here, right up until the reassignment below.
  const carryOverDebris = entry.matchState?.debris ?? [];
  const carryOverNextDebrisId = entry.matchState?.nextDebrisId ?? 1;
  entry.matchState = M.createMatchState(activeIds, loadouts, cosmetics, carryOverDebris, carryOverNextDebrisId);
  entry.inputs = {};
  for (const id of activeIds) entry.inputs[id] = neutralInput(entry.matchState.ships[id]);
  entry.deathsThisMatch = {}; // per-seat death count, reset per match -- feeds the "win without dying" daily challenge (see startTickLoop's match_over handling)
  entry.recentKills = {}; // per-seat kill timestamps within Killstreak.KILLSTREAK_WINDOW, reset per match -- see startTickLoop's "hit" handling
  startTickLoop(code);
}

// A socket that never IDENTIFY'd (or whose profile lookup somehow comes back
// empty) still gets a match -- just with the free starter loadout, same as
// resolveShipStats' own fallback for an unrecognized ship/weapon id. A
// missing loadout should never be the reason a match fails to start.
function resolveLoadoutForSeat(entry, seatId) {
  const seat = entry.room.players[seatId];
  const sock = seat && sockets.get(seat.socketId);
  const profile = sock?.profileId ? ProfileStore.get(sock.profileId) : null;
  return Loadouts.resolveShipStats(profile?.equippedShip, profile?.equippedWeapon, profile?.upgrades);
}

// Same fallback philosophy as resolveLoadoutForSeat -- an unidentified/
// missing profile just gets the free default engine color, never blocks a
// match from starting.
function resolveCosmeticForSeat(entry, seatId) {
  const seat = entry.room.players[seatId];
  const sock = seat && sockets.get(seat.socketId);
  const profile = sock?.profileId ? ProfileStore.get(sock.profileId) : null;
  return Loadouts.resolveEngineColor(profile?.equippedCosmetic);
}

function serializeMatchState(state, now) {
  const ships = {};
  for (const [id, s] of Object.entries(state.ships)) {
    ships[id] = {
      pos: [s.pos.x, s.pos.y, s.pos.z],
      vel: [s.vel.x, s.vel.y, s.vel.z],
      yaw: s.yaw,
      pitch: s.pitch,
      kills: s.kills,
      invulnerable: now < s.invulnerableUntil,
      thrusting: !!s.thrusting,
      heat: s.heat,
      overheated: !!s.overheated,
      engineColor: s.engineColor,
      speedBoosted: now < s.speedBoostUntil,
    };
  }
  return {
    tick: state.tick,
    playerIds: state.playerIds,
    ships,
    projectiles: state.projectiles.map((p) => ({
      id: p.id,
      ownerId: p.ownerId,
      pos: [p.pos.x, p.pos.y, p.pos.z],
      vel: [p.vel.x, p.vel.y, p.vel.z],
    })),
    // type/pos are included even while on cooldown (active: false) so the
    // client can render a dimmed marker instead of nothing -- players learn
    // the map faster if a cooling-down pickup still shows what/where it is.
    pickups: state.pickups.map((p) => ({ id: p.id, type: p.type, pos: [p.pos.x, p.pos.y, p.pos.z], active: p.active })),
    // Unlike pickups, inactive debris is dropped entirely rather than sent
    // dimmed -- its position is meaningless while on cooldown (frozen at a
    // now-ancient death site, on a DEBRIS_RESPAWN_DELAY measured in minutes,
    // not seconds), so there's nothing worth learning the map by seeing it.
    debris: state.debris.filter((d) => d.active).map((d) => ({ id: d.id, pos: [d.pos.x, d.pos.y, d.pos.z], vel: [d.vel.x, d.vel.y, d.vel.z] })),
    winner: state.winner,
  };
}

function startTickLoop(code) {
  const entry = rooms.get(code);
  if (!entry) return;
  // Defensive: never let two tick loops run concurrently against the same
  // shared matchState/room (would double physics speed and duplicate
  // broadcasts). Shouldn't be reachable given the beginMatch() guard above,
  // but costs nothing to make impossible outright.
  if (entry.tickTimer) clearInterval(entry.tickTimer);
  const stepMs = P.TICK_DT * 1000;
  let last = Date.now();
  let acc = 0;

  entry.tickTimer = setInterval(() => {
    const now = Date.now();
    acc += now - last;
    last = now;

    while (acc >= stepMs && entry.tickTimer) {
      acc -= stepMs;
      const nowSec = Date.now() / 1000;
      // Bots have no socket to ever send PLAYER_INPUT, so their entry.inputs
      // slot is computed fresh here, every tick, right before stepMatch
      // reads it -- same shape/timing as a real player's input, just
      // sourced from bot.js's pure AI instead of a WebSocket message.
      for (const id of entry.matchState.playerIds) {
        const seat = entry.room.players[id];
        if (!seat?.isBot) continue;
        const difficulty = Bot.BOT_DIFFICULTIES[seat.botDifficulty] ?? Bot.BOT_DIFFICULTIES[Bot.DEFAULT_BOT_DIFFICULTY];
        const targetId = Bot.pickTarget(id, entry.matchState.ships);
        entry.inputs[id] = Bot.computeBotInput(entry.matchState.ships[id], targetId ? entry.matchState.ships[targetId] : null, nowSec, difficulty);
      }
      const { state, events } = M.stepMatch(entry.matchState, entry.inputs, P.TICK_DT, nowSec);
      entry.matchState = state;
      for (const ev of events) {
        broadcastToRoom(entry, MSG.MATCH_EVENT, ev);
        if (ev.event === "hit" || ev.event === "well_death" || ev.event === "moon_death" || ev.event === "debris_death") {
          updateProfileForSeat(entry, ev.victimId, (id) => ProfileStore.addStats(id, { deaths: 1 }));
          entry.deathsThisMatch[ev.victimId] = (entry.deathsThisMatch[ev.victimId] ?? 0) + 1;
        }
        if (ev.event === "hit") {
          updateProfileForSeat(entry, ev.killerId, (id) => {
            ProfileStore.awardCurrency(id, KILL_CURRENCY_REWARD);
            ProfileStore.addStats(id, { kills: 1 });
          });
          creditChallengeProgress(entry, ev.killerId, "kills");
          creditAchievementCheck(entry, ev.killerId);
          const { timestamps, label } = Killstreak.recordKill(entry.recentKills[ev.killerId] ?? [], nowSec);
          entry.recentKills[ev.killerId] = timestamps;
          if (label) broadcastToRoom(entry, MSG.MATCH_EVENT, { event: "killstreak", playerId: ev.killerId, label });
        }
        if (ev.event === "pickup") {
          creditChallengeProgress(entry, ev.playerId, "pickups");
        }
      }

      if (state.winner) {
        entry.room = R.recordMatchOver(entry.room, state.winner, "won");
        clearInterval(entry.tickTimer);
        entry.tickTimer = null;
        updateProfileForSeat(entry, state.winner, (id) => {
          ProfileStore.awardCurrency(id, MATCH_WIN_CURRENCY_REWARD);
          ProfileStore.addStats(id, { wins: 1, matchesPlayed: 1 });
        });
        creditChallengeProgress(entry, state.winner, "wins");
        if (!entry.deathsThisMatch[state.winner]) creditChallengeProgress(entry, state.winner, "deathlessWins");
        creditChallengeProgress(entry, state.winner, "matches");
        for (const id of state.playerIds) {
          if (id === state.winner) continue;
          updateProfileForSeat(entry, id, (pid) => {
            ProfileStore.awardCurrency(pid, MATCH_PARTICIPATION_CURRENCY_REWARD);
            ProfileStore.addStats(pid, { losses: 1, matchesPlayed: 1 });
          });
          creditChallengeProgress(entry, id, "matches");
        }
        // Runs last, once every player's wins/losses/matchesPlayed/currency
        // for THIS match has already been applied above -- settleMatch's own
        // achievement check and PROFILE_STATE send need final stats, not a
        // still-in-progress snapshot from partway through this block.
        settleMatch(entry, state.playerIds, state.winner);
      }
    }

    if (entry.matchState) broadcastToRoom(entry, MSG.MATCH_STATE, serializeMatchState(entry.matchState, Date.now() / 1000));
  }, stepMs);
}

function handleDisconnectSocket(socketId) {
  const sock = sockets.get(socketId);
  if (!sock?.roomCode) return;
  const entry = rooms.get(sock.roomCode);
  if (!entry) return;

  const wasActive = entry.room.phase === "active";
  const { room, deleted, disconnectedId } = R.handleDisconnect(entry.room, socketId, Date.now() / 1000);
  // A pending "starting" countdown timer must be cancelled on ANY disconnect
  // that reverts the room out of "starting", not just when the room is
  // deleted outright -- otherwise a disconnect-during-countdown leaves a
  // stale setTimeout that can force-start a match later against whichever
  // players happen to be in the room by then (see beginMatch()'s guard for
  // the second half of this fix).
  if (entry.startTimer) {
    clearTimeout(entry.startTimer);
    entry.startTimer = null;
  }
  if (deleted) {
    // The last PLAYER just left (deleted is never true for a spectator
    // disconnect -- see room.js's handleDisconnect), but a spectator or two
    // might still be sitting here watching an empty room. Let them know
    // rather than just going silent on them.
    entry.room = room;
    broadcastToRoom(entry, MSG.MATCH_EVENT, { event: "room_closed" });
    if (entry.tickTimer) clearInterval(entry.tickTimer);
    rooms.delete(sock.roomCode);
    return;
  }

  entry.room = room;
  reconcilePlayerIdsForRoom(sock.roomCode);

  if (wasActive && room.phase === "active") {
    // Free-for-all continues with fewer players -- drop their ship from the
    // live sim and let everyone remaining know why an opponent just vanished.
    // disconnectedId is null for a spectator leaving (nothing to remove from
    // the live sim, and no one needs telling) -- see room.js's handleDisconnect.
    if (disconnectedId) {
      entry.matchState = M.removePlayer(entry.matchState, disconnectedId);
      broadcastToRoom(entry, MSG.MATCH_EVENT, { event: "player_left", playerId: disconnectedId });
    }
  } else if (room.phase === "over" && entry.tickTimer) {
    clearInterval(entry.tickTimer);
    entry.tickTimer = null;
    broadcastToRoom(entry, MSG.MATCH_EVENT, { event: "match_over", winnerId: room.winner, reason: room.winReason });
    if (room.winner) {
      updateProfileForSeat(entry, room.winner, (id) => {
        ProfileStore.awardCurrency(id, MATCH_WIN_CURRENCY_REWARD);
        ProfileStore.addStats(id, { wins: 1, matchesPlayed: 1 });
      });
      creditChallengeProgress(entry, room.winner, "wins");
      if (!entry.deathsThisMatch?.[room.winner]) creditChallengeProgress(entry, room.winner, "deathlessWins");
      creditChallengeProgress(entry, room.winner, "matches");
      // entry.matchState still reflects the roster from right before this
      // disconnect (this "over via forfeit" branch, unlike the "still
      // active" one above, never called M.removePlayer) -- so the
      // disconnecting player is correctly still counted as the loser here
      // (match history AND, for a ranked room, the Elo update), not
      // silently excluded just for having quit. Their own room seat is
      // already cleared by now (room.js nulls it immediately on a
      // forfeit), so their profileId has to come from this still-valid
      // `sock` reference instead of the normal seat lookup -- see
      // settleMatch's own comment on this.
      if (entry.matchState) {
        const extra = disconnectedId && sock.profileId ? { [disconnectedId]: sock.profileId } : {};
        settleMatch(entry, entry.matchState.playerIds, room.winner, extra);
      }
    }
  } else if (room.phase === "waiting") {
    // A pre-match disconnect can compact the roster down and open a seat --
    // pull in the longest-waiting spectator (if any) before broadcasting,
    // so LOBBY_STATE reflects the promotion in one go instead of flickering.
    promoteWaitingSpectators(sock.roomCode);
    broadcastLobbyState(sock.roomCode);
  }
}

// Shared by CREATE_ROOM and the "no joinable room" branch of QUICK_JOIN/RANKED_JOIN.
function createNewRoom(socketId, sock, ranked = false) {
  const code = R.generateRoomCode((c) => rooms.has(c));
  if (!code) {
    send(sock.ws, MSG.ERROR, { code: ERROR_CODES.SERVER_FULL, message: "Could not allocate a room code, try again." });
    return;
  }
  const room = R.createRoom(code, socketId, ranked);
  rooms.set(code, { room, matchState: null, inputs: {}, tickTimer: null, startTimer: null });
  sock.roomCode = code;
  sock.playerId = "p1";
  send(sock.ws, MSG.ROOM_CREATED, { code, playerNumber: "p1" });
  broadcastLobbyState(code);
}

// Shared by JOIN_ROOM and the "found a joinable room" branch of QUICK_JOIN.
// Assumes `code` names a room that actually exists (callers already know
// this: JOIN_ROOM just looked it up, QUICK_JOIN just picked it from `rooms`).
function joinExistingRoom(code, socketId, sock) {
  const entry = rooms.get(code);
  const { room, error, playerId } = R.joinRoom(entry.room, socketId);
  // A full/starting/active room (ROOM_FULL) doesn't have to be a dead end --
  // fall back to spectating instead of just bouncing them with an error.
  // ROOM_ALREADY_OVER stays a hard error: a finished room has nothing live
  // left to watch.
  if (error === "ROOM_FULL") {
    entry.room = R.addSpectator(entry.room, socketId);
    sock.roomCode = code;
    sock.playerId = null;
    send(sock.ws, MSG.SPECTATING, { code, playerIds: R.activePlayerIds(entry.room) });
    // Don't make them wait for the next tick if a match is already live --
    // hand them the current snapshot immediately.
    if (entry.matchState) send(sock.ws, MSG.MATCH_STATE, serializeMatchState(entry.matchState, Date.now() / 1000));
    return;
  }
  if (error) {
    send(sock.ws, MSG.ERROR, { code: error, message: "That room can't be joined right now." });
    return;
  }
  entry.room = room;
  sock.roomCode = code;
  sock.playerId = playerId;
  send(sock.ws, MSG.ROOM_JOINED, { code, playerNumber: playerId });
  broadcastLobbyState(code);
}

function handleMessage(socketId, msg) {
  const sock = sockets.get(socketId);
  if (!sock || typeof msg?.type !== "string") return;

  switch (msg.type) {
    case MSG.CREATE_ROOM: {
      // Without this guard, a socket already seated in room A could create/
      // join a second room, silently orphaning room A (its cleanup would
      // thereafter target the socket's new room instead) -- and, for JOIN,
      // a host could even join their own just-created code, permanently
      // occupying both seats and locking out a real second player.
      if (sock.roomCode) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ALREADY_IN_ROOM, message: "You're already in a room." });
        return;
      }
      createNewRoom(socketId, sock);
      return;
    }
    case MSG.JOIN_ROOM: {
      if (sock.roomCode) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ALREADY_IN_ROOM, message: "You're already in a room." });
        return;
      }
      const code = String(msg.code || "").toUpperCase();
      if (!rooms.has(code)) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ROOM_NOT_FOUND, message: "No room with that code." });
        return;
      }
      joinExistingRoom(code, socketId, sock);
      return;
    }
    case MSG.QUICK_JOIN: {
      // Public matchmaking: join whichever room is already sitting there
      // waiting for an opponent, or spin up a fresh one if the server has
      // none right now. No room code involved on either side.
      if (sock.roomCode) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ALREADY_IN_ROOM, message: "You're already in a room." });
        return;
      }
      const target = R.findJoinableRoom(Array.from(rooms.values(), (entry) => entry.room));
      if (target) {
        joinExistingRoom(target.code, socketId, sock);
      } else {
        createNewRoom(socketId, sock);
      }
      return;
    }
    case MSG.RANKED_JOIN: {
      // Same matchmaking shape as QUICK_JOIN, but findJoinableRoom's
      // ranked=true keeps this pool entirely separate from casual rooms --
      // a ranked search can never land in (or create) a casual room and
      // vice versa, so the two queues never cross-match.
      if (sock.roomCode) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ALREADY_IN_ROOM, message: "You're already in a room." });
        return;
      }
      const target = R.findJoinableRoom(Array.from(rooms.values(), (entry) => entry.room), true);
      if (target) {
        joinExistingRoom(target.code, socketId, sock);
      } else {
        createNewRoom(socketId, sock, true);
      }
      return;
    }
    case MSG.SET_READY: {
      const entry = rooms.get(sock.roomCode);
      if (!entry || !sock.playerId) return;
      entry.room = R.setReady(entry.room, sock.playerId, !!msg.ready);
      broadcastLobbyState(sock.roomCode);
      if (entry.room.phase === "starting") {
        broadcastToRoom(entry, MSG.MATCH_STARTING, { countdownMs: MATCH_STARTING_COUNTDOWN_MS });
        entry.startTimer = setTimeout(() => beginMatch(sock.roomCode), MATCH_STARTING_COUNTDOWN_MS);
      }
      return;
    }
    case MSG.ADD_BOT: {
      // Any seated player can add/remove a bot -- there's no distinct
      // "host" concept in this room model, and letting only p1 do it would
      // just be an arbitrary restriction with no real benefit.
      const entry = rooms.get(sock.roomCode);
      if (!entry || !sock.playerId) return;
      // An unrecognized/missing difficulty falls back to medium rather than
      // rejecting the request outright -- same "never block on a cosmetic
      // detail" philosophy as an unrecognized ship/weapon id elsewhere.
      const difficulty = Bot.BOT_DIFFICULTIES[msg.difficulty] ? msg.difficulty : Bot.DEFAULT_BOT_DIFFICULTY;
      const { room, error } = R.addBot(entry.room, difficulty);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES[error] ?? error, message: "Couldn't add a bot right now." });
        return;
      }
      entry.room = room;
      broadcastLobbyState(sock.roomCode);
      return;
    }
    case MSG.REMOVE_BOT: {
      const entry = rooms.get(sock.roomCode);
      if (!entry || !sock.playerId) return;
      entry.room = R.removeBot(entry.room, String(msg.slot || ""));
      promoteWaitingSpectators(sock.roomCode); // a freed bot seat is a seat a waiting spectator can be pulled into
      broadcastLobbyState(sock.roomCode);
      return;
    }
    case MSG.SEND_PING: {
      const entry = rooms.get(sock.roomCode);
      // Only a seated player mid-match can ping -- not a spectator (they'd
      // have nothing at stake to call out), and only from the fixed catalog
      // (never whatever string msg.pingId happens to be) since this whole
      // feature exists specifically to avoid a free-text abuse surface.
      if (!entry || !sock.playerId || entry.room.phase !== "active" || !Pings.PINGS[msg.pingId]) return;
      const nowMs = Date.now();
      if (nowMs - sock.lastPingAt < Pings.PING_COOLDOWN_MS) return;
      sock.lastPingAt = nowMs;
      broadcastToRoom(entry, MSG.PING, { playerId: sock.playerId, pingId: msg.pingId });
      return;
    }
    case MSG.PLAYER_INPUT: {
      const entry = rooms.get(sock.roomCode);
      if (!entry || !sock.playerId || entry.room.phase !== "active") return;
      const maxPitch = 1.4835; // ~85 degrees, matches the client's own pointer-lock clamp
      // `Number(x) || 0` only guards against falsy results (NaN, 0, "") --
      // it does NOT catch Infinity, which valid JSON can produce (e.g. a
      // literal like 1e400 overflows silently). Math.sin/cos(Infinity) is
      // NaN, which then poisons a ship's integrated position permanently
      // (NaN propagates through every subsequent tick and can never be hit
      // by a swept-sphere test again) -- confirmed exploitable via a single
      // malformed PLAYER_INPUT message. Number.isFinite closes that gap;
      // aimPitch is included too for defense-in-depth even though the
      // clamp below happens to already neutralize an infinite input.
      const rawYaw = Number(msg.aimYaw);
      const rawPitch = Number(msg.aimPitch);
      entry.inputs[sock.playerId] = {
        aimYaw: Number.isFinite(rawYaw) ? rawYaw : 0,
        aimPitch: Math.max(-maxPitch, Math.min(maxPitch, Number.isFinite(rawPitch) ? rawPitch : 0)),
        thrusting: !!msg.thrusting,
        firing: !!msg.firing,
      };
      return;
    }
    case MSG.LEAVE_ROOM: {
      handleDisconnectSocket(socketId);
      sock.roomCode = null;
      sock.playerId = null;
      return;
    }
    case MSG.IDENTIFY: {
      // The client generates and locally persists this id (localStorage) --
      // there's no auth, so it's really just "which save file to load", not
      // a credential the server can verify. Never echo another socket's
      // profileId into any broadcast payload (LOBBY_STATE/MATCH_STATE stay
      // on room-seat ids p1-p4 only) -- unlike a room code, this id is
      // long-lived and controls real progress, not just one match.
      const playerId = String(msg.playerId || "");
      if (!playerId) return;
      sock.profileId = playerId;
      const profile = ProfileStore.get(playerId);
      send(sock.ws, MSG.PROFILE_STATE, { profile });
      return;
    }
    case MSG.PURCHASE_UNLOCK: {
      if (!sock.profileId) return;
      const { profile: next, error } = Profile.purchaseUnlock(ProfileStore.get(sock.profileId), msg.kind, msg.id);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES[error], message: "Couldn't complete that purchase." });
        return;
      }
      ProfileStore.set(sock.profileId, next);
      send(sock.ws, MSG.PROFILE_STATE, { profile: next });
      return;
    }
    case MSG.EQUIP_LOADOUT: {
      if (!sock.profileId) return;
      const { profile: next, error } = Profile.setEquipped(ProfileStore.get(sock.profileId), msg.shipId, msg.weaponId, msg.cosmeticId);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES[error], message: "Couldn't equip that loadout." });
        return;
      }
      ProfileStore.set(sock.profileId, next);
      send(sock.ws, MSG.PROFILE_STATE, { profile: next });
      return;
    }
    case MSG.PURCHASE_UPGRADE: {
      if (!sock.profileId) return;
      const { profile: next, error } = Profile.purchaseUpgrade(ProfileStore.get(sock.profileId), msg.stat);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES[error], message: "Couldn't purchase that upgrade." });
        return;
      }
      ProfileStore.set(sock.profileId, next);
      send(sock.ws, MSG.PROFILE_STATE, { profile: next });
      return;
    }
    case MSG.REQUEST_REMATCH: {
      const entry = rooms.get(sock.roomCode);
      if (!entry || !sock.playerId || entry.room.phase !== "over") return; // a spectator has no seat to request a rematch on behalf of
      entry.room = R.rematch(entry.room);
      entry.matchState = null; // the finished match's state is no longer relevant; beginMatch() builds a fresh one
      promoteWaitingSpectators(sock.roomCode); // rematch can reopen a seat if the previous roster had fewer than MAX_PLAYERS
      broadcastLobbyState(sock.roomCode);
      return;
    }
    case MSG.SET_DISPLAY_NAME: {
      if (!sock.profileId) return;
      const { profile: next, error } = Profile.setDisplayName(ProfileStore.get(sock.profileId), msg.name);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES[error], message: "Enter a callsign (up to 16 characters)." });
        return;
      }
      ProfileStore.set(sock.profileId, next);
      send(sock.ws, MSG.PROFILE_STATE, { profile: next });
      return;
    }
    case MSG.REQUEST_LEADERBOARD: {
      const board = msg.ranked ? ProfileStore.getRankedLeaderboard(sock.profileId) : ProfileStore.getLeaderboard(sock.profileId);
      send(sock.ws, MSG.LEADERBOARD_STATE, { ranked: !!msg.ranked, ...board });
      return;
    }
    case MSG.LATENCY_PING: {
      // Round-trip latency display -- echoes the client's own timestamp
      // back unmodified so it never has to trust (or synchronize with)
      // the server's clock, just its own. Valid in any state (no room,
      // no identify) since it's not gameplay, just a connection-health
      // readout.
      send(sock.ws, MSG.LATENCY_PONG, { sentAt: msg.sentAt });
      return;
    }
    case MSG.REQUEST_ROOM_LIST: {
      // Casual, still-"waiting" (has an open seat) rooms only -- ranked
      // rooms have no business being browsed (Ranked is matched via its
      // own queue, not picked by hand), and anything full/starting/active
      // isn't joinable as a player anyway (JOIN_ROOM would just route it
      // to spectating, a different feature with its own entry point).
      const list = Array.from(rooms.values())
        .filter((entry) => entry.room.phase === "waiting" && !entry.room.ranked)
        .map((entry) => ({ code: entry.room.code, playerCount: R.activePlayerIds(entry.room).length, maxPlayers: R.MAX_PLAYERS }));
      send(sock.ws, MSG.ROOM_LIST, { rooms: list });
      return;
    }
  }
}

wss.on("connection", (ws) => {
  const socketId = crypto.randomUUID();
  sockets.set(socketId, { ws, roomCode: null, playerId: null, profileId: null, lastPingAt: 0 });
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(socketId, msg);
  });

  ws.on("close", () => {
    handleDisconnectSocket(socketId);
    sockets.delete(socketId);
  });
});

// Half-open connection detection (standard ws ping/pong heartbeat pattern).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

ProfileStore.load();

// Render (and most PaaS hosts) send SIGTERM on redeploy/scale-down -- flush
// whatever's pending so a shutdown mid-match doesn't lose the last few
// seconds of earned currency on top of the deploy already wiping the disk.
process.on("SIGTERM", () => {
  ProfileStore.flushSync();
  process.exit(0);
});
process.on("SIGINT", () => {
  ProfileStore.flushSync();
  process.exit(0);
});

httpServer.listen(PORT, () => {
  console.log(`Gravity Duel listening on port ${PORT}`);
});
