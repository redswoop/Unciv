# Civ5-Look Renderer (Unciv save viewer)

Web renderer that loads **real Unciv save files** and draws them as a pannable,
tiltable, Civ5-style 3D map in three.js. No Unciv engine changes ever — we
consume its save output. The POC is done; current work is visual quality.

**Read first:** `README.md` (what proved out, screenshots), `docs/SAVE_FORMAT.md`
(save wire format, JSON dialects, minimum GameInfo subset, save provenance).

## Commands

```bash
bun install
bun run dev          # vite dev server at http://127.0.0.1:5199 (loads the reference save)
bun test             # all tests — most assert against REAL saves
bun run summary      # parse the reference save, print text summary
bunx tsc --noEmit    # typecheck (strict)
bunx vite build      # normal build -> dist/ (used by Pages workflow)
bunx vite build --config vite.embedded.config.ts   # single-file build -> dist-embedded/embedded.html
bun run e2e/screenshot.ts "http://127.0.0.1:5199/?x=15&y=12&dist=16&tilt=0.9" /tmp/shot.png
```

Screenshots: headless chromium at `/opt/pw-browsers/chromium` (playwright-core,
`--use-angle=swiftshader` for WebGL). The page exposes a readiness contract —
wait on `#app[data-render-state="ready"]`, never timers. Camera framing is URL
params: `?x=&y=&dist=&tilt=`.

## Architecture (data flows one way)

```
save file (base64+gzip, libGDX JSON) 
  → src/save/load-save.ts + gdx-json.ts     parse (all 3 libGDX dialects)
  → src/save/types.ts                       minimal GameInfo subset (reality-derived)
  → src/ruleset/ruleset.ts                  name → definition (terrains, nations→colors…)
  → src/render/board-model.ts               PURE render model: world pos (hex-math),
                                            heights, welded corner heights, owners,
                                            borders, rivers, roads, cities, units
  → src/render/scene.ts                     three.js: merged geometries, lights, sprites
  → src/app-boot.ts                         shared boot; entries: main.ts (fetch)
                                            and embedded-main.ts (all inlined)
```

- `board-model.ts` imports no three.js; `scene.ts` holds no game knowledge.
  Keep it that way — every mapping decision must be testable in bun:test.
- `src/hex/hex-math.ts` is a **1:1 port of Unciv's HexMath.kt**. Do not
  "improve" it or introduce redblob axial math — Unciv's scheme is its own
  (x = 10 o'clock neighbour, y = 2 o'clock; world = clock-vector combination).
  Quirks of the original are pinned by tests on purpose.
- `src/render/asset-map.json` is the single Unciv-id → asset mapping.
  **Asset choices are data, not code.** Texture slots live in
  `public/textures/artful/`; real Artful pack conversions come from
  `cli/convert-artful.py` (needs Pillow + the pack zip), procedural fills from
  `cli/generate-textures.ts` (never overwrites existing files; `--force` to regen).

## Hard rules

- **Parse reality.** Types and parsers were reverse-engineered from real saves
  (`public/saves/` — archived multiplayer games, see SAVE_FORMAT.md). Never
  invent schema; when a new save breaks parsing, fix against that save and add
  it as a fixture.
- **Two fixture saves, two jobs.** `aztecs-turn0.unciv` is the REFERENCE WORLD:
  bundled default of dev server / embedded build / chunk presets, Armen's own
  game (1276 tiles, world-wrap, 3 natural wonders; landmarks pinned in
  `aztec-world.test.ts` — capital @ world (15,12), forest (7.5,1), desert/Sinai
  (-15,-10.5)). `turn518-14civs.unciv` is the late-game regression fixture
  (9919 tiles, 266 cities, borders/roads/rivers at scale). New model/render
  logic gets tests against whichever exercises it — usually both (see
  `board-model.test.ts` patterns: welded corners, no shearing, edge lengths).
- Old saves use libGDX *minimal* JSON (unquoted keys AND values) and omit
  default-valued fields (`position:{}` = origin, no `turns` = 0). Ruleset JSONs
  have `//` comments + trailing commas. `parseGdxJson` handles all of it.
- TypeScript strict; no default exports; bun for everything.

## Visual quality backlog (the "looks kind of awful" list)

Camera FOV 16°, tilt 0.9. Full map uses **Firaxis digimaps + piece heightmaps**
when `public/textures/civ5/` exists (`python3 cli/extract-civ5-assets.py` from
local Steam Civ5); otherwise Artful fallback. Kit: `src/render/civ5-tiles.ts`.
Chunk/hero demos: `/chunk.html`, `/hero.html`.

Done: core land looks locked (grass/plains/desert/tundra/snow, flat + hill)
with per-terrain `TerrainLook.gain` calibrated vs the real frame capture
(rendered ground = source digimap × 0.75, ratios preserved — recalibrate gains
if lighting/tone mapping changes), smooth per-vertex baked hillshade, and
priority-ordered land-land blend skirts (higher `blendPriority` washes over
lower; all pinned in `civ5-tiles.test.ts`). Remaining gaps:

1. **City banners are world-scaled sprites** — monstrous when zoomed in,
   overlapping when zoomed out. Fix: screen-space size cap (scale sprites by
   distance in the render loop), fade/cluster at far zoom. `scene.ts` cities section.
2. **Foliage polish** — forests follow extracted `docs/civ5-forests.xml`
   (360 trees/tile, 4 masks, space_between, overlay α0.6), LOD-scaled
   (hero/detail/full). Still billboard atlas not 3D GR2; atlas res + true
   360 density on full map are remaining knobs.
3. **Railroads/roads are chunky flat quads** — the dark crisscross reads as
   scribbles. Thinner width, dashed ties for rail, and route through edge
   midpoints (curve via city/tile centers) would read far better.
4. **Unit markers are letter-initial billboards.** Even Civ5-style flag pins
   (pole + banner icon shape) would read better; unit-type icon atlas later.
5. **Water (mostly done)** — Civ5-style system: water tiles carry negative
   seabed depths (`SEABED_DEPTH`), the waterline is the z=0 contour of the
   welded field. Geometry rules earned by iteration (each guards against a
   regression we hit): land centers clamped ≥ `LAND_MIN_H`; every corner
   touching water capped ≤ `SHORE_CORNER_Z` (else mountains hoist seabed
   into dry hex plates); water centers = MEAN of welded corners (else each
   tile is a bowl → sand ridges along every hex edge); `shoreWobble`
   two-octave world noise displaces the field near the waterline at FULL
   strength (else the coast runs parallel to hex edges — value noise RMS is
   ~¼ of max, so amplitude must look oversized on paper), with water clamped
   ≤ −0.008 so crests never beach. One shared seabed material (sand→reef by
   depth, two-octave threshold noise); land materials mirror the exact same
   floor formula × `WATER_GAIN` below the waterline (hex-edge seams
   otherwise); translucent z=0 surface driven by Firaxis' `waterdepthcolor`
   LUT (RGB = tint, ALPHA = opacity ramp) + animated foam. Calibration
   traps: load the LUT **non-sRGB** (hardware decode + ACES crushes its navy
   to black), NO normal map on the surface (minification → binary speckle;
   bumps only feed foam noise), beach/floor shader passes only on welded
   boards (standalone chunk tiles sit at FLAT_Z ≈ the sand band). Remaining:
   close-zoom shimmer, Ice feature look, mountain-foot rock/beach blend.
6. **No fog of war** — everything is visible. Save carries per-civ
   `exploredTiles`; a "view as civ X" toggle + darkened unexplored tiles is
   pure board-model work.
7. Per-tile UV rotation (6 variants) to further break large-field tiling.

## Distribution

- **GitHub Pages**: `.github/workflows/pages.yml` deploys `vite build` on push
  to main. Requires repo Settings → Pages → Source = "GitHub Actions" (one-time).
- **Single-file artifact**: embedded build inlines save + ruleset + textures
  (7.4MB, zero network). Entry: `embedded.html` / `src/embedded-main.ts`.

## Git

- Commit messages: short imperative summary.
- Don't commit `node_modules/`, `dist/`, `dist-embedded/`.
- `public/saves/*.unciv` are real archived games — treat as fixtures, don't
  regenerate or "clean" them.
