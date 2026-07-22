// Renders the Hangar view (ship/weapon unlock + equip cards) from the
// current profile + loadouts catalog, and wires purchase/equip clicks to
// net.send. Kept separate from main.js the same way hud.js/render.js are --
// main.js owns view switching, this owns the Hangar's own DOM.

import { MSG } from "../protocol.js";
import * as Loadouts from "./loadouts.js";

const UNLOCKED_FIELD_BY_KIND = { ship: "unlockedShips", weapon: "unlockedWeapons", cosmetic: "unlockedCosmetics" };
const EQUIPPED_FIELD_BY_KIND = { ship: "equippedShip", weapon: "equippedWeapon", cosmetic: "equippedCosmetic" };
const EQUIP_PAYLOAD_KEY_BY_KIND = { ship: "shipId", weapon: "weaponId", cosmetic: "cosmeticId" };

function statSummaryHtml(kind, def) {
  if (kind === "ship") {
    return `Thrust ${def.thrustAccel} &middot; Top speed ${def.maxSpeed} &middot; Heat capacity ${def.maxHeat}`;
  }
  if (kind === "weapon") {
    return `Fire rate ${(1 / def.fireCooldown).toFixed(2)}/s &middot; Shot speed ${def.projectileLaunchSpeed}`;
  }
  // cosmetic: a color swatch reads better here than any numeric stat line --
  // there's nothing to compare, engine color is purely visual.
  const hex = `#${def.engineColor.toString(16).padStart(6, "0")}`;
  return `<span class="cosmetic-swatch" style="background:${hex};color:${hex}"></span>`;
}

function buildCard(kind, id, def, profile, net, errorEl) {
  const isUnlocked = profile[UNLOCKED_FIELD_BY_KIND[kind]].includes(id);
  const isEquipped = profile[EQUIPPED_FIELD_BY_KIND[kind]] === id;

  const card = document.createElement("div");
  card.className = `loadout-card${isEquipped ? " equipped" : ""}`;
  card.innerHTML = `
    <div class="loadout-name">${def.name}${isEquipped ? ' <span class="loadout-equipped-tag">EQUIPPED</span>' : ""}</div>
    <div class="loadout-stats">${statSummaryHtml(kind, def)}</div>
  `;

  const actionBtn = document.createElement("button");
  actionBtn.type = "button";
  actionBtn.className = "secondary";
  if (isEquipped) {
    actionBtn.textContent = "Equipped";
    actionBtn.disabled = true;
  } else if (isUnlocked) {
    actionBtn.textContent = "Equip";
    actionBtn.addEventListener("click", () => {
      errorEl.textContent = "";
      net.send(MSG.EQUIP_LOADOUT, { [EQUIP_PAYLOAD_KEY_BY_KIND[kind]]: id });
    });
  } else {
    actionBtn.textContent = def.cost > 0 ? `Unlock — ${def.cost} credits` : "Unlock";
    actionBtn.disabled = profile.currency < def.cost;
    actionBtn.addEventListener("click", () => {
      errorEl.textContent = "";
      net.send(MSG.PURCHASE_UNLOCK, { kind, id });
    });
  }
  card.appendChild(actionBtn);
  return card;
}

function buildUpgradeRow(stat, tree, profile, net, errorEl) {
  const level = profile.upgrades[stat] ?? 0;
  const maxed = level >= tree.maxLevel;

  const row = document.createElement("div");
  row.className = "upgrade-row";

  let pipsHtml = "";
  for (let i = 0; i < tree.maxLevel; i++) pipsHtml += `<span class="upgrade-pip${i < level ? " filled" : ""}"></span>`;

  row.innerHTML = `
    <div class="upgrade-info">
      <div class="upgrade-name">${tree.label}</div>
      <div class="upgrade-pips">${pipsHtml}</div>
    </div>
  `;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  if (maxed) {
    btn.textContent = "Maxed";
    btn.disabled = true;
  } else {
    const cost = Loadouts.upgradeCost(level);
    btn.textContent = `Level Up — ${cost} credits`;
    btn.disabled = profile.currency < cost;
    btn.addEventListener("click", () => {
      errorEl.textContent = "";
      net.send(MSG.PURCHASE_UPGRADE, { stat });
    });
  }
  row.appendChild(btn);
  return row;
}

// Called whenever the Hangar is shown and whenever a fresh PROFILE_STATE
// arrives while it's open, so purchases/equips/upgrades reflect immediately
// without needing a page reload.
export function renderHangar(profile, net) {
  const errorEl = document.querySelector("[data-hangar-error]");
  const shipGrid = document.querySelector("[data-ship-grid]");
  const weaponGrid = document.querySelector("[data-weapon-grid]");
  const cosmeticGrid = document.querySelector("[data-cosmetic-grid]");
  const upgradeList = document.querySelector("[data-upgrade-list]");
  if (!profile || !shipGrid || !weaponGrid) return;

  shipGrid.innerHTML = "";
  for (const [id, def] of Object.entries(Loadouts.SHIPS)) {
    shipGrid.appendChild(buildCard("ship", id, def, profile, net, errorEl));
  }
  weaponGrid.innerHTML = "";
  for (const [id, def] of Object.entries(Loadouts.WEAPONS)) {
    weaponGrid.appendChild(buildCard("weapon", id, def, profile, net, errorEl));
  }
  if (cosmeticGrid) {
    cosmeticGrid.innerHTML = "";
    for (const [id, def] of Object.entries(Loadouts.COSMETICS)) {
      cosmeticGrid.appendChild(buildCard("cosmetic", id, def, profile, net, errorEl));
    }
  }
  if (upgradeList) {
    upgradeList.innerHTML = "";
    for (const [stat, tree] of Object.entries(Loadouts.UPGRADE_TREE)) {
      upgradeList.appendChild(buildUpgradeRow(stat, tree, profile, net, errorEl));
    }
  }
}
