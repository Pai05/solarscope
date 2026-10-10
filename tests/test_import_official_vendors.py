import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("importer", ROOT / "scripts" / "import_official_vendors.py")
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)

STATES = {s["name"]: s for s in json.loads((ROOT / "backend/data/india_locations.json").read_text(encoding="utf-8"))["states"]}
MP = STATES["Madhya Pradesh"]


def row(*cells):
    return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"


# Rows copied from the MPCZ page (shape and spelling as published).
MPCZ_PAGE = "<table><tr><th>Sr. No</th><th>Company Name</th></tr>" + "".join([
    row(2, "SHOURYA ENERGY SOLUTIONS", "SANDESH CHOUKSEY", "9300585810",
        "F-STAR, 01, SAGAR ROYAL VILLAS, HOSHANGABADROAD, BHOPAL, Bhopal, Madhya Pradesh, 462026"),
    row(1, "SolarSquare Energy Private Limited", "Manoj Kumar", "8826376150",
        "Het Kunj, G3 B Wing, VP Road, Opp. Fidai Baugh Lane,Andheri West, Mumbai 400058"),
    row(70, "TEST(Don't Choose This)", "TEST", "6232913148", "TEST"),
    row(37, "TIRUPATI SALES AND ONLINE POWER", "MR DHARMENDRA KUMAR JOSHI", "9826229850",
        "DR. J.P. SHARMA KE PAAS, JINSI NALA NO. 03, LASHKAR,Gwalior, Madhya Pradesh, 474001"),
]) + "</table>"


def test_mpcz_parses_rows_and_skips_test_entry():
    items = imp.mpcz(MPCZ_PAGE, STATES, "2026-10-10")
    assert [e["id"] for e in items] == ["mpcz-002", "mpcz-001", "mpcz-037"]
    shourya, square, tirupati = items
    assert shourya["city"] == "Bhopal" and shourya["pincode"] == "462026" and shourya["phone"] == "9300585810"
    assert shourya["location_precision"] == "city" and shourya["state"] == "Madhya Pradesh"
    # Office outside the state: keep the real address, place it at the DISCOM area, flag it as approximate.
    assert square["city"] is None and square["location_precision"] == "region" and "Mumbai" in square["address"]
    assert tirupati["city"] == "Gwalior"
    for e in items:
        assert e["source"] == {"name": imp.MPCZ_NAME, "url": imp.MPCZ_URL, "retrieved": "2026-10-10"}
        assert e["email"] is None and e["min_kwp"] is None  # not published by MPCZ


@pytest.mark.parametrize("address, city, district_only", [
    ("C-3A, NARAYAN NAGAR, HOSHANGABAD ROAD, BHOPAL-462026", "Bhopal", False),  # a road, not the town
    ("KN : 67/11 City/Town : Pipariya District: Narmadapuram PIN Code: 461775", "Pipariya", False),
    ("PLOT NO. E-1(D), Mandideep, District Raisen, BHOPAL, MP 462046", "Bhopal", False),
    ("1, Gram Ghatakhedi, Tehsil Khilchipur, Dist. Rajgarh 465697", "Rajgarh", True),
    ("Ram kala nagar,Morar gwalior", "Gwalior", False),
    ("A-22, Minal Residency near Minal Gate No -01", None, False),
    (None, None, False),
])
def test_locate_city_in_address(address, city, district_only):
    found, dist = imp.locate(address, MP)
    assert (found["name"] if found else None, dist) == (city, district_only)


# `pdftotext -table` output of the Puducherry PDF, including rows whose text wraps onto the next line.
PY_TEXT = """\
                                           LIST OF SOLAR  VENDORS REGISTERED IN THE  UT  OF PUDUCHERRY

Sl. No.                      Agency Name                            Contact Person                      Email              Mobile

1        Aarvin Green Power India Private Limited         Veerasamy Ravindran            aarvingreen@gmail.com             8826501199

17       French Traders                                   Shamudeen Mohammed             frenchtraders28@gmail.com         7200042488
                                                          Salahudeen
70       Taken Solar Energy and Infrastructure Corporation  Arun. G                  takenenergyindia@gmail.com        9345348836
         Pvt. Ltd.
"""


def test_puducherry_table_with_wrapped_rows():
    items = imp.puducherry(PY_TEXT, STATES, "2026-10-10")
    got = [(e["id"], e["company_name"], e["contact_person"], e["email"], e["phone"]) for e in items]
    assert got == [
        ("py-001", "Aarvin Green Power India Private Limited", "Veerasamy Ravindran", "aarvingreen@gmail.com", "8826501199"),
        ("py-017", "French Traders", "Shamudeen Mohammed Salahudeen", "frenchtraders28@gmail.com", "7200042488"),
        ("py-070", "Taken Solar Energy and Infrastructure Corporation Pvt. Ltd.", "Arun. G",
         "takenenergyindia@gmail.com", "9345348836"),
    ]
    assert all(e["address"] is None and e["location_precision"] == "region" for e in items)


@pytest.mark.parametrize("raw, expected", [
    ("9300585810", "9300585810"),
    (" 93005 85810 ", "9300585810"),
    ("0755-2551234", "0755-2551234"),  # landline kept as published
    ("", None),
])
def test_phone(raw, expected):
    assert imp.phone(raw) == expected
