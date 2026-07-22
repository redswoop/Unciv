# Unciv Save Format — as reverse-engineered from source + real saves

## Where Unciv writes saves

- Desktop: `~/.local/share/Unciv/SaveFiles/` (Linux), `%APPDATA%/Unciv/SaveFiles/` (Windows) — plus `MultiplayerGames/` for multiplayer downloads. Android: `/sdcard/Android/data/com.unciv.app/files/SaveFiles`.
- Autosaves are named `Autosave-*`; every multiplayer turn uploads the full serialized game.

## Wire format

From `core/src/com/unciv/logic/files/UncivFiles.kt` (`gameInfoFromString`) and
`core/src/com/unciv/ui/screens/savescreens/Gzip.kt`:

```
save = base64( gzip( json ) )   // when zipped (multiplayer always, autosave by setting)
save = json                     // otherwise
```

Loading mirrors Unciv: strip `\r\n`, try base64→gunzip, on failure treat the text
as JSON directly.

## The JSON dialect

libGDX `Json`, **not** strict JSON:

- Current Unciv uses `JsonWriter.OutputType.json` (strict, valid).
- Older saves (e.g. the 2021 community archive this POC uses) are
  `OutputType.minimal`: unquoted names **and** values —
  `{civName:Barbarians,gold:-1427}`. Unquoted tokens never contain
  `{}[],:"` or newlines; anything number/boolean/null-shaped is typed,
  the rest are strings (`Leaning Tower of Pisa`, `4.2.13`).
- libGDX omits fields equal to the prototype default: `turns:0` is absent,
  `position:{}` means `(0,0)`, `position:{y:-1}` means `(0,-1)`.
- Ruleset JSONs (hand-written) add `//` and `/* */` comments, tabs, and
  trailing commas.

`src/save/gdx-json.ts` parses all three dialects.

## Minimum GameInfo subset for a static frame

Verified against real saves (field order follows Kotlin declaration order):

| Path | Used for |
|---|---|
| `tileMap.mapParameters.mapSize{radius,width,height}`, `.shape`, `.worldWrap` | layout bounds |
| `tileMap.tileList[].position{x,y}` | hex coords (Unciv scheme, see hex-math.ts) |
| `.baseTerrain` | base texture |
| `.terrainFeatures[]` (new) / `.terrainFeature` (old) | overlays: Hill, Forest, Jungle, Marsh, Oasis, Ice, Atoll, Fallout, Flood plains |
| `.naturalWonder`, `.resource`, `.improvement`, `.roadStatus` | overlays |
| `.hasBottomRightRiver/.hasBottomRiver/.hasBottomLeftRiver` | river edges (each tile owns its three bottom edges) |
| `.militaryUnit/.civilianUnit{owner,name}`, `.airUnits[]` | unit billboards; `owner` is the civ *name* in old saves, may be `civID` in new |
| `civilizations[].civName`, `.civID`, `.playerType`, `.cities[]` | owners |
| `cities[].location{x,y}`, `.name`, `.tiles[{x,y}]` | city billboards + **territory borders** (a tile is owned iff in some city's `tiles`) |
| `gameParameters.baseRuleset` (absent in old saves → Vanilla) | ruleset choice |
| `turns` | HUD |

Civ colors are NOT in the save — they come from the ruleset's `Nations.json`
(`outerColor`/`innerColor` RGB arrays), resolved by nation name = `civName`.

## Provenance of the bundled saves

`saves/*.unciv` are real archived multiplayer games from
[xlenstra/unciv-save-archive](https://github.com/xlenstra/unciv-save-archive)
(the maintainer's periodic dump of Unciv's shared multiplayer Dropbox).

- `turn518-14civs.unciv` — turn 518, Perlin radius-57 map, 9919 tiles
  (= exactly `getNumberOfTilesInHexagon(57)`), 14 major civs + 28 city-states,
  27 cities, 7 natural wonders, fallout scars. Vanilla-era ruleset.
- `turn206-huge.unciv` — turn 206, rectangular Huge (87×57) map; second
  shape for regression coverage.
