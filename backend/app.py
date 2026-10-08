"""SolarScope FastAPI app: serves the frontend and the API from one process."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="SolarScope")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# Mounted last so API routes take precedence.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
