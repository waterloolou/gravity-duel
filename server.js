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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8892;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function broadcastToRoom(entry, type, payload = {}) {
  for (const pid of ["p1", "p2"]) {
    const player = entry.room.players[pid];
    if (!player?.connected) continue;
    const sock = sockets.get(player.socketId);
    if (sock) send(sock.ws, type, payload);
  }
}

function lobbyStatePayload(room) {
  return {
    code: room.code,
    players: ["p1", "p2"]
      .filter((pid) => room.players[pid])
      .map((pid) => ({ playerNumber: pid, connected: room.players[pid].connected, ready: room.players[pid].ready })),
  };
}

function broadcastLobbyState(code) {
  const entry = rooms.get(code);
  if (entry) broadcastToRoom(entry, MSG.LOBBY_STATE, lobbyStatePayload(entry.room));
}

function neutralInput(ship) {
  return { aimYaw: ship.yaw, aimPitch: ship.pitch, thrusting: false, firing: false };
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
  entry.matchState = M.createMatchState();
  entry.inputs = { p1: neutralInput(entry.matchState.ships.p1), p2: neutralInput(entry.matchState.ships.p2) };
  startTickLoop(code);
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
    };
  }
  return {
    tick: state.tick,
    ships,
    projectiles: state.projectiles.map((p) => ({ id: p.id, ownerId: p.ownerId, pos: [p.pos.x, p.pos.y, p.pos.z] })),
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
      const { state, events } = M.stepMatch(entry.matchState, entry.inputs, P.TICK_DT, nowSec);
      entry.matchState = state;
      for (const ev of events) broadcastToRoom(entry, MSG.MATCH_EVENT, ev);

      if (state.winner) {
        entry.room = R.recordMatchOver(entry.room, state.winner, "won");
        clearInterval(entry.tickTimer);
        entry.tickTimer = null;
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

  const { room, deleted } = R.handleDisconnect(entry.room, socketId, Date.now() / 1000);
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
    if (entry.tickTimer) clearInterval(entry.tickTimer);
    rooms.delete(sock.roomCode);
  } else {
    entry.room = room;
    if (room.phase === "over" && entry.tickTimer) {
      clearInterval(entry.tickTimer);
      entry.tickTimer = null;
      broadcastToRoom(entry, MSG.MATCH_EVENT, { type: "match_over", winnerId: room.winner, reason: room.winReason });
    } else if (room.phase === "waiting") {
      broadcastLobbyState(sock.roomCode);
    }
  }
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
      const code = R.generateRoomCode((c) => rooms.has(c));
      if (!code) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.SERVER_FULL, message: "Could not allocate a room code, try again." });
        return;
      }
      const room = R.createRoom(code, socketId);
      rooms.set(code, { room, matchState: null, inputs: {}, tickTimer: null, startTimer: null });
      sock.roomCode = code;
      sock.playerId = "p1";
      send(sock.ws, MSG.ROOM_CREATED, { code, playerNumber: "p1" });
      broadcastLobbyState(code);
      return;
    }
    case MSG.JOIN_ROOM: {
      if (sock.roomCode) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ALREADY_IN_ROOM, message: "You're already in a room." });
        return;
      }
      const code = String(msg.code || "").toUpperCase();
      const entry = rooms.get(code);
      if (!entry) {
        send(sock.ws, MSG.ERROR, { code: ERROR_CODES.ROOM_NOT_FOUND, message: "No room with that code." });
        return;
      }
      const { room, error } = R.joinRoom(entry.room, socketId);
      if (error) {
        send(sock.ws, MSG.ERROR, { code: error, message: "That room can't be joined right now." });
        return;
      }
      entry.room = room;
      sock.roomCode = code;
      sock.playerId = "p2";
      send(sock.ws, MSG.ROOM_JOINED, { code, playerNumber: "p2" });
      broadcastLobbyState(code);
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
  }
}

wss.on("connection", (ws) => {
  const socketId = crypto.randomUUID();
  sockets.set(socketId, { ws, roomCode: null, playerId: null });
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

httpServer.listen(PORT, () => {
  console.log(`Gravity Duel running at http://localhost:${PORT}`);
});
