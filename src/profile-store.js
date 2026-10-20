// Server-side persistence for anonymous player profiles: an in-memory Map is
// the source of truth for every read (so gameplay-path lookups are always
// synchronous and never block on disk), with a debounced, atomic
// write-through to a JSON file so progress survives a normal server restart.
//
// This file is I/O-heavy server orchestration, not the pure/unit-tested
// style used elsewhere (room.js, profile.js) -- held to the same lower
// rigor bar as server.js itself, deliberately not a *.test.js target.
//
// Known limitation: hosts with ephemeral disk (e.g. Render's free tier)
// wipe data/players.json on every redeploy, and likely on idle-sleep/wake
// too. "Persists across sessions" holds during normal uptime, not across a
// deploy -- surfaced to players in the Hangar UI, not hidden here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileStore } from "./profile-store-core.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DATA_PATH = path.join(DATA_DIR, "players.json");
const FLUSH_DELAY_MS = 3000; // coalesces bursts (e.g. several kills in a row) into one write

let dirty = false;
let writeTimer = null;
const store = createProfileStore({ onChange: markDirty });
const profiles = store.profiles; // playerId -> profile

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    for (const [id, profile] of Object.entries(raw)) profiles.set(id, profile);
    console.log(`profile-store: loaded ${profiles.size} player profile(s) from ${DATA_PATH}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`profile-store: couldn't read ${DATA_PATH}, starting with an empty store (${err.message})`);
    }
  }
}

function markDirty() {
  dirty = true;
  if (!writeTimer) writeTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  writeTimer = null;
  if (!dirty) return;
  dirty = false;
  const tmpPath = `${DATA_PATH}.tmp`;
  const json = JSON.stringify(Object.fromEntries(profiles));
  try {
    await fs.promises.writeFile(tmpPath, json, "utf8");
    // rename is atomic on the same filesystem -- a reader (or a crash mid-write)
    // only ever sees the fully-old or fully-new file, never a torn one.
    await fs.promises.rename(tmpPath, DATA_PATH);
  } catch (err) {
    console.warn(`profile-store: failed to persist ${DATA_PATH} (${err.message})`);
    dirty = true; // retry on the next markDirty-triggered flush
  }
  if (dirty) writeTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

// Synchronous and best-effort -- used only on process shutdown, where
// blocking briefly to avoid losing the last few seconds of currency is
// worth it (the async flush() above is for the normal hot path).
export function flushSync() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(Object.fromEntries(profiles)), "utf8");
  } catch (err) {
    console.warn(`profile-store: shutdown flush failed (${err.message})`);
  }
}

// The store's operations (get, awardCurrency, addStats, ...) live in
// profile-store-core.js, shared with the in-browser peer-to-peer host.
export const {
  get,
  awardCurrency,
  addStats,
  recordChallengeProgress,
  applyRankedResult,
  addMatchHistoryEntry,
  checkAchievements,
  set,
  getLeaderboard,
  getRankedLeaderboard,
} = store;
