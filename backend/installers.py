"""Installer directory for SolarScope: loads backend/data/installers.json and filters it, plus the list of
Indian states/UTs and their cities (backend/data/india_locations.json) for the State / City filters.

The shipped installers are copied from official empanelled-vendor lists by scripts/import_official_vendors.py
(each entry names its source). See README "Find solar installers near me".
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "installers.json"
LOCATIONS_FILE = Path(__file__).resolve().parent / "data" / "india_locations.json"

REQUIRED = ("id", "company_name", "state", "lat", "lon", "service_areas", "services", "certifications",
            "last_verified")
# May be missing or null: official vendor lists do not publish all of these.
OPTIONAL_TEXT = ("contact_person", "phone", "email", "website", "address", "city", "pincode")
OPTIONAL_NUM = ("years_experience", "min_kwp", "max_kwp")

log = logging.getLogger("solarscope.installers")


class InstallerDataError(Exception):
    """The installer file is missing or unreadable."""


def _num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _valid(entry: object) -> bool:
    """Required fields present, optional ones null or the right type, and a way to contact them."""
    if not isinstance(entry, dict) or any(k not in entry for k in REQUIRED):
        return False
    if any(entry.get(k) is not None and not isinstance(entry[k], str) for k in OPTIONAL_TEXT):
        return False
    if any(entry.get(k) is not None and not _num(entry[k]) for k in OPTIONAL_NUM):
        return False
    lo, hi, lat, lon = entry.get("min_kwp"), entry.get("max_kwp"), entry["lat"], entry["lon"]
    return (_num(lat) and _num(lon) and -90 <= lat <= 90 and -180 <= lon <= 180
            and (lo is None or hi is None or 0 <= lo <= hi)
            and bool(entry.get("phone") or entry.get("email"))
            and all(isinstance(entry[k], list) for k in ("service_areas", "services", "certifications")))


_cache: dict[Path, tuple[float, object]] = {}


def _read_json(path: Path) -> object:
    """Parsed JSON, cached until the file's modification time changes (edits apply without a restart)."""
    try:
        mtime = path.stat().st_mtime
        if path in _cache and _cache[path][0] == mtime:
            return _cache[path][1]
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise InstallerDataError(f"data file not found: {path.name}")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise InstallerDataError(f"data file unreadable: {path.name}: {e}")
    _cache[path] = (mtime, doc)
    return doc


def load(path: Path | None = None) -> tuple[list[dict], str]:
    """Return (valid installers, note). Malformed entries are skipped and logged, not fatal."""
    doc = _read_json(path or DATA_FILE)
    if not isinstance(doc, dict) or not isinstance(doc.get("installers"), list):
        raise InstallerDataError("installer file must be an object with an 'installers' list")
    good = [e for e in doc["installers"] if _valid(e)]
    if len(good) != len(doc["installers"]):
        log.warning("skipped %d malformed installer entries", len(doc["installers"]) - len(good))
    return good, str(doc.get("_note", ""))


def load_locations(path: Path | None = None) -> list[dict]:
    """States/UTs as [{"name", "type", "cities": [{"name", "lat", "lon"}]}], sorted by name."""
    doc = _read_json(path or LOCATIONS_FILE)
    states = doc.get("states") if isinstance(doc, dict) else None
    if not isinstance(states, list):
        raise InstallerDataError("locations file must be an object with a 'states' list")
    out = []
    for st in states:
        if not isinstance(st, dict) or not isinstance(st.get("name"), str) or not isinstance(st.get("cities"), list):
            continue
        cities = [c for c in st["cities"] if isinstance(c, dict) and isinstance(c.get("name"), str)
                  and isinstance(c.get("lat"), (int, float)) and isinstance(c.get("lon"), (int, float))]
        out.append({"name": st["name"], "type": st.get("type", "state"),
                    "cities": sorted(cities, key=lambda c: c["name"].casefold())})
    return sorted(out, key=lambda s: s["name"].casefold())


def _norm(s: str) -> str:
    return " ".join(s.split()).casefold()


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle (haversine) distance in km. Straight line, not road distance."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def filter_installers(items: list[dict], state: str | None = None, city: str | None = None,
                      min_kwp: float | None = None, max_kwp: float | None = None,
                      lat: float | None = None, lon: float | None = None,
                      radius_km: float | None = None) -> list[dict]:
    """City matches the installer's city or any of its service areas. A kWp range keeps installers whose
    own [min_kwp, max_kwp] overlaps it; a single bound keeps installers that can reach it. Installers whose
    capacity range is not published are kept (we cannot rule them out).
    With lat/lon, each result gets distance_km, results are sorted nearest first and radius_km (if given)
    drops installers further away. Without lat/lon, results are sorted by name."""
    out = []
    for e in items:
        if state and _norm(e["state"]) != _norm(state):
            continue
        if city and _norm(city) not in {_norm(e.get("city") or ""), *(_norm(a) for a in e["service_areas"])}:
            continue
        if min_kwp is not None and e.get("max_kwp") is not None and e["max_kwp"] < min_kwp:
            continue
        if max_kwp is not None and e.get("min_kwp") is not None and e["min_kwp"] > max_kwp:
            continue
        if lat is not None and lon is not None:
            d = distance_km(lat, lon, e["lat"], e["lon"])
            if radius_km is not None and d > radius_km:
                continue
            e = {**e, "distance_km": round(d, 1)}
        out.append(e)
    if lat is not None and lon is not None:
        # At equal distance, offices whose town is known come before ones placed at their DISCOM area.
        return sorted(out, key=lambda e: (e["distance_km"], e.get("location_precision") == "region",
                                          e["company_name"].casefold()))
    return sorted(out, key=lambda e: e["company_name"].casefold())
