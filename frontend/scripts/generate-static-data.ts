import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Ohlc = { open: number; high: number; low: number; close: number };
type ConstituentSeries = { symbol: string; sharesOutstanding: number; bars: Ohlc[] };
type StrategyStats = { cagr: number; annVol: number; maxDrawdown: number; sharpe: number };
type StrategyName = "snp1" | "snp10";
type ScenarioName = "base" | "optimistic" | "pessimistic";

type ExecutionParams = {
  signalLagDays: number;
  executionVenue: string;
  spreadBpsPerSide: number;
  impactBpsPerSide: number;
  totalCostBpsPerTurnover: number;
  snp1LeaderAdvantageBps: number;
  snp10BufferRanks: number;
};

type ScenarioPayload = {
  metadata: {
    generatedAt: string;
    formulaVersion: string;
    commitSha: string;
    assumptions: string[];
    strategy: StrategyName;
    scenario: ScenarioName;
    tradingDaysPerYear: number;
    years: number;
    execution: ExecutionParams;
  };
  series: {
    dates: string[];
    sp500: number[];
    strategy: number[];
    sp500Returns: number[];
    strategyReturns: number[];
  };
  diagnostics: {
    holdings: string[] | string[][];
    executedRebalances: Array<{ date: string; details: string }>;
  };
  stats: { sp500: StrategyStats; strategy: StrategyStats };
};

type MarketDataProvider = {
  getData(): { dates: string[]; benchmarkClose: number[]; constituents: ConstituentSeries[] };
};

const TRADING_DAYS = 252;
const END_DATE = new Date("2026-03-07T00:00:00Z");
const FORMULA_VERSION = "snp1-snp10-v3-base-execution";
const TIMEFRAMES = [5, 10, 25, 50] as const;

const BASE_EXECUTION: ExecutionParams = {
  signalLagDays: 1,
  executionVenue: "next-day-open",
  spreadBpsPerSide: 5,
  impactBpsPerSide: 7,
  totalCostBpsPerTurnover: 12,
  snp1LeaderAdvantageBps: 35,
  snp10BufferRanks: 2,
};

const CONSTITUENTS: Array<{ symbol: string; startPrice: number; sharesOutstanding: number; drift: number; vol: number }> = [
  { symbol: "AAPL", startPrice: 30, sharesOutstanding: 16_800_000_000, drift: 0.16, vol: 0.28 },
  { symbol: "MSFT", startPrice: 25, sharesOutstanding: 7_500_000_000, drift: 0.15, vol: 0.24 },
  { symbol: "AMZN", startPrice: 18, sharesOutstanding: 10_000_000_000, drift: 0.14, vol: 0.33 },
  { symbol: "NVDA", startPrice: 12, sharesOutstanding: 2_500_000_000, drift: 0.22, vol: 0.45 },
  { symbol: "GOOGL", startPrice: 20, sharesOutstanding: 12_400_000_000, drift: 0.13, vol: 0.27 },
  { symbol: "META", startPrice: 15, sharesOutstanding: 2_600_000_000, drift: 0.14, vol: 0.34 },
  { symbol: "BRK.B", startPrice: 45, sharesOutstanding: 2_300_000_000, drift: 0.1, vol: 0.2 },
  { symbol: "XOM", startPrice: 28, sharesOutstanding: 4_100_000_000, drift: 0.09, vol: 0.26 },
  { symbol: "JPM", startPrice: 22, sharesOutstanding: 2_900_000_000, drift: 0.09, vol: 0.23 },
  { symbol: "V", startPrice: 35, sharesOutstanding: 2_100_000_000, drift: 0.11, vol: 0.22 },
];

function businessDaysEndingAt(end: Date, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(end);
  while (out.length < count) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out.reverse();
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

function computeStats(returns: number[], levelsWithBase: number[]): StrategyStats {
  const periods = returns.length;
  const years = periods / TRADING_DAYS;
  const ending = levelsWithBase[levelsWithBase.length - 1];
  const starting = levelsWithBase[0];
  const cagr = Math.pow(ending / starting, 1 / years) - 1;

  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(returns.length, 1);
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / Math.max(returns.length, 1);
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

class MockMarketDataProvider implements MarketDataProvider {
  private years: number;
  constructor(years: number) { this.years = years; }

  getData() {
    const totalDays = TRADING_DAYS * this.years;
    const dates = businessDaysEndingAt(END_DATE, totalDays);
    const constituents = CONSTITUENTS.map((c) => ({
      symbol: c.symbol,
      sharesOutstanding: c.sharesOutstanding,
      bars: this.generateBars(c.symbol, c.startPrice, c.drift, c.vol, totalDays),
    }));

    const benchmarkClose = this.generateBenchmark(totalDays);

    return { dates, benchmarkClose, constituents };
  }

  private generateBars(symbol: string, startPrice: number, drift: number, vol: number, totalDays: number): Ohlc[] {
    const bars: Ohlc[] = [];
    let prevClose = startPrice;

    const muDaily = drift / TRADING_DAYS;
    const sigmaDaily = vol / Math.sqrt(TRADING_DAYS);

    for (let i = 0; i < totalDays; i += 1) {
      const overnight = normal(`${symbol}:overnight`, i) * (sigmaDaily * 0.35);
      const intraday = normal(`${symbol}:intraday`, i) * (sigmaDaily * 0.8);
      const open = Math.max(0.5, prevClose * (1 + overnight));
      const close = Math.max(0.5, open * (1 + muDaily + intraday));

      const rangeNoise = Math.abs(normal(`${symbol}:range`, i)) * sigmaDaily * 1.2;
      const highBase = Math.max(open, close);
      const lowBase = Math.min(open, close);
      const high = highBase * (1 + rangeNoise);
      const low = Math.max(0.25, lowBase * (1 - rangeNoise));

      bars.push({ open, high, low, close });
      prevClose = close;
    }

    return bars;
  }

  private generateBenchmark(totalDays: number): number[] {
    const out: number[] = [];
    let level = 100;

    const muDaily = 0.1 / TRADING_DAYS;
    const sigmaDaily = 0.18 / Math.sqrt(TRADING_DAYS);

    for (let i = 0; i < totalDays; i += 1) {
      const ret = muDaily + sigmaDaily * normal("SP500", i);
      level *= 1 + ret;
      out.push(level);
    }

    return out;
  }
}

function marketCaps(constituents: ConstituentSeries[], dayIndex: number): Array<{ symbol: string; cap: number }> {
  return constituents
    .map((c) => ({ symbol: c.symbol, cap: c.bars[dayIndex].close * c.sharesOutstanding }))
    .sort((a, b) => b.cap - a.cap);
}

function averageOpenClose(bar: Ohlc): number {
  return (bar.open + bar.close) / 2;
}

function simulateSnp1(
  providerData: ReturnType<MarketDataProvider["getData"]>,
  scenario: ScenarioName,
  metadataBase: Omit<ScenarioPayload["metadata"], "scenario" | "strategy">
): ScenarioPayload {
  const { dates, constituents, benchmarkClose } = providerData;
  const symbolMap = new Map(constituents.map((c) => [c.symbol, c]));
  const rankings = dates.map((_, idx) => marketCaps(constituents, idx));
  const top1Symbols = rankings.map((r) => r[0].symbol);

  const holdingByDate: string[] = new Array(dates.length);
  const executedRebalances: Array<{ date: string; details: string }> = [];

  let holding = top1Symbols[0];
  holdingByDate[0] = holding;
  let pendingSwap: { from: string; to: string } | null = null;

  const levels = [100];
  const returns: number[] = [0];

  for (let i = 1; i < dates.length; i += 1) {
    const valueStart = levels[levels.length - 1];
    let valueEnd = valueStart;

    if (pendingSwap) {
      const oldSeries = symbolMap.get(pendingSwap.from)!;
      const newSeries = symbolMap.get(pendingSwap.to)!;
      const sharesOld = valueStart / oldSeries.bars[i - 1].close;

      let sellPrice = oldSeries.bars[i].open;
      let buyPrice = newSeries.bars[i].open;
      let sellCost = 0;
      let buyCost = 0;

      if (scenario === "optimistic") {
        sellPrice = averageOpenClose(oldSeries.bars[i]);
        buyPrice = averageOpenClose(newSeries.bars[i]);
      } else if (scenario === "pessimistic") {
        sellPrice = oldSeries.bars[i].low;
        buyPrice = newSeries.bars[i].high;
      } else {
        const sideCost = BASE_EXECUTION.totalCostBpsPerTurnover / 10_000;
        sellCost = sideCost;
        buyCost = sideCost;
      }

      const cash = sharesOld * sellPrice * (1 - sellCost);
      const sharesNew = cash / (buyPrice * (1 + buyCost));
      valueEnd = sharesNew * newSeries.bars[i].close;
      holding = pendingSwap.to;
      executedRebalances.push({ date: dates[i], details: `${pendingSwap.from}->${pendingSwap.to}` });
      pendingSwap = null;
    } else {
      const holdSeries = symbolMap.get(holding)!;
      valueEnd = valueStart * (holdSeries.bars[i].close / holdSeries.bars[i - 1].close);
    }

    returns.push(valueEnd / valueStart - 1);
    levels.push(valueEnd);

    const prevTop = top1Symbols[i - 1];
    const targetTop = top1Symbols[i];
    if (scenario === "base") {
      if (targetTop !== holding) {
        const prevCaps = rankings[i - 1];
        const topCap = prevCaps.find((x) => x.symbol === targetTop)!.cap;
        const holdCap = prevCaps.find((x) => x.symbol === holding)!.cap;
        const advantageBps = (topCap / holdCap - 1) * 10_000;
        if (advantageBps >= BASE_EXECUTION.snp1LeaderAdvantageBps) {
          pendingSwap = { from: holding, to: targetTop };
        }
      }
    } else if (prevTop !== targetTop) {
      pendingSwap = { from: holding, to: targetTop };
    }

    holdingByDate[i] = holding;
  }

  const sp500Returns = benchmarkClose.map((level, i) => (i === 0 ? 0 : level / benchmarkClose[i - 1] - 1));

  return {
    metadata: { ...metadataBase, strategy: "snp1", scenario },
    series: { dates, sp500: benchmarkClose, strategy: levels, sp500Returns, strategyReturns: returns },
    diagnostics: { holdings: holdingByDate, executedRebalances },
    stats: {
      sp500: computeStats(sp500Returns, [100, ...benchmarkClose]),
      strategy: computeStats(returns, [100, ...levels]),
    },
  };
}

function simulateSnp10Base(
  providerData: ReturnType<MarketDataProvider["getData"]>,
  metadataBase: Omit<ScenarioPayload["metadata"], "scenario" | "strategy">
): ScenarioPayload {
  const { dates, constituents, benchmarkClose } = providerData;
  const symbolMap = new Map(constituents.map((c) => [c.symbol, c]));
  const rankings = dates.map((_, idx) => marketCaps(constituents, idx));

  const holdings: string[][] = new Array(dates.length).fill(null).map(() => []);
  const executedRebalances: Array<{ date: string; details: string }> = [];

  const firstTop10 = rankings[0].slice(0, 10).map((x) => x.symbol);
  let currentSet = new Set(firstTop10);
  let prevWeights = new Map<string, number>();
  const firstCaps = rankings[0].filter((x) => currentSet.has(x.symbol));
  const firstTotalCap = firstCaps.reduce((a, b) => a + b.cap, 0);
  for (const p of firstCaps) prevWeights.set(p.symbol, p.cap / firstTotalCap);
  holdings[0] = [...currentSet].sort();

  const levels = [100];
  const returns = [0];

  for (let i = 1; i < dates.length; i += 1) {
    const valueStart = levels[levels.length - 1];

    const rankPrev = rankings[i - 1];
    const rankMap = new Map(rankPrev.map((x, idx) => [x.symbol, idx + 1]));

    const keep = [...currentSet].filter((s) => (rankMap.get(s) ?? 999) <= 10 + BASE_EXECUTION.snp10BufferRanks);
    const candidates = rankPrev.map((x) => x.symbol).filter((s) => !keep.includes(s));
    while (keep.length < 10) keep.push(candidates.shift()!);
    const targetSet = new Set(keep.slice(0, 10));

    const targetCaps = rankPrev.filter((x) => targetSet.has(x.symbol));
    const totalCap = targetCaps.reduce((a, b) => a + b.cap, 0);
    const targetWeights = new Map<string, number>();
    for (const p of targetCaps) targetWeights.set(p.symbol, p.cap / totalCap);

    const universe = new Set([...prevWeights.keys(), ...targetWeights.keys()]);
    let closeToOpen = 0;
    for (const s of universe) {
      const w = prevWeights.get(s) ?? 0;
      if (w === 0) continue;
      const bars = symbolMap.get(s)!.bars;
      closeToOpen += w * (bars[i].open / bars[i - 1].close - 1);
    }

    const afterOpen = valueStart * (1 + closeToOpen);

    let sumAbsDelta = 0;
    for (const s of universe) sumAbsDelta += Math.abs((targetWeights.get(s) ?? 0) - (prevWeights.get(s) ?? 0));
    const oneWayTurnover = 0.5 * sumAbsDelta;
    const costRate = BASE_EXECUTION.totalCostBpsPerTurnover / 10_000;
    const cost = afterOpen * oneWayTurnover * costRate;

    let openToClose = 0;
    for (const [s, w] of targetWeights) {
      const bars = symbolMap.get(s)!.bars;
      openToClose += w * (bars[i].close / bars[i].open - 1);
    }

    const valueEnd = Math.max(0.0001, (afterOpen - cost) * (1 + openToClose));

    if (oneWayTurnover > 0.0001) {
      executedRebalances.push({
        date: dates[i],
        details: `turnover=${(oneWayTurnover * 100).toFixed(2)}% costBps=${BASE_EXECUTION.totalCostBpsPerTurnover}`,
      });
    }

    returns.push(valueEnd / valueStart - 1);
    levels.push(valueEnd);
    currentSet = targetSet;
    prevWeights = targetWeights;
    holdings[i] = [...currentSet].sort();
  }

  const sp500Returns = benchmarkClose.map((level, i) => (i === 0 ? 0 : level / benchmarkClose[i - 1] - 1));

  return {
    metadata: { ...metadataBase, strategy: "snp10", scenario: "base" },
    series: { dates, sp500: benchmarkClose, strategy: levels, sp500Returns, strategyReturns: returns },
    diagnostics: { holdings, executedRebalances },
    stats: {
      sp500: computeStats(sp500Returns, [100, ...benchmarkClose]),
      strategy: computeStats(returns, [100, ...levels]),
    },
  };
}

function toCsv(payload: ScenarioPayload): string {
  const lines = ["date,sp500,strategy,sp500Return,strategyReturn,holding,rebalanced"];
  const rebalanceDates = new Set(payload.diagnostics.executedRebalances.map((s) => s.date));

  for (let i = 0; i < payload.series.dates.length; i += 1) {
    const holding = Array.isArray(payload.diagnostics.holdings[i])
      ? (payload.diagnostics.holdings[i] as string[]).join("|")
      : (payload.diagnostics.holdings[i] as string);
    const row = [
      payload.series.dates[i],
      payload.series.sp500[i].toFixed(6),
      payload.series.strategy[i].toFixed(6),
      payload.series.sp500Returns[i].toFixed(10),
      payload.series.strategyReturns[i].toFixed(10),
      holding,
      rebalanceDates.has(payload.series.dates[i]) ? "1" : "0",
    ];
    lines.push(row.join(","));
  }

  return lines.join("\n");
}

function getCommitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const outDir = path.join(projectRoot, "public", "data");
  mkdirSync(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const commitSha = getCommitSha();
  const assumptions = [
    "Universe constrained to mock S&P500 constituents listed in script",
    "Trading calendar uses weekdays only and omits exchange holidays",
    "Signals formed from close-price market caps on day t and executed at day t+1 open",
    "Base scenario applies explicit per-turnover execution costs and hysteresis to reduce churn",
    "SNP1 base rotates only when leader exceeds incumbent by configured bps threshold",
    "SNP10 base uses sticky rank buffer around top-10 edges before membership changes",
    "Optimistic/Pessimistic SNP1 remain stress bounds using favorable/adverse fills",
    "Benchmark SP500 path is deterministic synthetic close series",
  ];

  const artifacts: Array<{ strategy: StrategyName; scenario: ScenarioName; timeframeYears: number; json: string; csv: string }> = [];

  for (const years of TIMEFRAMES) {
    const provider = new MockMarketDataProvider(years);
    const marketData = provider.getData();
    const metadataBase = {
      generatedAt,
      formulaVersion: FORMULA_VERSION,
      commitSha,
      assumptions,
      tradingDaysPerYear: TRADING_DAYS,
      years,
      execution: BASE_EXECUTION,
    };

    const payloads: ScenarioPayload[] = [
      simulateSnp1(marketData, "base", metadataBase),
      simulateSnp1(marketData, "optimistic", metadataBase),
      simulateSnp1(marketData, "pessimistic", metadataBase),
      simulateSnp10Base(marketData, metadataBase),
    ];

    for (const payload of payloads) {
      const base = `sp500_vs_${payload.metadata.strategy}_${payload.metadata.scenario}_${years}y`;
      const jsonFile = `${base}.json`;
      const csvFile = `${base}.csv`;
      writeFileSync(path.join(outDir, jsonFile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      writeFileSync(path.join(outDir, csvFile), `${toCsv(payload)}\n`, "utf8");
      artifacts.push({
        strategy: payload.metadata.strategy,
        scenario: payload.metadata.scenario,
        timeframeYears: years,
        json: `/data/${jsonFile}`,
        csv: `/data/${csvFile}`,
      });
    }
  }

  const manifest = {
    metadata: {
      generatedAt,
      formulaVersion: FORMULA_VERSION,
      commitSha,
      assumptions,
      execution: BASE_EXECUTION,
      supportedTimeframesYears: [...TIMEFRAMES],
      supportedStrategies: ["snp1", "snp10"],
      supportedScenariosByStrategy: {
        snp1: ["base", "optimistic", "pessimistic"],
        snp10: ["base"],
      },
      defaultTimeframeYears: 25,
      defaultStrategy: "snp1",
      defaultScenario: "base",
    },
    artifacts,
  };

  writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Generated static data into ${outDir}`);
}

main();
