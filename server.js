#!/usr/bin/env node
// Optional dedicated server: static files plus the game over WebSockets.
// The published game (GitHub Pages) doesn't need this -- players host
// matches for each other peer-to-peer (src/p2p.js). Open the page with
// ?server=1 to use this server instead.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as ProfileStore from "./src/profile-store.js";
import { createGameServer } from "./src/game-server.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8892;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function isInsideRoot(filePath) {
  return filePath === ROOT || filePath.startsWith(ROOT + path.sep);
}

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(ROOT, urlPath);
  if (!isInsideRoot(filePath)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// --- WebSocket / room layer --------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const game = createGameServer({ store: ProfileStore });

wss.on("connection", (ws) => {
  const socketId = game.connect((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    game.message(socketId, msg);
  });

  ws.on("close", () => game.disconnect(socketId));
});

// Half-open connection detection (standard ws ping/pong heartbeat pattern).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

ProfileStore.load();

// Render (and most PaaS hosts) send SIGTERM on redeploy/scale-down -- flush
// whatever's pending so a shutdown mid-match doesn't lose the last few
// seconds of earned currency on top of the deploy already wiping the disk.
process.on("SIGTERM", () => {
  ProfileStore.flushSync();
  process.exit(0);
});
process.on("SIGINT", () => {
  ProfileStore.flushSync();
  process.exit(0);
});

httpServer.listen(PORT, () => {
  console.log(`Gravity Duel listening on port ${PORT}`);
});
