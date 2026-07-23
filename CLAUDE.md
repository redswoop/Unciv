# Civ5-Look Renderer (Unciv save viewer)

Web renderer that loads **real Unciv save files** and draws them as a pannable,
tiltable, Civ5-style 3D map in three.js. No Unciv engine changes ever — we
consume its save output. The POC is done; current work is visual quality.

**Read first:** `README.md` (what proved out, screenshots), `docs/SAVE_FORMAT.md`
(save wire format, JSON dialects, minimum GameInfo subset, save provenance).

## Commands

```bash
bun install
bun run dev          # vite dev server at http://127.0.0.1:5199 (loads bundled real save)
bun test             # all tests — most assert against the REAL bundled save
bun run summary      # parse the bundled save, print text summary
bunx tsc --noEmit    # typecheck (strict)
bunx vite build      # normal build -> dist/ (used by Pages workflow)
bunx vite build --config vite.embedded.config.ts   # single-file build -> dist-embedded/embedded.html
bun run e2e/screenshot.ts "http://127.0.0.1:5199/?x=-4.5&y=12&dist=16&tilt=0.9" /tmp/shot.png
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
- **Tests against the real save.** New model/render logic gets a test that runs
  the actual turn-518 save through it (see `board-model.test.ts` patterns:
  welded corners, no shearing, edge lengths).
- Old saves use libGDX *minimal* JSON (unquoted keys AND values) and omit
  default-valued fields (`position:{}` = origin, no `turns` = 0). Ruleset JSONs
  have `//` comments + trailing commas. `parseGdxJson` handles all of it.
- TypeScript strict; no default exports; bun for everything.

## Visual quality backlog (the "looks kind of awful" list)

Camera FOV 16°, tilt 0.9. Full map uses **Firaxis digimaps + piece heightmaps**
when `public/textures/civ5/` exists (`python3 cli/extract-civ5-assets.py` from
local Steam Civ5); otherwise Artful fallback. Kit: `src/render/civ5-tiles.ts`.
Chunk/hero demos: `/chunk.html`, `/hero.html`. Remaining gaps:

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
5. **Water is flat opaque.** Cheap wins: animated normal-ish shimmer shader,
   coast-to-ocean gradient using the Artful depth LUT (already sampled in
   `cli/generate-textures.ts`), subtle foam ring on coastlines.
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
