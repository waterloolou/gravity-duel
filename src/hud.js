// Writes the authoritative state that render.js also consumes into data-*
// attributes on an always-present HUD element. This is deliberately the
// source of truth for both human-visible score display AND automated
// end-to-end test assertions -- one computation, not two that could drift.

export function updateHud(hudEl, { connection, selfId, matchState, roomPhase, winner }) {
  hudEl.dataset.connection = connection ?? "disconnected";
  hudEl.dataset.selfId = selfId ?? "";
  hudEl.dataset.matchStatus = roomPhase ?? "";
  hudEl.dataset.winner = winner ?? "";

  if (matchState && selfId) {
    const opponentId = selfId === "p1" ? "p2" : "p1";
    const self = matchState.ships[selfId];
    const opp = matchState.ships[opponentId];
    hudEl.dataset.selfKills = String(self?.kills ?? 0);
    hudEl.dataset.oppKills = String(opp?.kills ?? 0);
    hudEl.dataset.selfInvulnerable = String(self?.invulnerable ?? false);
  }

  const scoreEl = hudEl.querySelector("[data-score-display]");
  if (scoreEl && matchState && selfId) {
    scoreEl.textContent = `You: ${hudEl.dataset.selfKills} — Opponent: ${hudEl.dataset.oppKills}`;
  }
}
