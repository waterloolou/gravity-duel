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
  PURCHASE_UNLOCK: "purchase_unlock",
  EQUIP_LOADOUT: "equip_loadout",
  PURCHASE_UPGRADE: "purchase_upgrade",
  REQUEST_REMATCH: "request_rematch",
  SET_DISPLAY_NAME: "set_display_name",
  REQUEST_LEADERBOARD: "request_leaderboard",
  ADD_BOT: "add_bot",
  REMOVE_BOT: "remove_bot",

  // Server -> Client
  ROOM_CREATED: "room_created",
  ROOM_JOINED: "room_joined",
  SPECTATING: "spectating", // sent instead of ROOM_JOINED when JOIN_ROOM lands on a full/in-progress room -- see room.js's addSpectator
  LOBBY_STATE: "lobby_state",
  ERROR: "error",
  MATCH_STARTING: "match_starting",
  MATCH_STATE: "match_state",
  MATCH_EVENT: "match_event",
  PROFILE_STATE: "profile_state",
  LEADERBOARD_STATE: "leaderboard_state",
  CHALLENGE_COMPLETED: "challenge_completed",
};

export const ERROR_CODES = {
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  ROOM_FULL: "ROOM_FULL",
  ROOM_ALREADY_OVER: "ROOM_ALREADY_OVER",
  INVALID_CODE: "INVALID_CODE",
  SERVER_FULL: "SERVER_FULL",
  ALREADY_IN_ROOM: "ALREADY_IN_ROOM",
  INSUFFICIENT_CURRENCY: "INSUFFICIENT_CURRENCY",
  ALREADY_UNLOCKED: "ALREADY_UNLOCKED",
  NOT_UNLOCKED: "NOT_UNLOCKED",
  UNKNOWN_LOADOUT_ID: "UNKNOWN_LOADOUT_ID",
  MAX_LEVEL_REACHED: "MAX_LEVEL_REACHED",
  INVALID_NAME: "INVALID_NAME",
  ROOM_NOT_JOINABLE: "ROOM_NOT_JOINABLE",
};

export const MATCH_STARTING_COUNTDOWN_MS = 3000;
