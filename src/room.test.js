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
});

check("joinRoom transitions waiting -> full-not-ready and assigns the joiner to p2", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const { room: joined, error } = R.joinRoom(room, "socket-2");
  assert.equal(error, null);
  assert.equal(joined.phase, "full-not-ready");
  assert.equal(joined.players.p2.socketId, "socket-2");
});

check("joinRoom rejects a third player with ROOM_FULL", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  const { room: after, error } = R.joinRoom(room, "socket-3");
  assert.equal(error, "ROOM_FULL");
  assert.equal(after.players.p2.socketId, "socket-2", "the original second player should be untouched");
});

check("a round doesn't start until BOTH players are ready", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  assert.equal(room.phase, "full-not-ready", "only one player ready should not start the match");
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting", "both ready should move to starting");
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
  const { deleted } = R.handleDisconnect(room, "socket-1", 0);
  assert.equal(deleted, true);
});

check("disconnect pre-match reverts to waiting with the same code, remaining player becomes p1", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  const { room: after, deleted } = R.handleDisconnect(room, "socket-1", 0); // host (p1) leaves
  assert.equal(deleted, false);
  assert.equal(after.phase, "waiting");
  assert.equal(after.code, "ABCD", "room code must be preserved, not regenerated");
  assert.equal(after.players.p1.socketId, "socket-2", "the remaining player becomes p1");
  assert.equal(after.players.p1.ready, false, "ready state should reset");
  assert.equal(after.players.p2, null);
});

check("disconnect during ready-countdown also reverts to waiting (not just full-not-ready)", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  assert.equal(room.phase, "starting");
  const { room: after } = R.handleDisconnect(room, "socket-2", 0);
  assert.equal(after.phase, "waiting");
});

check("disconnect during an active match ends the WHOLE match in favor of the remaining player, not just the current moment", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);
  assert.equal(room.phase, "active");

  const { room: after, deleted } = R.handleDisconnect(room, "socket-2", 0); // p2 leaves mid-match
  assert.equal(deleted, false);
  assert.equal(after.phase, "over");
  assert.equal(after.winner, "p1");
  assert.equal(after.winReason, "opponent_disconnected");
});

check("disconnect from a socket that isn't actually in the room is a no-op", () => {
  const room = R.createRoom("ABCD", "socket-1");
  const { room: after, deleted } = R.handleDisconnect(room, "some-other-socket", 0);
  assert.equal(deleted, false);
  assert.deepEqual(after, room);
});

check("recordMatchOver and further disconnects after the match is over are no-ops", () => {
  let room = R.createRoom("ABCD", "socket-1");
  ({ room } = R.joinRoom(room, "socket-2"));
  room = R.setReady(room, "p1", true);
  room = R.setReady(room, "p2", true);
  room = R.beginMatch(room);
  room = R.recordMatchOver(room, "p1", "won");
  assert.equal(room.phase, "over");

  const stillOver = R.recordMatchOver(room, "p2", "won");
  assert.equal(stillOver.winner, "p1", "recordMatchOver should be a no-op once already over");

  const { room: after } = R.handleDisconnect(room, "socket-1", 0);
  assert.equal(after.phase, "over", "a disconnect after the match is already over should not change anything");
});

console.log(`\n${passed} room.js assertions passed`);
