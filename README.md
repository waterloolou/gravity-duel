# Gravity Duel

A real-time 2–4 player 3D free-for-all where your shots curve under real gravity. Aim around the well, or through it.

## ▶ [Play in your browser](https://waterloolou.github.io/gravity-duel/)

No install, no server. Works on desktop (mouse + keyboard) and touch screens.

## Modes
- **Quick Play**: joins someone already waiting for a match, or starts one and waits for an opponent. Add bots while you wait.
- **Ranked**: same matchmaking, Elo on the line, no bots.
- **Play with a friend**: *Create room* and send the 4-letter code or the *Copy Invite Link* link. Your friend types the code into *Join room* or just opens the link.
- **Vs bots**: create a room, *Add Bot* (Easy / Medium / Hard), press *Ready*. Works offline.

Controls: mouse to aim · **W** thrust · **click** fire · **C** toggle camera · **1–4** quick-chat pings.

## How online play works (no server)
Like [Cursed Clash](https://github.com/waterloolou/Cursed_Clash), Gravity Duel is peer-to-peer:

- Every browser runs its own copy of the game server (`src/game-server.js`).
- Whoever creates a room **hosts** it: their tab runs the physics for everyone, and friends connect straight to it over WebRTC ([PeerJS](https://peerjs.com/) is used only to introduce the two browsers).
- Quick Play and Ranked look for a host on a few shared matchmaking slots, and become the host if none is waiting (`src/p2p.js`).
- Credits, unlocks and stats are saved in each player's own browser and travel with them to whichever room they join.

The host should keep the game tab open and in front: browsers slow down background tabs, which would pause the match.

## Run it locally
```bash
npm install
npm start          # serves http://localhost:8892
npm test           # physics, rooms, matches, profiles, bots, game server
```
Open http://localhost:8892 for peer-to-peer mode, or http://localhost:8892/?server=1 to play through the Node WebSocket server (`server.js`) instead.
