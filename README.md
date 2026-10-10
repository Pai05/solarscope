# SolarScope

**How much of a cluttered Indian rooftop can really carry solar panels?**

Indian flat roofs are full of water tanks, stairwell rooms, AC units and dishes. SolarScope takes a top-down
drone or aerial image, segments **usable roof** vs **obstructions**, lets the user fix the mask with a brush,
applies an edge setback and obstruction buffer, packs real panel rectangles into what is left, and reports
capacity (kWp), yearly generation (kWh), savings (₹), payback after subsidy and CO₂ avoided, with every
assumption and its source shown.

Built for Environmental Hacks (WeMakeDevs x AWS), track: Waste and Energy (Rooftop solar).

## Two ways to use it

| Page | For | Flow |
|---|---|---|
| **Image** (`/image.html`) | Anyone with a top-down drone/aerial photo | Upload → AI detects roof + obstructions → brush fixes → scale (type, draw a known length, or measure a wall with AR) → panels → report |
| **Phone scan** (`/scan.html`) | Anyone with an ARCore Android phone (or a tape) | Tap each roof corner with the camera (WebXR) → live area → tap around tanks/stair rooms → **digital roof plan drawn to scale** → panels placed on it → report. Without AR: type length × width and add obstructions, drag them into place |

## How it works

1. **Segmentation**: U-Net (ResNet-34 encoder, segmentation-models-pytorch) trained on hand-labelled 0.1 m/px
   tiles of Vijayawada (India) and Dhaka drone imagery from OpenAerialMap (CC-BY 4.0). Exported to ONNX, runs on CPU.
2. **Scale**: metres per pixel from the image's stated resolution, or by drawing a line over a known length.
3. **Correction**: brush to paint roof / obstruction / erase; drag "Pick my roof" around one building; zoom and pan.
   **AR wall measurement** (Android Chrome + ARCore, WebXR hit-test): tap where a house wall meets the ground at
   both corners, repeat 3x, and the median length calibrates the image scale. True size from the phone,
   shape and obstructions from the image.
4. **Geometry** (`backend/geometry.py`): edge setback and obstruction buffer by Euclidean distance transform;
   greedy panel packing in both orientations and several row offsets, keeping the best.
5. **Economics** (`backend/solar_calc.py`): irradiance from NASA POWER for the site → yield → savings,
   tiered PM Surya Ghar subsidy with cap → payback → CO₂.

## Find solar installers near me

After the report is computed on either page, **📍 Find solar installers near me** (below the report) opens
`/installers.html`:

- **Project summary**: panels, kWp, estimated system cost and cost after subsidy.
- **Nearest installers first**: uses the latitude/longitude from the report, or **Use my current location**
  (browser geolocation). Each card shows "≈ N km away" (straight-line distance); a distance filter keeps
  installers within 25 / 50 / 100 / 250 km or at any distance. Without a location, all installers are listed by name.
- **Contact directly**: big **Call** button (`tel:`), **WhatsApp** (opens a chat with a prefilled quote request
  for your kWp), **Email** (`mailto:` with the same prefilled request), **Directions** (Google Maps route to the
  address) and **Website**.
- **State / City filters** list all 28 states and 8 union territories of India; picking a state lists its main
  cities (installer data so far covers Madhya Pradesh and Puducherry, see below). Plus an optional search box and "Only installers that handle N kWp" (installers whose capacity range
  covers your system size).

Privacy: the project summary is passed in the tab's `sessionStorage`, never in the page URL. The location is only
sent to this app's own API, rounded to 2 decimals (~1 km), to sort by distance; it is not stored. The button is
disabled again as soon as the roof or settings change, until the report is recomputed.

API: `GET /api/installers?state=&city=&min_kwp=&max_kwp=&lat=&lon=&radius_km=&limit=` (all optional). `state` matches
exactly (case-insensitive), `city` matches the installer's city or any of its service areas, and a kWp range keeps
installers whose own `min_kwp`-`max_kwp` range overlaps it. With `lat` and `lon`, each result gets `distance_km`
and results are sorted nearest first; `radius_km` drops installers further away. `limit` (1-200, default 50)
caps the list. Returns `{"count", "total", "installers", "note"}` (`count` returned, `total` matching); 422 for
out-of-range values, 400 if `min_kwp > max_kwp`, only one of `lat`/`lon` is given, or `radius_km` has no location;
503 if the data file is missing or broken. `GET /api/locations` returns the states/UTs and their cities
(from `backend/data/india_locations.json`) for the dropdowns.

### Installer data: real, from official lists

`backend/data/installers.json` holds **188 real installers copied from official empanelled-vendor lists**, checked
on 2026-10-10. Nothing is made up: a field the source does not publish is `null` and the card simply leaves it out.

| Source | Vendors | Published fields |
|---|---|---|
| [MPCZ (MP Madhya Kshetra Vidyut Vitaran Co.) - Vendor List (Empanelled for Solar Subsidy)](https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/1) | 108 (the page's `TEST` row is skipped) | company, contact person, phone, address |
| [Electricity Department, Puducherry - vendors registered under the PM Surya Ghar portal](https://electricity.py.gov.in/list-vendors-registered-under-pm-surya-ghar-portal) (PDF of 15-09-2026) | 80 | company, contact person, email, mobile |

Other states have no entries yet. Their lists are behind the JavaScript national portal or are out of date (the
Tamil Nadu PDF is from 2022, before PM Surya Ghar), so the page points users to
[pmsuryaghar.gov.in](https://pmsuryaghar.gov.in) instead. Every card names its source and the date it was checked.

- **Locations are approximate.** Distances use the centre of the office's town found in the address
  (`location_precision: "city"`). Where the address names no town in that state (offices in Mumbai, Delhi, etc.,
  or Puducherry, whose list has no addresses) the installer is placed at the DISCOM area and the card says
  "approx." (`"region"`).
- **Listed is not recommended.** Being on a DISCOM list means the vendor is registered there, not that SolarScope
  vouches for them. The page says to check the vendor on the national portal and get written quotes.
- **Personal data.** Contact persons' names and mobile numbers are published by the DISCOMs so consumers can reach
  vendors; they are reproduced here only for that purpose. Remove an entry if the vendor asks.

**Refreshing the data.** DISCOMs update their lists regularly. Re-run the importer (it rewrites `installers.json`):

```powershell
# Download the current Puducherry PDF from the page linked above first. Needs pdftotext (poppler/xpdf) on PATH.
python scripts/import_official_vendors.py --py-pdf "Solar Vendors 15092026.pdf"
```

It downloads the MPCZ page itself (or pass a saved copy with `--mpcz-html`). To add another state, add a parser
for its official list to the importer, keeping only fields the source prints.

### Editing `backend/data/installers.json`

The file is `{"_note": "...", "installers": [ ... ]}`; the `_note` is shown as a banner on the page. Each installer:

| Field | Type | Example / notes |
|---|---|---|
| `id` | string | unique, e.g. `"mpcz-002"` |
| `company_name` | string | as published |
| `state` | string | the state/UT the vendor is empanelled in; exact name from `india_locations.json` |
| `city` | string or `null` | office town, if it is in that state; exact name from `india_locations.json` |
| `lat`, `lon` | number | used for "near me" distance |
| `location_precision` | `"city"` or `"region"` | how exact `lat`/`lon` are (see above) |
| `phone`, `email` | string or `null` | at least one is required. WhatsApp is offered for 10-digit Indian mobiles (bare or `+91…`) |
| `contact_person`, `website`, `address`, `pincode` | string or `null` | `website` must be `http(s)://`; no address = no Directions button |
| `service_areas` | list of strings | area the vendor is registered for; also matched by the City filter |
| `services` | list of strings | e.g. `"Rooftop solar under PM Surya Ghar (subsidy)"` |
| `certifications` | list of strings | empanelment, e.g. `"Empanelled / registered vendor, MP Madhya Kshetra Vidyut Vitaran Co. (MPCZ)"` |
| `years_experience`, `min_kwp`, `max_kwp` | number or `null` | installers with an unknown range are kept by the size filter |
| `last_verified` | string | date the entry was checked against its source |
| `source` | object | `{"name", "url", "retrieved"}`: the official list it came from |

Entries that break these rules are skipped (and logged) rather than breaking the page. The file is re-read whenever
it changes, so edits show up without restarting the server.

**States and cities** (`backend/data/india_locations.json`): every state/UT with its main cities and approximate
city-centre coordinates, one city per line. Add a city as `{"name": "...", "lat": ..., "lon": ...}` under its
state; it appears in the City dropdown at once.

## Where AWS fits

| AWS service | What runs there |
|---|---|
| **EC2** (t3.small, Ubuntu 24.04, ap-south-1) | The whole app: FastAPI + ONNX Runtime + static frontend, as a systemd service |
| **S3** | Model weights (`models/solarscope.onnx`), pulled at deploy time |
| **IAM role** (instance profile) | Read-only access from EC2 to the weights bucket; no access keys on the server |

Caddy on the same instance terminates HTTPS (needed for camera/AR in browsers) at `https://<ip>.sslip.io`.

Deploy guide: [`infra/DEPLOY.md`](infra/DEPLOY.md).

## Model results

U-Net (ResNet-34, ImageNet encoder) trained for 40 epochs (10 min on a laptop CPU) on 65 hand-labelled
256 px tiles (273 roof and 89 obstruction polygons, 11 background-only tiles); evaluated on 13 held-out tiles.

| Class | IoU (held-out) |
|---|---|
| Background | 0.71 |
| Roof | 0.58 |
| Obstruction | 0.24 |
| **Mean** | **0.51** |

![validation: image | ground truth | prediction](docs/val_preview.png)

*Columns: image, hand label, prediction (green roof, red obstruction). Split in `docs/split.json`.*

**Reading the numbers honestly:**
- Roof IoU is pulled down partly by our own labels: several validation tiles have real roofs we did not
  label, which the model does find (rows 2, 3, 6, 8 above) and which count as errors.
- Obstruction IoU is low. The model finds large water tanks, stair rooms and existing solar arrays,
  but misses small white tanks and AC units (~6-9 px at 0.1 m/px). That is why the app has a correction brush.
- Small data: 78 tiles from two cities. Touching roofs of neighbouring buildings merge into one region.

![demo samples: image | prediction with panel layout](docs/samples_prediction.jpg)

## Ground-truth check

_TBD: tape-measured roof vs SolarScope estimate._

## Project structure

```
backend/                 FastAPI app (serves the API and the frontend from one process)
  app.py                 routes: /health, /config, /predict, /report, /api/installers, /api/locations
  geometry.py            setbacks, obstruction buffer, panel packing
  solar_calc.py          economics and every assumption with its source
  irradiance.py          NASA POWER lookup
  model.py, schemas.py   ONNX segmenter, request models
  installers.py          installer directory: load, validate, filter, distance
  data/
    installers.json      installers copied from official DISCOM lists (see "Installer data")
    india_locations.json states / UTs of India with their main cities
frontend/                static site, no build step
  index.html  image.html  scan.html  installers.html
  css/styles.css         design system (tokens, light/dark, components, layouts)
  js/theme.js            light/dark toggle (loaded in <head>)
  js/common.js           shared helpers, report card, step progress
  js/app.js              image page: upload, detection, brush editor
  js/plan.js             phone-scan page: roof plan and panels
  js/ar.js               WebXR measuring (both pages)
  js/installers.js       installers page
  samples/               sample tiles for the image page
scripts/
  import_official_vendors.py   rebuilds backend/data/installers.json from the official lists
tests/                   pytest: API, geometry, economics, model, installers, importer
training/                tiling, labelling and training of the segmentation model
infra/                   EC2 deploy (systemd + Caddy)
docs/                    write-up, metrics and figures
```

## Run locally (Windows PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
pytest -q
uvicorn backend.app:app --reload --port 8000     # open http://localhost:8000
```

If the project is in a OneDrive (or other synced) folder, `--reload` can miss file changes and keep serving old
code (for example a 404 on a new endpoint), or hang while reloading. Stop the server (Ctrl+C) and start it again
after changing backend code. Editing `backend/data/*.json` needs no restart.

Put a trained `solarscope.onnx` (+ `.json`) in `models/` to enable detection; without it you can paint the roof by hand.

## Train the model

1. Label `training/tiles/*.png` in Roboflow (classes `roof`, `obstruction`; roof first, obstructions on top), export **COCO Segmentation** without augmentations.
2. `python training/coco_to_masks.py --coco <unzipped export> --preview` → `training/labels/` (check `training/labels_preview/`), commit and push.
3. Open `training/train_colab.ipynb` in Colab (T4 GPU), run all, download `solarscope.onnx` and `solarscope.json`.

## Assumptions and sources

All economic inputs live in `backend/solar_calc.py` (`DEFAULT_ASSUMPTIONS`) and are shown in the app's report
with their source and a verified flag. Checked on 2026-10-08.

| Input | Value | Source | Status |
|---|---|---|---|
| Solar irradiance | per site (e.g. 5.12 kWh/m²/day, Vijayawada) | [NASA POWER](https://power.larc.nasa.gov) climatology, `ALLSKY_SFC_SW_DWN` annual mean | ✅ live |
| Tariff | ₹6.00/kWh (₹8.75 above 225 units/month) | [APCPDCL](https://apcpdcl.in/arrfilings/252026/ARR-Brief-Note.pdf) LT-I Domestic slabs FY 2025-26; APERC kept them for [FY 2026-27](https://mercomindia.com/andhra-pradesh-retains-existing-power-tariffs-for-fy-2027) | ✅ (conservative slab) |
| Installed cost | ₹50,000/kWp | MNRE PM Surya Ghar benchmark, general category states, [pv magazine India](https://www.pv-magazine-india.com/2024/04/17/mnre-releases-draft-guidelines-for-residential-rooftop-solar-subsidy-scheme/) | ✅ (benchmark, not a quote) |
| Subsidy | ₹30,000/kW for 2 kW + ₹18,000 for the 3rd kW, cap ₹78,000 | [PM Surya Ghar Cabinet approval](https://www.pmindia.gov.in/?p=16395970) (₹30k / 60k / 78k for 1 / 2 / 3+ kW) | ✅ |
| Grid emission factor | 0.675 kgCO₂/kWh | [CEA CO₂ Baseline Database v22.0](https://cea.nic.in/wp-content/uploads/baseline/2026/09/User_Guide__Version_22.0.pdf) (Aug 2026), Table 4, FY 2025-26 | ✅ |
| Panel | 2.272 × 1.133 m, 540 Wp | Waaree 540 Wp mono PERC, retailer listings | ⚠️ confirm with datasheet |
| Performance ratio | 0.75 | typical rooftop value | ⚠️ placeholder |

Simplifications: flush/low-tilt mounting (no inter-row shading spacing), no degradation or tariff escalation,
simple payback.

## AI tools used

Claude (Claude Code) was used as a pair programmer for code, tests and docs.

## License

MIT, see `LICENSE`. Third-party data, weights and libraries in [`CREDITS.md`](CREDITS.md).
