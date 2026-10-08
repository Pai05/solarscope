"""Roof segmentation with an ONNX U-Net on CPU (onnxruntime; no torch on the server).

The model was trained on tiles at MODEL_GSD metres per pixel, so input images are resampled
to that scale before inference and the mask is resized back to the input size.
Optional metadata (classes, metrics, training info) is read from the .json next to the .onnx.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = Path(os.environ.get("SOLARSCOPE_MODEL", ROOT / "models" / "solarscope.onnx"))
MODEL_GSD = 0.1
MAX_SIDE = 1536  # cap on model input side to bound CPU time and RAM
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def preprocess(rgb: np.ndarray, gsd_m: float) -> tuple[np.ndarray, tuple[int, int]]:
    """Resample to MODEL_GSD, pad to a multiple of 32, normalise. Returns NCHW tensor and the
    unpadded (h, w) of the resampled image."""
    h, w = rgb.shape[:2]
    scale = gsd_m / MODEL_GSD
    nh, nw = max(32, round(h * scale)), max(32, round(w * scale))
    if max(nh, nw) > MAX_SIDE:
        k = MAX_SIDE / max(nh, nw)
        nh, nw = max(32, round(nh * k)), max(32, round(nw * k))
    img = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.BILINEAR), np.float32) / 255.0
    ph, pw = -nh % 32, -nw % 32
    img = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode="reflect")
    x = ((img - MEAN) / STD).transpose(2, 0, 1)[None]
    return np.ascontiguousarray(x, np.float32), (nh, nw)


def postprocess(logits: np.ndarray, valid_hw: tuple[int, int], out_hw: tuple[int, int]) -> np.ndarray:
    nh, nw = valid_hw
    mask = logits[0].argmax(0)[:nh, :nw].astype(np.uint8)
    return np.asarray(Image.fromarray(mask).resize((out_hw[1], out_hw[0]), Image.NEAREST))


class Segmenter:
    def __init__(self, path: Path = MODEL_PATH):
        self.path = path
        self._session = None
        meta_path = path.with_suffix(".json")
        self.meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    @property
    def available(self) -> bool:
        return self.path.exists()

    def _get_session(self):
        if self._session is None:
            import onnxruntime as ort  # imported lazily so tests and /health work without it

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = os.cpu_count() or 1
            self._session = ort.InferenceSession(str(self.path), opts, providers=["CPUExecutionProvider"])
        return self._session

    def predict(self, rgb: np.ndarray, gsd_m: float) -> np.ndarray:
        sess = self._get_session()
        x, valid = preprocess(rgb, gsd_m)
        (logits,) = sess.run(None, {sess.get_inputs()[0].name: x})
        return postprocess(logits, valid, rgb.shape[:2])
