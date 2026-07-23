#!/usr/bin/env python3
"""Extract Firaxis Civ5 terrain assets for the local renderer.

Writes PNGs (+ forests.xml) to public/textures/civ5/ (gitignored — do not commit).

    python3 cli/extract-civ5-assets.py
    python3 cli/extract-civ5-assets.py "/path/to/Civilization V.app/Contents"
"""

from __future__ import annotations

import re
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
DOCS = Path(__file__).resolve().parent.parent / "docs"

# Digimaps / feature sheets from TerrainTextures.fpk
WANT_TERRAIN_TEX = {
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
    "forest_overlay_europe.dds",
    "jungle_overlay_europe.dds",
    "forest_tile1.dds",
    "forest_tile2.dds",
    "forest_tile3.dds",
    "forest_tile4.dds",
}

# Piece heightmaps: (folder under terrain/pieces, Europe filename, out stem)
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


def parse_fpk(data: bytes, *, require_dds: bool = False) -> list[tuple[str, int, int]]:
    """Parse a Civ5 FPK table of contents.

    After each name the TOC has a short variable padding, then
    ``(size:u32, offset:u32)``. We scan a small window for a pair whose
    payload is in-range (and optionally starts with ``DDS ``).
    """
    if len(data) < 16 or data[4:8] != b"FPK_":
        raise ValueError("not a Civ5 FPK")
    data_off = struct.unpack_from("<I", data, 8)[0]
    off = 14
    entries: list[tuple[str, int, int]] = []
    # Walk TOC; data_off is a hint, but some packs need a wider scan
    toc_limit = min(len(data), max(data_off + 50_000, 4096))
    while off + 12 < toc_limit:
        name_len = struct.unpack_from("<I", data, off)[0]
        if name_len == 0 or name_len > 260:
            break
        raw = data[off + 4 : off + 4 + name_len]
        if len(raw) < name_len or not all(32 <= b < 127 for b in raw):
            break
        name = raw.decode("ascii", errors="replace")
        p = off + 4 + name_len
        matched = False
        for skip in range(0, 16):
            if p + 4 + skip + 8 > len(data):
                break
            size, offset = struct.unpack_from("<II", data, p + 4 + skip)
            if not (4 <= size <= 80_000_000 and 0 <= offset < len(data)):
                continue
            if offset + min(4, size) > len(data):
                continue
            if require_dds and data[offset : offset + 4] != b"DDS ":
                continue
            if not require_dds and offset < 8:
                continue
            # payload should generally live at/after data section
            if offset < data_off and data_off < len(data) // 2:
                # still accept if magic looks right
                magic = data[offset : offset + 4]
                if magic not in (b"DDS ", b"<?xm", b"\xef\xbb\xbf<", b")\xdel"):
                    # GR2 often starts with binary; allow if size fits snugly
                    if offset + size > len(data) + 1024:
                        continue
            end = min(len(data), offset + size)
            if end - offset < 4:
                continue
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
        n = len(payload) // 8
        w = int(n**0.5)
        n = w * w
    vals = [payload[i * 8] for i in range(n)]
    im = Image.new("L", (w, w))
    im.putdata(vals)
    im.save(out_png)
    print(f"  H {out_png.name}: {min(vals)}–{max(vals)}")


def write_dds_or_blob(name: str, blob: bytes, out_dir: Path) -> None:
    """Write raw blob; if DDS, also convert to PNG."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name
    path.write_bytes(blob)
    if name.lower().endswith(".dds") and blob[:4] == b"DDS ":
        try:
            im = Image.open(path).convert("RGBA")
            png = out_dir / name.replace(".dds", ".png").replace(".DDS", ".png")
            im.save(png)
            print(f"  {png.name} {im.size}")
        except Exception as e:
            print(f"  {name} raw only ({e})")
    elif name.lower().endswith(".xml"):
        # also mirror recipe docs
        print(f"  xml {name} ({len(blob)} bytes)")
    else:
        print(f"  blob {name} ({len(blob)} bytes)")


def extract_named_from_fpk(fpk_path: Path, want: set[str] | None = None, want_re: str | None = None) -> int:
    """Extract matching entries from an FPK. Returns count written."""
    if not fpk_path.exists():
        print(f"  missing {fpk_path}")
        return 0
    data = fpk_path.read_bytes()
    try:
        # Texture packs prefer DDS magic (tight); model/data packs accept any
        require_dds = "texture" in fpk_path.name.lower() or fpk_path.name.lower().endswith(
            "textures.fpk"
        )
        entries = parse_fpk(data, require_dds=require_dds)
        if len(entries) < 3 and require_dds:
            # retry without magic if TOC is odd
            entries = parse_fpk(data, require_dds=False)
    except ValueError as e:
        print(f"  {fpk_path.name}: {e}")
        return 0
    by_name = {n: (s, o) for n, s, o in entries}
    # also index by basename
    by_base = {Path(n).name.lower(): (n, s, o) for n, s, o in entries}
    written = 0
    names = list(want) if want else []
    if want_re:
        rx = re.compile(want_re, re.I)
        names.extend(n for n, _, _ in entries if rx.search(n))
    seen: set[str] = set()
    for key in names:
        k = key.lower()
        if k in seen:
            continue
        if key in by_name:
            size, offset = by_name[key]
            name = key
        elif k in by_base:
            name, size, offset = by_base[k]
        elif Path(key).name.lower() in by_base:
            name, size, offset = by_base[Path(key).name.lower()]
        else:
            if want and key in want:
                print(f"  missing {key}")
            continue
        seen.add(k)
        end = min(len(data), offset + size)
        blob = data[offset:end]
        # clamp insane sizes (bad TOC parse)
        if len(blob) < 4:
            continue
        if size > len(data) and b"<?xml" in blob[:200]:
            # xml often stored with wrong size — find end by next null or reasonable bound
            z = blob.find(b"\x00")
            if 20 < z < 200_000:
                blob = blob[:z]
        out_name = Path(name).name
        write_dds_or_blob(out_name, blob, OUT)
        if out_name.lower() == "forests.xml":
            # keep a checked-in recipe copy for the renderer docs
            DOCS.mkdir(parents=True, exist_ok=True)
            (DOCS / "civ5-forests.xml").write_bytes(blob)
            print(f"  docs/civ5-forests.xml")
        written += 1
    print(f"  {fpk_path.name}: {len(entries)} TOC entries, wrote {written}")
    return written


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_STEAM
    if not root.exists():
        sys.exit(f"Civ5 not found at {root}")

    OUT.mkdir(parents=True, exist_ok=True)

    # 1) Terrain digimaps + forest atlases / tiles / overlays
    terrain_fpk = root / "Assets/Resource/DX9/TerrainTextures.fpk"
    print("TerrainTextures.fpk")
    extract_named_from_fpk(terrain_fpk, want=WANT_TERRAIN_TEX)

    # 2) forests.xml recipe from TerrainModels.fpk
    # TOC for this pack is sparse/odd; pull forests.xml by content scan.
    print("TerrainModels.fpk (forests.xml)")
    tm = root / "Assets/Resource/Common/TerrainModels.fpk"
    if tm.exists():
        blob = tm.read_bytes()
        m = re.search(
            rb"<\?xml[^>]+\?>\s*<!--[\s\S]{0,2000}?random_trees_per_tile[\s\S]{0,800}?<Forest\b[^/]*/>",
            blob,
        )
        if m:
            xml = m.group()
            (OUT / "forests.xml").write_bytes(xml)
            DOCS.mkdir(parents=True, exist_ok=True)
            (DOCS / "civ5-forests.xml").write_bytes(xml)
            print(f"  forests.xml ({len(xml)} bytes) → textures/civ5 + docs/")
        else:
            # try TOC path as fallback
            n = extract_named_from_fpk(tm, want={"forests.xml"}, want_re=r"forests\.xml")
            if n == 0:
                print("  forests.xml not found")
    else:
        print(f"  missing {tm}")

    # 3) Piece heightmaps
    pieces = root / "Assets/Assets/terrain/pieces"
    print("piece heightmaps")
    for folder, filename, stem in PIECE_HEIGHTS:
        src = pieces / folder / "Europe" / filename
        if not src.exists():
            src = pieces / folder / filename
        if not src.exists():
            print(f"  missing piece {folder}/{filename}")
            continue
        decode_piece_height_r8(src, OUT / f"{stem}.png")

    print(f"done → {OUT}")


if __name__ == "__main__":
    main()
