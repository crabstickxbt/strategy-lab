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
    dataSource: {
      provider: string;
      benchmarkSymbol: string;
      benchmarkProxyLabel: string;
      constituentSymbols: string[];
      symbolToStooq: Record<string, string>;
      dateRange: { start: string; end: string };
      generatedFromAlignedTradingDates: boolean;
      rankingMethod: string;
    };
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
  getData(years: number): Promise<{ dates: string[]; benchmarkClose: number[]; constituents: ConstituentSeries[] }>;
};

type SourceSymbol = { symbol: string; stooq: string; sharesOutstanding: number };

const TRADING_DAYS = 252;
const FORMULA_VERSION = "real-stooq-v1";
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

const BENCHMARK = { symbol: "SPX", stooq: "^spx" };

const CONSTITUENTS: SourceSymbol[] = [
  { symbol: "XOM", stooq: "xom.us", sharesOutstanding: 4_250_000_000 },
  { symbol: "IBM", stooq: "ibm.us", sharesOutstanding: 910_000_000 },
  { symbol: "GE", stooq: "ge.us", sharesOutstanding: 1_090_000_000 },
  { symbol: "KO", stooq: "ko.us", sharesOutstanding: 4_320_000_000 },
  { symbol: "PG", stooq: "pg.us", sharesOutstanding: 2_350_000_000 },
  { symbol: "JNJ", stooq: "jnj.us", sharesOutstanding: 2_410_000_000 },
  { symbol: "CVX", stooq: "cvx.us", sharesOutstanding: 1_900_000_000 },
  { symbol: "MMM", stooq: "mmm.us", sharesOutstanding: 550_000_000 },
  { symbol: "CAT", stooq: "cat.us", sharesOutstanding: 500_000_000 },
  { symbol: "MRK", stooq: "mrk.us", sharesOutstanding: 2_530_000_000 },
];

function computeStats(returns: number[], levels: number[]): StrategyStats {
  const periods = returns.length;
  const years = periods / TRADING_DAYS;
  const ending = levels[levels.length - 1];
  const starting = levels[0];
  const cagr = Math.pow(ending / starting, 1 / years) - 1;

  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(returns.length, 1);
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / Math.max(returns.length, 1);
  const annVol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  const annReturn = mean * TRADING_DAYS;
  const sharpe = annVol > 0 ? annReturn / annVol : 0;

  let peak = levels[0];
  let maxDrawdown = 0;
  for (let i = 1; i < levels.length; i += 1) {
    const level = levels[i];
    if (level > peak) peak = level;
    const drawdown = level / peak - 1;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }

  return { cagr, annVol, maxDrawdown, sharpe };
}

function averageOpenClose(bar: Ohlc): number {
  return (bar.open + bar.close) / 2;
}

function marketCaps(constituents: ConstituentSeries[], dayIndex: number): Array<{ symbol: string; cap: number }> {
  return constituents
    .map((c) => ({ symbol: c.symbol, cap: c.bars[dayIndex].close * c.sharesOutstanding }))
    .sort((a, b) => b.cap - a.cap);
}

async function fetchStooqDailyCsv(stooqSymbol: string): Promise<Map<string, Ohlc>> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const res = await fetch(url, { headers: { "user-agent": "strategy-lab-data-generator/1.0" } });
  if (!res.ok) throw new Error(`Failed fetch ${stooqSymbol}: HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) throw new Error(`No rows for ${stooqSymbol}`);

  const out = new Map<string, Ohlc>();
  for (let i = 1; i < lines.length; i += 1) {
    const [date, open, high, low, close] = lines[i].split(",");
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    if (!date || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    out.set(date, { open: o, high: h, low: l, close: c });
  }
  return out;
}

class StooqMarketDataProvider implements MarketDataProvider {
  private benchmarkBarsByDate = new Map<string, Ohlc>();
  private symbolsBarsByDate = new Map<string, Map<string, Ohlc>>();
  private alignedDates: string[] = [];

  async init() {
    this.benchmarkBarsByDate = await fetchStooqDailyCsv(BENCHMARK.stooq);
    for (const c of CONSTITUENTS) {
      this.symbolsBarsByDate.set(c.symbol, await fetchStooqDailyCsv(c.stooq));
    }

    const candidate = [...this.benchmarkBarsByDate.keys()]
      .filter((d) => CONSTITUENTS.every((c) => this.symbolsBarsByDate.get(c.symbol)!.has(d)))
      .sort();

    if (candidate.length < 50 * TRADING_DAYS) {
      throw new Error(`Aligned date count too small: ${candidate.length}`);
    }
    this.alignedDates = candidate;
  }

  async getData(years: number) {
    if (!this.alignedDates.length) throw new Error("Provider not initialized");

    const daysNeeded = years * TRADING_DAYS;
    const dates = this.alignedDates.slice(-daysNeeded);
    if (dates.length < daysNeeded) throw new Error(`Not enough aligned bars for ${years}Y window`);

    const benchmarkRaw = dates.map((d) => this.benchmarkBarsByDate.get(d)!.close);
    const benchmarkBase = benchmarkRaw[0];
    const benchmarkClose = benchmarkRaw.map((x) => (x / benchmarkBase) * 100);

    const constituents: ConstituentSeries[] = CONSTITUENTS.map((c) => ({
      symbol: c.symbol,
      sharesOutstanding: c.sharesOutstanding,
      bars: dates.map((d) => this.symbolsBarsByDate.get(c.symbol)!.get(d)!),
    }));

    return { dates, benchmarkClose, constituents };
  }

  dateRangeFor(years: number) {
    const daysNeeded = years * TRADING_DAYS;
    const dates = this.alignedDates.slice(-daysNeeded);
    return { start: dates[0], end: dates[dates.length - 1] };
  }
}

function simulateSnp1(
  providerData: Awaited<ReturnType<MarketDataProvider["getData"]>>,
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
      sp500: computeStats(sp500Returns, benchmarkClose),
      strategy: computeStats(returns, levels),
    },
  };
}

function simulateSnp10Base(
  providerData: Awaited<ReturnType<MarketDataProvider["getData"]>>,
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
      sp500: computeStats(sp500Returns, benchmarkClose),
      strategy: computeStats(returns, levels),
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

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const outDir = path.join(projectRoot, "public", "data");
  mkdirSync(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const commitSha = getCommitSha();

  const provider = new StooqMarketDataProvider();
  await provider.init();

  const symbolToStooq = Object.fromEntries(CONSTITUENTS.map((c) => [c.symbol, c.stooq]));

  const assumptions = [
    "Daily OHLC for benchmark and all strategy symbols is fetched from Stooq CSV endpoint (no auth).",
    "Benchmark uses ^SPX (S&P 500 index) close series, normalized to 100 at each timeframe start.",
    "Universe is a fixed 10-stock long-history proxy set, not full historical S&P 500 constituents.",
    "SNP1/SNP10 ranking uses proxy market cap = daily close * static shares outstanding constants in generator.",
    "Shares outstanding are modern approximations and are not reconstructed point-in-time historically.",
    "Only dates available across benchmark + all 10 symbols are used (intersection alignment).",
    "Signals use market-cap ranking at day t close and execute on day t+1.",
    "Base scenario applies explicit turnover cost + hysteresis; optimistic/pessimistic are fill stress bounds.",
  ];

  const artifacts: Array<{ strategy: StrategyName; scenario: ScenarioName; timeframeYears: number; json: string; csv: string }> = [];

  for (const years of TIMEFRAMES) {
    const marketData = await provider.getData(years);
    const metadataBase = {
      generatedAt,
      formulaVersion: FORMULA_VERSION,
      commitSha,
      assumptions,
      tradingDaysPerYear: TRADING_DAYS,
      years,
      execution: BASE_EXECUTION,
      dataSource: {
        provider: "stooq",
        benchmarkSymbol: BENCHMARK.stooq,
        benchmarkProxyLabel: "S&P 500 index proxy (^SPX)",
        constituentSymbols: CONSTITUENTS.map((c) => c.symbol),
        symbolToStooq,
        dateRange: provider.dateRangeFor(years),
        generatedFromAlignedTradingDates: true,
        rankingMethod: "close * static sharesOutstanding proxy",
      },
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
      dataSource: {
        provider: "stooq",
        benchmarkSymbol: BENCHMARK.stooq,
        benchmarkProxyLabel: "S&P 500 index proxy (^SPX)",
        constituentSymbols: CONSTITUENTS.map((c) => c.symbol),
        symbolToStooq,
        rankingMethod: "close * static sharesOutstanding proxy",
        alignedUniverseCount: CONSTITUENTS.length,
      },
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
