#!/usr/bin/env python3
"""Convert Rajul's Artful Terrain Textures (Civ5 pseudo-DLC) into the
renderer's asset slots. Requires Pillow (DXT5 DDS decode).

    python3 cli/convert-artful.py /path/to/"Artful Textures"

Regional variants exist (Europe/Asia/America/Africa); Europe is the default
look. Slots not covered by the pack (forest, jungle, hill, ice, atoll,
fallout, water) stay procedural — run `bun run cli/generate-textures.ts`
afterwards to fill those in (it never overwrites existing files).
"""

import os
import sys

from PIL import Image

SIZE = 512  # plenty at map zoom; keeps the repo light

# asset-map slot -> path inside the pack's Terrain/ directory
MAPPING = {
    "grassland": "Grassland/Europe/euro_grassland_d.dds",
    "plains": "Plain/Europe/euro_plain_d.dds",
    "desert": "Desert/Europe/euro_desert_d.dds",
    "tundra": "Tundra/Europe/euro_tundra_d.dds",
    "snow": "Snow/generic_snow_d.dds",
    "mountain": "Mountain/Europe/euro_mountain_base_d.dds",
    "marsh": "Marsh/Europe/marsh_d.dds",
    "flood-plains": "FloodPlains/floodplains_d.dds",
    "oasis": "Oasis/oasis_diff.dds",
}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    pack_root = os.path.join(sys.argv[1], "Terrain")
    out_dir = os.path.join(os.path.dirname(__file__), "../public/textures/artful")
    os.makedirs(out_dir, exist_ok=True)
    for slot, rel in MAPPING.items():
        src = os.path.join(pack_root, rel)
        im = Image.open(src).convert("RGBA")
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
        dst = os.path.join(out_dir, f"{slot}.png")
        im.save(dst)
        print(f"{slot:14s} <- {rel}")


if __name__ == "__main__":
    main()
