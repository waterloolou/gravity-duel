// Writes the authoritative state that render.js also consumes into data-*
// attributes on an always-present HUD element. This is deliberately the
// source of truth for both human-visible score display AND automated
// end-to-end test assertions -- one computation, not two that could drift.

import { KILLS_TO_WIN } from "./physics.js";

function renderPips(container, kills) {
  let html = "";
  for (let i = 0; i < KILLS_TO_WIN; i++) {
    html += `<span class="pip${i < kills ? " filled" : ""}"></span>`;
  }
  container.innerHTML = html;
}

export function updateHud(hudEl, { connection, selfId, matchState, roomPhase, winner }) {
  hudEl.dataset.connection = connection ?? "disconnected";
  hudEl.dataset.selfId = selfId ?? "";
  hudEl.dataset.matchStatus = roomPhase ?? "";
  hudEl.dataset.winner = winner ?? "";

  if (matchState && selfId) {
    const opponentId = selfId === "p1" ? "p2" : "p1";
    const self = matchState.ships[selfId];
    const opp = matchState.ships[opponentId];
    const selfKills = String(self?.kills ?? 0);
    const oppKills = String(opp?.kills ?? 0);

    // Only touch the pip DOM when the count actually changed -- updateHud
    // runs once per rendered frame (~60Hz), and rebuilding these nodes every
    // frame regardless would be pointless DOM churn.
    if (hudEl.dataset.selfKills !== selfKills) {
      hudEl.dataset.selfKills = selfKills;
      const pips = hudEl.querySelector("[data-self-pips]");
      if (pips) renderPips(pips, Number(selfKills));
    }
    if (hudEl.dataset.oppKills !== oppKills) {
      hudEl.dataset.oppKills = oppKills;
      const pips = hudEl.querySelector("[data-opp-pips]");
      if (pips) renderPips(pips, Number(oppKills));
    }

    hudEl.dataset.selfInvulnerable = String(self?.invulnerable ?? false);
    const shieldBadge = hudEl.querySelector("[data-shield-badge]");
    if (shieldBadge) shieldBadge.hidden = !self?.invulnerable;
  }
}
