/**
 * Shared top-of-HUD page nav — every view links to every other view.
 * Call mountSiteNav() once from each entry (main/chunk/hero/embedded).
 */

export interface SiteNavLink {
  href: string;
  label: string;
  /** true when this link is the active page/view */
  active: (path: string, search: string) => boolean;
}

const mode = (search: string) => new URLSearchParams(search).get("mode") ?? "chunk";
const isChunk = (path: string) => path.includes("chunk");

/** Canonical destinations available from every page. */
export const SITE_NAV: SiteNavLink[] = [
  {
    href: "/",
    label: "full map",
    active: (path) =>
      path === "/" || path.endsWith("/index.html") || path.endsWith("/embedded.html"),
  },
  {
    href: "/hero.html",
    label: "hero tile",
    active: (path) => path.includes("hero"),
  },
  {
    href: "/chunk.html?mode=gallery",
    label: "gallery",
    active: (path, search) => isChunk(path) && mode(search) === "gallery",
  },
  {
    href: "/chunk.html?mode=chunk&x=-3&y=-44&r=11",
    label: "forest chunk",
    active: (path, search) => {
      if (!isChunk(path) || mode(search) === "gallery") return false;
      const q = new URLSearchParams(search);
      return q.get("x") === "-3" && q.get("y") === "-44";
    },
  },
  {
    href: "/chunk.html?mode=chunk&x=-4.5&y=12&r=12",
    label: "Korea desert",
    active: (path, search) => {
      if (!isChunk(path) || mode(search) === "gallery") return false;
      const q = new URLSearchParams(search);
      return q.get("x") === "-4.5" && q.get("y") === "12";
    },
  },
  {
    href: "/chunk.html?mode=chunk&x=0&y=0&r=18",
    label: "origin",
    active: (path, search) => {
      if (!isChunk(path) || mode(search) === "gallery") return false;
      const q = new URLSearchParams(search);
      // default chunk also lands near origin if no params — only mark explicit origin
      return q.get("x") === "0" && q.get("y") === "0";
    },
  },
];

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected || document.getElementById("site-nav-styles")) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "site-nav-styles";
  style.textContent = `
    #site-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      margin: 8px 0 0;
      padding-top: 8px;
      border-top: 1px solid rgba(58, 74, 98, 0.85);
    }
    #site-nav a {
      color: #9cf;
      font-size: 12px;
      text-decoration: none;
      white-space: nowrap;
    }
    #site-nav a:hover { color: #cfe8ff; text-decoration: underline; }
    #site-nav a.is-active {
      color: #f3d789;
      font-weight: 600;
      pointer-events: none;
      text-decoration: none;
    }
    #site-nav .nav-label {
      flex: 0 0 100%;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.45;
      margin: 0 0 2px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Fill `#site-nav` (or create it under `#hud` if missing) with the shared links.
 * Active page is highlighted and not clickable.
 */
export function mountSiteNav(): void {
  injectStyles();
  const path = location.pathname;
  const search = location.search;

  let host = document.getElementById("site-nav");
  if (!host) {
    const hud = document.getElementById("hud");
    if (!hud) return;
    host = document.createElement("nav");
    host.id = "site-nav";
    // insert before .controls / .muted if present, else append
    const anchor =
      hud.querySelector(".controls") ??
      hud.querySelector(".muted") ??
      null;
    if (anchor) hud.insertBefore(host, anchor);
    else hud.appendChild(host);
  }

  host.innerHTML =
    `<span class="nav-label">Views</span>` +
    SITE_NAV.map((link) => {
      const on = link.active(path, search);
      if (on) return `<a class="is-active" aria-current="page">${link.label}</a>`;
      return `<a href="${link.href}">${link.label}</a>`;
    }).join("");
}
