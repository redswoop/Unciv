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

# Piece heightmaps: (folder under terrain/pieces, Europe filename, out stem).
# Only single-hex 128x128 pieces: "…01"/"…_1_2" are one hex; "…_2_x"/"…_3_x"
# are 512x512 multi-hex cluster pieces our per-tile kit can't place.
PIECE_HEIGHTS = [
    ("Grass", "Grass 01_H.dds", "grass_flat_h"),
    ("Grass Hill", "Grass_Hill_01_H.dds", "grass_hill_01_h"),
    ("Grass Hill", "Grass_Hill_02_H.dds", "grass_hill_02_h"),
    ("Plains", "Plains 01_H.dds", "plains_flat_h"),
    ("Plains Hill", "Plains Hill 01_H.dds", "plains_hill_01_h"),
    ("Plains Hill", "Plains_Hill_02_H.dds", "plains_hill_02_h"),
    ("Desert", "Desert 01_H.dds", "desert_flat_h"),
    ("Desert Hill", "Desert Hill 01_H.dds", "desert_hill_01_h"),
    ("Desert Hill", "Euro_Desert_Hill_1_2_H.dds", "desert_hill_12_h"),
    ("Mountain", "Euro_Moun_1_1_H.dds", "mountain_11_h"),
    ("Mountain", "Euro_Moun_1_2_H.dds", "mountain_12_h"),
    ("Tundra", "Euro_Tundra 01_H.dds", "tundra_flat_h"),
    ("Tundra Hill", "Euro_Tundra Hill 01_H.dds", "tundra_hill_01_h"),
    ("Tundra Hill", "Euro_Tundra_Hill_1_2_H.dds", "tundra_hill_12_h"),
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
    data = dds_path.read_bytes()
    h, w = struct.unpack_from("<II", data, 12)
    if (w, h) != (128, 128):
        # multi-hex cluster piece (512x512 2_x/3_x) — decoding it as a single
        # tile yields a constant "flat" image, so refuse instead
        print(f"  skip {dds_path.name}: {w}x{h} is not a single-hex piece")
        return
    payload = data[128:]
    n = w * h
    if len(payload) < n * 8:
        raise ValueError(f"{dds_path.name}: payload too small for {w}x{h} R8x8")
    vals = [payload[i * 8] for i in range(n)]
    im = Image.new("L", (w, h))
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


def parse_fpk_exact(data: bytes) -> list[tuple[str, int, int]]:
    """Exact FPK v6 TOC walk (reverse-engineered from hex dumps):

    header: u32 version, "FPK_", u32 data_start, u16 zero, then per entry:
      u32 name_len, name[name_len], u32 pad_n, pad[pad_n], u32 unk,
      u32 size, u32 offset

    Unlike parse_fpk's heuristic scan this never mis-aligns, so it works on
    packs whose first entry has non-zero pad (StrategicViewTextures etc.).
    """
    if len(data) < 16 or data[4:8] != b"FPK_":
        raise ValueError("not a Civ5 FPK")
    off = 14
    entries: list[tuple[str, int, int]] = []
    n = len(data)
    while off + 4 <= n:
        (name_len,) = struct.unpack_from("<I", data, off)
        if name_len == 0 or name_len > 300 or off + 4 + name_len > n:
            break
        name = data[off + 4 : off + 4 + name_len].decode("ascii", errors="replace")
        p = off + 4 + name_len
        if p + 4 > n:
            break
        (pad_n,) = struct.unpack_from("<I", data, p)
        if pad_n > 64:
            break
        p += 4 + pad_n
        if p + 12 > n:
            break
        _unk, size, offset = struct.unpack_from("<III", data, p)
        entries.append((name, size, offset))
        off = p + 12
    return entries


# Strategic-view art (256x256 DXT sprites drawn flat on tiles — our on-map
# resource/improvement/wonder art) + city sprites. Names are the Firaxis
# originals; the renderer maps Unciv ids onto them in asset-map.json.
SV_BASE = {
    # resources
    "sv_aluminum.dds", "sv_banana.dds", "sv_coal.dds", "sv_cotton.dds",
    "sv_cow.dds", "sv_deer.dds", "sv_dye.dds", "sv_fish.dds", "sv_fur.dds",
    "sv_gems.dds", "sv_gold.dds", "sv_horse.dds", "sv_incense.dds",
    "sv_iron.dds", "sv_ivory.dds", "sv_marble.dds", "sv_oil.dds",
    "sv_pearl.dds", "sv_sheep.dds", "sv_silk.dds", "sv_silver.dds",
    "sv_spices.dds", "sv_sugar.dds", "sv_uranium.dds", "sv_whale.dds",
    "sv_wheat.dds", "sv_wine.dds",
    # improvements
    "sv_farm.dds", "sv_mine.dds", "sv_pasture.dds", "sv_plantation.dds",
    "sv_quarry.dds", "sv_tradingpost.dds", "sv_lumbermill.dds", "sv_fort.dds",
    "sv_oilwell.dds", "sv_offshoreplatform.dds", "sv_fishingboats.dds",
    "sv_customhouse.dds", "sv_academy.dds", "sv_citadel.dds",
    "sv_manufactory.dds", "sv_camp.dds", "sv_ancientruins.dds",
    "sv_barbariancamp.dds", "sv_cityruins.dds", "sv_landmark.dds",
    # natural wonders
    "sv_fuji.dds", "sv_geyser.dds", "sv_gibraltar.dds", "sv_krakatoa.dds",
    "sv_mesa.dds", "sv_crater.dds", "sv_coralreef.dds", "sv_naturalwonders.dds",
    # city sprites (size variants)
    "sv_ancient_africa_small_city.dds", "sv_ancient_africa_medium_city.dds",
    "sv_ancient_africa_large_city.dds",
}

SV_EXP1 = {
    # G&K resources
    "sv_citrus.dds", "sv_copper.dds", "sv_crabs.dds", "sv_salt.dds",
    "sv_truffles.dds",
    # G&K improvements + natural wonders
    "sv_holy_site.dds", "sv_polder.dds",
    "sv_mount_kailash.dds", "sv_mount_sinai.dds", "sv_sri_pada.dds",
    "sv_uluru.dds",
}


# Ground decals: crop fields, river banks, road strips, improvement pads.
# These drape on terrain in the real game — our renderer does the same.
DECALS_DECALPACK = {
    "crops_europe_01_d.dds", "crops_europe_02_d.dds", "crops_europe_03_d.dds",
    "crops_europe_04_d.dds", "crops_europe_05_d.dds", "crops_europe_06_d.dds",
    "crops_europe_07_d.dds", "crops_europe_08_d.dds",
    "wheat_farm_d.dds",
    "riverbank_d.dds", "riverbank_d_endcap1.dds", "riverbank_d_endcap2.dds",
    "roadsandrails_d.dds", "roads_rails.dds",
    "floodplains_d.dds",
    "tree_shadow_2.dds",
}

DECALS_IMPROVEMENTS = {
    "ancient_farm_decal_d.dds", "modern_farm_decal_diff.dds",
    "fort_mid_decal_d.dds", "lumbermill_mid_decal_d.dds",
    "med_trading_post_decal_diff.dds", "mod_trading_post_decal_d.dds",
    "anc_academy_decal_d.dds", "ind_academy_decal_d.dds",
    "citadel_decal_anc_d.dds", "anc_customs_house_decal_d.dds",
    "med_manufactory_decal_d.dds", "ind_manufactory_decal_diff.dds",
    "landmark_decal_euro_d.dds", "oil_rig_decal_d.dds",
}


def synthesize_stone_bubble() -> None:
    """Civ5 shipped no strategic-view icon for Stone (it predates SV art).

    Synthesize one in the same visual language: reuse the dark glass disc from
    sv_iron (its ring/gloss), paint boulders over the anvil. Saved next to the
    extracted originals so the renderer treats it identically.
    """
    from PIL import ImageDraw, ImageFilter

    base_path = OUT / "sv" / "sv_iron.png"
    if not base_path.exists():
        print("  sv_iron.png missing — run sv extraction first")
        return
    im = Image.open(base_path).convert("RGBA")
    w, h = im.size
    cx, cy = w // 2, h // 2
    # cover the anvil with the disc's own dark navy (sampled from an empty ring
    # area), feathered so the gloss survives
    patch = Image.new("RGBA", im.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(patch)
    fill = im.getpixel((cx, int(h * 0.78)))[:3]
    pd.ellipse([cx - 62, cy - 58, cx + 62, cy + 66], fill=(*fill, 255))
    patch = patch.filter(ImageFilter.GaussianBlur(6))
    im.alpha_composite(patch)
    d = ImageDraw.Draw(im)

    def boulder(bx, by, r, tone):
        outline = tuple(max(0, c - 60) for c in tone[:3]) + (255,)
        d.ellipse(
            [bx - r, by - int(r * 0.82), bx + r, by + int(r * 0.82)],
            fill=tone,
            outline=outline,
            width=4,
        )
        # top-light
        d.ellipse(
            [bx - int(r * 0.55), by - int(r * 0.62), bx + int(r * 0.3), by - int(r * 0.08)],
            fill=tuple(min(255, c + 42) for c in tone[:3]) + (255,),
        )

    boulder(cx - 34, cy + 26, 30, (122, 120, 114, 255))
    boulder(cx + 34, cy + 30, 27, (104, 102, 96, 255))
    boulder(cx, cy - 14, 38, (150, 148, 140, 255))
    im.save(OUT / "sv" / "sv_stone.png")
    print("  synthesized sv_stone.png")


def extract_decals(root: Path) -> None:
    """Extract ground decals into public/textures/civ5/decal/."""
    out = OUT / "decal"
    packs = [
        (root / "Assets/Resource/DX9/DecalTextures.fpk", DECALS_DECALPACK),
        (root / "Assets/Resource/DX9/ImprovementTextures.fpk", DECALS_IMPROVEMENTS),
    ]
    for fpk_path, want in packs:
        print(fpk_path.name + " (decals)")
        if not fpk_path.exists():
            print(f"  missing {fpk_path}")
            continue
        data = fpk_path.read_bytes()
        entries = {n.lower(): (s, o) for n, s, o in parse_fpk_exact(data)}
        wrote = 0
        for name in sorted(want):
            hit = entries.get(name)
            if not hit:
                print(f"  missing {name}")
                continue
            size, offset = hit
            write_dds_or_blob(name, data[offset : offset + size], out)
            wrote += 1
        print(f"  wrote {wrote}/{len(want)}")


def extract_sv_art(root: Path) -> None:
    """Extract strategic-view sprites into public/textures/civ5/sv/."""
    out = OUT / "sv"
    packs = [
        (root / "Assets/Resource/DX9/StrategicViewTextures.fpk", SV_BASE),
        (root / "Assets/Resource/DX9/Expansion1UITextures.fpk", SV_EXP1),
    ]
    for fpk_path, want in packs:
        print(fpk_path.name + " (sv art)")
        if not fpk_path.exists():
            print(f"  missing {fpk_path}")
            continue
        data = fpk_path.read_bytes()
        entries = {n.lower(): (s, o) for n, s, o in parse_fpk_exact(data)}
        wrote = 0
        for name in sorted(want):
            hit = entries.get(name)
            if not hit:
                print(f"  missing {name}")
                continue
            size, offset = hit
            write_dds_or_blob(name, data[offset : offset + size], out)
            wrote += 1
        print(f"  wrote {wrote}/{len(want)}")


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

    # 4) Strategic-view sprites (resources / improvements / wonders / cities)
    extract_sv_art(root)

    # 5) Ground decals (crop fields, riverbanks, roads, improvement pads)
    extract_decals(root)

    # 6) Synthesized bubbles for resources Civ5 shipped no SV art for
    synthesize_stone_bubble()

    print(f"done → {OUT}")


if __name__ == "__main__":
    main()
