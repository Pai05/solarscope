import base64
import io
import re

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import app as app_module
from backend import irradiance
from backend.app import app
from backend.schemas import PANEL_DEFAULTS

client = TestClient(app)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(irradiance, "annual_ghi", lambda lat, lon: (5.0, "test irradiance"))


def b64(mask: np.ndarray) -> str:
    return base64.b64encode(mask.astype(np.uint8).tobytes()).decode()


def png_bytes(w=64, h=48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 120, 120)).save(buf, "PNG")
    return buf.getvalue()


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_frontend_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "SolarScope" in r.text


@pytest.mark.parametrize("page", ["/", "/image.html", "/scan.html", "/installers.html"])
def test_page_assets_exist(page):
    """Every local script and stylesheet a page links to is served (catches broken paths after moves)."""
    html = client.get(page).text
    refs = re.findall(r'<(?:script|link)[^>]+(?:src|href)="([^"]+)"', html)
    local = [r for r in refs if not r.startswith(("http", "data:", "#"))]
    assert any(r.endswith(".css") for r in local) and any(r.endswith(".js") for r in local)
    for ref in local:
        assert client.get("/" + ref.lstrip("/")).status_code == 200, f"{page} -> {ref}"


def test_client_log_accepts_and_caps_text():
    r = client.post("/client-log", content=b"x" * 5000)
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_config_lists_assumptions():
    r = client.get("/config").json()
    assert "tariff_inr_per_kwh" in r["assumptions"]
    assert r["layout_defaults"]["panel_wp"] > 0


def test_report_on_square_roof():
    mask = np.zeros((120, 120), np.uint8)
    mask[10:110, 10:110] = 1          # 10 m x 10 m roof at 0.1 m/px
    mask[50:70, 50:70] = 2            # 2 m x 2 m water tank
    body = {"width": 120, "height": 120, "mask_b64": b64(mask), "gsd_m": 0.1, "lat": 16.5, "lon": 80.6}
    r = client.post("/report", json=body)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["areas_m2"]["roof_total"] == pytest.approx(100.0)
    assert rep["areas_m2"]["obstructions"] == pytest.approx(4.0)
    assert rep["areas_m2"]["usable_after_setback"] < rep["areas_m2"]["roof_free"]
    assert rep["panel_count"] > 0
    assert rep["panel_count"] == sum(t["count"] for t in rep["panel_types"])
    assert rep["capacity_kw"] == pytest.approx(sum(t["count"] * t["wp"] for t in rep["panel_types"]) / 1000)
    assert rep["irradiance_source"] == "nasa_power"
    assert rep["assumptions"]["ghi_kwh_m2_day"]["source"] == "test irradiance"
    # Panels (standard and small) must not overlap the tank or each other.
    cover = np.zeros(mask.shape, int)
    for x, y, w, h in rep["panels"] + rep["small_panels"]:
        assert not (mask[y:y + h, x:x + w] == 2).any()
        cover[y:y + h, x:x + w] += 1
    assert cover.max() == 1


def test_small_panels_fill_gaps_on_slanted_roof():
    # Trapezoid roof like a phone scan: the standard panels leave the slanted corners empty.
    mask = np.zeros((80, 120), np.uint8)
    for y in range(10, 70):
        mask[y, 10:110 - (y - 10) // 2] = 1
    base = {"width": 120, "height": 80, "mask_b64": b64(mask), "gsd_m": 0.1}
    off = client.post("/report", json={**base, "fill_small_panels": False}).json()
    on = client.post("/report", json=base).json()
    assert [t["name"] for t in off["panel_types"]] == ["Standard"] and off["small_panels"] == []
    std, small = on["panel_types"]
    assert std["count"] == off["panel_count"]                 # standard layout unchanged
    assert small["count"] > 0 and on["panel_count"] == std["count"] + small["count"]
    assert on["capacity_kw"] > off["capacity_kw"]
    assert on["min_panel_size_m"] == {"w": small["w_m"], "h": small["h_m"]}


def test_small_panel_not_smaller_is_ignored():
    mask = np.ones((60, 60), np.uint8)
    body = {"width": 60, "height": 60, "mask_b64": b64(mask), "gsd_m": 0.1, "small_panel_w_m": 2.0, "small_panel_h_m": 1.2}
    rep = client.post("/report", json=body).json()
    assert len(rep["panel_types"]) == 1 and rep["small_panels"] == []


def test_report_roof_point_selects_one_building():
    mask = np.zeros((100, 250), np.uint8)
    mask[10:90, 10:110] = 1
    mask[10:90, 140:240] = 1
    base = {"width": 250, "height": 100, "mask_b64": b64(mask), "gsd_m": 0.1}
    both = client.post("/report", json=base).json()
    one = client.post("/report", json={**base, "roof_point": [50, 50]}).json()
    assert one["areas_m2"]["roof_total"] == pytest.approx(both["areas_m2"]["roof_total"] / 2)


def test_report_without_location_uses_flagged_fallback():
    mask = np.ones((50, 50), np.uint8)
    r = client.post("/report", json={"width": 50, "height": 50, "mask_b64": b64(mask), "gsd_m": 0.1}).json()
    assert r["irradiance_source"] == "fallback_placeholder"
    assert r["all_assumptions_verified"] is False


@pytest.mark.parametrize("change, status", [
    ({"width": 51}, 400),             # size mismatch
    ({"mask_b64": "!!notb64"}, 400),
    ({"gsd_m": 0}, 422),
    ({"overrides": {"nope": 1}}, 400),
])
def test_report_validation(change, status):
    body = {"width": 50, "height": 50, "mask_b64": b64(np.ones((50, 50))), "gsd_m": 0.1, **change}
    assert client.post("/report", json=body).status_code == status


def test_report_rejects_bad_class_values():
    body = {"width": 10, "height": 10, "mask_b64": b64(np.full((10, 10), 7)), "gsd_m": 0.1}
    assert client.post("/report", json=body).status_code == 400


def test_predict_without_model_is_503(monkeypatch):
    monkeypatch.setattr(type(app_module.segmenter), "available", property(lambda self: False))
    r = client.post("/predict", files={"file": ("a.png", png_bytes(), "image/png")})
    assert r.status_code == 503


def test_predict_with_fake_model(monkeypatch):
    seg = app_module.segmenter
    monkeypatch.setattr(type(seg), "available", property(lambda self: True))
    monkeypatch.setattr(seg, "predict", lambda rgb, gsd: np.ones(rgb.shape[:2], np.uint8))
    r = client.post("/predict", files={"file": ("a.png", png_bytes(64, 48), "image/png")}, data={"gsd_m": "0.1"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j["width"], j["height"]) == (64, 48)
    assert len(base64.b64decode(j["mask_b64"])) == 64 * 48


def test_predict_rejects_non_image(monkeypatch):
    monkeypatch.setattr(type(app_module.segmenter), "available", property(lambda self: True))
    r = client.post("/predict", files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 400


def test_pages_and_scripts_are_revalidated():
    # Phones must not keep running cached old scripts after an update (e.g. the "start on Home" rule).
    for path in ("/", "/scan.html", "/js/theme.js", "/css/styles.css"):
        assert client.get(path).headers.get("cache-control") == "no-cache", path
    assert "no-cache" not in (client.get("/config").headers.get("cache-control") or "")
