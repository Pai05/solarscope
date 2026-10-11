"""Fit the solar plan to the user's budget: the largest system (most Wp) the roof can hold whose cost stays
within the budget. Cost grows with capacity (net cost too: the subsidy per kW is below the cost per kW), so for
each number of standard panels the most small panels that still fit the budget is found by binary search."""
from __future__ import annotations

from typing import Callable

Panel = tuple[int, int, int, int]  # (x, y, w, h) px


def best_mix(n_std_max: int, n_small_max: int, std_wp: float, small_wp: float,
             cost_of_kw: Callable[[float], float], budget: float) -> tuple[int, int]:
    """(standard, small) panel counts with the most Wp whose cost_of_kw(kWp) <= budget; fewer panels on ties."""
    kw = lambda s, m: (s * std_wp + m * small_wp) / 1000  # noqa: E731
    best = (0, 0)
    best_key = (0.0, 0)
    for s in range(n_std_max + 1):
        if cost_of_kw(kw(s, 0)) > budget:
            break  # more standard panels only cost more
        lo, hi = 0, n_small_max  # largest m with cost <= budget
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if cost_of_kw(kw(s, mid)) <= budget:
                lo = mid
            else:
                hi = mid - 1
        key = (s * std_wp + lo * small_wp, -(s + lo))
        if key > best_key:
            best, best_key = (s, lo), key
    return best


def pick_compact(panels: list[Panel], n: int, near: tuple[float, float] | None = None) -> tuple[list[Panel], list[Panel]]:
    """(kept, spare): n panels kept together - row by row from the top-left, or nearest to `near` (x, y px)."""
    if near is None:
        order = sorted(panels, key=lambda p: (p[1], p[0]))
    else:
        cx, cy = near
        order = sorted(panels, key=lambda p: (p[0] + p[2] / 2 - cx) ** 2 + (p[1] + p[3] / 2 - cy) ** 2)
    return order[:n], order[n:]


def centre(panels: list[Panel]) -> tuple[float, float] | None:
    if not panels:
        return None
    return (sum(p[0] + p[2] / 2 for p in panels) / len(panels), sum(p[1] + p[3] / 2 for p in panels) / len(panels))
