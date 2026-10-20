// Writes the authoritative state that render.js also consumes into data-*
// attributes on an always-present HUD element. This is deliberately the
// source of truth for both human-visible score display AND automated
// end-to-end test assertions -- one computation, not two that could drift.

import { KILLS_TO_WIN, MAX_HEAT } from "./physics.js";

function renderPipsHtml(kills) {
  let html = "";
  for (let i = 0; i < KILLS_TO_WIN; i++) {
    html += `<span class="pip${i < kills ? " filled" : ""}"></span>`;
  }
  return html;
}

// One card per active player (2-4), self highlighted -- "VS" between exactly
// two (the common 1v1 case, matching the original layout), a plain divider
// otherwise since "VS" doesn't read right among 3+ combatants.
function renderScoreboard(container, playerIds, ships, selfId) {
  const cards = playerIds.map((id) => {
    const isSelf = id === selfId;
    const label = isSelf ? "You" : id.toUpperCase();
    const kills = ships[id]?.kills ?? 0;
    return `<div class="score-side ${isSelf ? "self" : "opp"}"><span class="score-label">${label}</span><div class="kill-pips">${renderPipsHtml(kills)}</div></div>`;
  });
  const divider = playerIds.length === 2 ? '<span class="score-vs">VS</span>' : '<span class="score-divider"></span>';
  container.innerHTML = cards.join(divider);
  container.dataset.count = String(playerIds.length);
}

export function updateHud(hudEl, { connection, selfId, matchState, roomPhase, winner }) {
  hudEl.dataset.connection = connection ?? "disconnected";
  hudEl.dataset.selfId = selfId ?? "";
  hudEl.dataset.matchStatus = roomPhase ?? "";
  hudEl.dataset.winner = winner ?? "";

  if (matchState && selfId) {
    // Only touch the scoreboard DOM when something actually changed --
    // updateHud runs once per rendered frame (~60Hz), and rebuilding these
    // nodes every frame regardless would be pointless DOM churn. selfId is
    // part of the signature (not just playerIds/kills) because it can now
    // change mid-match on its own: a spectator cycling which ship they're
    // following (see main.js's cycleSpectateTarget) needs the "You"
    // highlight to move immediately, even if no one's score changed.
    const signature = `${selfId}|${matchState.playerIds.map((id) => `${id}:${matchState.ships[id]?.kills ?? 0}`).join(",")}`;
    if (hudEl.dataset.scoreSignature !== signature) {
      hudEl.dataset.scoreSignature = signature;
      const panel = hudEl.querySelector("[data-score-panel]");
      if (panel) renderScoreboard(panel, matchState.playerIds, matchState.ships, selfId);
    }

    const self = matchState.ships[selfId];
    hudEl.dataset.selfInvulnerable = String(self?.invulnerable ?? false);
    const shieldBadge = hudEl.querySelector("[data-shield-badge]");
    if (shieldBadge) shieldBadge.hidden = !self?.invulnerable;

    const boostBadge = hudEl.querySelector("[data-boost-badge]");
    if (boostBadge) boostBadge.hidden = !self?.speedBoosted;

    const heatGauge = hudEl.querySelector("[data-heat-gauge]");
    if (heatGauge && self) {
      const pct = Math.max(0, Math.min(100, (self.heat / MAX_HEAT) * 100));
      const fill = heatGauge.querySelector("[data-heat-fill]");
      if (fill) fill.style.width = `${pct}%`;
      heatGauge.dataset.overheated = String(!!self.overheated);
      const label = heatGauge.querySelector("[data-heat-label]");
      if (label) label.textContent = self.overheated ? "OVERHEATED" : "ENGINE";
    }
  }
}
