"""Mask geometry: scale, areas, roof selection, setback, obstruction buffer and panel layout.

Mask classes: 0 background, 1 usable roof, 2 obstruction. Obstructions sit on top of a roof,
so the roof outline is (mask == 1) | (mask == 2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

BACKGROUND, ROOF, OBSTRUCTION = 0, 1, 2
EARTH_CIRCUMFERENCE_M = 40_075_016.686


# --- scale -----------------------------------------------------------------------------------

def gsd_from_calibration(pixel_length: float, real_length_m: float) -> float:
    """Metres per pixel from a user-drawn line of known real length."""
    if pixel_length <= 0 or real_length_m <= 0:
        raise ValueError("lengths must be > 0")
    return real_length_m / pixel_length


def gsd_from_web_mercator(zoom: int, lat_deg: float, tile_size: int = 256) -> float:
    """Ground metres per pixel of a Web Mercator (slippy map) tile at a zoom level and latitude."""
    return EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat_deg)) / (tile_size * 2**zoom)


def area_m2(pixel_count: int, gsd_m: float) -> float:
    return pixel_count * gsd_m**2


# --- masks -----------------------------------------------------------------------------------

def select_roof(mask: np.ndarray, point_xy: tuple[int, int] | None) -> np.ndarray:
    """Keep only the building whose roof contains point (x, y); everything else becomes background.
    No point, or a point off any roof: mask returned unchanged."""
    if point_xy is None:
        return mask
    x, y = point_xy
    h, w = mask.shape
    if not (0 <= x < w and 0 <= y < h):
        return mask
    labels, _ = ndimage.label(mask != BACKGROUND)
    lab = labels[y, x]
    if lab == 0:
        return mask
    return np.where(labels == lab, mask, BACKGROUND).astype(mask.dtype)


def usable_area_mask(mask: np.ndarray, gsd_m: float, setback_m: float, obstruction_buffer_m: float) -> np.ndarray:
    """Pixels where panels may go: roof, at least `setback_m` from the roof edge and
    `obstruction_buffer_m` from any obstruction. Image borders count as roof edges (conservative)."""
    roof_outline = np.pad(mask != BACKGROUND, 1)
    dist_to_edge = ndimage.distance_transform_edt(roof_outline)[1:-1, 1:-1] * gsd_m
    usable = (mask == ROOF) & (dist_to_edge > setback_m)
    obstruction = mask == OBSTRUCTION
    if obstruction.any() and obstruction_buffer_m > 0:
        dist_to_obs = ndimage.distance_transform_edt(~obstruction) * gsd_m
        usable &= dist_to_obs > obstruction_buffer_m
    return usable


# --- panel layout ----------------------------------------------------------------------------

@dataclass(frozen=True)
class Layout:
    panels: list[tuple[int, int, int, int]]  # (x, y, w, h) in pixels
    landscape: bool

    @property
    def count(self) -> int:
        return len(self.panels)


def _pack_rows(integral: np.ndarray, pw: int, ph: int, y0: int) -> list[tuple[int, int, int, int]]:
    """Greedy left-to-right packing in rows of height ph starting at y0."""
    H, W = integral.shape[0] - 1, integral.shape[1] - 1
    full = pw * ph
    placed = []
    for y in range(y0, H - ph + 1, ph):
        # Sum of each pw x ph window in this row band, for every x.
        s = (integral[y + ph, pw:] - integral[y, pw:] - integral[y + ph, :-pw] + integral[y, :-pw])
        candidates = np.flatnonzero(s == full)
        next_free = 0
        for x in candidates:
            if x >= next_free:
                placed.append((int(x), y, pw, ph))
                next_free = x + pw
    return placed


def layout_panels(usable: np.ndarray, gsd_m: float, panel_w_m: float, panel_h_m: float, offsets: int = 4) -> Layout:
    """Fill the usable mask with axis-aligned panel rectangles. Tries both orientations and a few
    row offsets, keeps the layout with the most panels. Panel size is rounded up to whole pixels."""
    if panel_w_m <= 0 or panel_h_m <= 0 or gsd_m <= 0:
        raise ValueError("panel size and gsd must be > 0")
    a = math.ceil(panel_w_m / gsd_m - 1e-9)
    b = math.ceil(panel_h_m / gsd_m - 1e-9)
    integral = np.pad(usable.astype(np.int64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    best = Layout([], landscape=True)
    H, W = usable.shape
    for pw, ph, landscape in ((max(a, b), min(a, b), True), (min(a, b), max(a, b), False)):
        if pw > W or ph > H:
            continue
        for k in range(offsets):
            y0 = (k * ph) // offsets
            panels = _pack_rows(integral, pw, ph, y0)
            if len(panels) > best.count:
                best = Layout(panels, landscape)
    return best
