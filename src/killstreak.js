// Multi-kill detection: kills by the same player landed within a short time
// window of each other earn an escalating callout. Purely a spectacle/HUD
// concern -- it never affects scoring, currency, or win conditions, which
// already happen per-kill in server.js/match.js regardless of streak.

export const KILLSTREAK_WINDOW = 4; // seconds between kills to still count as the same streak

export const KILLSTREAK_LABELS = {
  2: "Double Kill!",
  3: "Triple Kill!",
  4: "Quad Kill!",
};
const MEGA_KILL_LABEL = "Mega Kill!"; // any further kill in the same window, beyond the named tiers above

// `timestamps` is this player's kill times so far in the current match,
// oldest first. Prunes anything that's fallen outside the window before
// appending `now`, so a streak that's gone cold correctly restarts at 2 on
// the next kill rather than accumulating forever. `label` is set only when
// this kill pushes the in-window count to 2 or more -- since this is meant
// to be called exactly once per real "hit" kill event, each tier naturally
// announces exactly once per streak, not on every tick the count stays at
// or above it.
export function recordKill(timestamps, now) {
  const inWindow = timestamps.filter((t) => now - t < KILLSTREAK_WINDOW);
  const next = [...inWindow, now];
  const label = next.length >= 2 ? (KILLSTREAK_LABELS[next.length] ?? MEGA_KILL_LABEL) : null;
  return { timestamps: next, label };
}
