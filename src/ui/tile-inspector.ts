/**
 * Hover tile inspector: everything the save knows about the tile under the
 * cursor. Info gathering + HTML assembly are DOM-free so they stay testable
 * in bun:test; only TileTooltip touches the document.
 */

import type { BoardModel, CityMarker, RenderTile, UnitMarker } from "../render/board-model";

export interface TileHoverInfo {
  tile: RenderTile;
  city?: CityMarker;
  units: UnitMarker[];
}

/** Per-tile lookup of cities/units, built once per board model. */
export class TileInfoIndex {
  private readonly cityByKey = new Map<string, CityMarker>();
  private readonly unitsByKey = new Map<string, UnitMarker[]>();

  constructor(model: BoardModel) {
    for (const c of model.cities) this.cityByKey.set(c.key, c);
    for (const u of model.units) {
      const list = this.unitsByKey.get(u.key);
      if (list) list.push(u);
      else this.unitsByKey.set(u.key, [u]);
    }
  }

  info(tile: RenderTile): TileHoverInfo {
    return {
      tile,
      city: this.cityByKey.get(tile.key),
      units: this.unitsByKey.get(tile.key) ?? [],
    };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function row(label: string, value: string): string {
  return `<div class="ti-row"><span class="ti-label">${label}</span><span>${value}</span></div>`;
}

export function tileInfoHtml(info: TileHoverInfo): string {
  const { tile, city, units } = info;
  const parts: string[] = [];

  const title = tile.naturalWonder ?? tile.baseTerrain;
  parts.push(`<div class="ti-title">${esc(title)}</div>`);
  if (tile.naturalWonder) parts.push(row("Base", esc(tile.baseTerrain)));
  if (tile.features.length > 0) parts.push(row("Features", esc(tile.features.join(", "))));
  if (tile.resource) {
    const type = tile.resourceType ? ` (${tile.resourceType})` : "";
    parts.push(row("Resource", esc(tile.resource) + type));
  }
  if (tile.improvement) parts.push(row("Improvement", esc(tile.improvement)));
  if (tile.roadStatus) parts.push(row("Road", tile.roadStatus));
  if (tile.owner) parts.push(row("Owner", esc(tile.owner)));
  if (city) parts.push(row("City", `${esc(city.name)} — ${esc(city.civ)}, pop ${city.population}`));
  for (const u of units) {
    parts.push(row(u.military ? "Unit ⚔" : "Unit", `${esc(u.name)} (${esc(u.civ)})`));
  }
  parts.push(`<div class="ti-hex">hex ${tile.hex.x}, ${tile.hex.y}</div>`);
  return parts.join("");
}

/**
 * Tooltip HTML for the spec-based demo views (chunk/gallery/hero), where a
 * tile is just baseTerrain + features + key.
 */
export function specInfoHtml(spec: {
  baseTerrain: string;
  features: string[];
  key: string;
}): string {
  const parts: string[] = [`<div class="ti-title">${esc(spec.baseTerrain)}</div>`];
  if (spec.features.length > 0) parts.push(row("Features", esc(spec.features.join(", "))));
  parts.push(`<div class="ti-hex">${esc(spec.key)}</div>`);
  return parts.join("");
}

/** Cursor-following tooltip panel, styled to match the HUD. */
export class TileTooltip {
  private readonly el: HTMLDivElement;

  constructor() {
    this.injectStyles();
    this.el = document.createElement("div");
    this.el.id = "tile-tooltip";
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  show(clientX: number, clientY: number, html: string): void {
    this.el.innerHTML = html;
    this.el.hidden = false;
    // offset from cursor; flip when the panel would leave the viewport
    const pad = 14;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let x = clientX + pad;
    let y = clientY + pad + 4;
    if (x + w > window.innerWidth - 4) x = clientX - pad - w;
    if (y + h > window.innerHeight - 4) y = clientY - pad - h;
    this.el.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
  }

  private injectStyles(): void {
    if (document.getElementById("tile-tooltip-styles")) return;
    const style = document.createElement("style");
    style.id = "tile-tooltip-styles";
    style.textContent = `
      #tile-tooltip {
        position: fixed; top: 0; left: 0; z-index: 20;
        pointer-events: none;
        color: #e8e2ce; font-family: Georgia, serif; font-size: 12px;
        background: rgba(12, 22, 38, 0.88); border: 1px solid #3a4a62;
        border-radius: 8px; padding: 8px 12px; max-width: 260px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
      }
      #tile-tooltip .ti-title {
        color: #f3d789; font-size: 14px; margin-bottom: 3px;
      }
      #tile-tooltip .ti-row { display: flex; gap: 8px; line-height: 1.5; }
      #tile-tooltip .ti-label { opacity: 0.6; min-width: 74px; }
      #tile-tooltip .ti-hex {
        opacity: 0.45; font-size: 10px; margin-top: 4px;
        letter-spacing: 0.04em;
      }
    `;
    document.head.appendChild(style);
  }
}
