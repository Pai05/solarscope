"""Train the SolarScope U-Net (3 classes) and export it to ONNX.

Designed for a free Colab/Kaggle GPU, also runs (slowly) on CPU:
  python training/train.py --epochs 60
  python training/train.py --epochs 1 --smoke     # quick pipeline check

Outputs in --out (default models/):
  solarscope.onnx        model for the server (input NCHW float32, ImageNet-normalised, 0.1 m/px)
  solarscope.json        metadata + validation metrics, shown in the web app
  val_preview.png        image | ground truth | prediction for each validation tile
  split.json             which tiles were used for train / val
"""

from __future__ import annotations

import argparse
import json
import random
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

import segmentation_models_pytorch as smp

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
CLASSES = ["background", "roof", "obstruction"]
IGNORE = 255
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
COLOURS = np.array([[0, 0, 0], [34, 197, 94], [239, 68, 68]], np.uint8)


def normalise(rgb: np.ndarray) -> torch.Tensor:
    x = (rgb.astype(np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(x.transpose(2, 0, 1).copy())


class Tiles(Dataset):
    def __init__(self, names: list[str], tiles: Path, labels: Path, size: int, augment: bool):
        self.items = [(tiles / n, labels / n) for n in names]
        self.size, self.augment = size, augment

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i):
        ip, lp = self.items[i]
        img = Image.open(ip).convert("RGB")
        lab = Image.open(lp)
        if self.augment:
            img, lab = self._scale_jitter(img, lab)
        rgb, m = np.asarray(img), np.asarray(lab).astype(np.int64)
        if self.augment:
            k = random.randint(0, 3)
            rgb, m = np.rot90(rgb, k), np.rot90(m, k)
            if random.random() < 0.5:
                rgb, m = rgb[:, ::-1], m[:, ::-1]
            rgb = self._colour_jitter(rgb)
        return normalise(np.ascontiguousarray(rgb)), torch.from_numpy(np.ascontiguousarray(m))

    def _scale_jitter(self, img, lab):
        """Random zoom 0.8-1.25x then crop/pad back to size: robustness to scale errors."""
        s = random.uniform(0.8, 1.25)
        n = max(32, round(self.size * s))
        img = img.resize((n, n), Image.BILINEAR)
        lab = lab.resize((n, n), Image.NEAREST)
        if n >= self.size:
            x, y = random.randint(0, n - self.size), random.randint(0, n - self.size)
            box = (x, y, x + self.size, y + self.size)
            return img.crop(box), lab.crop(box)
        canvas_i = Image.new("RGB", (self.size, self.size))
        canvas_l = Image.new("L", (self.size, self.size), IGNORE)
        x, y = random.randint(0, self.size - n), random.randint(0, self.size - n)
        canvas_i.paste(img, (x, y))
        canvas_l.paste(lab, (x, y))
        return canvas_i, canvas_l

    @staticmethod
    def _colour_jitter(rgb: np.ndarray) -> np.ndarray:
        x = rgb.astype(np.float32)
        x = x * random.uniform(0.8, 1.2) + random.uniform(-20, 20)       # contrast / brightness
        x = x * np.random.uniform(0.92, 1.08, size=3)                     # per-channel tint
        return np.clip(x, 0, 255).astype(np.uint8)


def confusion(pred: torch.Tensor, target: torch.Tensor, n: int = 3) -> torch.Tensor:
    keep = target != IGNORE
    idx = target[keep] * n + pred[keep]
    return torch.bincount(idx, minlength=n * n).reshape(n, n).cpu()


def iou_from_confusion(cm: torch.Tensor) -> list[float]:
    tp = cm.diag().float()
    denom = cm.sum(0).float() + cm.sum(1).float() - tp
    return [float(t / d) if d > 0 else float("nan") for t, d in zip(tp, denom)]


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    cm = torch.zeros(3, 3, dtype=torch.long)
    for x, y in loader:
        logits = model(x.to(device))
        cm += confusion(logits.argmax(1), y.to(device))
    return iou_from_confusion(cm), cm


@torch.no_grad()
def save_preview(model, names, tiles, labels, device, path: Path, max_rows: int = 12):
    model.eval()
    rows = []
    for n in names[:max_rows]:
        rgb = np.asarray(Image.open(tiles / n).convert("RGB"))
        gt = np.asarray(Image.open(labels / n))
        pred = model(normalise(rgb)[None].to(device)).argmax(1)[0].cpu().numpy()
        blend = lambda m: (0.5 * rgb + 0.5 * COLOURS[np.clip(m, 0, 2)]).astype(np.uint8)  # noqa: E731
        rows.append(np.concatenate([rgb, blend(gt), blend(pred)], axis=1))
    if rows:
        Image.fromarray(np.concatenate(rows, axis=0)).save(path)


def export_onnx(model, path: Path, size: int, device) -> float:
    """Export with dynamic H/W, then check onnxruntime matches torch. Returns max abs logit diff."""
    model.eval().cpu()
    dummy = torch.randn(1, 3, size, size)
    kwargs = dict(input_names=["image"], output_names=["logits"], opset_version=17,
                  dynamic_axes={"image": {0: "n", 2: "h", 3: "w"}, "logits": {0: "n", 2: "h", 3: "w"}})
    try:
        torch.onnx.export(model, dummy, str(path), dynamo=False, **kwargs)
    except TypeError:  # older torch without the dynamo flag
        torch.onnx.export(model, dummy, str(path), **kwargs)
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    test = torch.randn(1, 3, size + 64, size + 32)  # different size: checks dynamic axes
    ref = model(test).detach().numpy()
    out = sess.run(None, {"image": test.numpy()})[0]
    model.to(device)
    return float(np.abs(ref - out).max())


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--tiles", default=str(ROOT / "tiles"))
    p.add_argument("--labels", default=str(ROOT / "labels"))
    p.add_argument("--out", default=str(REPO / "models"))
    p.add_argument("--encoder", default="resnet34")
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=5e-4)
    p.add_argument("--size", type=int, default=256)
    p.add_argument("--val-frac", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--smoke", action="store_true", help="tiny run to check the pipeline")
    a = p.parse_args()

    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    tiles, labels, out = Path(a.tiles), Path(a.labels), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    names = sorted(pth.name for pth in labels.glob("*.png") if (tiles / pth.name).exists())
    if len(names) < 5:
        raise SystemExit(f"Only {len(names)} labelled tiles in {labels}. Run coco_to_masks.py first.")
    # Split so validation gets labelled tiles; background-only tiles stay in training.
    has_roof = [n for n in names if np.asarray(Image.open(labels / n)).any()]
    empty = [n for n in names if n not in has_roof]
    random.shuffle(has_roof)
    n_val = max(2, round(len(has_roof) * a.val_frac))
    val, train = sorted(has_roof[:n_val]), sorted(has_roof[n_val:] + empty)
    if a.smoke:
        train, val, a.epochs = train[:8], val[:2], 1
    (out / "split.json").write_text(json.dumps({"train": train, "val": val}, indent=1))
    print(f"device={device} train={len(train)} val={len(val)} (background-only in train: {len(empty)})")

    train_dl = DataLoader(Tiles(train, tiles, labels, a.size, True), batch_size=a.batch, shuffle=True,
                          num_workers=2, drop_last=len(train) > a.batch)
    val_dl = DataLoader(Tiles(val, tiles, labels, a.size, False), batch_size=a.batch, num_workers=2)

    model = smp.Unet(a.encoder, encoder_weights="imagenet", classes=3).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * max(1, len(train_dl)))
    dice = smp.losses.DiceLoss("multiclass", ignore_index=IGNORE)

    best, best_ious, best_state = -1.0, None, None
    t0 = time.time()
    for epoch in range(1, a.epochs + 1):
        model.train()
        total = 0.0
        for x, y in train_dl:
            x, y = x.to(device), y.to(device)
            logits = model(x)
            loss = F.cross_entropy(logits, y, ignore_index=IGNORE) + dice(logits, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item()
        ious, _ = evaluate(model, val_dl, device)
        miou = float(np.nanmean(ious))
        if miou > best:
            best, best_ious = miou, ious
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        print(f"epoch {epoch:3d} loss {total / max(1, len(train_dl)):.3f} "
              f"IoU bg {ious[0]:.3f} roof {ious[1]:.3f} obstruction {ious[2]:.3f} mIoU {miou:.3f}"
              f"{'  *best' if miou == best else ''}")

    model.load_state_dict(best_state)
    torch.save(best_state, out / "solarscope.pt")
    save_preview(model, val, tiles, labels, device, out / "val_preview.png")
    diff = export_onnx(model, out / "solarscope.onnx", a.size, device)
    print(f"ONNX export ok, max |torch - onnxruntime| = {diff:.2e}")

    clean = lambda v: None if v != v else round(v, 4)  # noqa: E731  NaN is not valid JSON
    meta = {
        "arch": f"U-Net {a.encoder}",
        "classes": CLASSES,
        "gsd_m": 0.1,
        "metrics": {"miou": clean(best), **{f"iou_{c}": clean(v) for c, v in zip(CLASSES, best_ious)}},
        "n_train": len(train),
        "n_val": len(val),
        "epochs": a.epochs,
        "encoder_weights": "imagenet",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "train_minutes": round((time.time() - t0) / 60, 1),
        "data": "OpenAerialMap CC-BY 4.0 (Vijayawada/Bhuvan, Dhaka/CSC), hand-labelled",
    }
    (out / "solarscope.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["metrics"], indent=1))


if __name__ == "__main__":
    main()
