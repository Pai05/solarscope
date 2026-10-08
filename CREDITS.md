# Credits and licences

Every third-party dataset, pretrained model, imagery source and library used by SolarScope.

## Imagery

| Source | Where | Provider | Licence | Used for |
|---|---|---|---|---|
| [OpenAerialMap](https://openaerialmap.org): "VJWD_FLOODS" | Vijayawada, India (drone, ~2.8 cm/px) | Bhuvan | CC-BY 4.0 | Labelling tiles, demo samples |
| [OpenAerialMap](https://openaerialmap.org): "Mohakhali part 1 of 1, Tejgaon" | Dhaka, Bangladesh (drone, ~1.5 cm/px) | CSC | CC-BY 4.0 | Labelling tiles |

Changes: resampled to 0.1 m/px and cropped into 256 px tiles (`training/tiles`) and 512 px samples
(`frontend/samples`). Per-tile source URLs are in `training/tiles/manifest.csv` and `frontend/samples/samples.json`.

Not used: Google Maps / Earth, Bing, Esri World Imagery or Mapbox Satellite.
The Massachusetts Buildings dataset was considered and rejected (no stated licence, 1 m/px, US only).

## Labels

Hand-labelled by the SolarScope team during the hackathon (classes: roof, obstruction) in Roboflow,
exported as COCO and converted with `training/coco_to_masks.py`. Released with this repo under MIT.

## Data APIs

| Source | Licence / terms | Used for |
|---|---|---|
| [NASA POWER](https://power.larc.nasa.gov) climatology API (`ALLSKY_SFC_SW_DWN`) | NASA open data; acknowledgement requested | Site solar irradiance |

"These data were obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program."

## Pretrained weights

| Model | Licence | Notes |
|---|---|---|
| ResNet-34 ImageNet encoder via segmentation-models-pytorch | BSD-3 (torchvision weights) | Encoder initialisation only; the U-Net was trained by us on the tiles above. ImageNet itself is a research dataset. |

## Libraries

| Name | Use | Licence |
|---|---|---|
| FastAPI | Web API | MIT |
| Uvicorn | ASGI server | BSD-3-Clause |
| python-multipart | File uploads | Apache-2.0 |
| NumPy | Arrays | BSD-3-Clause |
| SciPy | Distance transform, labelling | BSD-3-Clause |
| Pillow | Images | MIT-CMU (HPND) |
| ONNX Runtime | CPU inference on the server | MIT |
| PyTorch | Training | BSD-3-Clause |
| segmentation-models-pytorch | U-Net | MIT |
| ONNX | Model export | Apache-2.0 |
| rasterio / GDAL | Reading OpenAerialMap GeoTIFFs | BSD-3-Clause / MIT |
| pytest, httpx | Tests | MIT, BSD-3-Clause |

## Official sources for economic inputs

| Input | Source |
|---|---|
| Grid emission factor | Central Electricity Authority, CO2 Baseline Database for the Indian Power Sector, User Guide v22.0 (Aug 2026) |
| Domestic tariff | APCPDCL Retail Supply Tariff FY 2025-26 (ARR brief note); APERC continuation for FY 2026-27 |
| Subsidy | PM Surya Ghar: Muft Bijli Yojana, Union Cabinet approval, 29 Feb 2024 |
| Benchmark cost | MNRE PM Surya Ghar guidelines (general category states) |

## Economic inputs

Listed with their sources in `backend/solar_calc.py` and in the app's "Assumptions and sources" table.
Values marked "to verify" are placeholders until checked against the named official source.
