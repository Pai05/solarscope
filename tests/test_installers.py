import json
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

from backend import installers
from backend.app import app

client = TestClient(app)


def entry(i, city, state, lo, hi, areas=None, lat=0.0, lon=0.0):
    return {
        "id": f"t{i}", "company_name": f"Test Installer {i}", "contact_person": None,
        "phone": "000-000-0000", "email": f"t{i}@example.com", "website": "https://example.com",
        "address": "Placeholder", "city": city, "state": state, "pincode": "000000", "lat": lat, "lon": lon,
        "service_areas": areas or [city], "services": ["Rooftop residential"], "years_experience": 0,
        "certifications": ["PLACEHOLDER"], "min_kwp": lo, "max_kwp": hi, "last_verified": "not verified",
    }


@pytest.fixture
def data_file(tmp_path, monkeypatch):
    f = tmp_path / "installers.json"
    f.write_text(json.dumps({"_note": "test data", "installers": [
        entry(1, "Vijayawada", "Andhra Pradesh", 1, 10, ["Vijayawada", "Guntur"], 16.5062, 80.6480),
        entry(2, "Guntur", "Andhra Pradesh", 3, 100, None, 16.3067, 80.4365),
        entry(3, "Bengaluru", "Karnataka", 1, 5, None, 12.9716, 77.5946),
    ]}), encoding="utf-8")
    monkeypatch.setattr(installers, "DATA_FILE", f)
    return f


def names(r):
    return [e["company_name"] for e in r.json()["installers"]]


def test_shipped_file_is_official_data_with_sources():
    raw = json.loads(installers.DATA_FILE.read_text(encoding="utf-8"))["installers"]
    items, note = installers.load()
    assert len(items) == len(raw) > 0, "every shipped entry must be valid"
    assert "official" in note
    assert len({e["id"] for e in items}) == len(items)
    for e in items:
        assert not e.get("demo"), e["id"]
        assert "test" not in e["company_name"].lower(), e["id"]  # the MPCZ page has a TEST row
        src = e["source"]
        host = urlparse(src["url"]).hostname
        assert src["url"].startswith("https://") and host.endswith((".gov.in", ".mpcz.in")), src["url"]
        assert src["retrieved"] and e["last_verified"] == src["retrieved"]
        assert e["location_precision"] in ("city", "region")
        assert e["phone"] or e["email"]


def test_locations_cover_all_states_and_uts():
    states = client.get("/api/locations").json()["states"]
    assert sum(s["type"] == "state" for s in states) == 28
    assert sum(s["type"] == "union_territory" for s in states) == 8
    names = {s["name"] for s in states}
    assert {"Andhra Pradesh", "Karnataka", "Tamil Nadu", "Delhi", "Ladakh", "Puducherry"} <= names
    for s in states:
        assert s["cities"], s["name"]
        for c in s["cities"]:
            assert 6 <= c["lat"] <= 37.5 and 68 <= c["lon"] <= 98, (s["name"], c)


def test_installer_cities_exist_in_locations():
    cities = {(s["name"], c["name"]) for s in installers.load_locations() for c in s["cities"]}
    states = {s["name"] for s in installers.load_locations()}
    for e in installers.load()[0]:
        assert e["state"] in states, e["id"]
        if e["city"]:
            assert (e["state"], e["city"]) in cities, e["id"]


def test_real_data_bhopal_nearest_first():
    r = client.get("/api/installers", params={"lat": 23.26, "lon": 77.41, "radius_km": 25}).json()
    assert r["total"] > 20
    assert all(e["state"] == "Madhya Pradesh" for e in r["installers"])
    d = [e["distance_km"] for e in r["installers"]]
    assert d == sorted(d)


def test_city_dropdown_matches_installers():
    gwalior = client.get("/api/installers", params={"state": "Madhya Pradesh", "city": "Gwalior"}).json()
    assert gwalior["total"] >= 5
    assert all(e["city"] == "Gwalior" for e in gwalior["installers"])


def test_unknown_capacity_is_not_filtered_out():
    items = [{"company_name": "X", "state": "S", "city": None, "service_areas": [], "lat": 0, "lon": 0,
              "min_kwp": None, "max_kwp": None}]
    assert installers.filter_installers(items, min_kwp=5, max_kwp=5) == items


@pytest.mark.parametrize("change, ok", [
    ({}, True),
    ({"email": None, "website": None, "address": None, "city": None, "years_experience": None,
      "min_kwp": None, "max_kwp": None, "contact_person": None, "pincode": None}, True),
    ({"phone": None, "email": None}, False),     # no way to contact them
    ({"phone": 12345}, False),
    ({"years_experience": "ten"}, False),
])
def test_optional_fields(change, ok):
    assert installers._valid({**entry(1, "A", "B", 1, 5), **change}) is ok


def test_locations_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(installers, "LOCATIONS_FILE", tmp_path / "nope.json")
    assert client.get("/api/locations").status_code == 503


def test_limit_and_total():
    r = client.get("/api/installers", params={"limit": 5}).json()
    assert r["count"] == len(r["installers"]) == 5 and r["total"] > 5
    assert client.get("/api/installers").json()["count"] == 50  # default limit
    assert client.get("/api/installers", params={"limit": 0}).status_code == 422
    assert client.get("/api/installers", params={"limit": 201}).status_code == 422


def test_list_all(data_file):
    r = client.get("/api/installers")
    assert r.status_code == 200
    j = r.json()
    assert j["count"] == 3 and j["note"] == "test data"
    assert names(r) == ["Test Installer 1", "Test Installer 2", "Test Installer 3"]


def test_filter_state_case_insensitive(data_file):
    assert names(client.get("/api/installers", params={"state": "  andhra   PRADESH "})) == [
        "Test Installer 1", "Test Installer 2"]


def test_filter_city_includes_service_areas(data_file):
    # Installer 1 is based in Vijayawada but serves Guntur.
    assert names(client.get("/api/installers", params={"city": "guntur"})) == ["Test Installer 1", "Test Installer 2"]
    assert names(client.get("/api/installers", params={"city": "Bengaluru", "state": "Andhra Pradesh"})) == []


@pytest.mark.parametrize("params, expected", [
    ({"min_kwp": 6, "max_kwp": 6}, ["Test Installer 1", "Test Installer 2"]),
    ({"min_kwp": 2, "max_kwp": 2}, ["Test Installer 1", "Test Installer 3"]),
    ({"min_kwp": 50}, ["Test Installer 2"]),
    ({"max_kwp": 2}, ["Test Installer 1", "Test Installer 3"]),
])
def test_filter_kwp_range(data_file, params, expected):
    assert names(client.get("/api/installers", params=params)) == expected


def test_empty_result(data_file):
    r = client.get("/api/installers", params={"state": "Goa"})
    assert r.status_code == 200 and r.json() == {"count": 0, "total": 0, "installers": [], "note": "test data"}


@pytest.mark.parametrize("params, status", [
    ({"min_kwp": -1}, 422),
    ({"max_kwp": "abc"}, 422),
    ({"min_kwp": 20000}, 422),
    ({"city": "x" * 61}, 422),
    ({"min_kwp": 10, "max_kwp": 5}, 400),
    ({"lat": 95, "lon": 80}, 422),
    ({"lat": 16.5, "lon": 200}, 422),
    ({"lat": 16.5}, 400),                       # lat without lon
    ({"radius_km": 50}, 400),                   # radius without a location
    ({"lat": 16.5, "lon": 80.6, "radius_km": 0}, 422),
])
def test_bad_params(data_file, params, status):
    assert client.get("/api/installers", params=params).status_code == status


def test_nearest_first_with_distance(data_file):
    # A user in Guntur: installer 2 is in town, installer 1 is ~31 km away, Bengaluru ~470 km.
    r = client.get("/api/installers", params={"lat": 16.30, "lon": 80.44})
    assert r.status_code == 200
    got = r.json()["installers"]
    assert [e["company_name"] for e in got] == ["Test Installer 2", "Test Installer 1", "Test Installer 3"]
    assert got[0]["distance_km"] < 2
    assert got[1]["distance_km"] == pytest.approx(31, abs=3)
    assert got[2]["distance_km"] == pytest.approx(470, abs=30)


def test_radius_keeps_only_nearby(data_file):
    params = {"lat": 16.30, "lon": 80.44}
    assert names(client.get("/api/installers", params={**params, "radius_km": 10})) == ["Test Installer 2"]
    assert names(client.get("/api/installers", params={**params, "radius_km": 50})) == [
        "Test Installer 2", "Test Installer 1"]
    assert names(client.get("/api/installers", params={"lat": 28.6, "lon": 77.2, "radius_km": 50})) == []


def test_location_combines_with_filters(data_file):
    r = client.get("/api/installers", params={"lat": 16.30, "lon": 80.44, "min_kwp": 2, "max_kwp": 2})
    assert names(r) == ["Test Installer 1", "Test Installer 3"]


def test_no_distance_without_location(data_file):
    assert all("distance_km" not in e for e in client.get("/api/installers").json()["installers"])


def test_distance_km_known_value():
    # Vijayawada -> Guntur city centres, about 31 km in a straight line.
    assert installers.distance_km(16.5062, 80.6480, 16.3067, 80.4365) == pytest.approx(31.6, abs=1)
    assert installers.distance_km(10, 10, 10, 10) == 0


def test_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(installers, "DATA_FILE", tmp_path / "nope.json")
    r = client.get("/api/installers")
    assert r.status_code == 503 and "not available" in r.json()["detail"]


@pytest.mark.parametrize("content", ["{not json", "[]", '{"installers": 5}'])
def test_invalid_file(tmp_path, monkeypatch, content):
    f = tmp_path / "installers.json"
    f.write_text(content, encoding="utf-8")
    monkeypatch.setattr(installers, "DATA_FILE", f)
    assert client.get("/api/installers").status_code == 503


def test_malformed_entries_are_skipped(tmp_path, monkeypatch):
    f = tmp_path / "installers.json"
    bad = entry(9, "X", "Y", 10, 1)  # min > max
    bad_loc = entry(8, "X", "Y", 1, 5, lat=123)
    f.write_text(json.dumps({"installers": [entry(1, "A", "B", 1, 5), {"company_name": "no fields"}, bad, bad_loc]}),
                 encoding="utf-8")
    monkeypatch.setattr(installers, "DATA_FILE", f)
    assert names(client.get("/api/installers")) == ["Test Installer 1"]


def test_installers_page_served():
    r = client.get("/installers.html")
    assert r.status_code == 200 and "installer" in r.text.lower()
