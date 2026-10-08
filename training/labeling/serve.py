"""Local labelling tool: a Roboflow-free replacement for STEP 1 of the plan.

Draw `roof` and `obstruction` polygons on each tile in the browser, then export a
COCO Segmentation file that training/coco_to_masks.py reads unchanged.

Usage (PowerShell, from the solorscope folder):
    python training/labeling/serve.py                 # open http://127.0.0.1:8765
    python training/labeling/serve.py --export        # write labeling/export/train/_annotations.coco.json
    python training/coco_to_masks.py --coco training/labeling/export

Work is autosaved to labeling/labels.json after every change.
"""
import argparse
import json
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
TILES = ROOT.parent / "tiles"
LABELS = ROOT / "labels.json"
EXPORT = ROOT / "export"
CATEGORIES = [{"id": 1, "name": "roof", "supercategory": "none"},
              {"id": 2, "name": "obstruction", "supercategory": "none"}]


def tile_names():
    return sorted(p.name for p in TILES.glob("*.png"))


def load_labels():
    if LABELS.exists():
        return json.loads(LABELS.read_text(encoding="utf-8"))
    return {}


def save_labels(labels):
    tmp = LABELS.with_suffix(".tmp")
    tmp.write_text(json.dumps(labels, indent=1), encoding="utf-8")
    tmp.replace(LABELS)


def read_tile(name):
    img = cv2.imread(str(TILES / name))
    if img is None:
        raise FileNotFoundError(name)
    return img


def smart_polygon(name, x, y, tol):
    """Flood-fill from (x, y) on a smoothed tile; good for uniform sheet roofs."""
    img = read_tile(name)
    h, w = img.shape[:2]
    smooth = cv2.bilateralFilter(img, 7, 40, 7)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
    cv2.floodFill(smooth, mask, (x, y), 0, (tol,) * 3, (tol,) * 3, flags)
    return outline(mask[1:-1, 1:-1], x, y)


def box_polygon(name, x0, y0, x1, y1):
    """GrabCut inside a dragged box; good for textured concrete roofs."""
    img = read_tile(name)
    h, w = img.shape[:2]
    x0, x1 = sorted((max(0, x0), min(w - 1, x1)))
    y0, y1 = sorted((max(0, y0), min(h - 1, y1)))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return []
    mask = np.zeros((h, w), np.uint8)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(img, mask, (x0, y0, x1 - x0, y1 - y0), bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    region = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    return outline(region, (x0 + x1) // 2, (y0 + y1) // 2)


def outline(region, x, y):
    """Clean a binary region and return the polygon of the blob nearest (x, y)."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    region = cv2.morphologyEx(region, cv2.MORPH_CLOSE, k)
    region = cv2.morphologyEx(region, cv2.MORPH_OPEN, k)
    contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    hit = [c for c in contours if cv2.pointPolygonTest(c, (float(x), float(y)), False) >= 0]
    c = max(hit or contours, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, 1.5, True)
    return c.reshape(-1, 2).astype(float).tolist()


def export(out_dir=EXPORT):
    """Write labelled tiles (status done/null) as a COCO Segmentation split."""
    labels = load_labels()
    images, annotations = [], []
    for name in tile_names():
        entry = labels.get(name)
        if not entry or entry.get("status") not in ("done", "null"):
            continue
        img = cv2.imread(str(TILES / name))
        h, w = img.shape[:2]
        image_id = len(images)
        images.append({"id": image_id, "file_name": name, "width": w, "height": h})
        if entry["status"] == "null":
            continue
        for shape in entry.get("shapes", []):
            pts = np.array(shape["points"], dtype=float)
            if len(pts) < 3:
                continue
            pts[:, 0] = pts[:, 0].clip(0, w)
            pts[:, 1] = pts[:, 1].clip(0, h)
            x0, y0 = pts.min(0)
            x1, y1 = pts.max(0)
            xs, ys = pts[:, 0], pts[:, 1]
            area = 0.5 * abs(np.dot(xs, np.roll(ys, 1)) - np.dot(ys, np.roll(xs, 1)))
            annotations.append({
                "id": len(annotations) + 1,
                "image_id": image_id,
                "category_id": 1 if shape["label"] == "roof" else 2,
                "segmentation": [pts.round(2).flatten().tolist()],
                "bbox": [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)],
                "area": round(float(area), 2),
                "iscrowd": 0,
            })
    split = Path(out_dir) / "train"
    split.mkdir(parents=True, exist_ok=True)
    coco = {"info": {"description": "solarscope-roofs (local labeller)"},
            "categories": CATEGORIES, "images": images, "annotations": annotations}
    (split / "_annotations.coco.json").write_text(json.dumps(coco), encoding="utf-8")
    skipped = len(tile_names()) - len(images)
    print(f"exported {len(images)} tiles, {len(annotations)} polygons to {split}"
          + (f" ({skipped} tiles not finished, left out)" if skipped else ""))
    return split


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, ctype="application/json", code=200):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/":
            return self.send((ROOT / "labeler.html").read_bytes(), "text/html; charset=utf-8")
        if url.path == "/api/state":
            return self.send({"tiles": tile_names(), "labels": load_labels()})
        if url.path.startswith("/tiles/"):
            p = TILES / Path(url.path[len("/tiles/"):]).name
            if p.exists():
                return self.send(p.read_bytes(), "image/png")
        if url.path == "/api/smart":
            try:
                name = Path(q["tile"][0]).name
                if "x1" in q:
                    pts = box_polygon(name, *(int(q[k][0]) for k in ("x", "y", "x1", "y1")))
                else:
                    pts = smart_polygon(name, int(q["x"][0]), int(q["y"][0]), int(q.get("tol", ["18"])[0]))
                return self.send({"points": pts})
            except Exception as e:  # report to the page instead of dropping the request
                return self.send({"error": str(e)}, code=400)
        self.send({"error": "not found"}, code=404)

    def do_POST(self):
        url = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if url.path == "/api/save":
            labels = load_labels()
            name = Path(body["tile"]).name
            if name not in tile_names():
                return self.send({"error": "unknown tile"}, code=400)
            labels[name] = {"status": body["status"], "shapes": body["shapes"]}
            save_labels(labels)
            return self.send({"ok": True})
        if url.path == "/api/export":
            split = export()
            return self.send({"ok": True, "path": str(split)})
        self.send({"error": "not found"}, code=404)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--export", action="store_true", help="export COCO and exit")
    p.add_argument("--no-browser", action="store_true")
    args = p.parse_args(argv)
    if args.export:
        export()
        return 0
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"labeller running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
