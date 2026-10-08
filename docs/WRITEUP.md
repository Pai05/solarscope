# SolarScope: writeup

> Fill the three blanks marked ⟨…⟩ before submitting.

**Live app:** http://⟨PUBLIC-IP⟩/ · **Code:** https://github.com/Pai05/solarscope (MIT) · **Video:** ⟨YOUTUBE-LINK⟩
**Track:** Waste and Energy (Rooftop solar)

## Problem
Indian city roofs are flat but crowded: overhead water tanks, stairwell rooms, AC units, dish antennas and
older solar arrays. Homeowners, and even installers doing a first estimate, cannot tell from a quick look how much of
a roof can really carry panels, so rooftop solar is either oversold or never considered.

## What we built
SolarScope turns a top-down drone or aerial image of a rooftop into a solar report:

1. A **segmentation model** marks usable roof (green) and obstructions (red).
2. The user **corrects the mask with a brush** and drags a box around their own building.
3. The usable area is shrunk by an **edge setback** (parapets, maintenance access) and an **obstruction buffer**.
4. **Real panel rectangles** (2.27 × 1.13 m, 540 Wp) are packed into what is left, trying both orientations.
5. The report gives **capacity (kWp), yearly generation (kWh), savings (₹), PM Surya Ghar subsidy, payback and CO₂ avoided**,
   and lists every input with its source and a verified / to-verify badge.

## How it works
- **Model:** U-Net with an ImageNet ResNet-34 encoder (segmentation-models-pytorch), 3 classes, trained on our own
  hand labels at 0.1 m/px, exported to ONNX and run with ONNX Runtime on CPU (no PyTorch on the server).
- **Data:** CC-BY 4.0 drone imagery from OpenAerialMap: Vijayawada (India, provider Bhuvan) and Dhaka (provider CSC).
  We cut 81 tiles and hand-labelled 78 of them (273 roof and 89 obstruction polygons, 11 background-only tiles) with a
  small labelling tool we wrote during the event.
- **Scale:** metres per pixel from the image, or calibrated by drawing a line over a known length.
- **Geometry:** setback and buffer by Euclidean distance transform; greedy panel packing with an integral image.
- **Energy and money:** irradiance from the NASA POWER API for the site; tariff from APCPDCL (Vijayawada) FY 2025-26
  slabs; subsidy per PM Surya Ghar (₹30k/kW for 2 kW, ₹18k for the 3rd kW, cap ₹78k); benchmark cost ₹50,000/kWp (MNRE);
  grid factor 0.675 kgCO₂/kWh (CEA CO₂ Baseline Database v22.0).

## Where AWS fits
| Service | Role |
|---|---|
| **Amazon EC2** (t3.small, Ubuntu 24.04, ap-south-1 Mumbai) | Runs the whole app: FastAPI + ONNX Runtime + frontend, as a systemd service that survives reboots |
| **Amazon S3** (`solarscope-envi-hackathon`) | Stores the model weights; the server pulls them at deploy time |
| **IAM role** (instance profile) | Gives EC2 read-only access to that one bucket; no access keys exist on the server |

One idempotent script (`infra/setup.sh`) installs everything, adds swap, downloads the weights from S3 and starts the service.

## Accuracy, honestly
Held-out IoU on 13 tiles: background 0.71, **roof 0.58**, **obstruction 0.24**, mean 0.51.
- Roof IoU is partly pulled down by our own labels: some validation tiles contain real roofs we did not label,
  which the model does find.
- The model finds large tanks, stair rooms and existing solar arrays, but misses small white tanks and AC units
  (6-9 px at 0.1 m/px). That is why correction by brush is part of the workflow, not an afterthought.
- Ground-truth check: ⟨TAPE-MEASURE RESULT, e.g. "roof measured 9.8 × 7.2 m = 70.6 m²; SolarScope 68 m² (-4%)"⟩.

Limits: small dataset from two cities; flush/low-tilt mounting assumed (no inter-row shading spacing); simple payback
without degradation or tariff escalation; tariff uses one slab (₹6.00, conservative; homes above 225 units/month save ₹8.75 per unit).

## Built during the event
Everything in the repository: the tile cutter, labelling tool, labels, training and ONNX export pipeline, backend
(geometry, panel layout, calculator, NASA POWER client), frontend, deployment script and tests (53). Commit history shows the timeline.

## AI tools used
Claude (Claude Code) was used as a pair programmer for code, tests, documentation and source research.

## Credits
Imagery: OpenAerialMap contributors, CC-BY 4.0 (Bhuvan; CSC). Irradiance: NASA LaRC POWER Project. Libraries and
licences: see `CREDITS.md`.

## Next steps
Larger and more diverse labelled set (more cities, more small obstructions), sun-path shading from tall obstructions,
per-slab bill calculation, and support for openly licensed satellite tiles for users without a drone image.
