// Renders the Leaderboard view from a LEADERBOARD_STATE payload. Kept
// separate from main.js the same way hangar.js/hud.js are.
//
// displayName is free-text chosen by OTHER players and rendered here to
// everyone who opens the leaderboard -- a real stored-XSS surface if
// interpolated into innerHTML unescaped, so every render path here goes
// through escapeHtml() even though nothing else in this codebase has
// needed to (every other user-facing string so far has been either
// developer-controlled content or plain textContent assignment).
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// A literal middle-dot, not the &middot; HTML entity -- this string gets
// used both via innerHTML (the ranked list) and via textContent (the self
// summary line below), and entities only decode in the former.
function statsLine(stats) {
  const kd = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills.toFixed(2);
  return `${stats.wins}W-${stats.losses}L · ${stats.kills}K/${stats.deaths}D (${kd})`;
}

export function renderLeaderboard(data) {
  const listEl = document.querySelector("[data-leaderboard-list]");
  const selfEl = document.querySelector("[data-leaderboard-self]");
  if (!data || !listEl) return;

  listEl.innerHTML = data.top.length
    ? data.top
        .map(
          (row) => `
        <li class="leaderboard-row${row.isYou ? " is-you" : ""}">
          <span class="lb-rank">#${row.rank}</span>
          <span class="lb-name">${escapeHtml(row.displayName)}</span>
          <span class="lb-stats">${statsLine(row.stats)}</span>
        </li>`
        )
        .join("")
    : `<li class="leaderboard-empty">No matches played yet -- be the first.</li>`;

  if (selfEl) {
    selfEl.textContent = data.self ? `Your rank: #${data.self.rank} — ${statsLine(data.self.stats)}` : "Play a match to appear on the leaderboard.";
  }
}
