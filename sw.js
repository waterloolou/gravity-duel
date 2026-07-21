// Deliberately minimal. Gravity Duel is a live WebSocket multiplayer game --
// there's no meaningful "offline mode" for a real-time match, so this
// doesn't attempt app-shell caching (which would also risk serving a stale
// client against a newer server after a deploy, a strictly worse failure
// mode than "no service worker at all"). This exists only so the page
// satisfies PWA install criteria (a registered service worker with a fetch
// handler) -- every request just passes straight through to the network.
self.addEventListener("fetch", () => {});
