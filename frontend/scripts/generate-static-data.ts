import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Ohlc = { open: number; high: number; low: number; close: number };
type ConstituentSeries = { symbol: string; sharesOutstanding: number; bars: Ohlc[] };
type StrategyStats = { cagr: number; annVol: number; maxDrawdown: number; sharpe: number };

type ScenarioPayload = {
  metadata: {
    generatedAt: string;
    formulaVersion: string;
    commitSha: string;
    assumptions: string[];
    scenario: "optimistic" | "pessimistic";
    tradingDaysPerYear: number;
    years: number;
  };
  series: {
    dates: string[];
    sp500: number[];
    snp1: number[];
    sp500Returns: number[];
    snp1Returns: number[];
  };
  top1ByDate: string[];
  holdingByDate: string[];
  executedSwaps: Array<{ date: string; from: string; to: string }>;
  stats: { sp500: StrategyStats; snp1: StrategyStats };
};

type MarketDataProvider = {
  getData(): { dates: string[]; benchmarkClose: number[]; constituents: ConstituentSeries[] };
};

const TRADING_DAYS = 252;
const START_DATE = new Date("2000-01-03T00:00:00Z");
const FORMULA_VERSION = "snp1-v2-timeframes";
const TIMEFRAMES = [5, 10, 25] as const;

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
    const dates = businessDays(START_DATE, totalDays);
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

function top1ByMarketCap(constituents: ConstituentSeries[], dayIndex: number): string {
  let topSymbol = constituents[0].symbol;
  let topCap = -Infinity;
  for (const c of constituents) {
    const cap = c.bars[dayIndex].close * c.sharesOutstanding;
    if (cap > topCap) {
      topCap = cap;
      topSymbol = c.symbol;
    }
  }
  return topSymbol;
}

function averageOpenClose(bar: Ohlc): number {
  return (bar.open + bar.close) / 2;
}

function scenarioFromData(
  providerData: ReturnType<MarketDataProvider["getData"]>,
  scenario: "optimistic" | "pessimistic",
  metadataBase: Omit<ScenarioPayload["metadata"], "scenario">
): ScenarioPayload {
  const { dates, constituents, benchmarkClose } = providerData;
  const symbolMap = new Map(constituents.map((c) => [c.symbol, c]));

  const top1Symbols = dates.map((_, idx) => top1ByMarketCap(constituents, idx));

  const holdingByDate: string[] = new Array(dates.length);
  const executedSwaps: Array<{ date: string; from: string; to: string }> = [];

  let holding = top1Symbols[0];
  holdingByDate[0] = holding;
  let pendingSwap: { from: string; to: string } | null = null;

  const snp1Levels = [100];
  const snp1Returns: number[] = [];

  for (let i = 1; i < dates.length; i += 1) {
    const prevHolding = holding;

    if (pendingSwap) {
      const oldSeries = symbolMap.get(pendingSwap.from)!;
      const newSeries = symbolMap.get(pendingSwap.to)!;

      const valueStart = snp1Levels[snp1Levels.length - 1];
      const sharesOld = valueStart / oldSeries.bars[i - 1].close;

      const sellPrice = scenario === "optimistic" ? averageOpenClose(oldSeries.bars[i]) : oldSeries.bars[i].low;
      const buyPrice = scenario === "optimistic" ? averageOpenClose(newSeries.bars[i]) : newSeries.bars[i].high;

      const cash = sharesOld * sellPrice;
      const sharesNew = cash / buyPrice;
      const valueEnd = sharesNew * newSeries.bars[i].close;

      snp1Returns.push(valueEnd / valueStart - 1);
      snp1Levels.push(valueEnd);
      holding = pendingSwap.to;
      executedSwaps.push({ date: dates[i], from: pendingSwap.from, to: pendingSwap.to });
      pendingSwap = null;
    } else {
      const holdSeries = symbolMap.get(holding)!;
      const valueStart = snp1Levels[snp1Levels.length - 1];
      const valueEnd = valueStart * (holdSeries.bars[i].close / holdSeries.bars[i - 1].close);
      snp1Returns.push(valueEnd / valueStart - 1);
      snp1Levels.push(valueEnd);
    }

    const topChangeAtPrevDay = top1Symbols[i - 1] !== top1Symbols[i];
    if (topChangeAtPrevDay) pendingSwap = { from: holding, to: top1Symbols[i] };

    holdingByDate[i] = holding;
    if (!holdingByDate[i - 1]) holdingByDate[i - 1] = prevHolding;
  }

  const sp500Levels = benchmarkClose;
  const sp500Returns = sp500Levels.map((level, i) => (i === 0 ? level / 100 - 1 : level / sp500Levels[i - 1] - 1));

  return {
    metadata: { ...metadataBase, scenario },
    series: {
      dates,
      sp500: sp500Levels,
      snp1: snp1Levels,
      sp500Returns,
      snp1Returns: [snp1Levels[0] / 100 - 1, ...snp1Returns],
    },
    top1ByDate: top1Symbols,
    holdingByDate,
    executedSwaps,
    stats: {
      sp500: computeStats(sp500Returns, [100, ...sp500Levels]),
      snp1: computeStats([snp1Levels[0] / 100 - 1, ...snp1Returns], [100, ...snp1Levels]),
    },
  };
}

function toCsv(payload: ScenarioPayload): string {
  const lines = ["date,sp500,snp1,sp500Return,snp1Return,top1Ticker,holdingTicker,swapExecuted"];
  const swapDates = new Set(payload.executedSwaps.map((s) => s.date));

  for (let i = 0; i < payload.series.dates.length; i += 1) {
    const row = [
      payload.series.dates[i],
      payload.series.sp500[i].toFixed(6),
      payload.series.snp1[i].toFixed(6),
      payload.series.sp500Returns[i].toFixed(10),
      payload.series.snp1Returns[i].toFixed(10),
      payload.top1ByDate[i],
      payload.holdingByDate[i],
      swapDates.has(payload.series.dates[i]) ? "1" : "0",
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
    "Top1 selection uses close-price market cap each day",
    "Swap after top1 change at day t executes at day t+1",
    "Pessimistic execution uses sell@LOW and buy@HIGH on execution day",
    "Optimistic execution uses average(open,close) for both legs",
    "Benchmark SP500 path is deterministic synthetic close series",
    "Mock provider can be replaced by real provider via MarketDataProvider interface",
  ];

  const artifacts: Array<{ scenario: string; timeframeYears: number; json: string; csv: string }> = [];

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
    };

    for (const scenario of ["optimistic", "pessimistic"] as const) {
      const payload = scenarioFromData(marketData, scenario, metadataBase);
      const base = `sp500_vs_snp1_${scenario}_${years}y`;
      const jsonFile = `${base}.json`;
      const csvFile = `${base}.csv`;
      writeFileSync(path.join(outDir, jsonFile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      writeFileSync(path.join(outDir, csvFile), `${toCsv(payload)}\n`, "utf8");
      artifacts.push({ scenario, timeframeYears: years, json: `/data/${jsonFile}`, csv: `/data/${csvFile}` });
    }
  }

  const manifest = {
    metadata: {
      generatedAt,
      formulaVersion: FORMULA_VERSION,
      commitSha,
      assumptions,
      supportedTimeframesYears: [...TIMEFRAMES],
      defaultTimeframeYears: 25,
      defaultScenario: "optimistic",
    },
    artifacts,
  };

  writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Generated static data into ${outDir}`);
}

main();
