"""Solar economics calculator for SolarScope.

Pipeline: capacity (kWp) -> yearly generation (kWh) -> savings (INR)
-> net cost after subsidy -> simple payback -> CO2 avoided.

Every number that comes from the outside world lives in DEFAULT_ASSUMPTIONS
as an `Assumption` carrying its unit, source and a `verified` flag.
Anything with verified=False is a PLACEHOLDER: check it against the named
official source, update value + source, then set verified=True.
The report echoes all assumptions so the UI can show them with sources.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, replace


@dataclass(frozen=True)
class Assumption:
    value: float
    unit: str
    source: str
    verified: bool = False


# Checked 2026-10-08. Anything with verified=False is still a placeholder. See README "Assumptions and sources".
_PMSG = ("PM Surya Ghar CFA (Cabinet approval 29 Feb 2024, pmindia.gov.in): Rs 30,000 for 1 kW, "
         "60,000 for 2 kW, 78,000 for 3 kW or more")
DEFAULT_ASSUMPTIONS: dict[str, Assumption] = {
    # Fallback only; normally replaced by NASA POWER ALLSKY_SFC_SW_DWN for the site's lat/lon.
    "ghi_kwh_m2_day": Assumption(
        5.0, "kWh/m2/day", "PLACEHOLDER fallback - NASA POWER is used when latitude/longitude are given"
    ),
    "performance_ratio": Assumption(
        0.75, "fraction", "PLACEHOLDER - typical rooftop PV range, no single official source"
    ),
    # Conservative: solar first offsets the most expensive units, so homes above 225 units/month save 8.75.
    "tariff_inr_per_kwh": Assumption(
        6.0, "INR/kWh",
        "APCPDCL (Vijayawada) LT-I Domestic, 126-225 units slab, FY 2025-26 tariff (ARR brief note); "
        "226-400 units: 8.75. APERC kept FY 2025-26 tariffs for FY 2026-27", verified=True,
    ),
    "installed_cost_inr_per_kw": Assumption(
        50000.0, "INR/kWp",
        "MNRE PM Surya Ghar benchmark, general category states: 50,000/kW up to 2 kW, 45,000/kW beyond "
        "(Feb 2024 guidelines, as reported by pv magazine India); market quotes vary", verified=True,
    ),
    # PM Surya Ghar central financial assistance: 60% of 2 kW benchmark, 40% of the 3rd kW, no CFA beyond 3 kW.
    "subsidy_tier1_inr_per_kw": Assumption(30000.0, "INR/kW (first tier1_kw)", _PMSG, verified=True),
    "subsidy_tier1_kw": Assumption(2.0, "kW", _PMSG, verified=True),
    "subsidy_tier2_inr_per_kw": Assumption(18000.0, "INR/kW (next tier2_kw)", _PMSG + " (78,000 - 60,000)", verified=True),
    "subsidy_tier2_kw": Assumption(1.0, "kW", _PMSG, verified=True),
    "subsidy_cap_inr": Assumption(78000.0, "INR", _PMSG, verified=True),
    "grid_emission_kg_per_kwh": Assumption(
        0.675, "kgCO2/kWh",
        "CEA CO2 Baseline Database v22.0 (Aug 2026), Table 4: weighted average, Indian grid, FY 2025-26, "
        "incl. cross-border transfers", verified=True,
    ),
}


def specific_yield_kwh_per_kwp(ghi_kwh_m2_day: float, performance_ratio: float) -> float:
    """Yearly kWh per kWp. At STC 1 kWp yields 1 kWh per 1 kWh/m2 of irradiance."""
    if ghi_kwh_m2_day < 0:
        raise ValueError("ghi_kwh_m2_day must be >= 0")
    if not 0 < performance_ratio <= 1:
        raise ValueError("performance_ratio must be in (0, 1]")
    return ghi_kwh_m2_day * 365 * performance_ratio


def annual_generation_kwh(capacity_kw: float, specific_yield: float) -> float:
    if capacity_kw < 0:
        raise ValueError("capacity_kw must be >= 0")
    return capacity_kw * specific_yield


def annual_savings_inr(generation_kwh: float, tariff_inr_per_kwh: float) -> float:
    return generation_kwh * tariff_inr_per_kwh


def subsidy_inr(
    capacity_kw: float,
    tier1_inr_per_kw: float,
    tier1_kw: float,
    tier2_inr_per_kw: float,
    tier2_kw: float,
    cap_inr: float,
) -> float:
    """Tiered per-kW subsidy: tier1 rate on the first tier1_kw, tier2 rate on the next tier2_kw, capped."""
    if capacity_kw < 0:
        raise ValueError("capacity_kw must be >= 0")
    kw1 = min(capacity_kw, tier1_kw)
    kw2 = min(max(capacity_kw - tier1_kw, 0.0), tier2_kw)
    return min(kw1 * tier1_inr_per_kw + kw2 * tier2_inr_per_kw, cap_inr)


def payback_years(net_cost_inr: float, annual_savings: float) -> float:
    """Simple payback (no degradation, no tariff escalation). inf if there are no savings."""
    if annual_savings <= 0:
        return math.inf
    return max(net_cost_inr, 0.0) / annual_savings


def co2_avoided_kg(generation_kwh: float, emission_kg_per_kwh: float) -> float:
    return generation_kwh * emission_kg_per_kwh


def compute_report(
    capacity_kw: float,
    ghi_kwh_m2_day: float | None = None,
    ghi_source: str | None = None,
    overrides: dict[str, float] | None = None,
) -> dict:
    """Full economics report. `ghi_kwh_m2_day` (e.g. from NASA POWER) overrides the fallback;
    `overrides` replaces any other assumption value (marked as user-supplied)."""
    a = dict(DEFAULT_ASSUMPTIONS)
    for key, value in (overrides or {}).items():
        if key not in a:
            raise KeyError(f"unknown assumption: {key}")
        a[key] = replace(a[key], value=float(value), source="user override", verified=False)
    if ghi_kwh_m2_day is not None:
        a["ghi_kwh_m2_day"] = replace(
            a["ghi_kwh_m2_day"], value=ghi_kwh_m2_day, source=ghi_source or "site irradiance", verified=True
        )

    v = {k: x.value for k, x in a.items()}
    sy = specific_yield_kwh_per_kwp(v["ghi_kwh_m2_day"], v["performance_ratio"])
    gen = annual_generation_kwh(capacity_kw, sy)
    savings = annual_savings_inr(gen, v["tariff_inr_per_kwh"])
    gross_cost = capacity_kw * v["installed_cost_inr_per_kw"]
    subsidy = min(
        subsidy_inr(
            capacity_kw,
            v["subsidy_tier1_inr_per_kw"],
            v["subsidy_tier1_kw"],
            v["subsidy_tier2_inr_per_kw"],
            v["subsidy_tier2_kw"],
            v["subsidy_cap_inr"],
        ),
        gross_cost,
    )
    net_cost = gross_cost - subsidy
    payback = payback_years(net_cost, savings)

    return {
        "capacity_kw": round(capacity_kw, 3),
        "specific_yield_kwh_per_kwp": round(sy, 1),
        "annual_generation_kwh": round(gen, 1),
        "annual_savings_inr": round(savings, 0),
        "gross_cost_inr": round(gross_cost, 0),
        "subsidy_inr": round(subsidy, 0),
        "net_cost_inr": round(net_cost, 0),
        "payback_years": None if math.isinf(payback) else round(payback, 1),
        "co2_avoided_kg_per_year": round(co2_avoided_kg(gen, v["grid_emission_kg_per_kwh"]), 1),
        "all_assumptions_verified": all(x.verified for x in a.values()),
        "assumptions": {k: asdict(x) for k, x in a.items()},
    }
