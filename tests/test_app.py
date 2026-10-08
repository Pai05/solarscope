from fastapi.testclient import TestClient

from backend.app import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_frontend_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "SolarScope" in r.text
