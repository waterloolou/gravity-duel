// Peer-to-peer networking, so Gravity Duel runs from a static site (GitHub
// Pages) with no game server -- the same approach Cursed Clash uses.
//
// How it works:
//   * Every browser runs its own copy of the game server (game-server.js).
//     Until you join someone else's room, the game talks to that local copy
//     directly, so the Hangar, bots and solo play all work offline.
//   * Creating a room makes your browser the HOST: it registers the room code
//     with the public PeerJS broker, and friends who join connect straight to
//     your browser over WebRTC. Your tab runs the authoritative physics for
//     everyone in the room.
//   * Joining a room connects to the host's browser and sends every message
//     there instead.
//   * Quick Play / Ranked use a handful of well-known "matchmaking slots":
//     join a host already waiting on a slot, or claim a free slot and wait.
//
// Profiles (credits, unlocks, stats) live in each player's own browser
// (localStorage) and are handed to the host on join; the host sends updates
// back, which are saved locally.
//
// To net.js this file looks like a WebSocket: readyState, send(string), and
// "open" / "close" / "message" events.

import { MSG, ERROR_CODES } from "../protocol.js";
import { createGameServer } from "./game-server.js";
import { createProfileStore } from "./profile-store-core.js";

const PEER_PREFIX = "gravityduel-v1-";
const MATCHMAKING_SLOTS = 6;
const CONNECT_TIMEOUT_MS = 6000;
const PROFILES_KEY = "gravityDuel.profiles";
const MAX_SAVED_PROFILES = 200;
export const P2P_HELLO = "p2p_hello"; // host -> joiner, first message on every connection
export const P2P_STATUS = "p2p_status"; // transport -> UI, matchmaking progress text

// Messages a remote player may send to the host's game server. Anything that
// would create or join a different room on the host's browser is refused.
const REMOTE_ALLOWED = new Set([
  MSG.IDENTIFY,
  MSG.JOIN_ROOM,
  MSG.SET_READY,
  MSG.LEAVE_ROOM,
  MSG.PLAYER_INPUT,
  MSG.PURCHASE_UNLOCK,
  MSG.EQUIP_LOADOUT,
  MSG.PURCHASE_UPGRADE,
  MSG.REQUEST_REMATCH,
  MSG.SET_DISPLAY_NAME,
  MSG.REQUEST_LEADERBOARD,
  MSG.ADD_BOT,
  MSG.REMOVE_BOT,
  MSG.SEND_PING,
  MSG.LATENCY_PING,
]);

function peerOptions() {
  const q = new URLSearchParams(location.search);
  const opts = {
    debug: 0,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
        {
          urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"],
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    },
  };
  // Self-hosted PeerJS broker, for testing: ?peerhost=localhost&peerport=9000
  if (q.get("peerhost")) {
    opts.host = q.get("peerhost");
    opts.port = Number(q.get("peerport") || 9000);
    opts.path = q.get("peerpath") || "/";
    opts.secure = q.get("peersecure") === "1";
  }
  return opts;
}

function createBrowserProfileStore() {
  let saveTimer = null;
  const store = createProfileStore({
    onChange: () => {
      if (!saveTimer) saveTimer = setTimeout(save, 500);
    },
  });
  function save() {
    saveTimer = null;
    try {
      const all = Array.from(store.profiles.entries()).slice(-MAX_SAVED_PROFILES);
      localStorage.setItem(PROFILES_KEY, JSON.stringify(Object.fromEntries(all)));
    } catch {
      // Private browsing / storage full: progress just won't survive a reload.
    }
  }
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILES_KEY) || "{}");
    for (const [id, profile] of Object.entries(raw)) store.profiles.set(id, profile);
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  addEventListener("pagehide", () => saveTimer && save());
  return store;
}

export function createP2PTransport() {
  const listeners = { open: [], close: [], message: [] };
  const emit = (type, ev) => listeners[type].forEach((fn) => fn(ev));
  const deliver = (obj) => emit("message", { data: JSON.stringify(obj) });
  const status = (text) => deliver({ type: P2P_STATUS, text });

  const store = createBrowserProfileStore();
  const local = createGameServer({ store, trustClientProfiles: true });
  let myPlayerId = null;
  let remote = null; // DataConnection to another player's hosted room, once joined
  let clientPeer = null; // our anonymous peer for outgoing connections
  let hostPeers = []; // peers accepting joiners for the room we host
  let pendingSlotPeer = null; // a claimed matchmaking slot, waiting for our room to be created
  let busy = false; // a join/matchmaking attempt is in flight

  const localSocketId = local.connect((data) => {
    const msg = JSON.parse(data);
    if (msg.type === MSG.ROOM_CREATED) startHosting(msg.code);
    deliver(msg);
  });

  const peerLibAvailable = () => typeof window.Peer === "function";

  // --- hosting ---------------------------------------------------------------

  function acceptConnection(conn, code) {
    conn.on("open", () => {
      const sid = local.connect((data) => {
        if (conn.open) conn.send(data);
      });
      conn.send(JSON.stringify({ type: P2P_HELLO, ...local.roomSummary(code) }));
      conn.on("data", (raw) => {
        let msg;
        try {
          msg = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          return;
        }
        if (!msg || !REMOTE_ALLOWED.has(msg.type)) return;
        if (msg.type === MSG.JOIN_ROOM && String(msg.code || "").toUpperCase() !== code) return;
        local.message(sid, msg);
      });
      conn.on("close", () => local.disconnect(sid));
      conn.on("error", () => local.disconnect(sid));
    });
  }

  function listenOn(peer, code) {
    peer.on("connection", (conn) => acceptConnection(conn, code));
    hostPeers.push(peer);
  }

  function startHosting(code) {
    if (pendingSlotPeer) {
      listenOn(pendingSlotPeer, code);
      pendingSlotPeer = null;
    }
    if (!peerLibAvailable()) {
      status("Offline: friends can't join right now, but you can play against bots.");
      return;
    }
    const peer = new window.Peer(PEER_PREFIX + code, peerOptions());
    peer.on("open", () => status(""));
    peer.on("error", (err) => {
      if (err?.type === "unavailable-id") status("That room code is already taken online. Leave and create a new room.");
      else if (err?.type === "network" || err?.type === "server-error" || err?.type === "socket-error")
        status("Lost the connection to the matchmaking service; friends may not be able to join.");
    });
    listenOn(peer, code);
  }

  // --- joining ---------------------------------------------------------------

  function getClientPeer() {
    if (clientPeer && !clientPeer.destroyed && clientPeer.open) return Promise.resolve(clientPeer);
    if (!peerLibAvailable()) return Promise.reject(new Error("offline"));
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(undefined, peerOptions());
      const timer = setTimeout(() => reject(new Error("offline")), CONNECT_TIMEOUT_MS * 2);
      peer.on("open", () => {
        clearTimeout(timer);
        clientPeer = peer;
        resolve(peer);
      });
      peer.on("error", (err) => {
        if (!peer.open) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // Connects to a hosted room (or matchmaking slot) and waits for its hello.
  // Resolves null if nobody is there.
  async function tryConnect(peerId) {
    const peer = await getClientPeer();
    return new Promise((resolve) => {
      let settled = false;
      const conn = peer.connect(peerId, { reliable: true, serialization: "raw" });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off("error", onPeerError);
        if (!result) {
          try {
            conn.close();
          } catch {}
        }
        resolve(result);
      };
      const onPeerError = (err) => {
        if (err?.type === "peer-unavailable" && String(err.message || "").includes(peerId)) finish(null);
      };
      const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
      peer.on("error", onPeerError);
      conn.on("data", function onHello(raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type !== P2P_HELLO) return;
        conn.off("data", onHello);
        finish({ conn, hello: msg });
      });
      conn.on("close", () => finish(null));
      conn.on("error", () => finish(null));
    });
  }

  // From now on every message goes to the remote host.
  function adoptRemote(conn, code) {
    remote = conn;
    conn.on("data", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // Progress earned in someone else's room is saved in our browser too.
      if (msg.type === MSG.PROFILE_STATE && msg.profile?.playerId === myPlayerId) store.set(myPlayerId, msg.profile);
      deliver(msg);
    });
    conn.on("close", () => {
      if (remote !== conn) return;
      remote = null;
      deliver({ type: MSG.MATCH_EVENT, event: "room_closed" });
    });
    // The host only knows the profile we bring with us.
    conn.send(JSON.stringify({ type: MSG.IDENTIFY, playerId: myPlayerId, profile: myPlayerId ? store.get(myPlayerId) : undefined }));
    conn.send(JSON.stringify({ type: MSG.JOIN_ROOM, code }));
  }

  async function joinByCode(code) {
    if (local.hasRoom(code)) {
      local.message(localSocketId, { type: MSG.JOIN_ROOM, code });
      return;
    }
    status(`Connecting to room ${code}…`);
    let found = null;
    try {
      found = await tryConnect(PEER_PREFIX + code);
    } catch {
      deliver({ type: MSG.ERROR, code: ERROR_CODES.ROOM_NOT_FOUND, message: "Can't reach the matchmaking service. Check your internet connection." });
      return;
    }
    if (!found) {
      deliver({ type: MSG.ERROR, code: ERROR_CODES.ROOM_NOT_FOUND, message: "No room with that code (the host may have left)." });
      return;
    }
    status("");
    adoptRemote(found.conn, code);
  }

  const joinable = (hello, ranked) =>
    hello && hello.code && hello.phase === "waiting" && !!hello.ranked === ranked && hello.playerCount < hello.maxPlayers;

  function claimSlot(peerId) {
    return new Promise((resolve) => {
      const peer = new window.Peer(peerId, peerOptions());
      const timer = setTimeout(() => {
        peer.destroy();
        resolve(null);
      }, CONNECT_TIMEOUT_MS);
      peer.on("open", () => {
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on("error", (err) => {
        if (peer.open) return;
        clearTimeout(timer);
        peer.destroy();
        resolve(null); // usually "unavailable-id": someone else holds this slot
      });
    });
  }

  async function matchmake(ranked) {
    const kind = ranked ? "ranked" : "quick";
    const createLocal = () => local.message(localSocketId, { type: MSG.CREATE_ROOM, ranked });
    if (!peerLibAvailable()) {
      createLocal();
      return;
    }
    status("Looking for an open match…");
    try {
      await getClientPeer();
    } catch {
      status("Offline: started a room you can fill with bots.");
      createLocal();
      return;
    }
    for (let i = 0; i < MATCHMAKING_SLOTS; i++) {
      const slotId = `${PEER_PREFIX}${kind}-${i}`;
      const found = await tryConnect(slotId);
      if (found) {
        if (joinable(found.hello, ranked)) {
          status("");
          adoptRemote(found.conn, found.hello.code);
          return;
        }
        found.conn.close();
        continue; // that host is mid-match or full
      }
      const claimed = await claimSlot(slotId);
      if (claimed) {
        pendingSlotPeer = claimed;
        status("Waiting for an opponent… (or add bots below)");
        createLocal();
        return;
      }
    }
    status("Every matchmaking slot is busy, so you're hosting a new room. Share its code!");
    createLocal();
  }

  async function browseRooms() {
    if (!peerLibAvailable()) {
      deliver({ type: MSG.ROOM_LIST, rooms: [] });
      return;
    }
    status("Looking for open rooms…");
    const rooms = [];
    try {
      const results = await Promise.all(
        Array.from({ length: MATCHMAKING_SLOTS }, (_, i) => tryConnect(`${PEER_PREFIX}quick-${i}`).catch(() => null))
      );
      for (const r of results) {
        if (!r) continue;
        if (joinable(r.hello, false)) rooms.push({ code: r.hello.code, playerCount: r.hello.playerCount, maxPlayers: r.hello.maxPlayers });
        r.conn.close();
      }
    } catch {}
    status("");
    deliver({ type: MSG.ROOM_LIST, rooms });
  }

  // --- the WebSocket-shaped surface net.js uses -------------------------------

  async function runExclusive(task) {
    if (busy) return;
    busy = true;
    try {
      await task();
    } finally {
      busy = false;
    }
  }

  const transport = {
    readyState: 0,
    addEventListener(type, fn) {
      listeners[type]?.push(fn);
    },
    send(data) {
      const msg = JSON.parse(data);
      if (msg.type === MSG.IDENTIFY) myPlayerId = String(msg.playerId || "") || null;
      if (remote) {
        if (remote.open) remote.send(data);
        return;
      }
      switch (msg.type) {
        case MSG.JOIN_ROOM:
          runExclusive(() => joinByCode(String(msg.code || "").toUpperCase()));
          return;
        case MSG.QUICK_JOIN:
          runExclusive(() => matchmake(false));
          return;
        case MSG.RANKED_JOIN:
          runExclusive(() => matchmake(true));
          return;
        case MSG.REQUEST_ROOM_LIST:
          runExclusive(browseRooms);
          return;
        default:
          local.message(localSocketId, msg);
      }
    },
    close() {
      for (const p of hostPeers) p.destroy();
      clientPeer?.destroy();
    },
  };
  setTimeout(() => {
    transport.readyState = 1; // WebSocket.OPEN
    emit("open", {});
  }, 0);
  addEventListener("pagehide", () => transport.close());
  return transport;
}
