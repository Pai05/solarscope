import base64
import io

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
    assert rep["capacity_kw"] == pytest.approx(rep["panel_count"] * PANEL_DEFAULTS["panel_wp"] / 1000)
    assert rep["irradiance_source"] == "nasa_power"
    assert rep["assumptions"]["ghi_kwh_m2_day"]["source"] == "test irradiance"
    # Panels must not overlap the tank.
    for x, y, w, h in rep["panels"]:
        assert not (mask[y:y + h, x:x + w] == 2).any()


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
