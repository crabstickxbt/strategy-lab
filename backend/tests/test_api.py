from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_simulate_shape_and_stats() -> None:
    payload = {
        "drift": 0.11,
        "vol": 0.23,
        "shockFrequency": 0.03,
        "shockAmplitude": 0.05,
    }

    response = client.post("/simulate", json=payload)
    assert response.status_code == 200

    data = response.json()
    assert set(data.keys()) == {"meta", "sp500", "snp1"}
    assert data["meta"]["periodYears"] == 5

    for key in ("sp500", "snp1"):
        section = data[key]
        assert len(section["dates"]) == 1260
        assert len(section["returns"]) == 1260
        assert len(section["levels"]) == 1260
        assert set(section["stats"].keys()) == {
            "cagr",
            "annVol",
            "maxDrawdown",
            "sharpe",
        }


def test_simulate_is_deterministic() -> None:
    payload = {
        "drift": 0.10,
        "vol": 0.2,
        "shockFrequency": 0.02,
        "shockAmplitude": 0.04,
    }

    first = client.post("/simulate", json=payload)
    second = client.post("/simulate", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
