"""SolarScope FastAPI app: serves the frontend and the API from one process."""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError

from backend import geometry, irradiance, solar_calc
from backend.model import MODEL_GSD, Segmenter
from backend.schemas import MAX_SIDE, PANEL_DEFAULTS, ReportRequest

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="SolarScope")
app.add_middleware(GZipMiddleware, minimum_size=1000)
segmenter = Segmenter()

PANEL_SOURCE = "PLACEHOLDER - check against a real module datasheet"
LAYOUT_SOURCE = "configurable layout rule (not a regulation)"


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_loaded": segmenter.available}


@app.get("/config")
def config() -> dict:
    return {
        "layout_defaults": PANEL_DEFAULTS,
        "assumptions": {k: vars(a) for k, a in solar_calc.DEFAULT_ASSUMPTIONS.items()},
        "model": {"available": segmenter.available, "gsd_m": MODEL_GSD, **segmenter.meta},
    }


def _decode_image(data: bytes) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "Could not read the image. Use a JPG or PNG.")
    if max(img.size) > MAX_SIDE:
        raise HTTPException(400, f"Image too large; max side is {MAX_SIDE} px (the web app resizes for you).")
    return np.asarray(img)


@app.post("/predict")
async def predict(file: UploadFile = File(...), gsd_m: float = Form(MODEL_GSD)) -> dict:
    if not segmenter.available:
        raise HTTPException(503, "Model not loaded on this server. You can still paint the roof by hand.")
    if not 0.005 < gsd_m <= 2.0:
        raise HTTPException(400, "gsd_m must be between 0.005 and 2 metres per pixel.")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 15 MB).")
    rgb = _decode_image(data)
    mask = await run_in_threadpool(segmenter.predict, rgb, gsd_m)
    h, w = mask.shape
    return {"width": w, "height": h, "mask_b64": base64.b64encode(mask.tobytes()).decode()}


def build_report(req: ReportRequest) -> dict:
    try:
        raw = base64.b64decode(req.mask_b64, validate=True)
    except ValueError:
        raise HTTPException(400, "mask_b64 is not valid base64.")
    if len(raw) != req.width * req.height:
        raise HTTPException(400, "mask size does not match width x height.")
    mask = np.frombuffer(raw, np.uint8).reshape(req.height, req.width)
    if mask.max(initial=0) > geometry.OBSTRUCTION:
        raise HTTPException(400, "mask values must be 0, 1 or 2.")

    mask = geometry.select_roof(geometry.crop_to_box(mask, req.roof_box), req.roof_point)
    usable = geometry.usable_area_mask(mask, req.gsd_m, req.setback_m, req.obstruction_buffer_m)
    layout = geometry.layout_panels(usable, req.gsd_m, req.panel_w_m, req.panel_h_m)
    capacity_kw = layout.count * req.panel_wp / 1000

    ghi = irradiance.annual_ghi(req.lat, req.lon) if req.lat is not None and req.lon is not None else None
    try:
        econ = solar_calc.compute_report(
            capacity_kw,
            ghi_kwh_m2_day=ghi[0] if ghi else None,
            ghi_source=ghi[1] if ghi else None,
            overrides=req.overrides,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e))

    px = lambda n: round(geometry.area_m2(int(n), req.gsd_m), 1)  # noqa: E731
    roof_px = int((mask == geometry.ROOF).sum())
    obs_px = int((mask == geometry.OBSTRUCTION).sum())
    econ["assumptions"].update({
        "panel_size_m": {"value": f"{req.panel_w_m} x {req.panel_h_m}", "unit": "m", "source": PANEL_SOURCE, "verified": False},
        "panel_wp": {"value": req.panel_wp, "unit": "Wp", "source": PANEL_SOURCE, "verified": False},
        "setback_m": {"value": req.setback_m, "unit": "m", "source": LAYOUT_SOURCE, "verified": True},
        "obstruction_buffer_m": {"value": req.obstruction_buffer_m, "unit": "m", "source": LAYOUT_SOURCE, "verified": True},
        "gsd_m": {"value": round(req.gsd_m, 4), "unit": "m/px", "source": "image scale (user-set or calibrated)", "verified": True},
    })
    econ["all_assumptions_verified"] = all(a["verified"] for a in econ["assumptions"].values())
    return {
        "areas_m2": {
            "roof_total": px(roof_px + obs_px),
            "obstructions": px(obs_px),
            "roof_free": px(roof_px),
            "usable_after_setback": px(usable.sum()),
            "covered_by_panels": round(layout.count * req.panel_w_m * req.panel_h_m, 1),
        },
        "panel_count": layout.count,
        "panel_orientation": "landscape" if layout.landscape else "portrait",
        "panels": layout.panels,
        "irradiance_source": "nasa_power" if ghi else "fallback_placeholder",
        **econ,
    }


@app.post("/report")
async def report(req: ReportRequest) -> dict:
    return await run_in_threadpool(build_report, req)


# Mounted last so API routes take precedence.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
