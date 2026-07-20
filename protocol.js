// Shared WebSocket message-type constants, imported unmodified by both
// server.js (Node) and the browser client (native ES module, no bundler) --
// kills an entire class of "server sends X, client listens for Y" typos.

export const MSG = {
  // Client -> Server
  CREATE_ROOM: "create_room",
  JOIN_ROOM: "join_room",
  QUICK_JOIN: "quick_join",
  SET_READY: "set_ready",
  LEAVE_ROOM: "leave_room",
  PLAYER_INPUT: "player_input",
  IDENTIFY: "identify",

  // Server -> Client
  ROOM_CREATED: "room_created",
  ROOM_JOINED: "room_joined",
  LOBBY_STATE: "lobby_state",
  ERROR: "error",
  MATCH_STARTING: "match_starting",
  MATCH_STATE: "match_state",
  MATCH_EVENT: "match_event",
  PROFILE_STATE: "profile_state",
};

export const ERROR_CODES = {
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  ROOM_FULL: "ROOM_FULL",
  ROOM_ALREADY_OVER: "ROOM_ALREADY_OVER",
  INVALID_CODE: "INVALID_CODE",
  SERVER_FULL: "SERVER_FULL",
  ALREADY_IN_ROOM: "ALREADY_IN_ROOM",
};

export const MATCH_STARTING_COUNTDOWN_MS = 3000;
