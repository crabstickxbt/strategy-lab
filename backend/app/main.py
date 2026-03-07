from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .simulation import StrategyParams, simulate_series


class SimulateRequest(BaseModel):
    drift: float = Field(0.10, ge=-1.0, le=1.0)
    vol: float = Field(0.20, ge=0.0, le=3.0)
    shockFrequency: float = Field(0.02, ge=0.0, le=1.0)
    shockAmplitude: float = Field(0.04, ge=0.0, le=1.0)


SP500_PARAMS = StrategyParams(
    drift=0.09,
    vol=0.18,
    shock_frequency=0.015,
    shock_amplitude=0.03,
)

app = FastAPI(title="Strategy Lab API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/simulate")
def simulate(payload: SimulateRequest) -> dict:
    snp1_params = StrategyParams(
        drift=payload.drift,
        vol=payload.vol,
        shock_frequency=payload.shockFrequency,
        shock_amplitude=payload.shockAmplitude,
    )

    sp500 = simulate_series("SP500", SP500_PARAMS)
    snp1 = simulate_series("SNP1", snp1_params)

    return {
        "meta": {
            "periodYears": 5,
            "tradingDays": 252,
            "seed": "deterministic-hash-v1",
        },
        "sp500": sp500,
        "snp1": snp1,
    }
