"""Cut labelling tiles from OpenAerialMap Cloud-Optimized GeoTIFFs at one fixed ground resolution.

Reads only the needed byte ranges over HTTP (no full download). Every tile is logged in
manifest.csv with its source, provider and licence so CREDITS.md stays accurate.

  python training/make_tiles.py --preview              # one small overview PNG per source
  python training/make_tiles.py --only vjwd_a --max-tiles 40
"""

from __future__ import annotations

import argparse
import csv
import math
import os
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")


def ground_gsd_m(src) -> tuple[float, float, float]:
    """True ground metres per pixel, plus centre lon/lat. Handles geographic CRS and Web Mercator."""
    cx = (src.bounds.left + src.bounds.right) / 2
    cy = (src.bounds.bottom + src.bounds.top) / 2
    (lon,), (lat,) = warp_transform(src.crs, "EPSG:4326", [cx], [cy])
    res = abs(src.transform.a)
    if src.crs.is_geographic:
        gsd = res * 111_320 * math.cos(math.radians(lat))
    elif src.crs.to_epsg() == 3857:
        gsd = res * math.cos(math.radians(lat))  # Mercator metres are stretched by 1/cos(lat)
    else:
        gsd = res  # assume projected metres (e.g. UTM)
    return gsd, lon, lat


def read_rgb(src, window: Window, out_size: tuple[int, int]) -> tuple[np.ndarray, float]:
    """Read RGB resampled to out_size (uses COG overviews). Returns image and valid-pixel fraction."""
    # Not boundless: boundless reads bypass COG overviews and pull full-resolution data.
    bands = [1, 2, 3, 4] if src.count >= 4 else [1, 2, 3]
    data = src.read(
        indexes=bands,
        window=window,
        out_shape=(len(bands), out_size[1], out_size[0]),
        resampling=Resampling.average,
    )
    rgb = np.moveaxis(data[:3], 0, -1)
    if data.shape[0] == 4:
        valid = data[3] > 0
    else:  # nodata colour varies by source (black, light grey), so use GDAL's dataset mask
        valid = src.dataset_mask(window=window, out_shape=(out_size[1], out_size[0])) > 0
    return rgb.astype(np.uint8), float(valid.mean())


def preview(row: dict, out_dir: Path, max_side: int = 1200) -> None:
    with rasterio.open("/vsicurl/" + row["url"]) as src:
        gsd, lon, lat = ground_gsd_m(src)
        k = max(src.width, src.height) / max_side
        size = (max(1, int(src.width / k)), max(1, int(src.height / k)))
        rgb, _ = read_rgb(src, Window(0, 0, src.width, src.height), size)
    path = out_dir / f"preview_{row['name']}.jpg"
    Image.fromarray(rgb).save(path, quality=85)
    w_m, h_m = src.width * gsd, src.height * gsd
    print(f"{row['name']}: gsd={gsd:.3f} m/px  extent={w_m:.0f}x{h_m:.0f} m  centre={lat:.5f},{lon:.5f} -> {path}")


def make_tiles(row: dict, out_dir: Path, target_gsd: float, tile: int, max_tiles: int, min_valid: float, writer) -> int:
    with rasterio.open("/vsicurl/" + row["url"]) as src:
        gsd, _, _ = ground_gsd_m(src)
        step = tile * target_gsd / gsd  # source pixels per tile side
        nx, ny = int(src.width // step), int(src.height // step)
        # Spread picks over the whole mosaic instead of taking the first row.
        cells = [(i, j) for j in range(ny) for i in range(nx)]
        stride = max(1, len(cells) // max(1, max_tiles * 2))
        n = 0
        for i, j in cells[::stride]:
            if n >= max_tiles:
                break
            win = Window(i * step, j * step, step, step)
            rgb, valid = read_rgb(src, win, (tile, tile))
            if valid < min_valid:
                continue
            x0, y0 = src.xy(j * step + step / 2, i * step + step / 2)
            (lon,), (lat,) = warp_transform(src.crs, "EPSG:4326", [x0], [y0])
            name = f"{row['name']}_{i:03d}_{j:03d}.png"
            Image.fromarray(rgb).save(out_dir / name)
            writer.writerow([name, row["title"], row["provider"], row["license"], row["url"],
                             target_gsd, f"{lat:.6f}", f"{lon:.6f}"])
            n += 1
            print(f"  {name} valid={valid:.2f}")
    return n


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--sources", default=str(ROOT / "sources.csv"))
    p.add_argument("--out", default=str(ROOT / "tiles"))
    p.add_argument("--only", nargs="*", help="source names to process")
    p.add_argument("--preview", action="store_true")
    p.add_argument("--gsd", type=float, default=0.1, help="target metres per pixel")
    p.add_argument("--tile", type=int, default=512)
    p.add_argument("--max-tiles", type=int, default=30, help="per source")
    p.add_argument("--min-valid", type=float, default=0.9)
    a = p.parse_args()

    with open(a.sources, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if not a.only or r["name"] in a.only]

    out = Path(a.out)
    if a.preview:
        out = out.parent / "previews"
        out.mkdir(parents=True, exist_ok=True)
        for r in rows:
            try:
                preview(r, out)
            except Exception as e:  # keep going; one bad source should not stop the rest
                print(f"{r['name']}: FAILED {e}")
        return

    out.mkdir(parents=True, exist_ok=True)
    manifest = out / "manifest.csv"
    new = not manifest.exists()
    with open(manifest, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["tile", "source_title", "provider", "license", "source_url", "gsd_m", "lat", "lon"])
        total = 0
        for r in rows:
            print(f"{r['name']}:")
            total += make_tiles(r, out, a.gsd, a.tile, a.max_tiles, a.min_valid, w)
    print(f"wrote {total} tiles to {out}")


if __name__ == "__main__":
    main()
