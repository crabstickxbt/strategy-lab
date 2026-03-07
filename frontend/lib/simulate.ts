import type { SimulateParams, SimulationResponse, StrategyResult, StrategyStats } from "./types";

const TRADING_DAYS = 252;
const SERIES_LENGTH = TRADING_DAYS * 5;
const START_DATE = new Date("2021-01-04T00:00:00Z");

const SP500_PARAMS = {
  drift: 0.09,
  vol: 0.18,
  shockFrequency: 0.015,
  shockAmplitude: 0.03,
};

function businessDays(start: Date, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(start);
  while (out.length < count) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function hash64(stream: string, idx: number, salt: number): bigint {
  const input = `${stream}:${idx}:${salt}`;
  let h = 1469598103934665603n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h *= 1099511628211n;
    h &= (1n << 64n) - 1n;
  }
  return h;
}

function uniform01(stream: string, idx: number, salt: number): number {
  const value = hash64(stream, idx, salt);
  return Number(value + 1n) / Number((1n << 64n) + 1n);
}

function normal(stream: string, idx: number): number {
  const u1 = uniform01(stream, idx, 1);
  const u2 = uniform01(stream, idx, 2);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return radius * Math.cos(theta);
}

function shock(stream: string, idx: number, shockFrequency: number, shockAmplitude: number): number {
  const eventU = uniform01(stream, idx, 3);
  if (eventU >= shockFrequency) return 0;
  const signU = uniform01(stream, idx, 4);
  return (signU > 0.5 ? 1 : -1) * shockAmplitude;
}

function computeStats(returns: number[], levelsWithBase: number[]): StrategyStats {
  const periods = returns.length;
  const years = periods / TRADING_DAYS;
  const ending = levelsWithBase[levelsWithBase.length - 1];
  const starting = levelsWithBase[0];
  const cagr = Math.pow(ending / starting, 1 / years) - 1;

  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length || 1);
  const annVol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  const annReturn = mean * TRADING_DAYS;
  const sharpe = annVol > 0 ? annReturn / annVol : 0;

  let peak = levelsWithBase[0];
  let maxDrawdown = 0;
  for (let i = 1; i < levelsWithBase.length; i += 1) {
    const level = levelsWithBase[i];
    if (level > peak) peak = level;
    const drawdown = level / peak - 1;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }

  return { cagr, annVol, maxDrawdown, sharpe };
}

function simulateSeries(name: string, params: SimulateParams): StrategyResult {
  const dates = businessDays(START_DATE, SERIES_LENGTH);
  const returns: number[] = [];
  const levels: number[] = [];
  const levelsWithBase = [100];

  const muDaily = params.drift / TRADING_DAYS;
  const sigmaDaily = params.vol / Math.sqrt(TRADING_DAYS);

  for (let i = 0; i < SERIES_LENGTH; i += 1) {
    const innovation = normal(name, i);
    const jump = shock(name, i, params.shockFrequency, params.shockAmplitude);
    const dailyReturn = muDaily + sigmaDaily * innovation + jump;
    returns.push(dailyReturn);
    levelsWithBase.push(levelsWithBase[levelsWithBase.length - 1] * (1 + dailyReturn));
    levels.push(levelsWithBase[levelsWithBase.length - 1]);
  }

  return {
    dates,
    returns,
    levels,
    stats: computeStats(returns, levelsWithBase),
  };
}

export function simulateLocal(params: SimulateParams): SimulationResponse {
  return {
    meta: { periodYears: 5, tradingDays: TRADING_DAYS, seed: "deterministic-hash-v1" },
    sp500: simulateSeries("SP500", SP500_PARAMS),
    snp1: simulateSeries("SNP1", params),
  };
}
