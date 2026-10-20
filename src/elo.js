// Pure Elo rating math for the ranked queue. No I/O -- profile-store.js
// owns persisting the result; this module only knows how to compute one.
//
// Gravity Duel's ranked matches are still 2-4 player free-for-alls, not
// strict 1v1 duels, so a match is scored as a set of independent pairwise
// games: the winner is treated as having individually beaten every other
// player, and each pairwise result applies the standard Elo update on its
// own. A player's final delta is just the sum of their pairwise deltas.
// This is a well-known way to extend Elo to FFA without inventing a new
// rating system, and it degrades to exactly standard 1v1 Elo whenever a
// "match" only has 2 players.

export const DEFAULT_RATING = 1000;
const K_FACTOR = 32; // standard default (chess/most online ladders)

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

// `ratings` is a { playerId: currentRating } map (a missing entry defaults
// to DEFAULT_RATING, so a first-ever ranked match needs no special setup).
// Returns a NEW { playerId: newRating } map covering every id in
// `playerIds` -- the input map is never mutated.
export function applyMatchResult(ratings, playerIds, winnerId) {
  const deltas = Object.fromEntries(playerIds.map((id) => [id, 0]));
  for (const id of playerIds) {
    if (id === winnerId) continue;
    const rWinner = ratings[winnerId] ?? DEFAULT_RATING;
    const rOther = ratings[id] ?? DEFAULT_RATING;
    const expectedWinner = expectedScore(rWinner, rOther);
    deltas[winnerId] += K_FACTOR * (1 - expectedWinner);
    deltas[id] += K_FACTOR * (0 - (1 - expectedWinner));
  }
  const next = {};
  for (const id of playerIds) {
    next[id] = Math.round((ratings[id] ?? DEFAULT_RATING) + deltas[id]);
  }
  return next;
}
