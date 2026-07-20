// Renders the Hangar view (ship/weapon unlock + equip cards) from the
// current profile + loadouts catalog, and wires purchase/equip clicks to
// net.send. Kept separate from main.js the same way hud.js/render.js are --
// main.js owns view switching, this owns the Hangar's own DOM.

import { MSG } from "../protocol.js";
import * as Loadouts from "./loadouts.js";

function statSummaryHtml(kind, def) {
  if (kind === "ship") {
    return `Thrust ${def.thrustAccel} &middot; Top speed ${def.maxSpeed} &middot; Heat capacity ${def.maxHeat}`;
  }
  return `Fire rate ${(1 / def.fireCooldown).toFixed(2)}/s &middot; Shot speed ${def.projectileLaunchSpeed}`;
}

function buildCard(kind, id, def, profile, net, errorEl) {
  const unlockedField = kind === "ship" ? "unlockedShips" : "unlockedWeapons";
  const equippedField = kind === "ship" ? "equippedShip" : "equippedWeapon";
  const isUnlocked = profile[unlockedField].includes(id);
  const isEquipped = profile[equippedField] === id;

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
      net.send(MSG.EQUIP_LOADOUT, kind === "ship" ? { shipId: id } : { weaponId: id });
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
  if (upgradeList) {
    upgradeList.innerHTML = "";
    for (const [stat, tree] of Object.entries(Loadouts.UPGRADE_TREE)) {
      upgradeList.appendChild(buildUpgradeRow(stat, tree, profile, net, errorEl));
    }
  }
}
