"""Photo + typed roof size: the marked roof is redrawn to scale, whatever the photo's pixel scale or angle."""
import base64
import math

import numpy as np
from fastapi.testclient import TestClient

from backend import geometry
from backend.app import app

client = TestClient(app)


def b64(mask):
    return base64.b64encode(np.ascontiguousarray(mask, np.uint8).tobytes()).decode()


def photo(px_per_m=20.0, squash=0.6, angle_deg=30, tank=True, size=600):
    """A 10 m x 6 m roof (with a 1 x 1 m tank) as a slanted phone photo would show it: rotated, and squashed
    along its width because the camera looks across the roof. The pixel scale is unknown to the app."""
    yy, xx = np.mgrid[0:size, 0:size] + 0.5
    a = math.radians(angle_deg)
    c = size / 2
    u = ((xx - c) * math.cos(a) + (yy - c) * math.sin(a)) / px_per_m
    v = (-(xx - c) * math.sin(a) + (yy - c) * math.cos(a)) / (px_per_m * squash)
    mask = np.zeros((size, size), np.uint8)
    mask[(abs(u) <= 5) & (abs(v) <= 3)] = 1
    if tank:
        mask[(abs(u - 2) <= 0.5) & (abs(v + 1) <= 0.5)] = 2
    return mask


def report(mask, **extra):
    body = {"width": mask.shape[1], "height": mask.shape[0], "mask_b64": b64(mask), "gsd_m": 0.1, **extra}
    r = client.post("/report", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def straight_plan(tank=True):
    """The same roof drawn straight at 0.05 m/px (what a phone scan gives)."""
    m = np.zeros((int(7.2 / 0.05), int(11.2 / 0.05)), np.uint8)
    m[12:12 + 120, 12:12 + 200] = 1
    if tank:
        m[12 + 40:12 + 60, 12 + 130:12 + 150] = 2
    return {"width": m.shape[1], "height": m.shape[0], "mask_b64": b64(m), "gsd_m": 0.05}


def test_photo_with_roof_size_matches_a_straight_plan():
    ref = client.post("/report", json=straight_plan()).json()
    for px_per_m, angle in ((20, 30), (55, -15), (8, 70)):  # any pixel scale and camera angle
        rep = report(photo(px_per_m, angle_deg=angle), roof_length_m=10, roof_width_m=6)
        assert abs(rep["areas_m2"]["roof_total"] - 60) < 4, rep["areas_m2"]  # low-res photos lose a few edge pixels
        # Same roof; the plan may come out mirrored (tank on the other side), so greedy packing can differ by a panel or two.
        assert abs(rep["panel_count"] - ref["panel_count"]) <= 2, (px_per_m, angle, rep["panel_count"], ref["panel_count"])
        assert rep["capacity_kw"] < 15


def test_without_roof_size_the_pixel_scale_is_used():
    # The old behaviour (the bug in the user's screenshot): an assumed 0.1 m/px makes this 60 m2 roof 144 m2.
    rep = report(photo(), roof_length_m=None)
    assert rep["plan"] is None and rep["areas_m2"]["roof_total"] > 120


def test_plan_payload_and_photo_panels():
    rep = report(photo(), roof_length_m=6, roof_width_m=10)  # order of length / width does not matter
    p = rep["plan"]
    assert p["gsd_m"] == 0.05 and len(p["obstructions"]) == 1
    assert len(p["photo_panels"]) == len(rep["panels"]) and len(p["photo_small_panels"]) == len(rep["small_panels"])
    # Every panel corner on the photo lies on (or right at the edge of) the marked roof.
    m = photo()
    for quad in p["photo_panels"]:
        for x, y in quad:
            xi, yi = min(int(x), m.shape[1] - 1), min(int(y), m.shape[0] - 1)
            assert m[max(yi - 2, 0):yi + 3, max(xi - 2, 0):xi + 3].any()
    o = p["obstructions"][0]
    assert abs(o["length_m"] - 1) < 0.2 and abs(o["width_m"] - 1) < 0.2 and not o["typed"]
    assert rep["assumptions"]["roof_size_m"]["value"] == "10 x 6"


def test_typed_obstruction_size_replaces_the_drawing():
    small = report(photo(), roof_length_m=10, roof_width_m=6)
    big = report(photo(), roof_length_m=10, roof_width_m=6, obstruction_sizes=[[3.0, 2.5]])
    o = big["plan"]["obstructions"][0]
    assert o["typed"] and (o["length_m"], o["width_m"]) == (3.0, 2.5)
    assert big["areas_m2"]["obstructions"] > small["areas_m2"]["obstructions"] + 5
    assert big["capacity_kw"] < small["capacity_kw"]  # fewer standard panels (small ones may fill the gaps)


def test_bad_inputs_are_rejected():
    empty = np.zeros((50, 50), np.uint8)
    body = {"width": 50, "height": 50, "mask_b64": b64(empty), "gsd_m": 0.1, "roof_length_m": 10, "roof_width_m": 6}
    assert client.post("/report", json=body).status_code == 400
    m = photo()
    base = {"width": m.shape[1], "height": m.shape[0], "mask_b64": b64(m), "gsd_m": 0.1, "roof_length_m": 10, "roof_width_m": 6}
    assert client.post("/report", json={**base, "obstruction_sizes": [[-1, 2]]}).status_code == 422
    assert client.post("/report", json={**base, "roof_length_m": 0}).status_code == 422


def test_to_metric_keeps_shape_and_size():
    plan, frame, corners = geometry.to_metric(photo(tank=False), 10, 6)
    roof = (plan != 0).sum() * 0.05 * 0.05
    assert abs(roof - 60) < 2.5
    x, y = frame.to_photo(0.6 + 5, 0.6 + 3)  # roof centre in plan metres -> photo
    assert abs(x - 300) < 3 and abs(y - 300) < 3


def trapezoid_photo(size=700):
    """A 8 m x 5 m roof photographed from one end: the far edge looks much shorter (perspective)."""
    m = np.zeros((size, size), np.uint8)
    near, far, top, bottom = (60, 640), (230, 470), 120, 620   # x-extent at the bottom (near) and top (far)
    for y in range(top, bottom):
        t = (y - top) / (bottom - top)
        x0 = far[0] + (near[0] - far[0]) * t
        x1 = far[1] + (near[1] - far[1]) * t
        m[y, int(x0):int(x1)] = 1
    return m


def test_perspective_photo_gets_the_full_roof_area():
    # Stretching the bounding box would lose the trapezoid's missing corners (the 23 m2 instead of 40 m2 seen with
    # the user's photo); the perspective transform maps the 4 roof corners onto the full 8 x 5 m rectangle.
    rep = report(trapezoid_photo(), roof_length_m=8, roof_width_m=5)
    assert abs(rep["areas_m2"]["roof_total"] - 40) < 1.5, rep["areas_m2"]
    ref = client.post("/report", json=_straight(8, 5)).json()
    assert abs(rep["panel_count"] - ref["panel_count"]) <= 1


def _straight(L, W, gsd=0.05, m=0.6):
    mask = np.zeros((int((W + 2 * m) / gsd), int((L + 2 * m) / gsd)), np.uint8)
    mask[int(m / gsd):int((m + W) / gsd), int(m / gsd):int((m + L) / gsd)] = 1
    return {"width": mask.shape[1], "height": mask.shape[0], "mask_b64": b64(mask), "gsd_m": gsd}


def test_roof_corners_are_found():
    q = geometry.roof_corners(trapezoid_photo())
    expected = np.array([[230, 120], [470, 120], [640, 620], [60, 620]])
    for p in expected:
        assert np.min(np.hypot(*(q - p).T)) < 6, (q, p)


def test_quad_from_sides():
    q = geometry.quad_from_sides(8, 5, 8, 5)                         # equal opposite sides: the rectangle
    assert np.allclose(q, [[0, 0], [8, 0], [8, 5], [0, 5]], atol=1e-9)
    q = geometry.quad_from_sides(8, 5.2, 7.5, 5)
    sides = [round(math.dist(q[i], q[(i + 1) % 4]), 6) for i in range(4)]
    assert sides == [8, 5.2, 7.5, 5]
    q = geometry.quad_from_sides(8, 5, 8, 5, diagonal=10)            # a typed diagonal fixes the shape
    assert math.isclose(math.dist(q[0], q[2]), 10)
    import pytest
    with pytest.raises(ValueError):
        geometry.quad_from_sides(10, 1, 1, 1)                        # impossible sides


def test_four_sided_roof_from_photo():
    # Roof with 4 different sides, typed as seen in the photo (top, right, bottom, left).
    rep = report(trapezoid_photo(), roof_sides_m=[8, 5.2, 7.5, 5])
    p = rep["plan"]
    assert p["roof_sides_m"] == [8, 5.2, 7.5, 5]
    expected = abs(geometry._shoelace(geometry.quad_from_sides(8, 5.2, 7.5, 5)))
    assert abs(rep["areas_m2"]["roof_total"] - expected) < 1.5, (rep["areas_m2"], expected)
    assert len(p["photo_roof_corners"]) == 4 and rep["panel_count"] > 0
    assert rep["assumptions"]["roof_size_m"]["value"].startswith("sides 8 (top) / 5.2 (right)")
    # The photo corners come back as the marked roof's corners, top-left first.
    tl = p["photo_roof_corners"][0]
    assert math.dist(tl, (230, 120)) < 8, tl


def test_four_sided_obstruction():
    rect = report(photo(), roof_length_m=10, roof_width_m=6, obstruction_sizes=[[2.0, 1.5]])
    quad = report(photo(), roof_length_m=10, roof_width_m=6, obstruction_sizes=[[2.0, 1.5, 1.2, 1.6]])
    o = quad["plan"]["obstructions"][0]
    assert o["typed"] and o["sides_m"] == [2.0, 1.5, 1.2, 1.6]
    assert quad["areas_m2"]["obstructions"] < rect["areas_m2"]["obstructions"]  # a trapezoid, smaller than 2 x 1.5


def test_bad_side_inputs_are_rejected():
    m = trapezoid_photo()
    base = {"width": m.shape[1], "height": m.shape[0], "mask_b64": b64(m), "gsd_m": 0.1}
    assert client.post("/report", json={**base, "roof_sides_m": [10, 1, 1, 1]}).status_code == 400
    assert client.post("/report", json={**base, "roof_sides_m": [8, 5, 7]}).status_code == 422
    assert client.post("/report", json={**base, "roof_sides_m": [8, 5, 8, 5], "obstruction_sizes": [[1, 2, 3]]}).status_code == 422


def two_tank_photo():
    m = trapezoid_photo()
    m[200:240, 280:330] = 2          # tank near the far (top) edge
    m[480:540, 150:230] = 2          # tank near the bottom-left
    return m


def test_obstruction_sizes_found_by_photo_position():
    m = two_tank_photo()
    plain = report(m, roof_length_m=8, roof_width_m=5)
    obs = plain["plan"]["obstructions"]
    assert len(obs) == 2
    # The page sends each painted obstruction's centre in the photo with the typed size.
    bottom_left = (190, 510)
    typed = report(m, roof_length_m=8, roof_width_m=5,
                   obstruction_inputs=[{"x": bottom_left[0], "y": bottom_left[1], "size": [1.2, 0.8, 1.0, 0.9]}])
    got = {tuple(round(c) for c in o["photo_xy"]): o for o in typed["plan"]["obstructions"]}
    near = min(got, key=lambda p: math.dist(p, bottom_left))
    far = max(got, key=lambda p: math.dist(p, bottom_left))
    assert got[near]["typed"] and got[near]["sides_m"] == [1.2, 0.8, 1.0, 0.9]
    assert not got[far]["typed"]                                   # the other tank is untouched
    # A point away from every obstruction changes nothing.
    none = report(m, roof_length_m=8, roof_width_m=5, obstruction_inputs=[{"x": 600, "y": 560, "size": [1, 1]}])
    assert not any(o["typed"] for o in none["plan"]["obstructions"])


def test_frame_round_trip():
    _, frame, corners = geometry.to_metric(trapezoid_photo(), 8, 5)
    for u, v in [(1, 1), (4.6, 3.1), (8.0, 5.2)]:
        x, y = frame.to_photo(u, v)
        assert np.allclose(frame.to_plan(x, y), (u, v), atol=1e-6)


def test_roof_cut_off_by_photo_edge_is_flagged():
    whole = report(trapezoid_photo(), roof_length_m=8, roof_width_m=5)
    assert whole["plan"]["roof_cut_off"] is False
    m = np.zeros((400, 600), np.uint8)
    m[150:400, 0:600] = 1                              # roof runs out of the bottom, left and right of the photo
    cut = report(m, roof_length_m=8, roof_width_m=5)
    assert cut["plan"]["roof_cut_off"] is True


def test_typed_roof_outline_limits_the_panels():
    # Roof paint spilling far past the typed roof must not get panels.
    m = trapezoid_photo()
    spill = m.copy()
    spill[60:120, 100:600] = 1                        # paint above the roof's top edge
    a = report(m, roof_length_m=8, roof_width_m=5)
    b = report(spill, roof_length_m=8, roof_width_m=5)
    assert b["areas_m2"]["roof_total"] <= 8 * 5 + 1.5


def test_layout_rows_and_columns_line_up():
    from backend import geometry as g
    usable = np.ones((100, 300), bool)
    usable[:, :40] = np.tri(100, 40, 0, bool)[::-1]   # slanted left edge: free packing would stagger the rows
    lay = g.layout_panels(usable, 0.05, 1.7, 1.0)
    xs = sorted({x for x, y, w, h in lay.panels})
    w = lay.panels[0][2]
    assert all((x - xs[0]) % w == 0 for x in xs)      # every column on one grid
