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

// `ranked` marks a room as matched via the Ranked queue rather than casual
// Quick Play/private codes -- see findJoinableRoom (kept in a separate pool
// from casual rooms so the two queues never cross-match) and addBot (no
// bots allowed in a ranked room; see that function's own comment).
// Everything else about a ranked room's lifecycle (phases, ready-up,
// MAX_PLAYERS, disconnect handling) is identical to a casual one -- only
// server.js treats a ranked match's result differently once it's over
// (updating Elo rating on top of the usual stats/currency).
export function createRoom(code, hostSocketId, ranked = false) {
  const players = { p1: { socketId: hostSocketId, connected: true, ready: false } };
  for (const slot of PLAYER_SLOTS.slice(1)) players[slot] = null;
  return {
    code,
    phase: "waiting", // waiting -> full -> starting -> active -> over
    players,
    spectators: [], // socketIds only -- see addSpectator's own comment for why no ready/connected tracking is needed here
    ranked,
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

// Used by the server's public matchmaking entry points (Quick Play and
// Ranked): picks an existing room still open for more players instead of
// always spinning up a fresh one, so unrelated players actually land in the
// same match rather than each getting their own empty room. Works the same
// whether the room currently has 1, 2, or 3 players in it -- anything short
// of MAX_PLAYERS. `ranked` keeps the two queues from ever cross-matching --
// a casual Quick Play search never returns a ranked room and vice versa.
export function findJoinableRoom(roomList, ranked = false) {
  return roomList.find((room) => room.phase === "waiting" && !!room.ranked === ranked) ?? null;
}

// Spectators watch a room's broadcasts (lobby state pre-match, then
// MATCH_STATE/MATCH_EVENT once a match is live) without occupying one of
// the MAX_PLAYERS seats -- server.js's fallback for anyone who tries to
// join a room that's already full/starting/active (see joinRoom's
// ROOM_FULL error) instead of just bouncing them with nothing to do.
// Unlike `players`, a spectator has no ready/connected bookkeeping: they're
// either in this list (watching) or not (see removeSpectator) -- no
// reconnection grace period, no seat to hold open.
export function addSpectator(room, socketId) {
  if (room.spectators.includes(socketId)) return room;
  return { ...room, spectators: [...room.spectators, socketId] };
}

export function removeSpectator(room, socketId) {
  if (!room.spectators.includes(socketId)) return room;
  return { ...room, spectators: room.spectators.filter((id) => id !== socketId) };
}

// Called whenever a pre-match roster change could have opened up a seat (a
// disconnect compacting the roster, or a rematch resetting to a fresh
// lobby) -- pulls waiting spectators into any now-open slots, FIFO ("first
// to ask to spectate, first offered a seat"), so landing in a full room
// doesn't mean "you can only ever watch, never play". Deliberately never
// promotes into "starting" (mid-countdown; the ready-up semantics for a
// player added that late aren't defined) or a live match (joinRoom already
// routes that whole case to spectating in the first place, never here).
export function promoteSpectators(room) {
  if (room.phase !== "waiting" && room.phase !== "full") return { room, promoted: [] };
  let players = room.players;
  let spectators = room.spectators;
  const promoted = [];
  for (const slot of PLAYER_SLOTS) {
    if (players[slot]) continue;
    if (spectators.length === 0) break;
    const [socketId, ...rest] = spectators;
    spectators = rest;
    players = { ...players, [slot]: { socketId, connected: true, ready: false } };
    promoted.push({ socketId, playerId: slot });
  }
  if (promoted.length === 0) return { room, promoted: [] };
  const filled = PLAYER_SLOTS.filter((id) => players[id]).length;
  const phase = filled >= MAX_PLAYERS ? "full" : "waiting";
  return { room: { ...room, phase, players, spectators }, promoted };
}

// A bot occupies a real seat (counts toward MAX_PLAYERS, gets a spawn
// position, shows up in the scoreboard) but has no socket -- `socketId:
// null` is how every socketId-keyed lookup elsewhere (broadcastToRoom,
// reconcilePlayerIdsForRoom, disconnect-by-socketId) already safely no-ops
// for it without needing bot-specific branches sprinkled through server.js.
// Always seated as ready: true since there's no human to wait on.
// `difficulty` is stored as-is (room.js doesn't know or care what
// difficulties exist -- server.js validates the requested value against
// bot.js's BOT_DIFFICULTIES before ever calling this, same layering as
// everywhere else pure state lives separately from the catalog it refers to).
export function addBot(room, difficulty = "medium") {
  if (room.ranked) return { room, error: "RANKED_NO_BOTS", slot: null }; // ranked rating only means something between real opponents
  if (room.phase !== "waiting" && room.phase !== "full") return { room, error: "ROOM_NOT_JOINABLE", slot: null };
  const slot = PLAYER_SLOTS.find((id) => !room.players[id]);
  if (!slot) return { room, error: "ROOM_FULL", slot: null };
  const players = { ...room.players, [slot]: { socketId: null, isBot: true, botDifficulty: difficulty, connected: true, ready: true } };
  const filled = PLAYER_SLOTS.filter((id) => players[id]).length;
  const phase = filled >= MAX_PLAYERS ? "full" : "waiting";
  return { room: { ...room, phase, players }, error: null, slot };
}

// Deliberately restricted to the same pre-match phases as addBot -- pulling
// a bot out mid-countdown or mid-match would leave setReady/the live sim in
// an undefined state no other code path expects. Not compacted down to a
// contiguous prefix afterward (unlike a human disconnect) since that would
// mean silently renumbering OTHER seated players' ids out from under them
// for what's a much rarer, deliberate action -- joinRoom already finds the
// next open slot regardless of gaps, so a freed slot doesn't go to waste.
export function removeBot(room, slot) {
  if (room.phase !== "waiting" && room.phase !== "full") return room;
  if (!room.players[slot]?.isBot) return room;
  const players = { ...room.players, [slot]: null };
  const filled = PLAYER_SLOTS.filter((id) => players[id]).length;
  const phase = filled >= MAX_PLAYERS ? "full" : "waiting";
  return { ...room, phase, players };
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
  if (!disconnectedId) {
    // Not a seated player -- might still be a spectator, who needs no
    // phase/roster handling beyond just being dropped from the list.
    const spectators = room.spectators.filter((id) => id !== socketId);
    if (spectators.length === room.spectators.length) return { room, deleted: false, disconnectedId: null }; // wasn't in this room at all
    return { room: { ...room, spectators }, deleted: false, disconnectedId: null };
  }

  const remainingIds = activePlayerIds(room).filter((id) => id !== disconnectedId);
  // A bot never disconnects on its own, so it can't be relied on to ever
  // trigger this cleanup again later -- if every HUMAN is gone, the whole
  // room (any remaining bots included) is torn down right here regardless
  // of phase, rather than leaving a bot-only room (or, worse, a bot-vs-bot
  // match that will run to completion with no one left to see it) orphaned
  // forever with nothing left to ever call handleDisconnect on it again.
  const remainingHumanIds = remainingIds.filter((id) => !room.players[id]?.isBot);
  if (remainingHumanIds.length === 0) {
    return { room, deleted: true, disconnectedId };
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
    // Their slot is vacated here too (not left stale) -- otherwise a later
    // rematch() would still count them as present via activePlayerIds and
    // wait forever for a ready-up that can never come from a socket that's
    // already gone.
    const winnerId = remainingIds[0] ?? null;
    return {
      room: { ...room, phase: "over", players: { ...room.players, [disconnectedId]: null }, winner: winnerId, winReason: "opponent_disconnected" },
      deleted: false,
      disconnectedId,
    };
  }

  // Every other phase (waiting / full / starting / over): remove the slot
  // and compact the rest down to a contiguous p1... prefix, so a fresh
  // joiner (or a later rematch()) always finds a clean roster. "over" is
  // included here -- a finished room can now go back to a live lobby via
  // rematch(), so a stale disconnected-but-still-seated player must not
  // silently keep occupying a slot once that happens. Only pre-match phases
  // actually revert to "waiting"; a still-"over" room stays "over" until
  // someone explicitly rematches. (remainingIds can't be empty here -- that
  // would mean remainingHumanIds is also empty, already returned above.)
  const players = {};
  remainingIds.forEach((id, i) => {
    players[PLAYER_SLOTS[i]] = { ...room.players[id], ready: false };
  });
  for (const slot of PLAYER_SLOTS.slice(remainingIds.length)) players[slot] = null;

  const phase = room.phase === "over" ? "over" : "waiting";
  return { room: { ...room, phase, players }, deleted: false, disconnectedId };
}

// Returns a finished room to a fresh pre-match lobby with the SAME roster
// (whoever is still connected), ready flags reset and winner/winReason
// cleared -- used by the "Rematch" button so a group doesn't have to
// re-matchmake from scratch to play again. Slot compaction (if needed)
// already happened via handleDisconnect while the match was wrapping up;
// this only resets state, it doesn't touch slot assignment.
export function rematch(room) {
  if (room.phase !== "over") return room;
  const activeIds = activePlayerIds(room);
  const players = {};
  for (const id of PLAYER_SLOTS) {
    players[id] = room.players[id] ? { ...room.players[id], ready: false } : null;
  }
  const phase = activeIds.length >= MAX_PLAYERS ? "full" : "waiting";
  return { ...room, phase, players, winner: null, winReason: null };
}
