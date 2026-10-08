# Labelling tiles

256x256 px RGB tiles at 0.1 m/px, cut by `training/make_tiles.py`. `manifest.csv` lists each tile's
source mosaic, provider, licence, source URL and centre lat/lon.

Imagery: OpenAerialMap, licensed **CC-BY 4.0**.
- "VJWD_FLOODS" (Vijayawada, India), provider: Bhuvan
- "Mohakhali part 1 of 1, Tejgaon" (Dhaka, Bangladesh), provider: CSC

Changes made: resampled to 0.1 m/px and cropped into tiles.
