// Pure room/lobby state machine. Operates on plain data only -- actual
// WebSocket references live in server.js, referenced here only by opaque
// `socketId` strings, keeping this module fully unit-testable without a
// network stack. Anything time-based (ready-countdown delay) is exposed as
// a separate explicit transition (`beginMatch`) rather than embedding a
// timer here, so `setTimeout` scheduling stays entirely in server.js.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // excludes I/O to avoid confusion with 1/0
const CODE_LENGTH = 4;
const MAX_CODE_ATTEMPTS = 10;

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

export function createRoom(code, hostSocketId) {
  return {
    code,
    phase: "waiting", // waiting -> full-not-ready -> starting -> active -> over
    players: {
      p1: { socketId: hostSocketId, connected: true, ready: false },
      p2: null,
    },
    winner: null,
    winReason: null,
  };
}

export function joinRoom(room, socketId) {
  if (room.phase !== "waiting") {
    return { room, error: room.phase === "full-not-ready" || room.phase === "starting" || room.phase === "active" ? "ROOM_FULL" : "ROOM_ALREADY_OVER" };
  }
  const next = {
    ...room,
    phase: "full-not-ready",
    players: { ...room.players, p2: { socketId, connected: true, ready: false } },
  };
  return { room: next, error: null };
}

export function setReady(room, playerId, ready) {
  if (room.phase !== "full-not-ready") return room; // ready-up only matters pre-match
  const next = {
    ...room,
    players: { ...room.players, [playerId]: { ...room.players[playerId], ready } },
  };
  const bothReady = next.players.p1?.ready && next.players.p2?.ready;
  return bothReady ? { ...next, phase: "starting" } : next;
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

// Returns { room, deleted } -- `deleted: true` means the caller should
// remove this room from its active-rooms map entirely.
export function handleDisconnect(room, socketId, now) {
  const disconnectedId = room.players.p1?.socketId === socketId ? "p1" : room.players.p2?.socketId === socketId ? "p2" : null;
  if (!disconnectedId) return { room, deleted: false }; // not a player in this room

  if (room.phase === "waiting") {
    // Only the host was ever present -- nothing to preserve.
    return { room, deleted: true };
  }

  if (room.phase === "full-not-ready" || room.phase === "starting") {
    // Revert to waiting, same code, keep the remaining player's slot as p1
    // so a fresh joiner always lands in the p2 slot consistently.
    const remainingId = disconnectedId === "p1" ? "p2" : "p1";
    const remaining = room.players[remainingId];
    return {
      room: {
        ...room,
        phase: "waiting",
        players: { p1: { ...remaining, ready: false }, p2: null },
      },
      deleted: false,
    };
  }

  if (room.phase === "active") {
    const winnerId = disconnectedId === "p1" ? "p2" : "p1";
    return { room: recordMatchOver(room, winnerId, "opponent_disconnected"), deleted: false };
  }

  // "over" -- match already concluded, nothing to change.
  return { room, deleted: false };
}
