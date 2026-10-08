"""Convert a Roboflow COCO Segmentation export into 3-class label masks for our tiles.

  python training/coco_to_masks.py --coco path/to/roboflow_export --preview

- Reads every */_annotations.coco.json under --coco (train/valid/test splits are merged;
  train.py makes its own split).
- Maps each exported image back to the original tile (Roboflow renames "x.png" to
  "x_png.rf.<hash>.jpg") and rescales polygons if Roboflow resized the image.
- Paints roof polygons (class 1) first, then obstructions (class 2) on top.
- Images without annotations become all-background masks (useful negatives).
- Writes training/labels/<tile>.png (uint8, values 0/1/2); --preview writes colour overlays.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
RF_NAME = re.compile(r"^(?P<stem>.+)_(?P<ext>png|jpg|jpeg)\.rf\.[0-9a-f]+\.\w+$", re.I)
COLOURS = {1: (34, 197, 94), 2: (239, 68, 68)}


def class_for(name: str) -> int | None:
    n = name.lower()
    if "obstruct" in n:
        return 2
    if "roof" in n:
        return 1
    return None  # Roboflow's dataset-level supercategory, or anything unexpected


def original_tile(file_name: str, tiles: Path) -> Path | None:
    name = Path(file_name).name
    m = RF_NAME.match(name)
    candidates = [f"{m['stem']}.png"] if m else []
    candidates.append(name)
    for c in candidates:
        if (tiles / c).exists():
            return tiles / c
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--coco", required=True, help="unzipped Roboflow COCO export folder")
    p.add_argument("--tiles", default=str(ROOT / "tiles"))
    p.add_argument("--out", default=str(ROOT / "labels"))
    p.add_argument("--preview", action="store_true", help="also write colour overlays to <out>_preview/")
    a = p.parse_args()

    tiles, out = Path(a.tiles), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    prev = out.parent / (out.name + "_preview")
    if a.preview:
        prev.mkdir(exist_ok=True)

    seen: dict[str, str] = {}
    stats = Counter()
    pixel_counts = np.zeros(3, np.int64)
    jsons = sorted(Path(a.coco).rglob("_annotations.coco.json"))
    if not jsons:
        raise SystemExit(f"No _annotations.coco.json under {a.coco}. Export as 'COCO Segmentation' and unzip.")

    for jp in jsons:
        coco = json.loads(jp.read_text(encoding="utf-8"))
        cats = {c["id"]: class_for(c["name"]) for c in coco["categories"]}
        unknown = [c["name"] for c in coco["categories"] if cats[c["id"]] is None and c.get("supercategory") != "none"]
        if unknown:
            print(f"note: ignoring categories {unknown} in {jp.parent.name}")
        anns_by_img: dict[int, list] = {}
        for ann in coco["annotations"]:
            anns_by_img.setdefault(ann["image_id"], []).append(ann)

        for img in coco["images"]:
            tile = original_tile(img["file_name"], tiles)
            if tile is None:
                print(f"skip: no original tile for {img['file_name']}")
                stats["unmatched"] += 1
                continue
            if tile.name in seen:
                raise SystemExit(
                    f"{tile.name} appears twice ({seen[tile.name]} and {jp.parent.name}/{img['file_name']}). "
                    "Export a dataset version WITHOUT augmentations."
                )
            seen[tile.name] = f"{jp.parent.name}/{img['file_name']}"

            with Image.open(tile) as t:
                tw, th = t.size
            sx, sy = tw / img["width"], th / img["height"]
            mask = Image.new("L", (tw, th), 0)
            draw = ImageDraw.Draw(mask)
            anns = anns_by_img.get(img["id"], [])
            for cls in (1, 2):  # roof first, obstructions painted over it
                for ann in anns:
                    if cats.get(ann["category_id"]) != cls:
                        continue
                    seg = ann.get("segmentation")
                    if not isinstance(seg, list) or not seg:
                        stats["no_polygon"] += 1
                        continue
                    for poly in seg:
                        pts = [(poly[i] * sx, poly[i + 1] * sy) for i in range(0, len(poly) - 1, 2)]
                        if len(pts) >= 3:
                            draw.polygon(pts, fill=cls)
                            stats[f"polygons_class{cls}"] += 1
            arr = np.asarray(mask)
            pixel_counts += np.bincount(arr.ravel(), minlength=3)[:3]
            stats["empty" if not anns else "labelled"] += 1
            mask.save(out / tile.name)

            if a.preview:
                rgb = np.asarray(Image.open(tile).convert("RGB")).copy()
                for c, col in COLOURS.items():
                    sel = arr == c
                    rgb[sel] = (0.55 * rgb[sel] + 0.45 * np.array(col)).astype(np.uint8)
                Image.fromarray(rgb).save(prev / tile.name)

    total = pixel_counts.sum() or 1
    print(f"tiles written: {stats['labelled'] + stats['empty']} "
          f"({stats['labelled']} labelled, {stats['empty']} background-only) -> {out}")
    print(f"polygons: roof {stats['polygons_class1']}, obstruction {stats['polygons_class2']}")
    print("pixel share: " + ", ".join(f"{n} {c / total:.1%}" for n, c in zip(("background", "roof", "obstruction"), pixel_counts)))
    if stats["unmatched"] or stats["no_polygon"]:
        print(f"WARNING: {stats['unmatched']} images unmatched, {stats['no_polygon']} annotations without polygons "
              "(bounding boxes are ignored; use polygon / Smart Polygon tools)")


if __name__ == "__main__":
    main()
