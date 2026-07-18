import { MSG } from "../protocol.js";
import { createNetClient, INTERPOLATION_DELAY_MS } from "./net.js";
import { createInputController } from "./input.js";
import { createRenderer } from "./render.js";
import { updateHud } from "./hud.js";

const net = createNetClient(`ws://${location.host}/ws`);

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
const matchOverBanner = document.querySelector("[data-match-over-banner]");
const matchOverText = document.querySelector("[data-match-over-text]");

document.querySelector("[data-create-room]").addEventListener("click", () => {
  homeError.textContent = "";
  net.send(MSG.CREATE_ROOM);
});

document.querySelector("[data-join-room]").addEventListener("click", () => {
  homeError.textContent = "";
  const code = document.querySelector("[data-join-code-input]").value.trim().toUpperCase();
  if (code.length !== 4) {
    homeError.textContent = "Enter the 4-letter room code.";
    return;
  }
  net.send(MSG.JOIN_ROOM, { code });
});

readyBtn.addEventListener("click", () => {
  readyBtn.disabled = true;
  net.send(MSG.SET_READY, { ready: true });
});

function enterLobby(code, playerNumber) {
  selfId = playerNumber;
  roomPhase = "lobby";
  roomCodeEl.textContent = code;
  hud.dataset.roomCodeHud = code;
  showView("lobby");
  updateHud(hud, { connection: "connected", selfId, roomPhase });
}

net.on(MSG.ROOM_CREATED, (msg) => enterLobby(msg.code, msg.playerNumber));
net.on(MSG.ROOM_JOINED, (msg) => enterLobby(msg.code, msg.playerNumber));

net.on(MSG.ERROR, (msg) => {
  homeError.textContent = msg.message ?? "Something went wrong.";
});

net.on(MSG.LOBBY_STATE, (msg) => {
  playerListEl.innerHTML = msg.players
    .map((p) => `<li data-player-row="${p.playerNumber}">${p.playerNumber}${p.playerNumber === selfId ? " (you)" : ""} — ${p.ready ? "ready" : "not ready"}</li>`)
    .join("");
});

let countdownTimer = null;
net.on(MSG.MATCH_STARTING, (msg) => {
  roomPhase = "starting";
  // Actually tick the displayed number down (3... 2... 1...) instead of
  // setting static text once and leaving it frozen for the full countdown
  // -- a static "Starting in 3..." for a full 3 seconds before an abrupt
  // jump to the match reads as stuck/broken, not as a running countdown.
  if (countdownTimer) clearInterval(countdownTimer);
  let secondsLeft = Math.ceil(msg.countdownMs / 1000);
  lobbyStatusEl.textContent = `Starting in ${secondsLeft}…`;
  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft > 0) {
      lobbyStatusEl.textContent = `Starting in ${secondsLeft}…`;
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
});

net.on(MSG.MATCH_EVENT, (msg) => {
  if (msg.event === "match_over") {
    roomPhase = "over";
    winner = msg.winnerId;
    winReason = msg.reason ?? "won";
    const youWon = winner === selfId;
    matchOverText.textContent =
      winReason === "opponent_disconnected"
        ? youWon
          ? "Your opponent disconnected — you win the match."
          : "You disconnected — match forfeited."
        : youWon
          ? "You win the match!"
          : "Your opponent wins the match.";
    matchOverBanner.hidden = false;
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
  renderer.resize();
  window.addEventListener("resize", () => {
    sizeCanvasFromLayout(canvas);
    renderer.resize();
  });

  let lastInputSend = 0;
  const inputIntervalMs = 1000 / 30;
  let aimInitialized = false;
  let latestSelf = null;
  // Extends the same test-only escape hatch input.js already exposes
  // (setAim/setInput) with read access to the authoritative self-ship state,
  // so an external script can drive a closed-loop maneuver (e.g. home in on
  // a known target position) without needing DOM/canvas pixel inspection.
  window.__testHooks.debugState = () => ({ self: latestSelf, inputState: input.getState() });

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
    // orientation before the player has ever touched the mouse. This was
    // the actual cause of an apparent "rendering" bug found during
    // verification: the camera and scene were correct throughout, but the
    // ship (and camera, which is rigidly attached to it) was being spun to
    // face empty space within the first ~33ms of every match.
    if (self && !aimInitialized) {
      input.setInitialAim(self.yaw, self.pitch);
      aimInitialized = true;
    }
    latestSelf = self;

    if (now - lastInputSend >= inputIntervalMs) {
      lastInputSend = now;
      const { aimYaw, aimPitch, thrusting, firing } = input.getState();
      net.send(MSG.PLAYER_INPUT, { aimYaw, aimPitch, thrusting, firing });
    }

    if (snap && selfId) {
      const opponentId = selfId === "p1" ? "p2" : "p1";
      const opp = snap.ships[opponentId];
      if (self) {
        renderer.updateCamera(self);
        renderer.updateTrajectoryPreview(self, input.getState().thrusting);
      }
      if (opp) renderer.updateOpponent(opp);
      renderer.updateProjectiles(snap.projectiles, selfId);
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
