"""SolarScope FastAPI app: serves the frontend and the API from one process."""

from __future__ import annotations

import base64
import io
import logging
import math
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError

from backend import budget, chat, geometry, help_kb, installers, irradiance, solar_calc
from backend.model import MODEL_GSD, Segmenter
from backend.schemas import MAX_SIDE, PANEL_DEFAULTS, ChatRequest, ReportRequest

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="SolarScope")
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def revalidate_pages(request: Request, call_next):
    """Pages, scripts and styles: the browser must check for a newer version every time (a cheap 304 when
    unchanged). Without this, phones keep running cached old scripts long after an update."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache"
    return response
segmenter = Segmenter()

PANEL_SOURCE = "Typical residential 60-cell module, ~1.70 x 1.00 m, 300-450 Wp (350 Wp mid-range) - confirm with your panel's datasheet"
LAYOUT_SOURCE = "configurable layout rule (not a regulation)"
PLAN_GSD = 0.05  # metres per pixel of the to-scale plan built from a photo and the typed roof size
SMALL_PANEL_SOURCE = ("Typical 36-cell 100 Wp module, ~1.00 x 0.67 m - different voltage from the standard panels: "
                      "wire on a separate string/MPPT input or use microinverters; confirm with your installer")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_loaded": segmenter.available}


client_log = logging.getLogger("solarscope.client")


@app.post("/client-log")
async def client_log_endpoint(request: Request) -> dict:
    """AR diagnostics from phones (WebXR cannot be debugged remotely without a cable). Text only, capped."""
    text = (await request.body())[:2000].decode("utf-8", "replace").replace("\n", " ")
    client_log.info("%s %s", request.client.host if request.client else "?", text)
    return {"ok": True}


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
    gsd, frame, obstructions = req.gsd_m, None, None
    roof_quad = None
    if req.roof_sides_m or (req.roof_length_m and req.roof_width_m):
        # Photo with the roof's real size typed in (length x width, or 4 sides): redraw the marked roof to scale
        # (any pixel scale or camera angle), then lay out panels on that to-scale plan exactly like a phone scan.
        if not (mask != geometry.BACKGROUND).any():
            raise HTTPException(400, "Mark the roof on the image first (Detect, or paint it with the Roof brush).")
        try:
            mask, frame, roof_quad = geometry.to_metric(
                mask, req.roof_length_m, req.roof_width_m, PLAN_GSD,
                sides_m=req.roof_sides_m, diagonal_m=req.roof_diagonal_m)
        except ValueError as e:
            raise HTTPException(400, f"{str(e).capitalize()}. Check the roof marking and the sizes you typed.")
        gsd = PLAN_GSD
        obstructions = geometry.obstruction_list(mask, gsd)  # as drawn; sizes the user typed replace them below
        sizes = list(req.obstruction_sizes or [])
        sizes += [None] * (len(obstructions) - len(sizes))
        for inp in req.obstruction_inputs or []:   # sizes typed per painted obstruction, found by its position
            k = _obstruction_at(obstructions, frame, gsd, inp.x, inp.y)
            if k is not None:
                sizes[k] = inp.size
        for o, size in zip(obstructions, sizes):
            if size:
                o["typed"] = True
                if len(size) == 4:
                    o["sides_m"] = list(size)
                    o["length_m"], o["width_m"] = max(size[0], size[2]), max(size[1], size[3])
                else:
                    o["length_m"], o["width_m"] = size[0], size[1]
        try:
            mask = geometry.resize_obstructions(mask, gsd, sizes)
        except ValueError as e:
            raise HTTPException(400, f"Obstruction sizes: {e}.")
    usable = geometry.usable_area_mask(mask, gsd, req.setback_m, req.obstruction_buffer_m)
    layout = geometry.layout_panels(usable, gsd, req.panel_w_m, req.panel_h_m)
    # Gaps the standard panels leave (slanted edges, strips beside tanks) get the small panel, if it is
    # really smaller; otherwise the second pass could only repeat the first.
    small_is_smaller = req.small_panel_w_m * req.small_panel_h_m < req.panel_w_m * req.panel_h_m
    small = (geometry.fill_gaps(usable, layout.panels, gsd, req.small_panel_w_m, req.small_panel_h_m)
             if req.fill_small_panels and small_is_smaller else geometry.Layout([], True))
    std_panels, small_panels = layout.panels, small.panels

    ghi = irradiance.annual_ghi(req.lat, req.lon) if req.lat is not None and req.lon is not None else None
    econ_for = lambda kw: solar_calc.compute_report(  # noqa: E731
        kw, ghi_kwh_m2_day=ghi[0] if ghi else None, ghi_source=ghi[1] if ghi else None, overrides=req.overrides)
    full_kw = (len(std_panels) * req.panel_wp + len(small_panels) * req.small_panel_wp) / 1000
    try:
        budget_info = None
        if req.budget_inr is not None:
            # Largest system the roof holds whose cost (after subsidy, or upfront) stays within the budget.
            key = "net_cost_inr" if req.budget_basis == "net" else "gross_cost_inr"
            full = econ_for(full_kw)
            n_std, n_small = budget.best_mix(len(std_panels), len(small_panels), req.panel_wp, req.small_panel_wp,
                                             lambda kw: econ_for(kw)[key], req.budget_inr)
            std_panels, spare_std = budget.pick_compact(std_panels, n_std)
            small_panels, spare_small = budget.pick_compact(small_panels, n_small, budget.centre(std_panels))
            budget_info = {
                "budget_inr": req.budget_inr,
                "basis": req.budget_basis,
                "limited": bool(spare_std or spare_small),
                "roof_max": {"panel_count": layout.count + small.count, "capacity_kw": full["capacity_kw"],
                             "gross_cost_inr": full["gross_cost_inr"], "net_cost_inr": full["net_cost_inr"]},
                "spare_panels": spare_std,          # panels the roof could hold beyond the budget, (x, y, w, h) px
                "spare_small_panels": spare_small,
            }
        capacity_kw = (len(std_panels) * req.panel_wp + len(small_panels) * req.small_panel_wp) / 1000
        econ = econ_for(capacity_kw)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e))
    if budget_info:
        budget_info["left_inr"] = round(req.budget_inr - econ["net_cost_inr" if req.budget_basis == "net" else "gross_cost_inr"])

    panel_types = [{"name": "Standard", "w_m": req.panel_w_m, "h_m": req.panel_h_m, "wp": req.panel_wp,
                    "count": len(std_panels)}]
    if req.fill_small_panels and small_is_smaller:
        panel_types.append({"name": "Small (fills gaps)", "w_m": req.small_panel_w_m, "h_m": req.small_panel_h_m,
                            "wp": req.small_panel_wp, "count": len(small_panels)})
    # Smallest panel the layout considers: below this no panel fits anywhere.
    smallest = min(panel_types, key=lambda t: t["w_m"] * t["h_m"])

    px = lambda n: round(geometry.area_m2(int(n), gsd), 1)  # noqa: E731
    roof_px = int((mask == geometry.ROOF).sum())
    obs_px = int((mask == geometry.OBSTRUCTION).sum())
    econ["assumptions"].update({
        "panel_size_m": {"value": f"{req.panel_w_m} x {req.panel_h_m}", "unit": "m", "source": PANEL_SOURCE, "verified": False},
        "panel_wp": {"value": req.panel_wp, "unit": "Wp", "source": PANEL_SOURCE, "verified": False},
        **({
            "small_panel_size_m": {"value": f"{req.small_panel_w_m} x {req.small_panel_h_m}", "unit": "m",
                                   "source": SMALL_PANEL_SOURCE, "verified": False},
            "small_panel_wp": {"value": req.small_panel_wp, "unit": "Wp", "source": SMALL_PANEL_SOURCE, "verified": False},
        } if len(panel_types) > 1 else {}),
        "setback_m": {"value": req.setback_m, "unit": "m", "source": LAYOUT_SOURCE, "verified": True},
        "obstruction_buffer_m": {"value": req.obstruction_buffer_m, "unit": "m", "source": LAYOUT_SOURCE, "verified": True},
        **({"roof_size_m": {"value": _roof_size_text(req), "unit": "m",
                            "source": "roof size typed by the user", "verified": True}}
           if frame else
           {"gsd_m": {"value": round(gsd, 4), "unit": "m/px", "source": "image scale (user-set or calibrated)", "verified": True}}),
    })
    econ["all_assumptions_verified"] = all(a["verified"] for a in econ["assumptions"].values())
    return {
        "areas_m2": {
            "roof_total": px(roof_px + obs_px),
            "obstructions": px(obs_px),
            "roof_free": px(roof_px),
            "usable_after_setback": px(usable.sum()),
            "covered_by_panels": round(sum(t["count"] * t["w_m"] * t["h_m"] for t in panel_types), 1),
        },
        "panel_count": len(std_panels) + len(small_panels),  # all panels in the plan; per size in panel_types
        "panel_types": panel_types,
        "min_panel_size_m": {"w": smallest["w_m"], "h": smallest["h_m"]},
        "panel_orientation": "landscape" if layout.landscape else "portrait",
        "panels": std_panels,            # standard panels, (x, y, w, h) px
        "small_panels": small_panels,    # small gap-filling panels, (x, y, w, h) px
        "budget": budget_info,           # null without a budget
        # Photo + typed roof size: the to-scale plan the panels were laid out on (panel boxes above are in its
        # pixels), the panels mapped back onto the photo, and the obstructions with their sizes.
        "plan": _plan_payload(mask, gsd, frame, std_panels, small_panels, obstructions, roof_quad, (req.width, req.height)) if frame else None,
        "irradiance_source": "nasa_power" if ghi else "fallback_placeholder",
        **econ,
    }


def _obstruction_at(obstructions: list[dict], frame, gsd: float, x: float, y: float) -> int | None:
    """Index of the plan obstruction nearest to photo point (x, y), if within 1.5 m of its centre."""
    u, v = frame.to_plan(x, y)
    best, best_d = None, 1.5
    for o in obstructions:
        d = math.hypot((o["cx"] + 0.5) * gsd - u, (o["cy"] + 0.5) * gsd - v)
        if d < best_d:
            best, best_d = o["id"], d
    return best


def _roof_size_text(req: ReportRequest) -> str:
    if req.roof_sides_m:
        t, r, b, l = req.roof_sides_m
        text = f"sides {t:g} (top) / {r:g} (right) / {b:g} (bottom) / {l:g} (left)"
        return text + (f", diagonal {req.roof_diagonal_m:g}" if req.roof_diagonal_m else "")
    return f"{max(req.roof_length_m, req.roof_width_m):g} x {min(req.roof_length_m, req.roof_width_m):g}"


def _plan_payload(mask, gsd, frame, std_panels, small_panels, obstructions, roof_quad, photo_size) -> dict:
    def quads(panels):  # panel boxes (plan px) -> corner points on the photo
        out = []
        for x, y, w, h in panels:
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
            out.append([[round(c, 1) for c in frame.to_photo(px * gsd, py * gsd)] for px, py in pts])
        return out
    return {
        "width": int(mask.shape[1]), "height": int(mask.shape[0]), "gsd_m": gsd,
        "mask_b64": base64.b64encode(np.ascontiguousarray(mask, np.uint8).tobytes()).decode(),
        "photo_panels": quads(std_panels),
        "photo_small_panels": quads(small_panels),
        "obstructions": [{k: o[k] for k in ("id", "length_m", "width_m", "cx", "cy")}
                         | {"typed": o.get("typed", False), "sides_m": o.get("sides_m"),
                            "photo_xy": [round(c, 1) for c in frame.to_photo((o["cx"] + 0.5) * gsd, (o["cy"] + 0.5) * gsd)]}
                         for o in obstructions],
        # Roof corners (top-left, top-right, bottom-right, bottom-left) in plan metres and on the photo, and the
        # length of each side (top, right, bottom, left), for labelling both views.
        "roof_corners_m": [[round(float(c), 3) for c in pt] for pt in roof_quad],
        "photo_roof_corners": [[round(c, 1) for c in frame.to_photo(*pt)] for pt in roof_quad],
        "roof_sides_m": [round(float(np.hypot(*(roof_quad[(i + 1) % 4] - roof_quad[i]))), 2) for i in range(4)],
        # A roof corner on the photo's border: the roof probably continues out of the picture, so the marked
        # outline is not the real roof edge and the typed sizes will not match it.
        "roof_cut_off": _cut_off([frame.to_photo(*pt) for pt in roof_quad], photo_size),
    }


def _cut_off(corners, photo_size) -> bool:
    w, h = photo_size
    tol = 0.015 * max(w, h)
    return sum(1 for x, y in corners if x < tol or y < tol or x > w - tol or y > h - tol) >= 2


@app.post("/report")
async def report(req: ReportRequest) -> dict:
    return await run_in_threadpool(build_report, req)


@app.get("/api/installers")
def list_installers(
    state: str | None = Query(None, max_length=60),
    city: str | None = Query(None, max_length=60),
    min_kwp: float | None = Query(None, ge=0, le=10000),
    max_kwp: float | None = Query(None, ge=0, le=10000),
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    radius_km: float | None = Query(None, gt=0, le=5000),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    """Installer directory, nearest first when lat/lon are given. The shipped data is placeholders (see README)."""
    if min_kwp is not None and max_kwp is not None and min_kwp > max_kwp:
        raise HTTPException(400, "min_kwp must not be greater than max_kwp.")
    if (lat is None) != (lon is None):
        raise HTTPException(400, "Give both lat and lon, or neither.")
    if radius_km is not None and lat is None:
        raise HTTPException(400, "radius_km needs lat and lon.")
    try:
        items, note = installers.load()
    except installers.InstallerDataError as e:
        logging.getLogger("solarscope.installers").error("%s", e)
        raise HTTPException(503, "Installer directory is not available right now.")
    found = installers.filter_installers(items, (state or "").strip() or None, (city or "").strip() or None,
                                         min_kwp, max_kwp, lat, lon, radius_km)
    return {"count": min(len(found), limit), "total": len(found), "installers": found[:limit], "note": note}


@app.get("/api/locations")
def list_locations() -> dict:
    """States and union territories of India with their main cities, for the installer filters."""
    try:
        return {"states": installers.load_locations()}
    except installers.InstallerDataError as e:
        logging.getLogger("solarscope.installers").error("%s", e)
        raise HTTPException(503, "Location list is not available right now.")


# Mounted last so API routes take precedence.
@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest) -> dict:
    """Help assistant: answers questions about using SolarScope (see backend/chat.py)."""
    history = [h.model_dump() for h in req.history[-6:]]
    return await run_in_threadpool(chat.reply, req.message, req.page, history)


@app.get("/api/chat/starters")
def chat_starters(page: str | None = Query(None, max_length=20)) -> dict:
    return {"questions": help_kb.starter_questions(page), "ai": chat.ai_enabled()}


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
