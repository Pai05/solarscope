import numpy as np
from fastapi.testclient import TestClient

from backend import budget, solar_calc
from backend.app import app

client = TestClient(app)


def b64(mask):
    import base64
    return base64.b64encode(mask.tobytes()).decode()


def net(kw):
    return solar_calc.compute_report(kw)["net_cost_inr"]


def test_best_mix_maximises_power_within_budget():
    # Rs 1 lakh after subsidy buys at most (100000 + 78000) / 50000 = 3.56 kWp.
    s, m = budget.best_mix(40, 20, 350, 100, net, 100_000)
    kw = (s * 350 + m * 100) / 1000
    assert net(kw) <= 100_000
    assert kw > 3.45                                   # nothing bigger fits: 3.55 kWp beats 10 x 350 = 3.50
    for extra in ((1, 0), (0, 1)):                     # one more panel of either size breaks the budget
        if s + extra[0] <= 40 and m + extra[1] <= 20:
            assert net(kw + (extra[0] * 350 + extra[1] * 100) / 1000) > 100_000


def test_best_mix_edge_cases():
    assert budget.best_mix(10, 5, 350, 100, net, 1) == (0, 0)          # too small for any panel
    assert budget.best_mix(3, 2, 350, 100, net, 10_000_000) == (3, 2)  # budget covers the whole roof


def test_pick_compact_keeps_panels_together():
    panels = [(x, y, 10, 10) for y in (0, 10) for x in (0, 10, 20)]
    kept, spare = budget.pick_compact(panels, 3)
    assert kept == [(0, 0, 10, 10), (10, 0, 10, 10), (20, 0, 10, 10)] and len(spare) == 3
    near, _ = budget.pick_compact(panels, 1, (25, 15))
    assert near == [(20, 10, 10, 10)]


def _roof(L=12.0, W=8.0, gsd=0.1):
    mask = np.zeros((int(W / gsd) + 20, int(L / gsd) + 20), np.uint8)
    mask[10:10 + int(W / gsd), 10:10 + int(L / gsd)] = 1
    return {"width": mask.shape[1], "height": mask.shape[0], "mask_b64": b64(mask), "gsd_m": gsd}


def test_report_fits_budget():
    base = _roof()
    full = client.post("/report", json=base).json()
    assert full["budget"] is None and full["net_cost_inr"] > 150_000   # roof alone would cost more than 1.5 lakh
    r = client.post("/report", json={**base, "budget_inr": 100_000}).json()
    b = r["budget"]
    assert b["limited"] and b["basis"] == "net" and r["net_cost_inr"] <= 100_000 and b["left_inr"] >= 0
    assert r["capacity_kw"] > 3.45 and r["panel_count"] < full["panel_count"]
    assert b["roof_max"]["panel_count"] == full["panel_count"]
    assert r["panel_count"] + len(b["spare_panels"]) + len(b["spare_small_panels"]) == full["panel_count"]
    assert r["capacity_kw"] == sum(t["count"] * t["wp"] for t in r["panel_types"]) / 1000
    # Upfront (gross) budget: the whole price must fit, so the system is smaller.
    g = client.post("/report", json={**base, "budget_inr": 100_000, "budget_basis": "gross"}).json()
    assert g["gross_cost_inr"] <= 100_000 and g["capacity_kw"] < r["capacity_kw"]


def test_budget_covering_whole_roof_is_not_limited():
    r = client.post("/report", json={**_roof(4, 3), "budget_inr": 5_000_000}).json()
    assert not r["budget"]["limited"] and r["budget"]["spare_panels"] == []
