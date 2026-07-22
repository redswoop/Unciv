#!/usr/bin/env python3
"""Extract Firaxis Civ5 terrain assets for the local renderer.

Writes PNGs to public/textures/civ5/ (gitignored — do not commit).

    python3 cli/extract-civ5-assets.py
    python3 cli/extract-civ5-assets.py "/path/to/Civilization V.app/Contents"
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image

DEFAULT_STEAM = (
    Path.home()
    / "Library/Application Support/Steam/steamapps/common"
    / "Sid Meier's Civilization V"
    / "Civilization V.app/Contents"
)

OUT = Path(__file__).resolve().parent.parent / "public/textures/civ5"

# Digimaps / feature sheets from TerrainTextures.fpk
WANT_FPK = {
    "euro_grassland_d.dds",
    "euro_grassland_h.dds",
    "euro_plain_d.dds",
    "euro_plain_h.dds",
    "euro_desert_d.dds",
    "euro_desert_h.dds",
    "euro_tundra_d.dds",
    "euro_tundra_hill_d.dds",
    "euro_coast_d.dds",
    "euro_coast_h.dds",
    "euro_shallow_seas_d.dds",
    "euro_mountain_base_d.dds",
    "euro_mountain_base_h.dds",
    "euro_mountain_top_d.dds",
    "euro_mountain_top_h.dds",
    "generic_snow_d.dds",
    "generic_snow_h.dds",
    "marsh_d.dds",
    "marsh_h.dds",
    "worl_ocean_floor_d.dds",
    "waterbumps.dds",
    "waterdepthcolor.dds",
    "forest_europe.dds",
    "jungle_europe.dds",
    "forest_tile1.dds",
    "forest_tile2.dds",
    "forest_tile3.dds",
    "forest_tile4.dds",
}

# Piece heightmaps: (folder under terrain/pieces, Europe filename glob prefix, out stem)
# We pull several variants for variety.
PIECE_HEIGHTS = [
    ("Grass", "Grass 01_H.dds", "grass_flat_h"),
    ("Grass Hill", "Grass_Hill_01_H.dds", "grass_hill_01_h"),
    ("Grass Hill", "Grass_Hill_02_H.dds", "grass_hill_02_h"),
    ("Grass Hill", "Grass_Hill_2_1_H.dds", "grass_hill_21_h"),
    ("Plains", "Plains 01_H.dds", "plains_flat_h"),
    ("Plains Hill", "Plains_Hill_01_H.dds", "plains_hill_01_h"),
    ("Plains Hill", "Plains_Hill_02_H.dds", "plains_hill_02_h"),
    ("Desert", "Desert 01_H.dds", "desert_flat_h"),
    ("Desert Hill", "Desert_Hill_01_H.dds", "desert_hill_01_h"),
    ("Desert Hill", "Desert_Hill_02_H.dds", "desert_hill_02_h"),
    ("Mountain", "Euro_Moun_1_1_H.dds", "mountain_11_h"),
    ("Mountain", "Euro_Moun_1_2_H.dds", "mountain_12_h"),
    ("Mountain", "Euro_Moun_2_1_H.dds", "mountain_21_h"),
    ("Tundra", "Tundra 01_H.dds", "tundra_flat_h"),
    ("Tundra Hill", "Tundra_Hill_01_H.dds", "tundra_hill_01_h"),
]


def parse_fpk(data: bytes) -> list[tuple[str, int, int]]:
    if data[4:8] != b"FPK_":
        raise ValueError("not a Civ5 FPK")
    data_off = struct.unpack_from("<I", data, 8)[0]
    off = 14
    entries: list[tuple[str, int, int]] = []
    while off + 8 < min(data_off + 5000, len(data)):
        name_len = struct.unpack_from("<I", data, off)[0]
        if name_len == 0 or name_len > 200:
            break
        raw = data[off + 4 : off + 4 + name_len]
        if not all(32 <= b < 127 for b in raw):
            break
        name = raw.decode()
        p = off + 4 + name_len
        matched = False
        for skip in range(0, 8):
            size, offset = struct.unpack_from("<II", data, p + 4 + skip)
            if (
                offset + 4 <= len(data)
                and data[offset : offset + 4] == b"DDS "
                and 16 <= size <= 80_000_000
            ):
                entries.append((name, size, offset))
                off = p + 4 + skip + 8
                matched = True
                break
        if not matched:
            break
    return entries


def decode_piece_height_r8(dds_path: Path, out_png: Path) -> None:
    """Piece *_H.dds format 36: each texel is R8 replicated across 8 bytes."""
    payload = dds_path.read_bytes()[128:]
    w = 128
    n = w * w
    if len(payload) < n * 8:
        # some pieces may include mips; still take top level
        n = len(payload) // 8
        w = int(n**0.5)
        n = w * w
    vals = [payload[i * 8] for i in range(n)]
    im = Image.new("L", (w, w))
    im.putdata(vals)
    im.save(out_png)
    print(f"  H {out_png.name}: {min(vals)}–{max(vals)}")


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_STEAM
    if not root.exists():
        sys.exit(f"Civ5 not found at {root}")

    fpk = root / "Assets/Resource/DX9/TerrainTextures.fpk"
    pieces = root / "Assets/Assets/terrain/pieces"
    if not fpk.exists():
        sys.exit(f"missing {fpk}")

    OUT.mkdir(parents=True, exist_ok=True)
    data = fpk.read_bytes()
    by_name = {n: (s, o) for n, s, o in parse_fpk(data)}
    print(f"FPK entries usable: {len(by_name)}")

    for name in sorted(WANT_FPK):
        if name not in by_name:
            print(f"  missing FPK {name}")
            continue
        size, offset = by_name[name]
        blob = data[offset : offset + size]
        dds_path = OUT / name
        dds_path.write_bytes(blob)
        try:
            im = Image.open(dds_path).convert("RGBA")
            png = OUT / name.replace(".dds", ".png")
            im.save(png)
            print(f"  digimap {png.name} {im.size}")
        except Exception as e:
            print(f"  {name} raw only ({e})")

    for folder, filename, stem in PIECE_HEIGHTS:
        src = pieces / folder / "Europe" / filename
        if not src.exists():
            # try without Europe for some pieces
            src = pieces / folder / filename
        if not src.exists():
            print(f"  missing piece {folder}/{filename}")
            continue
        decode_piece_height_r8(src, OUT / f"{stem}.png")

    print(f"done → {OUT}")


if __name__ == "__main__":
    main()
