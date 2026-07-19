import { MSG } from "../protocol.js";
import { createNetClient, INTERPOLATION_DELAY_MS } from "./net.js";
import { createInputController } from "./input.js";
import { createRenderer } from "./render.js";
import { createAudioSystem } from "./audio.js";
import { updateHud } from "./hud.js";

const net = createNetClient(`ws://${location.host}/ws`);
const audioSystem = createAudioSystem();

let selfId = null;
let roomPhase = "home";
let winner = null;
let winReason = null;

const views = {
  home: document.getElementById("view-home"),
  lobby: document.getElementById("view-lobby"),
  play: document.getElementById("view-play"),
};
function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

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

function buildKillFeedMessage(ev) {
  const isSelfVictim = ev.victimId === selfId;
  if (ev.event === "well_death") {
    return isSelfVictim ? "You were pulled into the well." : "Opponent was pulled into the well.";
  }
  if (ev.event === "moon_death") {
    return isSelfVictim ? "You crashed into a moon." : "Opponent crashed into a moon.";
  }
  if (isSelfVictim) return "You were eliminated.";
  if (ev.killerId === selfId) return "You eliminated your opponent!";
  return "Opponent scored a kill.";
}

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

readyBtn.addEventListener("click", () => {
  // Guard client-side against the exact bug that caused P1 to get
  // permanently stuck: clicking Ready before a second player has joined.
  // The server only accepts SET_READY once the room has two players (see
  // room.js's setReady, gated to the "full-not-ready" phase) and silently
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
  // A full rematch-without-refresh would need to reset gameLoopStarted,
  // aimInitialized, VFX/audio state, and the renderer's Three.js scene --
  // a real scope jump (explicitly deferred in this project's own backlog).
  // A reload is a completely reliable reset and gets back to a fresh room
  // in one click, which is what "Play Again" needs to actually do here.
  location.reload();
});

let playersInRoom = 1; // creating/joining always seats the local player immediately

function enterLobby(code, playerNumber) {
  selfId = playerNumber;
  roomPhase = "lobby";
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
  lobbyStatusEl.textContent = "Waiting for a second player…";
  updateHud(hud, { connection: "connected", selfId, roomPhase });
}

net.on(MSG.ROOM_CREATED, (msg) => enterLobby(msg.code, msg.playerNumber));
net.on(MSG.ROOM_JOINED, (msg) => enterLobby(msg.code, msg.playerNumber));

net.on(MSG.ERROR, (msg) => {
  homeError.textContent = msg.message ?? "Something went wrong.";
});

net.on(MSG.LOBBY_STATE, (msg) => {
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
    lobbyStatusEl.textContent = "Waiting for a second player…";
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
let latestOpponent = null;
let latestTick = 0;
let gameRenderer = null;

net.on(MSG.MATCH_EVENT, (msg) => {
  if (msg.event === "hit" || msg.event === "well_death" || msg.event === "moon_death") {
    const isSelfVictim = msg.victimId === selfId;
    audioSystem.explosion();
    pushKillFeed(buildKillFeedMessage(msg));

    if (isSelfVictim) {
      triggerDamageFlash();
      gameRenderer?.triggerShake(0.6);
    } else {
      if (latestOpponent) {
        gameRenderer?.spawnExplosion(
          { x: latestOpponent.pos[0], y: latestOpponent.pos[1], z: latestOpponent.pos[2] },
          0xffaa55
        );
      }
      if (msg.event === "hit" && msg.killerId === selfId) gameRenderer?.triggerShake(0.25);
    }
    return;
  }

  if (msg.event === "match_over") {
    roomPhase = "over";
    winner = msg.winnerId;
    winReason = msg.reason ?? "won";
    const youWon = winner === selfId;

    matchOverText.textContent = youWon ? "VICTORY" : "DEFEAT";
    let scoreLine;
    if (winReason === "opponent_disconnected") {
      scoreLine = youWon ? "Your opponent disconnected." : "You disconnected — match forfeited.";
    } else if (msg.finalScore && selfId) {
      const oppId = selfId === "p1" ? "p2" : "p1";
      scoreLine = `Final score — You ${msg.finalScore[selfId]} : ${msg.finalScore[oppId]} Opponent`;
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
  if (gameLoopStarted) return;
  gameLoopStarted = true;
  roomPhase = "active";
  showView("play");
  startGameLoop();
});

net.connect();

function startGameLoop() {
  const canvas = document.getElementById("scene");
  // The canvas's drawing-buffer size must be set BEFORE constructing the
  // WebGLRenderer, not after -- #view-play was `hidden` until the instant
  // before this runs, so the canvas has no meaningful CSS-derived size yet.
  sizeCanvasFromLayout(canvas);
  const input = createInputController(canvas);
  const renderer = createRenderer(canvas);
  gameRenderer = renderer;
  renderer.resize();
  window.addEventListener("resize", () => {
    sizeCanvasFromLayout(canvas);
    renderer.resize();
  });
  canvas.addEventListener("click", () => audioSystem.resume());

  let lastInputSend = 0;
  const inputIntervalMs = 1000 / 30;
  let aimInitialized = false;
  let wasThrusting = false;
  // Extends the same test-only escape hatch input.js already exposes
  // (setAim/setInput) with read access to the authoritative self-ship state,
  // so an external script can drive a closed-loop maneuver (e.g. home in on
  // a known target position) without needing DOM/canvas pixel inspection.
  window.__testHooks.debugState = () => ({ self: latestSelf, opponent: latestOpponent, tick: latestTick, inputState: input.getState() });

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
      const opponentId = selfId === "p1" ? "p2" : "p1";
      const opp = snap.ships[opponentId];
      latestOpponent = opp;
      latestTick = snap.tick;
      if (self) {
        renderer.updateCamera(self, inputState.thirdPerson, inputState.thrusting);
        renderer.updateTrajectoryPreview(self, inputState.thrusting, snap.tick);
      }
      if (opp) renderer.updateOpponent(opp);
      renderer.updateProjectiles(snap.projectiles, selfId, () => audioSystem.fire());
      renderer.updateMoons(snap.tick);
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
