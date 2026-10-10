"""Build installers.json from official, published empanelled-vendor lists (no made-up data).

    python scripts/import_official_vendors.py --py-pdf "Solar Vendors 15092026.pdf"

Sources (re-run when the DISCOMs publish new lists; they update them regularly):
  * MPCZ (MP Madhya Kshetra Vidyut Vitaran Co., Bhopal): HTML table, fetched from MPCZ_URL
    (or pass a saved copy with --mpcz-html).
  * Puducherry Electricity Department: PDF "List of vendors registered under the PM Surya Ghar Portal".
    Download it from PY_PAGE and pass it with --py-pdf (needs `pdftotext` from poppler/xpdf on PATH).

Only fields printed in the source are filled; everything else is null. Office coordinates are the centre of the
office's city (location_precision "city"), or of the DISCOM area when the address has no recognisable city in
that state (location_precision "region").
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import subprocess
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "backend" / "data"

MPCZ_URL = "https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/1"
MPCZ_NAME = "MPCZ - Vendor List (Empanelled for Solar Subsidy)"
PY_PAGE = "https://electricity.py.gov.in/list-vendors-registered-under-pm-surya-ghar-portal"
PY_NAME = "Electricity Department, Puducherry - List of vendors registered under the PM Surya Ghar Portal"

# Words in an address that name a town under another name.
ALIASES = {"lashkar": "Gwalior", "morar": "Gwalior", "hoshangabad": "Narmadapuram", "pondicherry": "Puducherry"}
TEST_ROW = re.compile(r"\btest\b", re.I)


def clean(s: str | None) -> str | None:
    s = re.sub(r"\s+", " ", s or "").strip(" ,")
    return s or None


def locate(address: str | None, state: dict) -> tuple[dict | None, bool]:
    """Find the office's city in `address` among `state`'s cities. Returns (city, from_district_only).
    The last mention wins (addresses end with the town); a name right after "Dist."/"District" is only used
    when nothing else matches, since the town itself is usually more precise."""
    if not address:
        return None, False
    text = address.lower()
    names = {c["name"].lower(): c for c in state["cities"]}
    names.update({a: names[t.lower()] for a, t in ALIASES.items() if t.lower() in names})
    hits = []
    for name, city in names.items():
        for m in re.finditer(rf"(?<![a-z]){re.escape(name)}(?![a-z])", text):
            # "Hoshangabad Road" is a road in Bhopal, not the town.
            if re.match(r"\s*(road|rd\b|bypass)", text[m.end():]):
                continue
            district = bool(re.search(r"(dist\.?|district)\s*:?\s*$", text[:m.start()]))
            hits.append((district, m.start(), city))
    if not hits:
        return None, False
    town = [h for h in hits if not h[0]]
    pick = max(town or hits, key=lambda h: h[1])
    return pick[2], not town


def pincode(address: str | None) -> str | None:
    found = re.findall(r"(?<!\d)([1-8]\d{2}) ?(\d{3})(?!\d)", address or "")
    return "".join(found[-1]) if found else None


def phone(s: str | None) -> str | None:
    d = re.sub(r"\D", "", s or "")
    return d if re.fullmatch(r"[6-9]\d{9}", d) else clean(s)


def entry(i: str, source: dict, state: dict, region: dict, company: str, person: str | None, tel: str | None,
          email: str | None, address: str | None, discom: str, retrieved: str) -> dict:
    city, district_only = locate(address, state)
    precise = city is not None
    where = city or region
    return {
        "id": i,
        "company_name": clean(company),
        "contact_person": clean(person),
        "phone": phone(tel),
        "email": clean(email),
        "website": None,
        "address": clean(address),
        "city": city["name"] if city else None,
        "state": state["name"],
        "pincode": pincode(address),
        "lat": where["lat"],
        "lon": where["lon"],
        "location_precision": "city" if precise and not district_only else "region",
        "service_areas": source["service_areas"],
        "services": ["Rooftop solar under PM Surya Ghar (subsidy)"],
        "years_experience": None,
        "certifications": [f"Empanelled / registered vendor, {discom}"],
        "min_kwp": None,
        "max_kwp": None,
        "last_verified": retrieved,
        "source": {"name": source["name"], "url": source["url"], "retrieved": retrieved},
    }


def mpcz(page: str, states: dict, retrieved: str) -> list[dict]:
    mp = states["Madhya Pradesh"]
    region = next(c for c in mp["cities"] if c["name"] == "Bhopal")  # MPCZ headquarters
    src = {"name": MPCZ_NAME, "url": MPCZ_URL, "service_areas": ["MPCZ area (Bhopal and Gwalior regions)"]}
    out = []
    for row in re.findall(r"<tr.*?</tr>", page, flags=re.S):
        cells = [clean(html.unescape(re.sub(r"<[^>]+>", " ", c)))
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", row, flags=re.S)]
        if len(cells) != 5 or not (cells[0] or "").isdigit():
            continue
        no, company, person, tel, address = cells
        if TEST_ROW.search(company or "") or not company:
            continue
        out.append(entry(f"mpcz-{int(no):03d}", src, mp, region, company, person, tel, None, address,
                         "MP Madhya Kshetra Vidyut Vitaran Co. (MPCZ)", retrieved))
    return out


def puducherry(text: str, states: dict, retrieved: str) -> list[dict]:
    """Parse `pdftotext -table` output: columns are separated by 2+ spaces. A row is
    `No  Agency  Contact person  Email  Mobile`; text wrapped onto the next line is added to the column it sits
    under (nearest column start of the row above)."""
    py = states["Puducherry"]
    region = next(c for c in py["cities"] if c["name"] == "Puducherry")
    src = {"name": PY_NAME, "url": PY_PAGE, "service_areas": ["Puducherry UT"]}
    rows = []  # [no, company, person, email, mobile, column starts]
    for line in text.splitlines():
        if not line.strip() or "LIST OF SOLAR" in line or "Agency Name" in line:
            continue
        fields = [(m.start(), m.group()) for m in re.finditer(r"\S+(?: \S+)*", line)]
        if re.fullmatch(r"\d{1,3}", fields[0][1]) and fields[0][0] < 3:
            no, rest = fields[0][1], fields[1:]
            email = next((f for f in rest if "@" in f[1]), None)
            mobile = next((f for f in rest if re.fullmatch(r"[6-9]\d{9}", f[1])), None)
            names = [f for f in rest if f is not email and f is not mobile]
            if len(names) != 2:
                raise ValueError(f"row {no}: expected agency and contact person, got {names!r}")
            cols = [names[0][0], names[1][0], email[0] if email else None, mobile[0] if mobile else None]
            rows.append([no, names[0][1], names[1][1], email[1] if email else "", mobile[1] if mobile else "", cols])
        elif rows:  # wrapped text continues the previous row
            cols = rows[-1][5]
            for start, frag in fields:
                k = min((i for i, c in enumerate(cols) if c is not None), key=lambda i: abs(cols[i] - start))
                rows[-1][k + 1] = f"{rows[-1][k + 1]} {frag}".strip() if k < 2 else rows[-1][k + 1] + frag
    out = []
    for no, company, person, email, tel, _ in rows:
        if TEST_ROW.search(company):
            continue
        out.append(entry(f"py-{int(no):03d}", src, py, region, company, person, tel, email, None,
                         "Electricity Department, Puducherry", retrieved))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mpcz-html", type=Path, help="saved copy of the MPCZ vendor page (default: download it)")
    ap.add_argument("--py-pdf", type=Path, help="Puducherry vendor list PDF")
    ap.add_argument("--retrieved", default=dt.date.today().isoformat(), help="date the sources were fetched")
    args = ap.parse_args()

    states = {s["name"]: s for s in json.loads((DATA / "india_locations.json").read_text(encoding="utf-8"))["states"]}
    if args.mpcz_html:
        page = args.mpcz_html.read_text(encoding="utf-8", errors="replace")
    else:
        req = urllib.request.Request(MPCZ_URL, headers={"User-Agent": "Mozilla/5.0"})
        page = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    items = mpcz(page, states, args.retrieved)
    if args.py_pdf:
        text = subprocess.run(["pdftotext", "-table", "-enc", "UTF-8", str(args.py_pdf), "-"],
                              capture_output=True, check=True).stdout.decode("utf-8")
        items += puducherry(text, states, args.retrieved)

    doc = {
        "_note": "Real installers copied from official DISCOM / state empanelled-vendor lists (see each entry's "
                 "source). Being listed does not mean SolarScope recommends them: check the vendor on "
                 "pmsuryaghar.gov.in and ask for written quotes. Office locations are approximate (city centre).",
        "installers": items,
    }
    with open(DATA / "installers.json", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    by_state = {}
    for e in items:
        by_state[e["state"]] = by_state.get(e["state"], 0) + 1
    print(f"wrote {len(items)} installers: {by_state}")


if __name__ == "__main__":
    main()
