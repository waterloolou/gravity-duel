import assert from "node:assert/strict";
import * as R from "./room.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("generateRoomCode produces a code of the expected length from the safe alphabet", () => {
  const code = R.generateRoomCode(() => false);
  assert.equal(code.length, 4);
  assert.ok(!/[IO01]/.test(code), "code should never contain visually-confusable I/O/0/1");
});

check("generateRoomCode retries on collision and eventually gives up if every attempt collides", () => {
  let calls = 0;
  const alwaysTaken = () => {
    calls++;
    return true;
  };
  const code = R.generateRoomCode(alwaysTaken);
  assert.equal(code, null, "should return null rather than loop forever");
  assert.ok(calls <= 10, "should be bounded, not unbounded retries");
});

check("createRoom starts in the waiting phase with only the host present", () => {
  const room = R.createRoom("ABCD", "socket-1");
  assert.equal(room.phase, "waiting");
  assert.equal(room.players.p1.socketId, "socket-1");
  assert.equal(room.players.p2, null);
  assert.equal(room.players.p3, null);
  assert.equal(room.players.p4, null);
  assert.deepEqual(room.spectators, []);
});

check("joinRoom fills the next open slot and stays joinable below capacity", () => {
  let room = R.createRoom("ABCD", "socket-1");
  let joined = R.joinRoom(room, "socket-2");
  assert.equal(joined.error, null);
  assert.equal(joined.playerId, "p2");
  assert.equal(joined.room.phase, "waiting", "still joinable with only 2 of 4 seats filled");
  room = joined.room;

  joined = R.joinRoom(room, "socket-3");
  assert.equal(joined.playerId, "p3");
  assert.equal(joined.room.phase, "waiting", "still joinable with only 3 of 4 seats filled");
  room = joined.room;

  joined = R.joinRoom(room, "socket-4");
  assert.equal(joined.playerId, "p4");
  assert.equal(joined.room.phase, "full", "4th join fills the lobby");
});

check("joinRoom rejects a 5th player once the lobby is full", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  ({ room } = R.joinRoom(room, "socket-4"));
  const { room: after, error } = R.joinRoom(room, "socket-5");
  assert.equal(error, "ROOM_FULL");
  assert.equal(after.players.p4.socketId, "socket-4", "the original 4th player should be untouched");
});

check("findJoinableRoom picks a waiting room (any size below capacity) and ignores full/in-progress ones", () => {
  let full = R.createRoom("BBBB", "socket-2");
  ({ room: full } = R.joinRoom(full, "socket-3"));
  ({ room: full } = R.joinRoom(full, "socket-4"));
  ({ room: full } = R.joinRoom(full, "socket-5"));
  const threeOfFour = R.createRoom("CCCC", "socket-6");
  const { room: partial } = R.joinRoom(threeOfFour, "socket-7");
  assert.equal(R.findJoinableRoom([full, partial]), partial);
});

check("findJoinableRoom returns null when nothing is joinable", () => {
  let full = R.createRoom("AAAA", "socket-1");
  ({ room: full } = R.joinRoom(full, "socket-2"));
  ({ room: full } = R.joinRoom(full, "socket-3"));
  ({ room: full } = R.joinRoom(full, "socket-4"));
  assert.equal(R.findJoinableRoom([full]), null);
  assert.equal(R.findJoinableRoom([]), null);
});

check("a match doesn't start until EVERY currently-seated player is ready", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  room = R.setReady(room, "p1", true);
  assert.equal(room.phase, "waiting", "one of three ready should not start the match");
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "waiting", "two of three ready should not start the match");
  room = R.setReady(room, "p3", true);
  assert.equal(room.phase, "starting", "all three seated players ready should start the match");
});

check("a match can start with only 2 players -- it doesn't have to wait for the lobby to fill to 4", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
});

check("setReady is a no-op while only the host is seated (nothing to ready up against)", () => {
  let room = R.createRoom("ABCD", "socket-1");
  const after = R.setReady(room, "p1", true);
  assert.equal(after.players.p1.ready, false);
  assert.equal(after.phase, "waiting");
});

check("beginMatch only fires from the starting phase", () => {
  let room = R.createRoom("ABCD", "socket-1");
  const unchanged = R.beginMatch(room); // still "waiting", not "starting"
  assert.equal(unchanged.phase, "waiting", "beginMatch should be a no-op outside the starting phase");

  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
  room = R.beginMatch(room);
  assert.equal(room.phase, "active");
});

check("disconnect while only the host is present deletes the room", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const { deleted, disconnectedId } = R.handleDisconnect(room, "socket-1", 0);
  assert.equal(deleted, true);
  assert.equal(disconnectedId, "p1");
});

check("disconnect pre-match reverts to waiting with the same code, remaining player becomes p1", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  const { room: after, deleted, disconnectedId } = R.handleDisconnect(room, "socket-1", 0); // host (p1) leaves
  assert.equal(deleted, false);
  assert.equal(disconnectedId, "p1");
  assert.equal(after.phase, "waiting");
  assert.equal(after.code, "ABCD", "room code must be preserved, not regenerated");
  assert.equal(after.players.p1.socketId, "socket-2", "the remaining player becomes p1");
  assert.equal(after.players.p1.ready, false, "ready state should reset");
  assert.equal(after.players.p2, null);
});

check("disconnect pre-match with 3 players compacts the remaining two down to p1/p2 and resets ready", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  room = R.setReady(room, "p1", true); // p1 (socket-1) readies, then leaves
  const { room: after } = R.handleDisconnect(room, "socket-1", 0);
  assert.equal(after.phase, "waiting");
  assert.equal(after.players.p1.socketId, "socket-2");
  assert.equal(after.players.p2.socketId, "socket-3");
  assert.equal(after.players.p3, null);
  assert.equal(after.players.p1.ready, false, "surviving players' ready state resets on any roster change");
  assert.equal(after.players.p2.ready, false);
});

check("disconnect during ready-countdown also reverts to waiting (not just the pre-ready lobby phases)", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
  const { room: after } = R.handleDisconnect(room, "socket-2", 0);
  assert.equal(after.phase, "waiting");
});

check("disconnect during an active 1v1 match ends the WHOLE match in favor of the remaining player", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);
  assert.equal(room.phase, "active");

  const { room: after, deleted, disconnectedId } = R.handleDisconnect(room, "socket-2", 0); // p2 leaves mid-match
  assert.equal(deleted, false);
  assert.equal(disconnectedId, "p2");
  assert.equal(after.phase, "over");
  assert.equal(after.winner, "p1");
  assert.equal(after.winReason, "opponent_disconnected");
});

check("disconnect during an active 1v1 match vacates the loser's slot too, not just the winner's phase/score", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);

  const { room: after } = R.handleDisconnect(room, "socket-2", 0);
  assert.equal(after.phase, "over");
  assert.equal(after.players.p2, null, "the departed player's slot must be vacated, not left stale");
  assert.equal(after.players.p1.socketId, "socket-1", "the winner's own slot should be untouched");
  // A stale-but-truthy p2 would make rematch() count them as still present
  // (via activePlayerIds) and wait forever for a ready-up from a socket
  // that's already gone -- this is what that would have softlocked.
  const rematched = R.rematch(after);
  assert.equal(rematched.phase, "waiting", "only p1 remains, so the room should be open for new players, not still counting a ghost p2");
  assert.equal(rematched.players.p2, null);
});

check("disconnect during an active FFA match with 3+ remaining players just vacates the slot and keeps playing", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.setReady(room, "p3", true);
  room = R.beginMatch(room);
  assert.equal(room.phase, "active");

  const { room: after, deleted, disconnectedId } = R.handleDisconnect(room, "socket-2", 0); // p2 leaves mid-match
  assert.equal(deleted, false);
  assert.equal(disconnectedId, "p2");
  assert.equal(after.phase, "active", "match should continue -- 2 players are still connected");
  assert.equal(after.winner, null);
  assert.equal(after.players.p2, null, "the departed player's slot should be vacated");
  assert.equal(after.players.p1.socketId, "socket-1", "remaining slots are untouched, not renumbered");
  assert.equal(after.players.p3.socketId, "socket-3");
});

check("disconnects during an active FFA match down to the last player ends it in their favor", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.setReady(room, "p3", true);
  room = R.beginMatch(room);

  ({ room } = R.handleDisconnect(room, "socket-2", 0));
  assert.equal(room.phase, "active");
  const { room: after } = R.handleDisconnect(room, "socket-3", 0);
  assert.equal(after.phase, "over");
  assert.equal(after.winner, "p1");
  assert.equal(after.winReason, "opponent_disconnected");
});

check("disconnect from a socket that isn't actually in the room is a no-op", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const { room: after, deleted, disconnectedId } = R.handleDisconnect(room, "some-other-socket", 0);
  assert.equal(deleted, false);
  assert.equal(disconnectedId, null);
  assert.deepEqual(after, room);
});

check("recordMatchOver is a no-op once the room is already over", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);
  room = R.recordMatchOver(room, "p1", "won");
  assert.equal(room.phase, "over");

  const stillOver = R.recordMatchOver(room, "p2", "won");
  assert.equal(stillOver.winner, "p1", "recordMatchOver should be a no-op once already over");
});

check("a disconnect after the match is over vacates that seat but stays over (until a rematch)", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.setReady(room, "p3", true);
  room = R.beginMatch(room);
  room = R.recordMatchOver(room, "p1", "won");

  const { room: after, deleted } = R.handleDisconnect(room, "socket-2", 0); // p2 leaves after the match ended
  assert.equal(deleted, false);
  assert.equal(after.phase, "over", "should still read as over, not silently reopen for matchmaking");
  assert.equal(after.winner, "p1", "the recorded result shouldn't change");
  // Compacted like any other departure -- p3 (still connected) should not be
  // left as a stale ghost seat that a later rematch() would incorrectly count.
  assert.equal(after.players.p1.socketId, "socket-1");
  assert.equal(after.players.p2.socketId, "socket-3");
  assert.equal(after.players.p3, null);
});

check("rematch resets a finished room to a fresh lobby with the same roster", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);
  room = R.recordMatchOver(room, "p2", "won");

  const after = R.rematch(room);
  assert.equal(after.phase, "waiting", "2 of 4 seats filled -- still short of MAX_PLAYERS, so joinable again");
  assert.equal(after.winner, null);
  assert.equal(after.winReason, null);
  assert.equal(after.players.p1.socketId, "socket-1", "same roster, not re-matchmade");
  assert.equal(after.players.p2.socketId, "socket-2");
  assert.equal(after.players.p1.ready, false, "ready flags reset -- everyone has to ready up again");
  assert.equal(after.players.p2.ready, false);
});

check("rematch goes to full (not waiting) when the finished room was already at capacity", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  ({ room } = R.joinRoom(room, "socket-4"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.setReady(room, "p3", true);
  room = R.setReady(room, "p4", true);
  room = R.beginMatch(room);
  room = R.recordMatchOver(room, "p1", "won");

  const after = R.rematch(room);
  assert.equal(after.phase, "full", "4 of 4 seats filled -- not joinable, straight back to ready-up");
});

check("rematch is a no-op outside the over phase", () => {
  const room = R.createRoom("ABCD", "socket-1");
  assert.equal(R.rematch(room), room);
});

check("addSpectator appends a socketId and is idempotent for a duplicate", () => {
  let room = R.createRoom("ABCD", "socket-1");
  room = R.addSpectator(room, "spec-1");
  assert.deepEqual(room.spectators, ["spec-1"]);
  room = R.addSpectator(room, "spec-2");
  assert.deepEqual(room.spectators, ["spec-1", "spec-2"]);
  const again = R.addSpectator(room, "spec-1");
  assert.equal(again, room, "adding an already-present spectator should return the same reference, not a needless copy");
});

check("removeSpectator drops a socketId and no-ops for one that isn't present", () => {
  let room = R.createRoom("ABCD", "socket-1");
  room = R.addSpectator(room, "spec-1");
  room = R.addSpectator(room, "spec-2");
  const after = R.removeSpectator(room, "spec-1");
  assert.deepEqual(after.spectators, ["spec-2"]);
  assert.equal(R.removeSpectator(after, "not-a-spectator"), after, "should return the same reference when the id isn't present");
});

check("handleDisconnect removes a spectator without touching players or phase", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.addSpectator(room, "spec-1");
  const { room: after, deleted, disconnectedId } = R.handleDisconnect(room, "spec-1", 0);
  assert.equal(deleted, false);
  assert.equal(disconnectedId, null, "a spectator leaving is not a seated player, so there's no ship/slot to clean up");
  assert.deepEqual(after.spectators, []);
  assert.equal(after.phase, "waiting");
  assert.equal(after.players.p1.socketId, "socket-1", "players should be completely untouched");
  assert.equal(after.players.p2.socketId, "socket-2");
});

check("promoteSpectators is a no-op with nobody waiting to be promoted", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const { room: after, promoted } = R.promoteSpectators(room);
  assert.equal(after, room, "should return the same reference, not a needless copy");
  assert.deepEqual(promoted, []);
});

check("promoteSpectators pulls waiting spectators into open seats, FIFO, and reports who got promoted", () => {
  let room = R.createRoom("ABCD", "socket-1"); // p1 filled, p2-p4 open
  room = R.addSpectator(room, "spec-1");
  room = R.addSpectator(room, "spec-2");
  const { room: after, promoted } = R.promoteSpectators(room);
  assert.deepEqual(promoted, [
    { socketId: "spec-1", playerId: "p2" },
    { socketId: "spec-2", playerId: "p3" },
  ]);
  assert.equal(after.players.p2.socketId, "spec-1");
  assert.equal(after.players.p3.socketId, "spec-2");
  assert.equal(after.players.p2.ready, false);
  assert.deepEqual(after.spectators, [], "promoted spectators should be removed from the spectator list");
  assert.equal(after.phase, "waiting", "still short of MAX_PLAYERS");
});

check("promoteSpectators stops once seats run out, leaving the rest still spectating", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  // Only p4 is open.
  room = R.addSpectator(room, "spec-1");
  room = R.addSpectator(room, "spec-2");
  const { room: after, promoted } = R.promoteSpectators(room);
  assert.deepEqual(promoted, [{ socketId: "spec-1", playerId: "p4" }]);
  assert.equal(after.players.p4.socketId, "spec-1");
  assert.deepEqual(after.spectators, ["spec-2"], "spec-2 should still be waiting -- no seat left for them");
  assert.equal(after.phase, "full", "filling the last seat should flip the room to full");
});

check("promoteSpectators never promotes into a starting, active, or over room", () => {
  for (const phase of ["starting", "active", "over"]) {
    let room = R.createRoom("ABCD", "socket-1");
    ({ room } = R.joinRoom(room, "socket-2"));
    room = R.addSpectator(room, "spec-1");
    room = { ...room, phase }; // force the phase directly -- only the promotion boundary is under test here
    const { room: after, promoted } = R.promoteSpectators(room);
    assert.deepEqual(promoted, [], `should not promote while phase is "${phase}"`);
    assert.deepEqual(after.spectators, ["spec-1"]);
  }
});

check("addBot fills the next open slot as an always-ready bot", () => {
  let room = R.createRoom("ABCD", "socket-1"); // p1 filled, p2-p4 open
  const { room: after, error, slot } = R.addBot(room);
  assert.equal(error, null);
  assert.equal(slot, "p2");
  assert.equal(after.players.p2.isBot, true);
  assert.equal(after.players.p2.ready, true, "a bot needs no human to wait on, so it's ready from the moment it's seated");
  assert.equal(after.players.p2.socketId, null);
  assert.equal(after.phase, "waiting", "still short of MAX_PLAYERS");
});

check("addBot flips the room to full once it fills the last seat", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  const { room: after } = R.addBot(room); // fills p4, the last seat
  assert.equal(after.phase, "full");
});

check("addBot rejects a room that's already full", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  ({ room } = R.joinRoom(room, "socket-4"));
  const { room: after, error, slot } = R.addBot(room);
  assert.equal(error, "ROOM_FULL");
  assert.equal(slot, null);
  assert.equal(after, room, "should return the same reference on failure");
});

check("addBot rejects a room that isn't in a pre-match phase", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
  const { error } = R.addBot(room);
  assert.equal(error, "ROOM_NOT_JOINABLE");
});

check("a room can start (and ready-up counts a bot as already ready) with just one human and a bot", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.addBot(room));
  room = R.setReady(room, "p1", true);
  assert.equal(room.phase, "starting", "the bot's own ready:true plus the human readying up should be enough to start");
});

check("removeBot vacates a bot's slot and reopens a full room", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.joinRoom(room, "socket-3"));
  ({ room } = R.addBot(room)); // fills p4 -> full
  assert.equal(room.phase, "full");
  const after = R.removeBot(room, "p4");
  assert.equal(after.players.p4, null);
  assert.equal(after.phase, "waiting");
});

check("removeBot is a no-op on a slot that isn't actually a bot", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const after = R.removeBot(room, "p1"); // p1 is socket-1, a real player
  assert.equal(after, room, "should return the same reference, not a needless copy");
});

check("removeBot is a no-op outside a pre-match phase", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.addBot(room));
  room = R.setReady(room, "p1", true);
  assert.equal(room.phase, "starting");
  const after = R.removeBot(room, "p2");
  assert.equal(after, room);
});

check("a human disconnecting from a room with only bots left tears the whole room down", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.addBot(room));
  ({ room } = R.addBot(room));
  const { deleted, disconnectedId } = R.handleDisconnect(room, "socket-1", 0);
  assert.equal(deleted, true, "bots can't disconnect on their own, so nothing would ever clean this room up otherwise");
  assert.equal(disconnectedId, "p1");
});

check("a human disconnecting mid-active-match with only a bot remaining also tears the room down immediately, not left running bot-vs-bot", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  ({ room } = R.addBot(room));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
  room = R.beginMatch(room);
  assert.equal(room.phase, "active");

  // socket-2 (human) leaves; only the bot (p3) and socket-1 (human) remain --
  // still fine, should NOT delete.
  let deleted;
  ({ room, deleted } = R.handleDisconnect(room, "socket-2", 0));
  assert.equal(deleted, false, "socket-1 is still a human playing against the bot -- should keep going");
  assert.equal(room.phase, "active");

  // Now socket-1 (the last human) also leaves -- only the bot remains.
  ({ deleted } = R.handleDisconnect(room, "socket-1", 0));
  assert.equal(deleted, true, "no humans left at all -- should tear the room down rather than let bots fight on for no one");
});

check("createRoom defaults to unranked; a ranked room can be created explicitly", () => {
  const casual = R.createRoom("ABCD", "socket-1");
  assert.equal(casual.ranked, false);
  const ranked = R.createRoom("ABCD", "socket-1", true);
  assert.equal(ranked.ranked, true);
});

check("findJoinableRoom never cross-matches a casual search into a ranked room or vice versa", () => {
  const casual = R.createRoom("CASL", "socket-1");
  const rankedRoom = R.createRoom("RANK", "socket-2", true);
  assert.equal(R.findJoinableRoom([rankedRoom], false), null, "a casual search should not find a ranked room");
  assert.equal(R.findJoinableRoom([casual], true), null, "a ranked search should not find a casual room");
  assert.equal(R.findJoinableRoom([casual, rankedRoom], false), casual);
  assert.equal(R.findJoinableRoom([casual, rankedRoom], true), rankedRoom);
});

check("addBot refuses to add a bot to a ranked room, regardless of phase", () => {
  const room = R.createRoom("ABCD", "socket-1", true);
  const { room: after, error, slot } = R.addBot(room);
  assert.equal(error, "RANKED_NO_BOTS");
  assert.equal(slot, null);
  assert.equal(after, room, "should return the same reference on failure");
});

console.log(`\n${passed} room.js assertions passed`);
