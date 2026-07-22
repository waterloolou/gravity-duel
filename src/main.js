import { MSG } from "../protocol.js";
import * as P from "./physics.js";
import { createNetClient, INTERPOLATION_DELAY_MS } from "./net.js";
import { createInputController } from "./input.js";
import { createRenderer } from "./render.js";
import { createAudioSystem } from "./audio.js";
import { updateHud } from "./hud.js";
import { renderHangar } from "./hangar.js";
import { renderLeaderboard } from "./leaderboard.js";
import * as Loadouts from "./loadouts.js";

// Registered for PWA installability (Add to Home Screen), not offline play
// -- see sw.js's own comment for why this game specifically shouldn't try
// to cache/serve itself offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

const net = createNetClient(`ws://${location.host}/ws`);
const audioSystem = createAudioSystem();

let selfId = null;
let roomPhase = "home";
let winner = null;
let winReason = null;
let profile = null;
let currentRoomCode = null;

// A friend's shared invite link (?room=ABCD) -- read once at load, then
// stripped from the URL immediately (history.replaceState) so a page
// refresh doesn't keep re-attempting to join a code that may have already
// filled up or finished. Pre-filling the code input too means a failed
// auto-join (room gone/full) still leaves something useful on screen to
// retry or fall back from, instead of just an error with no context.
const inviteCode = new URLSearchParams(location.search).get("room");
if (inviteCode) {
  history.replaceState(null, "", location.pathname);
}

// No accounts -- this id is just "which save file to load" for currency and
// (later) ship/weapon unlocks, generated once per browser and reused on
// every reconnect. Clearing site data or switching browsers starts fresh;
// that's an accepted tradeoff of staying anonymous, not a bug.
function getOrCreatePlayerId() {
  const KEY = "gravityDuel.playerId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

const views = {
  home: document.getElementById("view-home"),
  lobby: document.getElementById("view-lobby"),
  hangar: document.getElementById("view-hangar"),
  leaderboard: document.getElementById("view-leaderboard"),
  play: document.getElementById("view-play"),
};
function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

// The Hangar is reachable from both home and the lobby -- Back should
// return to wherever it was opened from, not always home (a player mid-
// queue in a lobby shouldn't get bounced out of it just to check loadouts).
let hangarReturnView = "home";
document.querySelectorAll("[data-open-hangar]").forEach((btn) => {
  btn.addEventListener("click", () => {
    audioSystem.uiClick();
    hangarReturnView = roomPhase === "lobby" ? "lobby" : "home";
    showView("hangar");
    renderHangar(profile, net);
  });
});
document.querySelector("[data-hangar-back]").addEventListener("click", () => {
  audioSystem.uiClick();
  showView(hangarReturnView);
});

const leaderboardErrorEl = document.querySelector("[data-leaderboard-error]");
document.querySelector("[data-open-leaderboard]").addEventListener("click", () => {
  audioSystem.uiClick();
  const callsignInput = document.querySelector("[data-callsign-input]");
  if (callsignInput && profile?.displayName) callsignInput.value = profile.displayName;
  leaderboardErrorEl.textContent = "";
  showView("leaderboard");
  net.send(MSG.REQUEST_LEADERBOARD);
});
document.querySelector("[data-leaderboard-back]").addEventListener("click", () => {
  audioSystem.uiClick();
  showView("home");
});
document.querySelector("[data-save-callsign]").addEventListener("click", () => {
  audioSystem.uiClick();
  leaderboardErrorEl.textContent = "";
  const name = document.querySelector("[data-callsign-input]").value;
  net.send(MSG.SET_DISPLAY_NAME, { name });
});

net.on(MSG.LEADERBOARD_STATE, (msg) => {
  renderLeaderboard(msg);
});

const hud = document.getElementById("hud");
const homeError = document.querySelector("[data-home-error]");
const roomCodeEl = document.querySelector("[data-room-code]");
const playerListEl = document.querySelector("[data-player-list]");
const lobbyStatusEl = document.querySelector("[data-lobby-status]");
const readyBtn = document.querySelector("[data-ready-btn]");
const countdownEl = document.querySelector("[data-countdown]");
const matchOverBanner = document.querySelector("[data-match-over-banner]");
const matchOverText = document.querySelector("[data-match-over-text]");
const matchOverScoreEl = document.querySelector("[data-match-over-score]");
const playAgainBtn = document.querySelector("[data-play-again]");
const killFeedEl = document.querySelector("[data-kill-feed]");
const damageFlashEl = document.querySelector("[data-damage-flash]");

function pushKillFeed(message) {
  const item = document.createElement("div");
  item.className = "kill-feed-item";
  item.textContent = message;
  killFeedEl.appendChild(item);
  // The element's own CSS animation (kill-feed-out) handles fade/slide-out
  // and removal timing -- this just reclaims the DOM node once it finishes,
  // rather than using a matching setTimeout that could drift out of sync.
  item.addEventListener("animationend", (e) => {
    if (e.animationName === "kill-feed-out") item.remove();
  });
}

function triggerDamageFlash() {
  damageFlashEl.classList.remove("active");
  void damageFlashEl.offsetWidth; // force reflow so re-adding the class restarts the CSS animation
  damageFlashEl.classList.add("active");
}

// "Opponent" only reads unambiguously in a 1v1 -- with up to 3 other players
// in a free-for-all, kill-feed lines need to say WHICH one.
function playerLabel(id) {
  return id === selfId ? "You" : id.toUpperCase();
}

function buildKillFeedMessage(ev) {
  const isSelfVictim = ev.victimId === selfId;
  const victim = playerLabel(ev.victimId);
  if (ev.event === "well_death") {
    return isSelfVictim ? "You were pulled into the well." : `${victim} was pulled into the well.`;
  }
  if (ev.event === "moon_death") {
    return isSelfVictim ? "You crashed into a moon." : `${victim} crashed into a moon.`;
  }
  if (isSelfVictim) return "You were eliminated.";
  if (ev.killerId === selfId) return `You eliminated ${victim}!`;
  return `${playerLabel(ev.killerId)} eliminated ${victim}.`;
}

document.querySelector("[data-quick-play]").addEventListener("click", () => {
  audioSystem.resume();
  audioSystem.uiClick();
  homeError.textContent = "";
  net.send(MSG.QUICK_JOIN);
});

document.querySelector("[data-create-room]").addEventListener("click", () => {
  audioSystem.resume();
  audioSystem.uiClick();
  homeError.textContent = "";
  net.send(MSG.CREATE_ROOM);
});

document.querySelector("[data-join-room]").addEventListener("click", () => {
  audioSystem.resume();
  audioSystem.uiClick();
  homeError.textContent = "";
  const code = document.querySelector("[data-join-code-input]").value.trim().toUpperCase();
  if (code.length !== 4) {
    homeError.textContent = "Enter the 4-letter room code.";
    return;
  }
  net.send(MSG.JOIN_ROOM, { code });
});

if (inviteCode) {
  const joinInput = document.querySelector("[data-join-code-input]");
  joinInput.value = inviteCode.toUpperCase();
  document.querySelector(".private-room").open = true; // reveal it rather than leaving a filled-in field hidden behind a closed <details>
}

const copyInviteBtn = document.querySelector("[data-copy-invite]");
copyInviteBtn?.addEventListener("click", async () => {
  audioSystem.uiClick();
  const link = `${location.origin}${location.pathname}?room=${currentRoomCode}`;
  const originalText = copyInviteBtn.textContent;
  try {
    await navigator.clipboard.writeText(link);
    copyInviteBtn.textContent = "Copied!";
  } catch {
    // Clipboard API can be unavailable (older browser, insecure context) --
    // fall back to just showing the link so it can be selected/copied by hand.
    window.prompt("Copy this invite link:", link);
  }
  setTimeout(() => {
    copyInviteBtn.textContent = originalText;
  }, 1500);
});

readyBtn.addEventListener("click", () => {
  // Guard client-side against the exact bug that caused P1 to get
  // permanently stuck: clicking Ready before at least one other player has
  // joined. The server only accepts SET_READY once the room has 2+ players
  // (see room.js's setReady, gated on MIN_PLAYERS_TO_START) and silently
  // no-ops otherwise -- but this button was unconditionally disabling
  // itself on click regardless, so an early click left the button
  // disabled forever with no way to actually register as ready once a
  // second player did show up.
  if (playersInRoom < 2) return;
  audioSystem.uiClick();
  readyBtn.disabled = true;
  net.send(MSG.SET_READY, { ready: true });
});

playAgainBtn.addEventListener("click", () => {
  audioSystem.uiClick();
  net.send(MSG.LEAVE_ROOM);
  // "Leave" (as opposed to "Rematch" below) intentionally goes all the way
  // back to the anonymous home screen -- a full reload is a completely
  // reliable reset for that, no need to hand-unwind VFX/audio/game-loop
  // state for a path that's leaving the room entirely anyway.
  location.reload();
});

document.querySelector("[data-rematch]").addEventListener("click", () => {
  audioSystem.uiClick();
  net.send(MSG.REQUEST_REMATCH);
});

let playersInRoom = 1; // creating/joining always seats the local player immediately

function enterLobby(code, playerNumber) {
  selfId = playerNumber;
  roomPhase = "lobby";
  currentRoomCode = code;
  roomCodeEl.textContent = code;
  hud.dataset.roomCodeHud = code;
  showView("lobby");
  countdownEl.hidden = true;
  // Disabled synchronously here too, not just from the LOBBY_STATE handler
  // below -- closes the brief window between entering the lobby and that
  // first broadcast arriving, during which a real player could otherwise
  // still land the exact stuck-forever click this whole guard exists to
  // prevent.
  readyBtn.disabled = true;
  lobbyStatusEl.textContent = "Waiting for at least one more player…";
  updateHud(hud, { connection: "connected", selfId, roomPhase });
}

// Fires once the socket actually reaches OPEN -- net.js's send() silently
// drops anything sent before that (no queue), so this is structurally
// guaranteed to be the first message this connection ever sends, which is
// exactly what the server assumes (see server.js's IDENTIFY handler).
net.on("_open", () => {
  net.send(MSG.IDENTIFY, { playerId: getOrCreatePlayerId() });
  // JOIN_ROOM doesn't depend on the profile being loaded (only match-start
  // loadout resolution does, later), so this can fire right alongside
  // IDENTIFY rather than waiting for a PROFILE_STATE round-trip.
  if (inviteCode) net.send(MSG.JOIN_ROOM, { code: inviteCode });
});

const currencyBadge = document.querySelector("[data-currency-badge]");
const currencyValueEl = document.querySelector("[data-currency]");
const hangarErrorEl = document.querySelector("[data-hangar-error]");
net.on(MSG.PROFILE_STATE, (msg) => {
  profile = msg.profile;
  if (currencyValueEl) currencyValueEl.textContent = String(profile.currency);
  if (currencyBadge) currencyBadge.hidden = false;
  // Re-render live so a purchase/equip click reflects immediately, without
  // needing to leave and reopen the Hangar.
  if (!views.hangar.hidden) renderHangar(profile, net);
  // A saved callsign can change how (or whether) we show up in the ranked
  // list -- re-fetch rather than trying to patch the already-rendered rows
  // by hand.
  if (!views.leaderboard.hidden) net.send(MSG.REQUEST_LEADERBOARD);
});

net.on(MSG.ROOM_CREATED, (msg) => enterLobby(msg.code, msg.playerNumber));
net.on(MSG.ROOM_JOINED, (msg) => enterLobby(msg.code, msg.playerNumber));

net.on(MSG.ERROR, (msg) => {
  const message = msg.message ?? "Something went wrong.";
  if (!views.hangar.hidden) hangarErrorEl.textContent = message;
  else if (!views.leaderboard.hidden) leaderboardErrorEl.textContent = message;
  else homeError.textContent = message;
});

net.on(MSG.LOBBY_STATE, (msg) => {
  // A LOBBY_STATE arriving while we're still showing the match-over banner
  // means someone clicked "Rematch" (see room.js's rematch() and server.js's
  // REQUEST_REMATCH handler) -- switch back to the lobby view and clear the
  // previous match's leftover UI state, same as enterLobby() does for a
  // brand-new room. The underlying game loop/renderer are NOT torn down
  // (see the MATCH_STATE handler below); they just pick up the next
  // match's snapshots once ready-up finishes again.
  if (roomPhase === "over") {
    roomPhase = "lobby";
    matchOverBanner.hidden = true;
    killFeedEl.innerHTML = "";
    winner = null;
    winReason = null;
    showView("lobby");
  }

  // Defensively reset any in-flight countdown -- covers a disconnect during
  // the starting countdown reverting the room back to "waiting", which must
  // not leave the big countdown number stuck on screen.
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownEl.hidden = true;

  playersInRoom = msg.players.length;
  playerListEl.innerHTML = msg.players
    .map((p) => `<li data-player-row="${p.playerNumber}">${p.playerNumber}${p.playerNumber === selfId ? " (you)" : ""} — ${p.ready ? "ready" : "not ready"}</li>`)
    .join("");

  const self = msg.players.find((p) => p.playerNumber === selfId);
  if (playersInRoom < 2) {
    readyBtn.disabled = true;
    lobbyStatusEl.textContent = "Waiting for at least one more player…";
  } else if (self?.ready) {
    readyBtn.disabled = true;
    lobbyStatusEl.textContent = "";
  } else {
    readyBtn.disabled = false;
    lobbyStatusEl.textContent = "";
  }
});

let countdownTimer = null;
net.on(MSG.MATCH_STARTING, (msg) => {
  roomPhase = "starting";
  if (countdownTimer) clearInterval(countdownTimer);
  let secondsLeft = Math.ceil(msg.countdownMs / 1000);
  lobbyStatusEl.textContent = "Get ready…";
  countdownEl.hidden = false;
  aimInitialized = false; // this match's ships get a fresh spawn facing -- see this flag's own declaration comment

  const showTick = (n) => {
    countdownEl.textContent = String(n);
    countdownEl.classList.remove("tick");
    void countdownEl.offsetWidth;
    countdownEl.classList.add("tick");
    audioSystem.countdownTick(n <= 1);
  };
  showTick(secondsLeft);
  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft > 0) {
      showTick(secondsLeft);
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      countdownEl.hidden = true;
    }
  }, 1000);
});

let latestSelf = null;
let latestShips = null; // full snapshot (all players, self included), for looking up any victim's position
let latestTick = 0;
let latestPickups = null;
let gameRenderer = null;
// Module-level (not local to startGameLoop's loop()) so MATCH_STARTING can
// reset it -- a rematch's fresh match assigns a brand-new spawn facing, and
// without this reset the input controller would stay pointed wherever the
// PREVIOUS match's ship happened to be aiming when it ended.
let aimInitialized = false;

// Mirrors render.js's own PICKUP_COLORS palette -- kept as a separate
// module-level copy rather than importing it, since render.js doesn't
// export its internal color constants (main.js only needs these two for
// the pickup-collected VFX/kill-feed text, not the full renderer).
const PICKUP_EVENT_COLORS = { speed: 0xffe066, shield: 0x4fd1ff, vent: 0xff7a3d };
const PICKUP_LABELS = { speed: "Speed boost", shield: "Shield", vent: "Heat vent" };

net.on(MSG.MATCH_EVENT, (msg) => {
  if (msg.event === "hit" || msg.event === "well_death" || msg.event === "moon_death") {
    const isSelfVictim = msg.victimId === selfId;
    audioSystem.explosion();
    pushKillFeed(buildKillFeedMessage(msg));

    if (isSelfVictim) {
      triggerDamageFlash();
      gameRenderer?.triggerShake(0.6);
    } else {
      const victim = latestShips?.[msg.victimId];
      if (victim) {
        gameRenderer?.spawnExplosion({ x: victim.pos[0], y: victim.pos[1], z: victim.pos[2] }, 0xffaa55);
      }
      if (msg.event === "hit" && msg.killerId === selfId) gameRenderer?.triggerShake(0.25);
    }
    return;
  }

  if (msg.event === "pickup") {
    audioSystem.pickup();
    const pos = P.PICKUP_SPAWN_POINTS.find((s) => s.id === msg.pickupId)?.pos;
    if (pos) gameRenderer?.spawnExplosion(pos, PICKUP_EVENT_COLORS[msg.pickupType] ?? 0xffffff);
    if (msg.playerId === selfId) pushKillFeed(`${PICKUP_LABELS[msg.pickupType] ?? "Pickup"} collected!`);
    return;
  }

  if (msg.event === "player_left") {
    pushKillFeed(`${msg.playerId.toUpperCase()} disconnected.`);
    return;
  }

  if (msg.event === "match_over") {
    roomPhase = "over";
    winner = msg.winnerId;
    winReason = msg.reason ?? "won";
    const youWon = winner === selfId;

    matchOverText.textContent = youWon ? "VICTORY" : winner ? "DEFEAT" : "MATCH OVER";
    let scoreLine;
    if (winReason === "opponent_disconnected") {
      scoreLine = youWon ? "Everyone else disconnected." : winner ? "You disconnected — match forfeited." : "Everyone disconnected.";
    } else if (msg.finalScore) {
      scoreLine = Object.entries(msg.finalScore)
        .map(([id, kills]) => `${playerLabel(id)} ${kills}`)
        .join(" · ");
    } else {
      scoreLine = "";
    }
    matchOverScoreEl.textContent = scoreLine;

    matchOverBanner.hidden = false;
    audioSystem.setThrusting(false);
    audioSystem.matchOverStinger(youWon);
    updateHud(hud, { connection: "connected", selfId, roomPhase, winner });
  }
});

let gameLoopStarted = false;
net.on(MSG.MATCH_STATE, () => {
  // showView/roomPhase run every time (idempotent) so a rematch's fresh
  // match correctly switches back from the lobby to the play view -- but
  // startGameLoop() itself (which builds the renderer/input controller)
  // must still only ever run once: it keeps running after the first match
  // ends, and simply resumes rendering once fresh snapshots arrive again,
  // so rebuilding the whole Three.js scene for a rematch would be both
  // wasteful and wrong (a second render loop racing the first).
  roomPhase = "active";
  showView("play");
  if (gameLoopStarted) return;
  gameLoopStarted = true;
  startGameLoop();
});

net.connect();

// The on-screen THRUST/FIRE/CAM buttons (see index.html's .touch-controls,
// CSS-gated to touch-primary devices via (pointer: coarse)) -- wired
// unconditionally here regardless of whether they're currently visible,
// same as the rest of input.js's listeners, since there's no harm in a
// hidden button never receiving a touch.
function wireTouchControls(input) {
  function bindHold(selector, onStart, onEnd) {
    const btn = document.querySelector(selector);
    if (!btn) return;
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault(); // suppresses the synthetic mousedown/click a touch would otherwise also fire
        audioSystem.resume();
        onStart();
      },
      { passive: false }
    );
    const release = (e) => {
      e.preventDefault();
      onEnd();
    };
    btn.addEventListener("touchend", release);
    btn.addEventListener("touchcancel", release);
  }

  bindHold("[data-touch-thrust]", () => input.setThrusting(true), () => input.setThrusting(false));
  bindHold("[data-touch-fire]", () => input.setFiring(true), () => input.setFiring(false));

  const camBtn = document.querySelector("[data-touch-cam]");
  camBtn?.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      audioSystem.resume();
      audioSystem.uiClick();
      input.toggleCamera();
    },
    { passive: false }
  );
}

function startGameLoop() {
  const canvas = document.getElementById("scene");
  // The canvas's drawing-buffer size must be set BEFORE constructing the
  // WebGLRenderer, not after -- #view-play was `hidden` until the instant
  // before this runs, so the canvas has no meaningful CSS-derived size yet.
  sizeCanvasFromLayout(canvas);
  const input = createInputController(canvas);
  wireTouchControls(input);
  const selfEngineColor = Loadouts.resolveEngineColor(profile?.equippedCosmetic);
  const renderer = createRenderer(canvas, selfEngineColor);
  gameRenderer = renderer;
  renderer.resize();
  window.addEventListener("resize", () => {
    sizeCanvasFromLayout(canvas);
    renderer.resize();
  });
  canvas.addEventListener("click", () => audioSystem.resume());
  // A touch-drag on the canvas (input.js's own touchstart) calls
  // preventDefault(), which suppresses the synthetic click the line above
  // relies on -- so touch needs its own explicit resume-on-first-touch.
  canvas.addEventListener("touchstart", () => audioSystem.resume(), { passive: true });

  let lastInputSend = 0;
  const inputIntervalMs = 1000 / 30;
  let wasThrusting = false;
  // Extends the same test-only escape hatch input.js already exposes
  // (setAim/setInput) with read access to the authoritative self-ship state,
  // so an external script can drive a closed-loop maneuver (e.g. home in on
  // a known target position) without needing DOM/canvas pixel inspection.
  window.__testHooks.debugState = () => ({ self: latestSelf, ships: latestShips, tick: latestTick, pickups: latestPickups, inputState: input.getState() });

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();

    const renderTime = now - INTERPOLATION_DELAY_MS;
    const snap = net.sampleAt(renderTime);
    const self = snap && selfId ? snap.ships[selfId] : null;

    // The server assigns each ship a spawn facing (toward the well) that
    // has nothing to do with the input controller's own default aim (0,0).
    // Sync to it once, before the first PLAYER_INPUT send -- otherwise the
    // very first input message snaps the ship's facing away from its spawn
    // orientation before the player has ever touched the mouse.
    if (self && !aimInitialized) {
      input.setInitialAim(self.yaw, self.pitch);
      aimInitialized = true;
    }
    latestSelf = self;

    const inputState = input.getState();
    if (now - lastInputSend >= inputIntervalMs) {
      lastInputSend = now;
      const { aimYaw, aimPitch, thrusting, firing } = inputState;
      net.send(MSG.PLAYER_INPUT, { aimYaw, aimPitch, thrusting, firing });
    }

    if (inputState.thrusting !== wasThrusting) {
      wasThrusting = inputState.thrusting;
      audioSystem.setThrusting(wasThrusting);
    }
    renderer.setLocalThrust(inputState.thrusting);

    if (snap && selfId) {
      latestShips = snap.ships;
      latestTick = snap.tick;
      latestPickups = snap.pickups;
      if (self) {
        renderer.updateCamera(self, inputState.thirdPerson, inputState.thrusting);
        renderer.updateTrajectoryPreview(self, inputState.thrusting, snap.tick);
      }
      renderer.updateOpponents(snap.ships, selfId);
      renderer.updateProjectiles(snap.projectiles, selfId, () => audioSystem.fire());
      renderer.updateMoons(snap.tick);
      renderer.updatePickups(snap.pickups);
      updateHud(hud, { connection: "connected", selfId, matchState: snap, roomPhase, winner });
    }

    renderer.render();
  }
  requestAnimationFrame(loop);
}

function sizeCanvasFromLayout(canvas) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}
