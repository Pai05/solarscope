import math

import pytest

from backend.solar_calc import (
    DEFAULT_ASSUMPTIONS,
    annual_generation_kwh,
    annual_savings_inr,
    co2_avoided_kg,
    compute_report,
    payback_years,
    specific_yield_kwh_per_kwp,
    subsidy_inr,
)

# Tests use explicit inputs, never the placeholder defaults, so they stay valid once values are verified.
TIERS = dict(tier1_inr_per_kw=100.0, tier1_kw=2.0, tier2_inr_per_kw=50.0, tier2_kw=1.0, cap_inr=250.0)


def test_specific_yield():
    assert specific_yield_kwh_per_kwp(4.0, 0.8) == pytest.approx(4.0 * 365 * 0.8)


@pytest.mark.parametrize("pr", [0.0, -0.1, 1.5])
def test_specific_yield_rejects_bad_pr(pr):
    with pytest.raises(ValueError):
        specific_yield_kwh_per_kwp(5.0, pr)


def test_generation_and_savings():
    gen = annual_generation_kwh(3.0, 1200.0)
    assert gen == 3600.0
    assert annual_savings_inr(gen, 6.5) == pytest.approx(23400.0)


def test_generation_rejects_negative_capacity():
    with pytest.raises(ValueError):
        annual_generation_kwh(-1.0, 1200.0)


@pytest.mark.parametrize(
    "kw, expected",
    [
        (0.0, 0.0),
        (1.0, 100.0),    # inside tier 1
        (2.0, 200.0),    # tier 1 full
        (2.5, 225.0),    # half of tier 2
        (3.0, 250.0),    # both tiers full == cap
        (10.0, 250.0),   # beyond tiers, capped
    ],
)
def test_subsidy_tiers(kw, expected):
    assert subsidy_inr(kw, **TIERS) == pytest.approx(expected)


def test_subsidy_cap_binds_before_tiers():
    assert subsidy_inr(3.0, **{**TIERS, "cap_inr": 120.0}) == 120.0


def test_payback():
    assert payback_years(100000.0, 20000.0) == 5.0
    assert payback_years(-5.0, 1000.0) == 0.0
    assert math.isinf(payback_years(1000.0, 0.0))


def test_co2():
    assert co2_avoided_kg(1000.0, 0.5) == 500.0


def test_compute_report_end_to_end():
    overrides = {
        "performance_ratio": 0.8,
        "tariff_inr_per_kwh": 5.0,
        "installed_cost_inr_per_kw": 1000.0,
        "subsidy_tier1_inr_per_kw": 100.0,
        "subsidy_tier1_kw": 2.0,
        "subsidy_tier2_inr_per_kw": 50.0,
        "subsidy_tier2_kw": 1.0,
        "subsidy_cap_inr": 250.0,
        "grid_emission_kg_per_kwh": 0.5,
    }
    r = compute_report(3.0, ghi_kwh_m2_day=5.0, ghi_source="test", overrides=overrides)
    sy = 5.0 * 365 * 0.8                      # 1460
    gen = 3.0 * sy                            # 4380
    assert r["specific_yield_kwh_per_kwp"] == pytest.approx(sy)
    assert r["annual_generation_kwh"] == pytest.approx(gen)
    assert r["annual_savings_inr"] == pytest.approx(round(gen * 5.0))
    assert r["gross_cost_inr"] == 3000.0
    assert r["subsidy_inr"] == 250.0
    assert r["net_cost_inr"] == 2750.0
    assert r["payback_years"] == pytest.approx(round(2750.0 / (gen * 5.0), 1))
    assert r["co2_avoided_kg_per_year"] == pytest.approx(gen * 0.5)
    assert r["assumptions"]["ghi_kwh_m2_day"]["source"] == "test"
    assert r["assumptions"]["tariff_inr_per_kwh"]["source"] == "user override"


def test_subsidy_never_exceeds_cost():
    r = compute_report(1.0, overrides={"installed_cost_inr_per_kw": 10.0})
    assert r["subsidy_inr"] <= r["gross_cost_inr"]
    assert r["net_cost_inr"] >= 0


def test_zero_capacity_has_no_payback():
    assert compute_report(0.0)["payback_years"] is None


def test_unknown_override_rejected():
    with pytest.raises(KeyError):
        compute_report(1.0, overrides={"not_a_field": 1.0})


def test_placeholders_are_flagged():
    # Guard: until someone verifies a value against its source, the report must say so.
    unverified = [k for k, a in DEFAULT_ASSUMPTIONS.items() if not a.verified]
    if unverified:
        assert compute_report(1.0)["all_assumptions_verified"] is False
