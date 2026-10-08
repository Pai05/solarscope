import math

import numpy as np
import pytest

from backend.geometry import (
    OBSTRUCTION,
    ROOF,
    area_m2,
    gsd_from_calibration,
    gsd_from_web_mercator,
    layout_panels,
    select_roof,
    usable_area_mask,
)


def roof(h, w, pad=0):
    m = np.zeros((h + 2 * pad, w + 2 * pad), np.uint8)
    m[pad:pad + h, pad:pad + w] = ROOF
    return m


# --- scale ---

def test_calibration():
    assert gsd_from_calibration(120, 1.2) == pytest.approx(0.01)
    with pytest.raises(ValueError):
        gsd_from_calibration(0, 1.0)


def test_web_mercator_equator_zoom0():
    assert gsd_from_web_mercator(0, 0.0) == pytest.approx(156543.03, rel=1e-6)


def test_web_mercator_shrinks_with_latitude_and_zoom():
    g = gsd_from_web_mercator(19, 0.0)
    assert gsd_from_web_mercator(19, 60.0) == pytest.approx(g * 0.5, rel=1e-9)
    assert gsd_from_web_mercator(20, 0.0) == pytest.approx(g / 2)


def test_area():
    assert area_m2(10_000, 0.1) == pytest.approx(100.0)


# --- masks ---

def test_mask_area_counts_classes():
    m = roof(100, 100)
    m[10:20, 10:20] = OBSTRUCTION
    assert area_m2(int((m == ROOF).sum()), 0.1) == pytest.approx(99.0)
    assert area_m2(int((m == OBSTRUCTION).sum()), 0.1) == pytest.approx(1.0)


def test_setback_shrinks_each_side():
    m = roof(100, 100, pad=10)  # 10 m x 10 m roof at 0.1 m/px
    u = usable_area_mask(m, 0.1, setback_m=1.0, obstruction_buffer_m=0)
    side = math.isqrt(int(u.sum()))
    assert 79 <= side <= 81  # ~8 m x 8 m left


def test_zero_setback_keeps_roof():
    m = roof(50, 50, pad=5)
    u = usable_area_mask(m, 0.1, 0.0, 0.0)
    assert u.sum() == 50 * 50


def test_image_border_counts_as_edge():
    u = usable_area_mask(roof(100, 100), 0.1, 1.0, 0.0)
    assert not u[:10].any() and not u[:, :10].any()


def test_obstruction_and_buffer_removed():
    m = roof(200, 200, pad=0)
    m[90:110, 90:110] = OBSTRUCTION  # 2 m tank in the middle
    u = usable_area_mask(m, 0.1, 0.0, obstruction_buffer_m=0.5)
    assert not u[90:110, 90:110].any()
    assert not u[85:90, 100].any()           # within 0.5 m buffer
    assert u[80, 100]                         # 1 m away: usable


def test_obstruction_inside_roof_does_not_create_setback():
    # Obstruction is part of the roof outline, so the edge setback must not apply around it.
    m = roof(200, 200, pad=5)
    m[100:110, 100:110] = OBSTRUCTION
    u = usable_area_mask(m, 0.1, setback_m=1.0, obstruction_buffer_m=0.0)
    assert u[99, 105]


def test_select_roof_keeps_clicked_building():
    m = np.zeros((50, 100), np.uint8)
    m[10:40, 5:40] = ROOF
    m[15:20, 10:15] = OBSTRUCTION
    m[10:40, 60:95] = ROOF
    sel = select_roof(m, (20, 25))
    assert (sel[:, 60:] == 0).all()
    assert (sel[15:20, 10:15] == OBSTRUCTION).all()
    assert select_roof(m, (50, 5)) is m  # background click: unchanged
    assert select_roof(m, None) is m


# --- panel layout ---

def test_layout_exact_fit():
    usable = np.ones((44, 100), bool)  # 4.4 m x 10 m at 0.1 m/px, panel 2.0 x 1.1 m
    lay = layout_panels(usable, 0.1, 2.0, 1.1)
    assert lay.count == 20  # portrait 1.1 wide x 2.0 tall: 9 x 2 = 18; landscape 5 x 4 = 20
    assert lay.landscape


def test_layout_prefers_better_orientation():
    usable = np.ones((20, 110), bool)  # 2.0 m tall strip: only portrait fits
    lay = layout_panels(usable, 0.1, 2.0, 1.1)
    assert lay.count == 10 and not lay.landscape


def test_panels_never_overlap_or_leave_usable_area():
    rng = np.random.default_rng(0)
    usable = np.ones((300, 300), bool)
    for _ in range(15):
        y, x = rng.integers(0, 280, 2)
        usable[y:y + 20, x:x + 20] = False
    lay = layout_panels(usable, 0.1, 2.0, 1.1)
    cover = np.zeros(usable.shape, int)
    for x, y, w, h in lay.panels:
        cover[y:y + h, x:x + w] += 1
    assert cover.max() == 1
    assert not (cover.astype(bool) & ~usable).any()
    assert lay.count > 0


def test_layout_too_small():
    assert layout_panels(np.ones((5, 5), bool), 0.1, 2.0, 1.1).count == 0


def test_layout_rejects_bad_input():
    with pytest.raises(ValueError):
        layout_panels(np.ones((5, 5), bool), 0.0, 2.0, 1.1)
