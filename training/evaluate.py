"""Evaluate the exported ONNX model on the held-out tiles, the same way the server runs it.

  python training/evaluate.py                      # uses docs/split.json "val" tiles
  python training/evaluate.py --tta                # + flip test-time augmentation

Reports pixel confusion matrix, per-class precision / recall / F1 / IoU, pixel accuracy, and the
quantity the app actually uses: roof and usable area in m2 per tile vs the hand label.
Writes docs/metrics.json (or --out).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
sys.path.insert(0, str(REPO))

from backend.geometry import usable_area_mask  # noqa: E402
from backend.model import Segmenter, postprocess, preprocess  # noqa: E402

CLASSES = ["background", "roof", "obstruction"]
GSD = 0.1


def predict(seg: Segmenter, rgb: np.ndarray, tta: bool) -> np.ndarray:
    sess = seg._get_session()
    name = sess.get_inputs()[0].name
    x, valid = preprocess(rgb, GSD)
    if not tta:
        return postprocess(sess.run(None, {name: x})[0], valid, rgb.shape[:2])
    # Average softmax over identity, horizontal and vertical flips.
    acc = 0
    for axis in (None, 3, 2):
        xi = x if axis is None else np.ascontiguousarray(np.flip(x, axis))
        logits = sess.run(None, {name: xi})[0]
        if axis is not None:
            logits = np.flip(logits, axis)
        e = np.exp(logits - logits.max(1, keepdims=True))
        acc = acc + e / e.sum(1, keepdims=True)
    return postprocess(acc, valid, rgb.shape[:2])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default=str(REPO / "models" / "solarscope.onnx"))
    p.add_argument("--split", default=str(REPO / "docs" / "split.json"))
    p.add_argument("--subset", default="val", choices=["val", "train"])
    p.add_argument("--tta", action="store_true")
    p.add_argument("--out", default=None)
    a = p.parse_args()

    names = json.loads(Path(a.split).read_text())[a.subset]
    seg = Segmenter(Path(a.model))
    cm = np.zeros((3, 3), np.int64)
    per_tile = []
    for n in names:
        rgb = np.asarray(Image.open(ROOT / "tiles" / n).convert("RGB"))
        gt = np.asarray(Image.open(ROOT / "labels" / n)).astype(np.int64)
        pred = predict(seg, rgb, a.tta).astype(np.int64)
        cm += np.bincount(gt.ravel() * 3 + pred.ravel(), minlength=9).reshape(3, 3)
        area = lambda m: float((m > 0).sum() * GSD**2)  # noqa: E731  roof incl. obstructions
        usable = lambda m: float(usable_area_mask(m.astype(np.uint8), GSD, 0.5, 0.3).sum() * GSD**2)  # noqa: E731
        per_tile.append({"tile": n, "roof_m2_label": area(gt), "roof_m2_pred": area(pred),
                         "usable_m2_label": usable(gt), "usable_m2_pred": usable(pred)})

    tp = np.diag(cm).astype(float)
    precision = tp / np.maximum(cm.sum(0), 1)
    recall = tp / np.maximum(cm.sum(1), 1)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-9)
    iou = tp / np.maximum(cm.sum(0) + cm.sum(1) - tp, 1)

    def area_err(key):
        lab = np.array([t[f"{key}_m2_label"] for t in per_tile])
        pr = np.array([t[f"{key}_m2_pred"] for t in per_tile])
        return {"total_label_m2": round(lab.sum(), 1), "total_pred_m2": round(pr.sum(), 1),
                "total_error_pct": round(100 * (pr.sum() - lab.sum()) / max(lab.sum(), 1e-9), 1),
                "mean_abs_error_m2_per_tile": round(float(np.abs(pr - lab).mean()), 1)}

    res = {
        "subset": a.subset, "tiles": len(names), "tta": a.tta, "gsd_m": GSD,
        "pixel_accuracy": round(float(tp.sum() / cm.sum()), 4),
        "per_class": {c: {"precision": round(precision[i], 4), "recall": round(recall[i], 4),
                          "f1": round(f1[i], 4), "iou": round(iou[i], 4)} for i, c in enumerate(CLASSES)},
        "miou": round(float(iou.mean()), 4),
        "confusion_matrix_pixels": {"rows_label_cols_pred": CLASSES, "counts": cm.tolist()},
        "confusion_matrix_row_pct": (100 * cm / np.maximum(cm.sum(1, keepdims=True), 1)).round(1).tolist(),
        "roof_area": area_err("roof"),
        "usable_area_after_setback": area_err("usable"),
        "per_tile": per_tile,
    }
    out = Path(a.out) if a.out else REPO / "docs" / ("metrics_tta.json" if a.tta else "metrics.json")
    out.write_text(json.dumps(res, indent=1))

    print(f"{a.subset}: {len(names)} tiles, TTA={a.tta}")
    print(f"pixel accuracy {res['pixel_accuracy']:.3f}   mIoU {res['miou']:.3f}")
    print(f"{'class':<12}{'precision':>10}{'recall':>8}{'F1':>7}{'IoU':>7}")
    for c, m in res["per_class"].items():
        print(f"{c:<12}{m['precision']:>10.3f}{m['recall']:>8.3f}{m['f1']:>7.3f}{m['iou']:>7.3f}")
    print("confusion matrix (% of each true class; rows = label, cols = prediction bg/roof/obs):")
    for c, row in zip(CLASSES, res["confusion_matrix_row_pct"]):
        print(f"  {c:<12}" + "".join(f"{v:>8.1f}" for v in row))
    print("roof area:", res["roof_area"])
    print("usable area:", res["usable_area_after_setback"])
    print(f"-> {out}")


if __name__ == "__main__":
    main()
