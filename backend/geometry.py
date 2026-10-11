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

def crop_to_box(mask: np.ndarray, box: tuple[int, int, int, int] | None) -> np.ndarray:
    """Set everything outside box (x0, y0, x1, y1) to background. Used when neighbouring
    roofs touch and cannot be separated by connectivity."""
    if box is None:
        return mask
    h, w = mask.shape
    x0, x1 = sorted((max(0, min(w, box[0])), max(0, min(w, box[2]))))
    y0, y1 = sorted((max(0, min(h, box[1])), max(0, min(h, box[3]))))
    out = np.zeros_like(mask)
    out[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    return out


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


def _pack_rows_adaptive(integral: np.ndarray, pw: int, ph: int) -> list[tuple[int, int, int, int]]:
    """Like _pack_rows, but each row starts at the first pixel row where a panel fits, instead of on a
    fixed grid. A usable strip only slightly taller than a panel is missed by every grid offset unless
    its edge happens to line up; this pass finds it wherever it is."""
    H = integral.shape[0] - 1
    full = pw * ph
    placed = []
    y = 0
    while y <= H - ph:
        s = (integral[y + ph, pw:] - integral[y, pw:] - integral[y + ph, :-pw] + integral[y, :-pw])
        candidates = np.flatnonzero(s == full)
        if not candidates.size:
            y += 1
            continue
        next_free = 0
        for x in candidates:
            if x >= next_free:
                placed.append((int(x), y, pw, ph))
                next_free = x + pw
        y += ph
    return placed


# --- photo -> to-scale plan (user-given roof length and width) -------------------------------------------

@dataclass(frozen=True)
class MetricFrame:
    """Maps the to-scale plan back to the photo: plan metres (u along the roof length, v across it, measured from
    the plan's top-left corner) -> photo pixel, through a perspective transform (homography)."""
    H: tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]

    def to_photo(self, u: float, v: float) -> tuple[float, float]:
        h = self.H
        w = h[2][0] * u + h[2][1] * v + h[2][2]
        return ((h[0][0] * u + h[0][1] * v + h[0][2]) / w, (h[1][0] * u + h[1][1] * v + h[1][2]) / w)

    def to_plan(self, x: float, y: float) -> tuple[float, float]:
        """Photo pixel -> plan metres (inverse of to_photo)."""
        h = np.linalg.inv(np.array(self.H))
        w = h[2, 0] * x + h[2, 1] * y + h[2, 2]
        return (float((h[0, 0] * x + h[0, 1] * y + h[0, 2]) / w), float((h[1, 0] * x + h[1, 1] * y + h[1, 2]) / w))


def _convex_hull(points: np.ndarray) -> np.ndarray:
    """Convex hull (Andrew's monotone chain), collinear points dropped."""
    pts = np.unique(points.astype(float), axis=0)
    if len(pts) < 3:
        return pts

    def half(seq):
        out: list = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def _simplify_closed(poly: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker for a closed polygon: keeps the corners, drops the pixel staircase between them."""
    def dp(seq):
        a, b = seq[0], seq[-1]
        ab = b - a
        n = math.hypot(*ab) or 1.0
        d = np.abs(ab[0] * (seq[:, 1] - a[1]) - ab[1] * (seq[:, 0] - a[0])) / n
        i = int(np.argmax(d))
        if d[i] <= tol or len(seq) < 3:
            return [a]
        return dp(seq[: i + 1]) + dp(seq[i:])

    far = int(np.argmax(np.hypot(*(poly - poly[0]).T)))
    ring = np.vstack([poly, poly[:1]])
    return np.array(dp(ring[: far + 1]) + dp(ring[far:]))


def _largest_quad(poly: np.ndarray) -> np.ndarray | None:
    """The four vertices of a convex polygon enclosing the largest area: the roof's corners."""
    n = len(poly)
    if n < 4:
        return None
    if n == 4:
        return poly

    def tri(a, b, c):  # areas of triangles a-b-c for arrays of b
        return np.abs((b[..., 0] - a[0]) * (c[1] - a[1]) - (b[..., 1] - a[1]) * (c[0] - a[0])) / 2

    best, quad = -1.0, None
    for i in range(n):
        for k in range(i + 2, n):
            js = np.arange(i + 1, k)
            ls = np.arange(k + 1, i + n) % n
            if not len(js) or not len(ls):
                continue
            t1, t2 = tri(poly[i], poly[js], poly[k]), tri(poly[k], poly[ls], poly[i])
            area = t1.max() + t2.max()
            if area > best:
                best, quad = area, poly[[i, js[int(np.argmax(t1))], k, ls[int(np.argmax(t2))]]]
    return quad


def _homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """3x3 perspective transform taking the 4 src points to the 4 dst points."""
    a, b = [], []
    for (x, y), (X, Y) in zip(src, dst):
        a += [[x, y, 1, 0, 0, 0, -X * x, -X * y], [0, 0, 0, x, y, 1, -Y * x, -Y * y]]
        b += [X, Y]
    return np.append(np.linalg.solve(np.array(a, float), np.array(b, float)), 1.0).reshape(3, 3)


def _shoelace(q: np.ndarray) -> float:
    return float(np.sum(q[:, 0] * np.roll(q[:, 1], -1) - np.roll(q[:, 0], -1) * q[:, 1]) / 2)


def roof_corners(mask: np.ndarray, by_long_side: bool = True) -> np.ndarray:
    """The marked roof's 4 corners in the photo (px), clockwise on screen. by_long_side: corner 0->1 and 2->3 are
    the long sides; otherwise corner 0 is the top-left one, so sides 0..3 are top, right, bottom, left as seen."""
    roof = mask != BACKGROUND
    if roof.sum() < 3:
        raise ValueError("no roof marked")
    edge = roof & ~ndimage.binary_erosion(roof)
    ys, xs = np.nonzero(edge)
    pts = np.concatenate([np.stack([xs + dx, ys + dy], 1) for dx in (0, 1) for dy in (0, 1)])  # pixel corners
    hull = _convex_hull(pts)
    diag = math.hypot(*(hull.max(0) - hull.min(0)))
    quad = _largest_quad(_simplify_closed(hull, max(1.0, 0.01 * diag)))
    if quad is None or abs(_shoelace(quad)) < 4:
        raise ValueError("roof marking too small")
    if _shoelace(quad) < 0:   # clockwise on screen (y down), like the plan
        quad = quad[::-1]
    if by_long_side:
        side = [math.dist(quad[i], quad[(i + 1) % 4]) for i in range(4)]
        if side[0] + side[2] < side[1] + side[3]:
            quad = np.roll(quad, -1, axis=0)
        if quad[2].sum() < quad[0].sum():  # keep the plan the same way up as the photo
            quad = np.roll(quad, -2, axis=0)
    else:
        quad = np.roll(quad, -int(np.argmin(quad.sum(1))), axis=0)  # start at the top-left corner
    return quad


def quad_from_sides(top: float, right: float, bottom: float, left: float, diagonal: float | None = None) -> np.ndarray:
    """Corners (metres; top-left, top-right, bottom-right, bottom-left; y down) of a 4-sided shape with these sides.
    Four sides alone allow many shapes; `diagonal` (top-left to bottom-right corner) fixes it. Without it the
    most regular one is used: the shape with the largest area, whose corners lie on a circle (for equal opposite
    sides that is the rectangle)."""
    a, b, c, d = top, right, bottom, left
    if diagonal is None:
        diagonal = math.sqrt((a * c + b * d) * (a * d + b * c) / (a * b + c * d))
    e = diagonal

    def ok(x, y, z):
        return x + y > z * 1.0001 and x + z > y * 1.0001 and y + z > x * 1.0001

    if not (ok(a, b, e) and ok(c, d, e)):
        raise ValueError("these side lengths (and diagonal) cannot form a roof shape")
    p0, p1 = np.array([0.0, 0.0]), np.array([a, 0.0])
    x = (e * e - b * b + a * a) / (2 * a)
    p2 = np.array([x, math.sqrt(max(e * e - x * x, 0.0))])          # below the top side
    # p3: distance d from p0 and c from p2, on the other side of the diagonal p0-p2 than p1.
    u = p2 / e
    n = np.array([-u[1], u[0]])
    t = (e * e - c * c + d * d) / (2 * e)
    h = math.sqrt(max(d * d - t * t, 0.0))
    p3 = t * u + h * n
    side = lambda p: p2[0] * p[1] - p2[1] * p[0]  # noqa: E731  (which side of the diagonal p0-p2)
    if side(p1) * side(p3) > 0:
        p3 = t * u - h * n
    return np.array([p0, p1, p2, p3])


def _polygon_mask(shape: tuple[int, int], poly_px: np.ndarray) -> np.ndarray:
    """Pixels (centres) inside a convex or simple polygon given in pixel units."""
    H, W = shape
    x0, y0 = np.floor(poly_px.min(0)).astype(int)
    x1, y1 = np.ceil(poly_px.max(0)).astype(int)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    out = np.zeros(shape, bool)
    if x1 <= x0 or y1 <= y0:
        return out
    yy, xx = np.mgrid[y0:y1, x0:x1] + 0.5
    inside = np.zeros(xx.shape, bool)
    n = len(poly_px)
    for i in range(n):                                    # even-odd ray casting
        (xa, ya), (xb, yb) = poly_px[i], poly_px[(i + 1) % n]
        crosses = (ya > yy) != (yb > yy)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = xa + (yy - ya) * (xb - xa) / (yb - ya)
        inside ^= crosses & (xx < xint)
    out[y0:y1, x0:x1] = inside
    return out


def to_metric(mask: np.ndarray, length_m: float | None = None, width_m: float | None = None, gsd_m: float = 0.05,
              margin_m: float = 0.6, sides_m: tuple[float, float, float, float] | None = None,
              diagonal_m: float | None = None) -> tuple[np.ndarray, MetricFrame, np.ndarray]:
    """Redraw the marked roof (and its obstructions) to scale. The roof's 4 corners in the photo are mapped by a
    perspective transform onto the real roof shape: a length x width rectangle, or the 4-sided shape given by
    `sides_m` (top, right, bottom, left as seen in the photo; optional `diagonal_m` top-left to bottom-right). This
    undoes both the camera angle and the near-far shrinking of a phone photo. Returns the plan mask (gsd_m metres
    per px), the map back to the photo and the roof's 4 corners in plan metres."""
    if sides_m:
        shape = quad_from_sides(*sides_m, diagonal=diagonal_m)
        quad = roof_corners(mask, by_long_side=False)
    else:
        L, W = max(length_m, width_m), min(length_m, width_m)
        shape = np.array([[0, 0], [L, 0], [L, W], [0, W]], float)
        quad = roof_corners(mask)
    m = margin_m
    shape = shape - shape.min(0) + m
    H = _homography(shape, quad)  # plan metres -> photo px
    extent = shape.max(0) + m
    Wpx, Hpx = int(math.ceil(extent[0] / gsd_m)), int(math.ceil(extent[1] / gsd_m))
    u, v = np.meshgrid((np.arange(Wpx) + 0.5) * gsd_m, (np.arange(Hpx) + 0.5) * gsd_m)
    w = H[2, 0] * u + H[2, 1] * v + H[2, 2]
    X = (H[0, 0] * u + H[0, 1] * v + H[0, 2]) / w
    Y = (H[1, 0] * u + H[1, 1] * v + H[1, 2]) / w
    xi, yi = np.floor(X).astype(int), np.floor(Y).astype(int)
    inside = (w > 0) & (xi >= 0) & (yi >= 0) & (xi < mask.shape[1]) & (yi < mask.shape[0])
    out = np.zeros((Hpx, Wpx), np.uint8)
    out[inside] = mask[yi[inside], xi[inside]]
    # The typed size is the roof: paint that spills past its 4 corners (wall, sky, neighbour's roof) is not roof.
    out[~_polygon_mask(out.shape, shape / gsd_m)] = BACKGROUND
    return out, MetricFrame(tuple(tuple(float(x) for x in row) for row in H)), shape


def obstruction_list(mask: np.ndarray, gsd_m: float) -> list[dict]:
    """Obstructions in a to-scale plan, largest first: {id, length_m, width_m, cx, cy} (cx, cy in plan px)."""
    labels, n = ndimage.label(mask == OBSTRUCTION)
    out = []
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        if sl is None:
            continue
        ys, xs = np.nonzero(labels[sl] == i)
        out.append({"label": i, "area": int(xs.size),
                    "length_m": round((sl[1].stop - sl[1].start) * gsd_m, 2),
                    "width_m": round((sl[0].stop - sl[0].start) * gsd_m, 2),
                    "cx": float(xs.mean() + sl[1].start), "cy": float(ys.mean() + sl[0].start)})
    out = [o for o in out if o["area"] * gsd_m * gsd_m >= 0.04]  # ignore brush specks under 0.2 x 0.2 m
    out.sort(key=lambda o: -o["area"])
    for k, o in enumerate(out):
        o["id"] = k
    return out


def obstruction_shape(size: tuple[float, ...]) -> np.ndarray:
    """Corners (metres, centred on 0) of a typed obstruction: (length, width) rectangle, or (top, right, bottom,
    left) 4-sided shape."""
    if len(size) == 2:
        shape = np.array([[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]], float)
    else:
        shape = quad_from_sides(*size[:4])
    return shape - shape.mean(0)


def resize_obstructions(mask: np.ndarray, gsd_m: float, sizes: list[tuple[float, ...] | None]) -> np.ndarray:
    """Replace each drawn obstruction (order of obstruction_list) whose size the user typed with that shape (length
    or top side along the roof) at the same place; the drawn shape becomes roof again."""
    if not sizes:
        return mask
    out = mask.copy()
    labels, _ = ndimage.label(mask == OBSTRUCTION)
    roof = mask != BACKGROUND
    for o, size in zip(obstruction_list(mask, gsd_m), sizes):
        if not size:
            continue
        out[labels == o["label"]] = ROOF
        poly = obstruction_shape(size) / gsd_m + np.array([o["cx"], o["cy"]]) + 0.5
        out[_polygon_mask(mask.shape, poly) & roof] = OBSTRUCTION  # an obstruction can only be on the roof
    return out


def fill_gaps(usable: np.ndarray, placed: list[tuple[int, int, int, int]], gsd_m: float,
              panel_w_m: float, panel_h_m: float) -> Layout:
    """Second pass: pack (smaller) panels into the usable pixels the first layout left empty."""
    free = usable.copy()
    for x, y, w, h in placed:
        free[y:y + h, x:x + w] = False
    return layout_panels(free, gsd_m, panel_w_m, panel_h_m)


def layout_panels(usable: np.ndarray, gsd_m: float, panel_w_m: float, panel_h_m: float, offsets: int = 4) -> Layout:
    """Fill the usable mask with axis-aligned panel rectangles. Tries both orientations, a few fixed
    row offsets and rows that start wherever a panel first fits; keeps the layout with the most panels.
    Panel size is rounded up to whole pixels."""
    if panel_w_m <= 0 or panel_h_m <= 0 or gsd_m <= 0:
        raise ValueError("panel size and gsd must be > 0")
    a = math.ceil(panel_w_m / gsd_m - 1e-9)
    b = math.ceil(panel_h_m / gsd_m - 1e-9)
    integral = np.pad(usable.astype(np.int64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    free = Layout([], landscape=True)   # most panels, each row packed on its own (columns may be staggered)
    grid = Layout([], landscape=True)   # most panels on one regular grid: rows and columns line up
    H, W = usable.shape
    for pw, ph, landscape in ((max(a, b), min(a, b), True), (min(a, b), max(a, b), False)):
        if pw > W or ph > H:
            continue
        tries = [_pack_rows(integral, pw, ph, (k * ph) // offsets) for k in range(offsets)]
        tries.append(_pack_rows_adaptive(integral, pw, ph))
        for panels in tries:
            if len(panels) > free.count:
                free = Layout(panels, landscape)
        for panels in _pack_grids(integral, pw, ph):
            if len(panels) > grid.count:
                grid = Layout(panels, landscape)
    # Real arrays sit on straight mounting rails, so prefer the tidy grid unless it costs more than 10 %.
    return grid if grid.count >= free.count - int(free.count * GRID_TOLERANCE) else free


GRID_TOLERANCE = 0.10  # share of panels a neat, rail-aligned layout may give up against free packing


def _pack_grids(integral: np.ndarray, pw: int, ph: int, steps: int = 8):
    """Layouts on a regular grid (columns every pw, rows every ph) for several grid offsets. The grid flush with
    the usable area's top-left edge comes first (it wins ties): leftover space then forms one strip on the far
    side, wide enough for small panels, instead of two thin strips that fit nothing."""
    H, W = integral.shape[0] - 1, integral.shape[1] - 1
    full = pw * ph
    col_used = np.flatnonzero(np.diff(integral[-1, :]))   # columns with any usable pixel
    row_used = np.flatnonzero(np.diff(integral[:, -1]))
    if not col_used.size:
        return
    flush_x, flush_y = int(col_used[0]) % pw, int(row_used[0]) % ph
    dys = [flush_y] + [d for d in sorted({(k * ph) // steps for k in range(steps)}) if d != flush_y]
    dxs = [flush_x] + [d for d in sorted({(k * pw) // steps for k in range(steps)}) if d != flush_x]
    for dy in dys:
        rows = np.arange(dy, H - ph + 1, ph)
        if not rows.size:
            continue
        for dx in dxs:
            cols = np.arange(dx, W - pw + 1, pw)
            if not cols.size:
                continue
            y, x = rows[:, None], cols[None, :]
            s = integral[y + ph, x + pw] - integral[y, x + pw] - integral[y + ph, x] + integral[y, x]
            yy, xx = np.nonzero(s == full)
            yield [(int(cols[j]), int(rows[i]), pw, ph) for i, j in zip(yy, xx)]
