// Pure room/lobby state machine. Operates on plain data only -- actual
// WebSocket references live in server.js, referenced here only by opaque
// `socketId` strings, keeping this module fully unit-testable without a
// network stack. Anything time-based (ready-countdown delay) is exposed as
// a separate explicit transition (`beginMatch`) rather than embedding a
// timer here, so `setTimeout` scheduling stays entirely in server.js.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // excludes I/O to avoid confusion with 1/0
const CODE_LENGTH = 4;
const MAX_CODE_ATTEMPTS = 10;

export const PLAYER_SLOTS = ["p1", "p2", "p3", "p4"];
export const MAX_PLAYERS = PLAYER_SLOTS.length;
export const MIN_PLAYERS_TO_START = 2;

export function generateRoomCode(codeExists) {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!codeExists(code)) return code;
  }
  return null; // caller should surface this as a server-full-ish error; effectively unreachable at this scale
}

export function activePlayerIds(room) {
  return PLAYER_SLOTS.filter((id) => room.players[id]);
}

export function createRoom(code, hostSocketId) {
  const players = { p1: { socketId: hostSocketId, connected: true, ready: false } };
  for (const slot of PLAYER_SLOTS.slice(1)) players[slot] = null;
  return {
    code,
    phase: "waiting", // waiting -> full -> starting -> active -> over
    players,
    winner: null,
    winReason: null,
  };
}

export function joinRoom(room, socketId) {
  if (room.phase !== "waiting") {
    return { room, error: room.phase === "full" || room.phase === "starting" || room.phase === "active" ? "ROOM_FULL" : "ROOM_ALREADY_OVER", playerId: null };
  }
  // Guaranteed to find one: phase only ever leaves "waiting" for "full" once
  // every slot is taken, so a still-"waiting" room always has room to give.
  const slot = PLAYER_SLOTS.find((id) => !room.players[id]);
  const players = { ...room.players, [slot]: { socketId, connected: true, ready: false } };
  const filled = PLAYER_SLOTS.filter((id) => players[id]).length;
  const phase = filled >= MAX_PLAYERS ? "full" : "waiting";
  return { room: { ...room, phase, players }, error: null, playerId: slot };
}

// Used by the server's public matchmaking entry point ("Play" button): picks
// an existing room still open for more players instead of always spinning up
// a fresh one, so unrelated players actually land in the same match rather
// than each getting their own empty room. Works the same whether the room
// currently has 1, 2, or 3 players in it -- anything short of MAX_PLAYERS.
export function findJoinableRoom(roomList) {
  return roomList.find((room) => room.phase === "waiting") ?? null;
}

// A match can start with as few as MIN_PLAYERS_TO_START players, not just
// once the lobby fills up -- it starts the moment everyone currently seated
// (2, 3, or 4 of them) has readied up. Ready-up itself is valid any time
// before the match starts, whether or not the room has hit capacity yet.
export function setReady(room, playerId, ready) {
  if (room.phase !== "waiting" && room.phase !== "full") return room;
  const activeIds = activePlayerIds(room);
  if (activeIds.length < MIN_PLAYERS_TO_START) return room; // can't ready up solo
  const players = { ...room.players, [playerId]: { ...room.players[playerId], ready } };
  const allReady = activeIds.every((id) => players[id].ready);
  const next = { ...room, players };
  return allReady ? { ...next, phase: "starting" } : next;
}

// Called by server.js once its countdown timer elapses.
export function beginMatch(room) {
  if (room.phase !== "starting") return room;
  return { ...room, phase: "active" };
}

export function recordMatchOver(room, winnerId, reason) {
  if (room.phase !== "active") return room;
  return { ...room, phase: "over", winner: winnerId, winReason: reason };
}

// Returns { room, deleted, disconnectedId } -- `deleted: true` means the
// caller should remove this room from its active-rooms map entirely.
// `disconnectedId` is the slot the departing socket held *before* this call
// (server.js needs it to remove the matching ship from a live match).
export function handleDisconnect(room, socketId, now) {
  const disconnectedId = PLAYER_SLOTS.find((id) => room.players[id]?.socketId === socketId);
  if (!disconnectedId) return { room, deleted: false, disconnectedId: null }; // not a player in this room

  const remainingIds = activePlayerIds(room).filter((id) => id !== disconnectedId);

  if (room.phase === "over") {
    return { room, deleted: false, disconnectedId };
  }

  if (room.phase === "active") {
    if (remainingIds.length >= 2) {
      // Free-for-all continues with fewer players -- just vacate their slot,
      // no phase change, no renumbering (a live match's remaining player ids
      // must stay exactly as they are; server.js syncs the matchState ships
      // separately using `disconnectedId`).
      return { room: { ...room, players: { ...room.players, [disconnectedId]: null } }, deleted: false, disconnectedId };
    }
    // Down to one player (or zero): elimination-by-disconnect ends the match
    // outright, same spirit as the original 1v1 "last one standing wins".
    const winnerId = remainingIds[0] ?? null;
    return {
      room: { ...room, phase: "over", winner: winnerId, winReason: "opponent_disconnected" },
      deleted: false,
      disconnectedId,
    };
  }

  // Pre-match (waiting / full / starting): remove the slot and compact the
  // rest down to a contiguous p1... prefix, so a fresh joiner always lands in
  // the next open slot. Reset everyone's ready state -- the roster just
  // changed, so any earlier "all ready" agreement no longer applies.
  if (remainingIds.length === 0) return { room, deleted: true, disconnectedId };

  const players = {};
  remainingIds.forEach((id, i) => {
    players[PLAYER_SLOTS[i]] = { ...room.players[id], ready: false };
  });
  for (const slot of PLAYER_SLOTS.slice(remainingIds.length)) players[slot] = null;

  return { room: { ...room, phase: "waiting", players }, deleted: false, disconnectedId };
}
