from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

MAX_SIDE = 2048
ObsSide = Annotated[float, Field(gt=0.05, le=100)]  # one side of a typed obstruction, metres
RoofSide = Annotated[float, Field(gt=0.5, le=300)]  # one side (or diagonal) of a typed roof, metres

# Layout defaults. Panel: a traditional residential 60-cell (120 half-cell) module, about 1.65-1.70 x 1.0 m and
# 300-450 Wp; 350 Wp is mid-range. Smaller than the 2.27 x 1.13 m 540 Wp modules, so it fits small Indian roofs.
# Users can type their own panel size and power in Layout settings.
PANEL_DEFAULTS = {
    "panel_w_m": 1.70,
    "panel_h_m": 1.00,
    "panel_wp": 350.0,
    "setback_m": 0.3,  # walkway/cleaning gap at roof edges; 0.5 m left no room on narrow Indian roofs
    "obstruction_buffer_m": 0.3,
    # Small panel used to fill the gaps the standard panels leave (corners of slanted roofs, strips beside
    # tanks): a common 36-cell 100 Wp module, about 1.00 x 0.67 m.
    "small_panel_w_m": 1.00,
    "small_panel_h_m": 0.67,
    "small_panel_wp": 100.0,
    "fill_small_panels": True,
}


class ObstructionInput(BaseModel):
    """Real size of one obstruction painted on the photo, found by a point on it (photo px)."""
    x: float = Field(ge=0, le=MAX_SIDE)
    y: float = Field(ge=0, le=MAX_SIDE)
    size: tuple[ObsSide, ObsSide] | tuple[ObsSide, ObsSide, ObsSide, ObsSide] = Field(
        description="[length, width] for a rectangle, or [top, right, bottom, left] m as seen in the photo")


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
    fill_small_panels: bool = Field(default=PANEL_DEFAULTS["fill_small_panels"],
                                    description="fill space the standard panels leave with the small panel")
    small_panel_w_m: float = Field(default=PANEL_DEFAULTS["small_panel_w_m"], gt=0.2, le=4)
    small_panel_h_m: float = Field(default=PANEL_DEFAULTS["small_panel_h_m"], gt=0.2, le=4)
    small_panel_wp: float = Field(default=PANEL_DEFAULTS["small_panel_wp"], gt=5, le=1500)
    budget_inr: float | None = Field(default=None, gt=0, le=1e9,
                                     description="plan the largest system whose cost stays within this (INR)")
    roof_length_m: float | None = Field(default=None, gt=0.5, le=300,
                                        description="real roof length; with roof_width_m the marked roof is redrawn to scale")
    roof_width_m: float | None = Field(default=None, gt=0.5, le=300)
    roof_sides_m: tuple[RoofSide, RoofSide, RoofSide, RoofSide] | None = Field(
        default=None, description="4 roof sides (m) as seen in the photo: top, right, bottom, left (any 4-sided roof)")
    roof_diagonal_m: RoofSide | None = Field(
        default=None, description="optional diagonal (m) from the top-left to the bottom-right corner; fixes the shape")
    obstruction_inputs: list[ObstructionInput] | None = Field(
        default=None, max_length=50, description="typed obstruction sizes, each found by a point on it in the photo")
    obstruction_sizes: list[tuple[ObsSide, ObsSide] | tuple[ObsSide, ObsSide, ObsSide, ObsSide] | None] | None = Field(
        default=None, max_length=50,
        description="typed size per obstruction (order the report lists them): [length, width] or [top, right, bottom, left] m")
    budget_basis: Literal["net", "gross"] = Field(default="net",
                                                  description="budget covers the cost after subsidy (net) or upfront (gross)")
    overrides: dict[str, float] = Field(default_factory=dict)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=2000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    page: str | None = Field(default=None, max_length=20)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)
