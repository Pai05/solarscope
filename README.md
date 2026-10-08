# SolarScope

Estimate rooftop solar potential from aerial/drone rooftop images, built for cluttered Indian rooftops.
A segmentation model separates **usable roof** from **obstructions** (water tanks, stairwell headrooms, AC units, dishes).
The usable area, minus an edge setback, is filled with panel rectangles, which gives capacity (kWp), yearly generation (kWh),
savings (INR), payback after subsidy and CO2 avoided.

Built for Environmental Hacks (WeMakeDevs x AWS), track: Waste and Energy (Rooftop solar).

> Work in progress. Phase 1: foundation.

## Run tests (Windows PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
pytest -v
```

## Assumptions to verify

All economic inputs live in `backend/solar_calc.py` (`DEFAULT_ASSUMPTIONS`). **None are verified yet.**
Each one is shown in the report with its source and a `verified` flag.

| Key | Placeholder | Source to check |
|---|---|---|
| `ghi_kwh_m2_day` | 5.0 kWh/m2/day (fallback) | NASA POWER, per site lat/lon |
| `performance_ratio` | 0.75 | Cite a published PR reference |
| `tariff_inr_per_kwh` | 7.0 | State DISCOM residential tariff order |
| `installed_cost_inr_per_kw` | 60,000 | MNRE / PM Surya Ghar benchmark cost |
| `subsidy_tier1_*`, `subsidy_tier2_*`, `subsidy_cap_inr` | 30,000/kW x 2 kW, 18,000/kW x 1 kW, cap 78,000 | pmsuryaghar.gov.in (current guidelines) |
| `grid_emission_kg_per_kwh` | 0.71 | CEA CO2 Baseline Database (latest version) |

## AI tools used

Claude (Claude Code) was used as a pair programmer.

## License

MIT, see `LICENSE`. Third-party credits in `CREDITS.md`.
