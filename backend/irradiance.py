"""Site irradiance from the NASA POWER climatology API, with an in-memory cache.

Returns None on any failure; the caller then falls back to the flagged placeholder
in solar_calc.DEFAULT_ASSUMPTIONS, and the report says so.
"""

from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

POWER_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
_cache: dict[tuple[float, float], tuple[float, str]] = {}


def annual_ghi(lat: float, lon: float, timeout_s: float = 10.0) -> tuple[float, str] | None:
    """Long-term mean all-sky surface shortwave irradiance (kWh/m2/day) and a source string."""
    key = (round(lat, 2), round(lon, 2))
    if key in _cache:
        return _cache[key]
    query = urllib.parse.urlencode({
        "parameters": "ALLSKY_SFC_SW_DWN",
        "community": "RE",
        "latitude": key[0],
        "longitude": key[1],
        "format": "JSON",
    })
    try:
        with urllib.request.urlopen(f"{POWER_URL}?{query}", timeout=timeout_s) as r:
            data = json.load(r)
        value = float(data["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]["ANN"])
    except Exception as e:  # network, HTTP or format error: fall back, never fail the report
        log.warning("NASA POWER lookup failed for %s: %s", key, e)
        return None
    if value <= 0:  # POWER uses -999 for missing data
        return None
    result = (value, f"NASA POWER climatology, ALLSKY_SFC_SW_DWN annual mean at {key[0]}, {key[1]}")
    _cache[key] = result
    return result
