from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from hashlib import sha256
from math import cos, log, pi, sqrt
from statistics import mean, pstdev

TRADING_DAYS = 252
SERIES_LENGTH = TRADING_DAYS * 5
START_DATE = date(2021, 1, 4)


@dataclass(frozen=True)
class StrategyParams:
    drift: float
    vol: float
    shock_frequency: float
    shock_amplitude: float


def _business_days(start: date, count: int) -> list[date]:
    days: list[date] = []
    cursor = start
    while len(days) < count:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _uniform_0_1(stream: str, idx: int, salt: int) -> float:
    payload = f"{stream}:{idx}:{salt}".encode("utf-8")
    hashed = sha256(payload).digest()
    value = int.from_bytes(hashed[:8], "big")
    return (value + 1) / (2**64 + 1)


def _normal(stream: str, idx: int) -> float:
    u1 = _uniform_0_1(stream, idx, 1)
    u2 = _uniform_0_1(stream, idx, 2)
    radius = sqrt(-2.0 * log(u1))
    theta = 2.0 * pi * u2
    return radius * cos(theta)


def _shock(stream: str, idx: int, frequency: float, amplitude: float) -> float:
    event_u = _uniform_0_1(stream, idx, 3)
    if event_u >= frequency:
        return 0.0
    sign_u = _uniform_0_1(stream, idx, 4)
    sign = 1.0 if sign_u > 0.5 else -1.0
    return sign * amplitude


def simulate_series(name: str, params: StrategyParams) -> dict:
    dates = _business_days(START_DATE, SERIES_LENGTH)
    base_level = 100.0
    levels = [base_level]
    returns: list[float] = []

    mu_daily = params.drift / TRADING_DAYS
    sigma_daily = params.vol / sqrt(TRADING_DAYS)

    for i in range(SERIES_LENGTH):
        innovation = _normal(name, i)
        jump = _shock(name, i, params.shock_frequency, params.shock_amplitude)
        daily_return = mu_daily + sigma_daily * innovation + jump
        returns.append(daily_return)
        levels.append(levels[-1] * (1.0 + daily_return))

    return {
        "dates": [d.isoformat() for d in dates],
        "returns": returns,
        "levels": levels[1:],
        "stats": compute_stats(returns, levels),
    }


def compute_stats(returns: list[float], levels_with_base: list[float]) -> dict:
    periods = len(returns)
    years = periods / TRADING_DAYS
    ending = levels_with_base[-1]
    starting = levels_with_base[0]
    cagr = (ending / starting) ** (1.0 / years) - 1.0

    ann_vol = pstdev(returns) * sqrt(TRADING_DAYS) if periods > 1 else 0.0
    ann_return = mean(returns) * TRADING_DAYS if periods > 0 else 0.0
    sharpe = ann_return / ann_vol if ann_vol > 0 else 0.0

    peak = levels_with_base[0]
    max_drawdown = 0.0
    for level in levels_with_base[1:]:
        if level > peak:
            peak = level
        drawdown = (level / peak) - 1.0
        if drawdown < max_drawdown:
            max_drawdown = drawdown

    return {
        "cagr": cagr,
        "annVol": ann_vol,
        "maxDrawdown": max_drawdown,
        "sharpe": sharpe,
    }
