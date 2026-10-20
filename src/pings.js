// A small fixed set of preset in-match callouts -- deliberately NOT free-text
// chat. Free text would be a real moderation/abuse surface the moment Quick
// Play matches total strangers together; a closed set of pings gives a
// social/tactical layer without that risk. Shared between client and server
// (like protocol.js's MSG) so server.js can validate every incoming pingId
// against this exact list rather than trusting whatever string a client
// sends.

export const PINGS = {
  watch_out: { id: "watch_out", label: "Watch out!", key: "1" },
  nice_shot: { id: "nice_shot", label: "Nice shot!", key: "2" },
  incoming: { id: "incoming", label: "Incoming!", key: "3" },
  thanks: { id: "thanks", label: "Thanks!", key: "4" },
};

// A player who could somehow fire off pings faster than a human plausibly
// would is either spamming or scripting -- this is purely an anti-spam
// floor, not a gameplay balance number, so it's kept here rather than in
// physics.js alongside the actually-tuned combat constants.
export const PING_COOLDOWN_MS = 1500;
