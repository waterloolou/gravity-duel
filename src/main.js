import { MSG } from "../protocol.js";
import * as P from "./physics.js";
import { PINGS, PING_COOLDOWN_MS } from "./pings.js";
import { createNetClient, INTERPOLATION_DELAY_MS } from "./net.js";
import { createP2PTransport, P2P_STATUS } from "./p2p.js";
import { createInputController } from "./input.js";
import { createRenderer } from "./render.js";
import { createAudioSystem, setMasterVolume, setMuted } from "./audio.js";
import { updateHud } from "./hud.js";
import { renderHangar } from "./hangar.js";
import { renderLeaderboard } from "./leaderboard.js";
import * as Loadouts from "./loadouts.js";
import * as Settings from "./settings.js";
import { createMinimap } from "./minimap.js";

// Registered for PWA installability (Add to Home Screen), not offline play
// -- see sw.js's own comment for why this game specifically shouldn't try
// to cache/serve itself offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// Default: peer-to-peer (players host matches for each other; works from a
// static site like GitHub Pages). ?server=1 uses the optional Node server.
const useDedicatedServer = new URLSearchParams(location.search).has("server");
const net = createNetClient(
  useDedicatedServer ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws` : createP2PTransport
);
const audioSystem = createAudioSystem();

// Applied immediately, before any match/audio-context exists -- both
// setMasterVolume/setMuted and a future createInputController/createRenderer
// call (see startGameLoop) read from this same object, so a player's saved
// preferences are already in effect the instant the page loads.
let settings = Settings.loadSettings();
setMasterVolume(settings.masterVolume);
setMuted(settings.muted);

let selfId = null;
let roomPhase = "home";
let winner = null;
let winReason = null;
let profile = null;
let currentRoomCode = null;
let isSpectator = false;
let spectateTargetId = null; // which player's ship the spectator camera is currently following

// A friend's shared invite link (?room=ABCD) -- read once at load, then
// stripped from the URL immediately (history.replaceState) so a page
// refresh doesn't keep re-attempting to join a code that may have already
// filled up or finished. Pre-filling the code input too means a failed
// auto-join (room gone/full) still leaves something useful on screen to
// retry or fall back from, instead of just an error with no context.
const inviteCode = new URLSearchParams(location.search).get("room");
if (inviteCode) {
  const keep = new URLSearchParams(location.search);
  keep.delete("room"); // keep ?server=1 etc., drop only the one-shot invite
  history.replaceState(null, "", location.pathname + (keep.toString() ? `?${keep}` : ""));
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
  settings: document.getElementById("view-settings"),
  lobby: document.getElementById("view-lobby"),
  spectateWait: document.getElementById("view-spectate-wait"),
  hangar: document.getElementById("view-hangar"),
  leaderboard: document.getElementById("view-leaderboard"),
  play: document.getElementById("view-play"),
};
const settingsGearBtn = document.querySelector("[data-open-settings]");
function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  // Settings is deliberately unreachable mid-match: the gear lives in the
  // always-visible header (even over #view-play), but opening it there
  // would hide the canvas while the game loop (and pointer-lock input)
  // keeps running underneath, with no sane "Back" target to return to.
  if (settingsGearBtn) settingsGearBtn.hidden = name === "play";
}

// Settings is reachable from anywhere BUT #view-play (see showView) --
// Back should return to wherever it was actually opened from, same
// "remember where we came from" pattern as hangarReturnView below.
let settingsReturnView = "home";
const keyLabel = (code) => (code?.startsWith("Key") ? code.slice(3) : code ?? "?");
function refreshSettingsUI() {
  const volumeEl = document.querySelector("[data-settings-volume]");
  const mutedEl = document.querySelector("[data-settings-muted]");
  const sensitivityEl = document.querySelector("[data-settings-sensitivity]");
  const colorblindEl = document.querySelector("[data-settings-colorblind]");
  if (volumeEl) volumeEl.value = String(Math.round(settings.masterVolume * 100));
  if (mutedEl) mutedEl.checked = settings.muted;
  if (sensitivityEl) sensitivityEl.value = String(Math.round(settings.sensitivity * 100));
  if (colorblindEl) colorblindEl.checked = settings.colorblindMode;
  document.querySelectorAll("[data-rebind-key]").forEach((btn) => {
    btn.textContent = keyLabel(settings[btn.dataset.rebindKey]);
  });
}
settingsGearBtn?.addEventListener("click", () => {
  audioSystem.uiClick();
  settingsReturnView = Object.entries(views).find(([, el]) => !el.hidden)?.[0] ?? "home";
  refreshSettingsUI();
  showView("settings");
});
document.querySelector("[data-settings-back]")?.addEventListener("click", () => {
  audioSystem.uiClick();
  showView(settingsReturnView);
});
document.querySelector("[data-settings-volume]")?.addEventListener("input", (e) => {
  settings = { ...settings, masterVolume: Settings.clampVolume(Number(e.target.value) / 100) };
  setMasterVolume(settings.masterVolume);
  Settings.saveSettings(settings);
});
document.querySelector("[data-settings-muted]")?.addEventListener("change", (e) => {
  settings = { ...settings, muted: e.target.checked };
  setMuted(settings.muted);
  Settings.saveSettings(settings);
});
document.querySelector("[data-settings-sensitivity]")?.addEventListener("input", (e) => {
  settings = { ...settings, sensitivity: Settings.clampSensitivity(Number(e.target.value) / 100) };
  gameInput?.setSensitivityMultiplier(settings.sensitivity); // takes effect immediately even mid-match
  Settings.saveSettings(settings);
});
document.querySelector("[data-settings-colorblind]")?.addEventListener("change", (e) => {
  settings = { ...settings, colorblindMode: e.target.checked };
  Settings.saveSettings(settings); // render.js only reads this at createRenderer() time -- see the settings-hint text in index.html
});
document.querySelectorAll("[data-rebind-key]").forEach((btn) => {
  btn.addEventListener("click", () => {
    audioSystem.uiClick();
    const field = btn.dataset.rebindKey;
    const originalLabel = btn.textContent;
    btn.textContent = "Press a key…";
    btn.disabled = true;
    const capture = (e) => {
      e.preventDefault();
      // Capture phase + stopImmediatePropagation: input.js's own keydown
      // listener (bubble phase) is still attached to `document` for the
      // rest of this tab's session even once we've navigated away from
      // #view-play (see gameInput's own comment) -- without this, the key
      // being pressed to rebind would ALSO be interpreted as live game
      // input (e.g. pressing W to rebind thrust would itself set
      // thrusting=true on a backgrounded match).
      e.stopImmediatePropagation();
      document.removeEventListener("keydown", capture, true);
      btn.disabled = false;
      if (e.code === "Escape") {
        btn.textContent = originalLabel; // cancel, no change
        return;
      }
      settings = { ...settings, [field]: e.code };
      gameInput?.[field === "thrustKey" ? "setThrustKey" : "setCameraToggleKey"](e.code);
      Settings.saveSettings(settings);
      btn.textContent = keyLabel(e.code);
    };
    document.addEventListener("keydown", capture, true);
  });
});
document.querySelector("[data-settings-reset]")?.addEventListener("click", () => {
  audioSystem.uiClick();
  settings = { ...Settings.DEFAULT_SETTINGS };
  Settings.saveSettings(settings);
  setMasterVolume(settings.masterVolume);
  setMuted(settings.muted);
  gameInput?.setSensitivityMultiplier(settings.sensitivity);
  gameInput?.setThrustKey(settings.thrustKey);
  gameInput?.setCameraToggleKey(settings.cameraToggleKey);
  refreshSettingsUI();
});

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
let leaderboardMode = "casual"; // "casual" | "ranked" -- which tab is active, drives what REQUEST_LEADERBOARD asks for
function requestLeaderboard() {
  net.send(MSG.REQUEST_LEADERBOARD, { ranked: leaderboardMode === "ranked" });
}
document.querySelector("[data-open-leaderboard]").addEventListener("click", () => {
  audioSystem.uiClick();
  const callsignInput = document.querySelector("[data-callsign-input]");
  if (callsignInput && profile?.displayName) callsignInput.value = profile.displayName;
  leaderboardErrorEl.textContent = "";
  showView("leaderboard");
  requestLeaderboard();
});
document.querySelectorAll("[data-leaderboard-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    audioSystem.uiClick();
    leaderboardMode = tab.dataset.leaderboardTab;
    document.querySelectorAll("[data-leaderboard-tab]").forEach((t) => t.classList.toggle("active", t === tab));
    requestLeaderboard();
  });
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
// Peer-to-peer matchmaking progress ("Looking for an open match…") from p2p.js.
const p2pStatusEl = document.querySelector("[data-p2p-status]");
net.on(P2P_STATUS, (msg) => {
  homeError.textContent = msg.text;
  if (p2pStatusEl) p2pStatusEl.textContent = msg.text;
});
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
const killstreakBannerEl = document.querySelector("[data-killstreak-banner]");
const spectateBadgeEl = document.querySelector("[data-spectate-badge]");
const spectateHintEl = document.querySelector("[data-spectate-hint]");
const spectateNextBtn = document.querySelector("[data-spectate-next]");

// Cycles the spectator camera to the next player in the current roster --
// wraps around, and just no-ops (nothing to cycle to) outside spectate mode
// or with only one ship left in the match.
function cycleSpectateTarget() {
  if (!isSpectator || !latestShips) return;
  const ids = Object.keys(latestShips);
  if (ids.length < 2) return;
  const i = ids.indexOf(spectateTargetId);
  spectateTargetId = ids[(i + 1) % ids.length];
}
spectateNextBtn?.addEventListener("click", () => {
  audioSystem.uiClick();
  cycleSpectateTarget();
});
document.addEventListener("keydown", (e) => {
  if (e.code !== "Tab" || !isSpectator) return;
  e.preventDefault(); // Tab would otherwise shift focus off the canvas
  cycleSpectateTarget();
});

// Quick-chat pings: a fixed preset catalog (src/pings.js), not free text --
// see that file's own comment for why. Buttons double as number-key
// shortcuts (1-4) so a player mid-fight doesn't have to reach for the mouse.
const pingButtons = document.querySelectorAll("[data-ping]");
function sendPing(pingId) {
  if (!PINGS[pingId] || isSpectator) return;
  audioSystem.uiClick();
  net.send(MSG.SEND_PING, { pingId });
  // Client-side mirror of the server's own PING_COOLDOWN_MS -- purely
  // visual feedback (a disabled look) so a rapid extra click doesn't just
  // silently do nothing; the server enforces the real cooldown regardless.
  pingButtons.forEach((btn) => (btn.disabled = true));
  setTimeout(() => pingButtons.forEach((btn) => (btn.disabled = false)), PING_COOLDOWN_MS);
}
pingButtons.forEach((btn) => btn.addEventListener("click", () => sendPing(btn.dataset.ping)));
document.addEventListener("keydown", (e) => {
  if (roomPhase !== "active" || isSpectator) return;
  const entry = Object.values(PINGS).find((p) => p.key === e.key);
  if (entry) sendPing(entry.id);
});

net.on(MSG.PING, (msg) => {
  const label = PINGS[msg.pingId]?.label ?? "…";
  pushKillFeed(`${playerLabel(msg.playerId)}: ${label}`);
});

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

function triggerKillstreakBanner(text) {
  killstreakBannerEl.textContent = text;
  killstreakBannerEl.classList.remove("active");
  void killstreakBannerEl.offsetWidth; // force reflow so re-adding the class restarts the CSS animation
  killstreakBannerEl.classList.add("active");
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
  if (ev.event === "debris_death") {
    return isSelfVictim ? "You were struck by drifting debris." : `${victim} was struck by drifting debris.`;
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

document.querySelector("[data-ranked-play]").addEventListener("click", () => {
  audioSystem.resume();
  audioSystem.uiClick();
  homeError.textContent = "";
  net.send(MSG.RANKED_JOIN);
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

const roomBrowserListEl = document.querySelector("[data-room-browser-list]");
document.querySelector("[data-browse-rooms]")?.addEventListener("click", () => {
  audioSystem.resume();
  audioSystem.uiClick();
  homeError.textContent = "";
  net.send(MSG.REQUEST_ROOM_LIST);
});

net.on(MSG.ROOM_LIST, (msg) => {
  if (!roomBrowserListEl) return;
  roomBrowserListEl.hidden = false;
  if (msg.rooms.length === 0) {
    roomBrowserListEl.innerHTML = `<li class="room-browser-empty">No open rooms right now -- create one instead.</li>`;
    return;
  }
  roomBrowserListEl.innerHTML = msg.rooms
    .map(
      (r) => `
      <li class="room-browser-row">
        <span>${r.code} · ${r.playerCount}/${r.maxPlayers} players</span>
        <button type="button" class="secondary" data-browse-join="${r.code}">Join</button>
      </li>`
    )
    .join("");
});

// Rows are rebuilt from scratch on every ROOM_LIST, so the Join buttons are
// wired via delegation on the always-present list container rather than
// re-binding a listener per row every time (same pattern as the lobby's
// bot-remove buttons).
roomBrowserListEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-browse-join]");
  if (!btn) return;
  audioSystem.uiClick();
  net.send(MSG.JOIN_ROOM, { code: btn.dataset.browseJoin });
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

document.querySelector("[data-add-bot]")?.addEventListener("click", () => {
  audioSystem.uiClick();
  const difficulty = document.querySelector("[data-bot-difficulty]")?.value;
  net.send(MSG.ADD_BOT, { difficulty });
});

// Bot rows are rebuilt from scratch on every LOBBY_STATE (see that handler),
// so their Remove buttons are wired via delegation on the always-present
// list container rather than re-binding a listener per row every time.
playerListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-bot]");
  if (!btn) return;
  audioSystem.uiClick();
  net.send(MSG.REMOVE_BOT, { slot: btn.dataset.removeBot });
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

// Shared by every "Leave" button (match-over banner, spectate-wait screen)
// -- a full reload is a completely reliable reset, no need to hand-unwind
// VFX/audio/game-loop state for a path that's leaving the room entirely.
function leaveRoomAndReload() {
  net.send(MSG.LEAVE_ROOM);
  location.reload();
}

playAgainBtn.addEventListener("click", () => {
  audioSystem.uiClick();
  leaveRoomAndReload();
});

document.querySelector("[data-rematch]").addEventListener("click", () => {
  audioSystem.uiClick();
  net.send(MSG.REQUEST_REMATCH);
});

const spectateRoomCodeEl = document.querySelector("[data-spectate-room-code]");
const spectateStatusEl = document.querySelector("[data-spectate-status]");
document.querySelector("[data-spectate-leave]")?.addEventListener("click", () => {
  audioSystem.uiClick();
  leaveRoomAndReload();
});

let playersInRoom = 1; // creating/joining always seats the local player immediately

function enterLobby(code, playerNumber) {
  selfId = playerNumber;
  // Also reached when a waiting spectator gets promoted into an opened
  // seat (server sends the same ROOM_JOINED message for that) -- clear the
  // flag so the game loop stops treating them as a camera-only viewer.
  isSpectator = false;
  spectateTargetId = null;
  roomPhase = "lobby";
  currentRoomCode = code;
  roomCodeEl.textContent = code;
  hud.dataset.roomCodeHud = code;
  showView("lobby");
  countdownEl.hidden = true;
  // Reset synchronously here too (not just from the LOBBY_STATE handler
  // below, which sets the real value moments later) -- otherwise a
  // ranked-then-casual (or vice versa) rejoin in the same tab could
  // flash the PREVIOUS room's badge state for one frame.
  const rankedBadgeEl = document.querySelector("[data-ranked-badge]");
  if (rankedBadgeEl) rankedBadgeEl.hidden = true;
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
  if (!views.leaderboard.hidden) requestLeaderboard();
});

net.on(MSG.CHALLENGE_COMPLETED, (msg) => {
  audioSystem.pickup(); // reuses the same rewarding chime as an arena pickup
  pushKillFeed(`Challenge complete: ${msg.labels.join(", ")} (+${msg.reward} credits)`);
});

net.on(MSG.ACHIEVEMENT_UNLOCKED, (msg) => {
  audioSystem.pickup();
  for (const label of msg.labels) pushKillFeed(`Achievement unlocked: ${label}`);
});

net.on(MSG.ROOM_CREATED, (msg) => enterLobby(msg.code, msg.playerNumber));
net.on(MSG.ROOM_JOINED, (msg) => enterLobby(msg.code, msg.playerNumber));

// Sent instead of ROOM_JOINED when the room we tried to join was already
// full/in-progress -- see room.js's addSpectator. If a match is already
// live, the server follows this immediately with a MATCH_STATE snapshot,
// so the MATCH_STATE handler below takes it from here into the play view;
// otherwise this screen just sits and waits for MATCH_STARTING.
net.on(MSG.SPECTATING, (msg) => {
  selfId = null;
  isSpectator = true;
  spectateTargetId = msg.playerIds?.[0] ?? null;
  roomPhase = "spectating";
  currentRoomCode = msg.code;
  hud.dataset.roomCodeHud = msg.code;
  if (spectateRoomCodeEl) spectateRoomCodeEl.textContent = msg.code;
  if (spectateStatusEl) spectateStatusEl.textContent = "Waiting for the match to start…";
  showView("spectateWait");
});

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
    killstreakBannerEl.classList.remove("active");
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

  const rankedBadgeEl = document.querySelector("[data-ranked-badge]");
  if (rankedBadgeEl) rankedBadgeEl.hidden = !msg.ranked;

  playersInRoom = msg.players.length;
  playerListEl.innerHTML = msg.players
    .map((p) => {
      if (p.isBot) {
        const difficultyLabel = p.botDifficulty ? p.botDifficulty[0].toUpperCase() + p.botDifficulty.slice(1) : "Medium";
        return `<li data-player-row="${p.playerNumber}">BOT (${difficultyLabel}) — ready <button type="button" class="bot-remove" data-remove-bot="${p.playerNumber}">Remove</button></li>`;
      }
      return `<li data-player-row="${p.playerNumber}">${p.playerNumber}${p.playerNumber === selfId ? " (you)" : ""} — ${p.ready ? "ready" : "not ready"}</li>`;
    })
    .join("");

  const self = msg.players.find((p) => p.playerNumber === selfId);
  if (playersInRoom < 2) {
    readyBtn.disabled = true;
    lobbyStatusEl.textContent = "Waiting for at least one more player… or add a bot to practice against.";
  } else if (self?.ready) {
    readyBtn.disabled = true;
    lobbyStatusEl.textContent = "";
  } else {
    readyBtn.disabled = false;
    lobbyStatusEl.textContent = "";
  }

  const addBotBtn = document.querySelector("[data-add-bot]");
  const botDifficultySelect = document.querySelector("[data-bot-difficulty]");
  if (addBotBtn) {
    // Ranked rating only means something between real opponents -- hidden
    // outright rather than shown-disabled, since "you can't do this here at
    // all" reads differently than "not right now."
    addBotBtn.hidden = !!msg.ranked;
    if (botDifficultySelect) botDifficultySelect.hidden = !!msg.ranked;
    addBotBtn.disabled = playersInRoom >= 4; // mirrors room.js's MAX_PLAYERS -- just an early client-side hint, the server is the real gate
  }
});

let countdownTimer = null;
net.on(MSG.MATCH_STARTING, (msg) => {
  roomPhase = "starting";
  // A spectator who joined a still-full-but-not-yet-started room sits on
  // the spectate-wait screen (not the lobby) while this countdown runs --
  // the ticking number below updates the (currently hidden, for them)
  // lobby countdown regardless, so give them their own one-line heads-up.
  if (isSpectator && spectateStatusEl) spectateStatusEl.textContent = "Match starting…";
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
let gameInput = null; // set in startGameLoop() -- lets Settings apply a live sensitivity/key-rebind change to an already-running match, not just the next one
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

// { clip, startedAt, killerId } | null -- clip is a raw (un-interpolated)
// snapshot array from net.js's longer-lived history buffer, captured at the
// instant of death. Real-time 1:1 playback (duration === lookback) ending
// right at the fatal hit is the simplest mapping that still reads as "here's
// what just happened," so both constants are kept equal on purpose.
let killcamState = null;
const KILLCAM_LOOKBACK_MS = 2000;
const KILLCAM_DURATION_MS = 2000;
const killcamBadgeEl = document.querySelector("[data-killcam-badge]");

net.on(MSG.MATCH_EVENT, (msg) => {
  if (msg.event === "hit" || msg.event === "well_death" || msg.event === "moon_death" || msg.event === "debris_death") {
    const isSelfVictim = msg.victimId === selfId;
    audioSystem.explosion();
    pushKillFeed(buildKillFeedMessage(msg));

    if (isSelfVictim) {
      triggerDamageFlash();
      gameRenderer?.triggerShake(0.6);
      // well_death/moon_death have no killer to show a replay from -- only
      // an actual "hit" (shot by another ship) gets a killcam. Skipped
      // (rather than shown empty) if the history buffer hasn't accumulated
      // at least a couple of frames yet, e.g. dying within the first
      // instant of a match.
      if (msg.event === "hit" && msg.killerId) {
        const clip = net.getKillcamClip(KILLCAM_LOOKBACK_MS);
        if (clip.length >= 2) {
          killcamState = { clip, startedAt: performance.now(), killerId: msg.killerId };
        }
      }
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

  if (msg.event === "killstreak") {
    audioSystem.killstreak();
    // Only ever shown to everyone in the room (not just the streaking
    // player) since a multi-kill against the room is a shared spectacle,
    // same spirit as the kill feed already broadcasting every death to
    // everyone -- attribute it by name unless it's the local player's own.
    triggerKillstreakBanner(msg.playerId === selfId ? msg.label : `${playerLabel(msg.playerId)}: ${msg.label}`);
    return;
  }

  if (msg.event === "player_left") {
    pushKillFeed(`${msg.playerId.toUpperCase()} disconnected.`);
    return;
  }

  // Only ever reaches a spectator in practice -- the room is only deleted
  // once every seated PLAYER has left (see room.js's handleDisconnect), by
  // which point any real player would already be long gone themselves.
  // Without this, a spectator watching an emptied-out room would just sit
  // on a frozen screen forever with no explanation.
  if (msg.event === "room_closed") {
    pushKillFeed("Room closed.");
    setTimeout(leaveRoomAndReload, 1200);
    return;
  }

  if (msg.event === "match_over") {
    roomPhase = "over";
    winner = msg.winnerId;
    winReason = msg.reason ?? "won";
    const youWon = !isSpectator && winner === selfId;

    if (isSpectator) {
      matchOverText.textContent = winner ? `${playerLabel(winner)} WINS` : "MATCH OVER";
    } else {
      matchOverText.textContent = youWon ? "VICTORY" : winner ? "DEFEAT" : "MATCH OVER";
    }

    let scoreLine;
    if (winReason === "opponent_disconnected") {
      if (isSpectator) {
        scoreLine = winner ? "Everyone else disconnected." : "Everyone disconnected.";
      } else {
        scoreLine = youWon ? "Everyone else disconnected." : winner ? "You disconnected — match forfeited." : "Everyone disconnected.";
      }
    } else if (msg.finalScore) {
      scoreLine = Object.entries(msg.finalScore)
        .map(([id, kills]) => `${playerLabel(id)} ${kills}`)
        .join(" · ");
    } else {
      scoreLine = "";
    }
    matchOverScoreEl.textContent = scoreLine;

    // shotsFired is only present after a natural (kills-based) match end --
    // a forfeit cuts the match short, and "accuracy over an abandoned
    // match" isn't a meaningful number, so it's simply absent there (same
    // as finalScore already is for that case).
    const matchOverAccuracyEl = document.querySelector("[data-match-over-accuracy]");
    if (matchOverAccuracyEl) {
      matchOverAccuracyEl.textContent = msg.shotsFired
        ? Object.entries(msg.shotsFired)
            .map(([id, shots]) => {
              const kills = msg.finalScore?.[id] ?? 0;
              const pct = shots > 0 ? Math.round((kills / shots) * 100) : 0;
              return `${playerLabel(id)}: ${kills}/${shots} (${pct}%)`;
            })
            .join(" · ")
        : "";
    }

    // A spectator has no seat to request a rematch on behalf of (see the
    // matching server-side guard on REQUEST_REMATCH) -- hide the button
    // rather than let them click something that silently does nothing.
    const rematchBtn = document.querySelector("[data-rematch]");
    if (rematchBtn) rematchBtn.hidden = isSpectator;

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

// Round-trip latency display, shown only during an actual match -- the
// tiny badge in the HUD's bottom-right corner. net.send() already no-ops
// silently while the socket isn't open, so this timer is safe to just
// run unconditionally from page load rather than only while connected.
const latencyBadgeEl = document.querySelector("[data-latency-badge]");
net.on(MSG.LATENCY_PONG, (msg) => {
  if (!latencyBadgeEl) return;
  const rtt = Math.round(performance.now() - msg.sentAt);
  latencyBadgeEl.textContent = `${rtt} ms`;
  latencyBadgeEl.dataset.tier = rtt < 80 ? "good" : rtt < 150 ? "medium" : "bad";
});
setInterval(() => net.send(MSG.LATENCY_PING, { sentAt: performance.now() }), 2000);

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
  const input = createInputController(canvas, {
    sensitivityMultiplier: settings.sensitivity,
    thrustKey: settings.thrustKey,
    cameraToggleKey: settings.cameraToggleKey,
  });
  gameInput = input;
  wireTouchControls(input);
  const selfEngineColor = Loadouts.resolveEngineColor(profile?.equippedCosmetic);
  const renderer = createRenderer(canvas, selfEngineColor, settings.colorblindMode);
  gameRenderer = renderer;
  const minimapCanvas = document.getElementById("minimap-canvas");
  const minimap = minimapCanvas ? createMinimap(minimapCanvas) : null;
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
  window.__testHooks.debugState = () => ({
    self: latestSelf,
    ships: latestShips,
    tick: latestTick,
    pickups: latestPickups,
    inputState: input.getState(),
    isSpectator,
    spectateTargetId,
  });

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();

    // Killcam: while active, render frames from the frozen clip captured at
    // the moment of death instead of the live interpolation buffer, camera
    // locked on the killer -- see the "hit" MATCH_EVENT handler for how
    // killcamState gets populated. Real time keeps advancing server-side
    // regardless (the player has already respawned); this is purely a
    // client-side replay overlay on top of that.
    let killcamActive = false;
    if (killcamState) {
      const elapsed = now - killcamState.startedAt;
      if (elapsed >= KILLCAM_DURATION_MS) {
        killcamState = null;
      } else {
        killcamActive = true;
      }
    }
    if (killcamBadgeEl) killcamBadgeEl.hidden = !killcamActive;

    const renderTime = now - INTERPOLATION_DELAY_MS;
    let snap;
    if (killcamActive) {
      const progress = Math.min(1, (now - killcamState.startedAt) / KILLCAM_DURATION_MS);
      const index = Math.min(killcamState.clip.length - 1, Math.floor(progress * killcamState.clip.length));
      snap = killcamState.clip[index];
    } else {
      snap = net.sampleAt(renderTime);
    }

    // A spectator has no ship of their own -- renderId stands in for selfId
    // everywhere below (camera target, "self" ship model), pointed at
    // whichever player they're currently following. Re-picks automatically
    // if that target disconnects or a fresh match starts a new roster,
    // rather than freezing on a ghost id forever. Killcam overrides this
    // the same way, pinned to the killer for the duration of the replay.
    if (isSpectator && snap && (!spectateTargetId || !snap.playerIds.includes(spectateTargetId))) {
      spectateTargetId = snap.playerIds[0] ?? null;
    }
    const passive = isSpectator || killcamActive; // no ship control either way -- just a difference in WHY
    const renderId = killcamActive ? killcamState.killerId : selfId ?? (isSpectator ? spectateTargetId : null);
    const self = snap && renderId ? snap.ships[renderId] : null;

    // Only touches the DOM on an actual mode change -- covers a spectator
    // getting promoted mid-session, where startGameLoop()'s one-time setup
    // has already long since run and can't be relied on to reflect the
    // switch back to normal play.
    if (hud.dataset.spectating !== String(isSpectator)) {
      hud.dataset.spectating = String(isSpectator);
      if (spectateBadgeEl) spectateBadgeEl.hidden = !isSpectator;
      if (spectateHintEl) spectateHintEl.hidden = !isSpectator;
      if (spectateNextBtn) spectateNextBtn.hidden = !isSpectator;
    }
    if (hud.dataset.killcam !== String(killcamActive)) hud.dataset.killcam = String(killcamActive);

    // The server assigns each ship a spawn facing (toward the well) that
    // has nothing to do with the input controller's own default aim (0,0).
    // Sync to it once, before the first PLAYER_INPUT send -- otherwise the
    // very first input message snaps the ship's facing away from its spawn
    // orientation before the player has ever touched the mouse. Passive
    // viewers (spectating, or watching their own killcam) never send input
    // at all, so this sync is meaningless for them.
    if (self && !passive && !aimInitialized) {
      input.setInitialAim(self.yaw, self.pitch);
      aimInitialized = true;
    }
    // Never overwritten with the killer's ship data during a killcam --
    // latestSelf/latestShips/latestTick/latestPickups (below) stay anchored
    // to the real live match throughout, since other logic (kill-feed
    // victim lookups, the debug hook) expects them to reflect what's
    // actually happening right now, not a ~2s-old replay frame.
    if (!killcamActive) latestSelf = self;

    const inputState = input.getState();
    if (!passive && now - lastInputSend >= inputIntervalMs) {
      lastInputSend = now;
      const { aimYaw, aimPitch, thrusting, firing } = inputState;
      net.send(MSG.PLAYER_INPUT, { aimYaw, aimPitch, thrusting, firing });
    }

    if (!passive && inputState.thrusting !== wasThrusting) {
      wasThrusting = inputState.thrusting;
      audioSystem.setThrusting(wasThrusting);
    }
    renderer.setLocalThrust(passive ? false : inputState.thrusting);

    if (snap && renderId) {
      if (!killcamActive) {
        latestShips = snap.ships;
        latestTick = snap.tick;
        latestPickups = snap.pickups;
      }
      if (self) {
        // Third-person whenever there's no ship of the viewer's own being
        // piloted right now -- there's no first-person view that makes
        // sense for a ship you're not flying. The FOV thrust-kick follows
        // the TRACKED ship's real thrust state in that case too, not the
        // local input controller's (which never fires while passive).
        const thirdPerson = passive ? true : inputState.thirdPerson;
        const thrustFlag = passive ? !!self.thrusting : inputState.thrusting;
        renderer.updateCamera(self, thirdPerson, thrustFlag);
        if (!passive) renderer.updateTrajectoryPreview(self, inputState.thrusting, snap.tick);
      }
      renderer.updateOpponents(snap.ships, renderId);
      renderer.updateProjectiles(snap.projectiles, renderId, () => audioSystem.fire());
      renderer.updateMoons(snap.tick);
      renderer.updatePickups(snap.pickups);
      renderer.updateDebris(snap.debris);
      minimap?.draw(snap, renderId);
      // Killcam keeps the HUD ("You", heat/shield/boost) anchored to the
      // real local player even though the camera/self-ship-model is
      // following the killer -- you're still yourself, just watching a
      // replay of what just happened to you. Spectating has no real selfId
      // to fall back to, so renderId (the followed player) is the next best
      // thing there.
      const hudSelfId = killcamActive ? selfId : renderId;
      updateHud(hud, { connection: "connected", selfId: hudSelfId, matchState: snap, roomPhase, winner });
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
