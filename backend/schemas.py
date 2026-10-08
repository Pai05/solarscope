from __future__ import annotations

from pydantic import BaseModel, Field

MAX_SIDE = 2048

# Layout defaults. Panel: a common 540 Wp mono PERC 144 half-cell module (Waaree 540 Wp, 2272 x 1133 mm per
# retailer listings); still to be confirmed against the manufacturer's datasheet.
PANEL_DEFAULTS = {
    "panel_w_m": 2.272,
    "panel_h_m": 1.133,
    "panel_wp": 540.0,
    "setback_m": 0.5,
    "obstruction_buffer_m": 0.3,
}


class ReportRequest(BaseModel):
    width: int = Field(gt=0, le=MAX_SIDE)
    height: int = Field(gt=0, le=MAX_SIDE)
    mask_b64: str = Field(description="width*height uint8 class ids (0 bg, 1 roof, 2 obstruction), base64")
    gsd_m: float = Field(gt=0.005, le=2.0, description="metres per pixel of the mask")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    roof_point: tuple[int, int] | None = Field(default=None, description="(x, y) on the roof to analyse")
    roof_box: tuple[int, int, int, int] | None = Field(default=None, description="(x0, y0, x1, y1) area to analyse")
    setback_m: float = Field(default=PANEL_DEFAULTS["setback_m"], ge=0, le=5)
    obstruction_buffer_m: float = Field(default=PANEL_DEFAULTS["obstruction_buffer_m"], ge=0, le=3)
    panel_w_m: float = Field(default=PANEL_DEFAULTS["panel_w_m"], gt=0.3, le=4)
    panel_h_m: float = Field(default=PANEL_DEFAULTS["panel_h_m"], gt=0.3, le=4)
    panel_wp: float = Field(default=PANEL_DEFAULTS["panel_wp"], gt=10, le=1500)
    overrides: dict[str, float] = Field(default_factory=dict)
