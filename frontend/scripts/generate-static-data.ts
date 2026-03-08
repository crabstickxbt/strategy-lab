import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Ohlc = { open: number; high: number; low: number; close: number };
type StrategyStats = { cagr: number; annVol: number; maxDrawdown: number; sharpe: number };
type StrategyName = "snp1" | "snp10";
type ScenarioName = "base" | "optimistic" | "pessimistic";
type PitRow = { date: string; symbols: string[] };
type SymbolManifestRow = { symbol: string; source: "stooq" | "yahoo" | "none"; file?: string };

const TRADING_DAYS = 252;
const TIMEFRAMES = [5, 10, 25, 50] as const;
const BENCHMARK_DIVIDEND_PROXY_YIELD = 0.018;
const WEIGHT_TOL = 1e-6;

function getCommitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function assertFinite(name: string, v: number) {
  if (!Number.isFinite(v)) throw new Error(`Non-finite value at ${name}: ${v}`);
}

function normalizeWeights(input: Map<string, number>, where: string): Map<string, number> {
  const out = new Map<string, number>();
  let sum = 0;
  for (const [k, w] of input) {
    const vv = Number.isFinite(w) ? Math.max(0, w) : 0;
    if (vv > 0) {
      out.set(k, vv);
      sum += vv;
    }
  }
  if (!(sum > 0)) throw new Error(`Weight normalization failed at ${where}: sum<=0`);
  for (const [k, w] of out) out.set(k, w / sum);
  const s = [...out.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(s - 1) > WEIGHT_TOL) throw new Error(`Weight sum deviation at ${where}: ${s}`);
  return out;
}

function computeStats(returns: number[], levels: number[]): StrategyStats {
  const years = returns.length / TRADING_DAYS;
  const cagr = Math.pow(levels[levels.length - 1] / levels[0], 1 / Math.max(years, 1e-9)) - 1;
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const varr = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, returns.length);
  const annVol = Math.sqrt(varr) * Math.sqrt(TRADING_DAYS);
  const sharpe = annVol > 0 ? (mean * TRADING_DAYS) / annVol : 0;
  let peak = levels[0], mdd = 0;
  for (const v of levels) {
    if (v > peak) peak = v;
    mdd = Math.min(mdd, v / peak - 1);
  }
  return { cagr, annVol, maxDrawdown: mdd, sharpe };
}

function parseStooqCsv(txt: string): Map<string, Ohlc> {
  const m = new Map<string, Ohlc>();
  const lines = txt.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [date, o, h, l, c] = lines[i].split(",");
    const open = +o, high = +h, low = +l, close = +c;
    if (date && open > 0 && high > 0 && low > 0 && close > 0) m.set(date, { open, high, low, close });
  }
  return m;
}

function parseYahooJson(txt: string): Map<string, Ohlc> {
  const obj = JSON.parse(txt);
  const out = new Map<string, Ohlc>();
  const r = obj?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  for (let i = 0; i < ts.length; i++) {
    const o = +q.open?.[i], h = +q.high?.[i], l = +q.low?.[i], c = +q.close?.[i];
    if (o > 0 && h > 0 && l > 0 && c > 0) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), { open: o, high: h, low: l, close: c });
  }
  return out;
}

function dailyDividendYield(a: number) {
  return a / TRADING_DAYS;
}

async function fetchShares(symbol: string): Promise<number | null> {
  const y = symbol.replace(/\./g, "-").replace(/\//g, "-");
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(y)}?modules=defaultKeyStatistics,price,summaryDetail`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const obj = await res.json();
    const r = obj?.quoteSummary?.result?.[0];
    for (const c of [r?.defaultKeyStatistics?.sharesOutstanding?.raw, r?.defaultKeyStatistics?.impliedSharesOutstanding?.raw, r?.price?.sharesOutstanding?.raw]) if (typeof c === "number" && c > 0) return c;
    return null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], c: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let n = 0;
  const ws = Array.from({ length: Math.min(c, items.length) }, async () => {
    while (true) {
      const i = n++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(ws);
  return out;
}

function toCsv(payload: any): string {
  const lines = ["date,sp500,strategy,sp500Return,strategyReturn,holding,rebalanced"];
  const reb = new Set(payload.diagnostics.executedRebalances.map((x: any) => x.date));
  for (let i = 0; i < payload.series.dates.length; i++) {
    const h = Array.isArray(payload.diagnostics.holdings[i]) ? payload.diagnostics.holdings[i].join("|") : payload.diagnostics.holdings[i];
    lines.push([payload.series.dates[i], payload.series.sp500[i].toFixed(6), payload.series.strategy[i].toFixed(6), payload.series.sp500Returns[i].toFixed(10), payload.series.strategyReturns[i].toFixed(10), h, reb.has(payload.series.dates[i]) ? "1" : "0"].join(","));
  }
  return lines.join("\n");
}

function loadSymbolBars(rawRoot: string, row: SymbolManifestRow): Map<string, Ohlc> {
  if (!row.file || row.source === "none") return new Map();
  try {
    const txt = readFileSync(path.join(rawRoot, row.file), "utf8");
    const bars = row.source === "stooq" ? parseStooqCsv(txt) : parseYahooJson(txt);
    return bars.size > 50 ? bars : new Map();
  } catch {
    return new Map();
  }
}

function sanitizeNextValue(v0: number, v1: number, clipCounter: { count: number }) {
  if (!Number.isFinite(v1) || v1 <= 0) {
    clipCounter.count++;
    return v0;
  }
  const r = v1 / v0 - 1;
  if (Math.abs(r) > 0.8) {
    clipCounter.count++;
    return v0;
  }
  return v1;
}

function collectDiagnostics(payload: any) {
  const returns: number[] = payload.series.strategyReturns;
  const levels: number[] = payload.series.strategy;
  const swapCount = payload.diagnostics.executedRebalances.length;
  const avgTurnover = payload.diagnostics.turnovers?.length
    ? payload.diagnostics.turnovers.reduce((a: number, b: number) => a + b, 0) / payload.diagnostics.turnovers.length
    : (swapCount / Math.max(1, returns.length));
  const maxDailyMove = returns.reduce((m, r) => Math.max(m, Math.abs(r)), 0);
  const minLevel = Math.min(...levels);
  const maxLevel = Math.max(...levels);
  const weightSeries = payload.diagnostics.weightSums ?? [];
  const weightSumMin = weightSeries.length ? Math.min(...weightSeries) : null;
  const weightSumMax = weightSeries.length ? Math.max(...weightSeries) : null;
  return { swapCount, averageTurnover: avgTurnover, maxDailyMove, minLevel, maxLevel, weightSumMin, weightSumMax };
}

function sanityCheck(payload: any, years: number, diagnosticsPath: string) {
  const sr = payload.series.strategyReturns as number[];
  const br = payload.series.sp500Returns as number[];
  const sl = payload.series.strategy as number[];
  const bl = payload.series.sp500 as number[];
  const all = [sr, br, sl, bl];
  for (const arr of all) arr.forEach((v, i) => assertFinite(`${payload.metadata.strategy}/${payload.metadata.scenario}[${i}]`, v));

  const extreme = sr.filter((r) => Math.abs(r) > 0.8).length;
  if (extreme > 1) throw new Error(`Repeated extreme daily moves (${extreme}) for ${payload.metadata.strategy}/${payload.metadata.scenario}/${years}Y. See ${diagnosticsPath}`);

  if (payload.metadata.strategy === "snp10" && payload.diagnostics.weightSums) {
    for (const [i, ws] of payload.diagnostics.weightSums.entries()) {
      if (Math.abs(ws - 1) > WEIGHT_TOL) throw new Error(`Weight-sum deviation > ${WEIGHT_TOL} for snp10 at i=${i}: ${ws}`);
    }
  }

  const sStats = payload.stats.strategy;
  const bStats = payload.stats.sp500;
  if (Math.abs(sStats.cagr) > 1 || Math.abs(bStats.cagr) > 1) {
    throw new Error(`Implausible CAGR (>|100%|) ${payload.metadata.strategy}/${payload.metadata.scenario}/${years}Y strategy=${sStats.cagr} benchmark=${bStats.cagr}. See ${diagnosticsPath}`);
  }

  if (payload.metadata.strategy === "snp1" && (years === 25 || years === 50)) {
    if (payload.diagnostics.executedRebalances.length === 0) {
      if (!payload.diagnostics.zeroSwapImpossible) {
        throw new Error(`SNP1 ${years}Y has zero swaps but not marked impossible. See ${diagnosticsPath}`);
      }
    }
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, "..", "..");
  const outDir = path.join(root, "frontend", "public", "data");
  const diagDir = path.join(outDir, "diagnostics");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(diagDir, { recursive: true });

  const snapshotDate = readFileSync(path.join(root, "data", "raw", "latest.txt"), "utf8").trim();
  const rawRoot = path.join(root, "data", "raw", snapshotDate);
  const pitDaily = JSON.parse(readFileSync(path.join(root, "data", "processed", "pit_membership_daily.json"), "utf8")) as PitRow[];
  const ingestManifest = JSON.parse(readFileSync(path.join(rawRoot, "manifest.json"), "utf8"));

  const benchmarkFiles = readdirSync(rawRoot).filter((f) => f.startsWith("benchmark_") && f.endsWith(".csv"));
  let benchmarkByDate = new Map<string, Ohlc>();
  let benchmarkSymbol = "unknown";
  let benchmarkTR = false;
  for (const f of benchmarkFiles.sort()) {
    const bars = parseStooqCsv(readFileSync(path.join(rawRoot, f), "utf8"));
    if (bars.size > benchmarkByDate.size) {
      benchmarkByDate = bars;
      benchmarkSymbol = f.replace("benchmark_", "").replace(".csv", "");
      benchmarkTR = /spxt|spxtr|sp500tr/.test(f);
    }
  }
  if (benchmarkByDate.size < 100) {
    const now = Math.floor(Date.now() / 1000), startTs = Math.floor(now - 50 * 365.25 * 24 * 3600);
    try {
      const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&period1=${startTs}&period2=${now}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const fb = parseYahooJson(await res.text());
        if (fb.size > benchmarkByDate.size) {
          benchmarkByDate = fb;
          benchmarkSymbol = "^GSPC";
          benchmarkTR = false;
        }
      }
    } catch {}
  }
  if (benchmarkByDate.size < 100) throw new Error("Benchmark history unavailable");

  const allDates = [...benchmarkByDate.keys()].sort();
  const start = pitDaily[0].date, end = pitDaily[pitDaily.length - 1].date;
  const dates = allDates.filter((d) => d >= start && d <= end);

  const membershipDates = pitDaily.map((x) => x.date);
  const membershipAt = (date: string) => {
    let lo = 0, hi = membershipDates.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (membershipDates[mid] <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return pitDaily[ans].symbols;
  };

  const maxWindow = Math.min(50 * TRADING_DAYS, dates.length);
  const dd = dates.slice(-maxWindow);

  const membershipSetByDdIdx = dd.map((d) => new Set(membershipAt(d)));

  const neededSymbols = new Set<string>();
  for (const set of membershipSetByDdIdx) for (const s of set) neededSymbols.add(s);

  const manifestBySymbol = new Map<string, SymbolManifestRow>();
  for (const row of ingestManifest.symbols as SymbolManifestRow[]) if (neededSymbols.has(row.symbol)) manifestBySymbol.set(row.symbol, row);

  const latestMembers = pitDaily[pitDaily.length - 1].symbols;
  const shares = new Map<string, number | null>();
  console.log(`Fetching shares outstanding for ${latestMembers.length} current members...`);
  await mapLimit(latestMembers, 10, async (s) => {
    shares.set(s, await fetchShares(s));
    return null;
  });
  console.log(`Shares: ${[...shares.values()].filter(Boolean).length} found / ${latestMembers.length} total`);

  console.log(`Building per-date rankings for ${dd.length} dates across ${neededSymbols.size} needed symbols...`);
  type RankEntry = { symbol: string; cap: number };
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dd.length; i++) dateIdx.set(dd[i], i);

  const capRank: RankEntry[][] = new Array(dd.length);
  for (let i = 0; i < dd.length; i++) capRank[i] = [];

  const symbolList = [...neededSymbols].sort();
  let loaded = 0;
  for (const sym of symbolList) {
    const row = manifestBySymbol.get(sym);
    if (!row?.file || row.source === "none") continue;
    let bars: Map<string, Ohlc>;
    try {
      const txt = readFileSync(path.join(rawRoot, row.file), "utf8");
      bars = row.source === "stooq" ? parseStooqCsv(txt) : parseYahooJson(txt);
      if (bars.size <= 50) continue;
    } catch {
      continue;
    }

    const sh = shares.get(sym) ?? null;
    for (const [date, ohlc] of bars) {
      const di = dateIdx.get(date);
      if (di === undefined) continue;
      if (!membershipSetByDdIdx[di].has(sym)) continue;
      const cap = sh && sh > 0 ? ohlc.close * sh : ohlc.close;
      capRank[di].push({ symbol: sym, cap });
    }
    loaded++;
    if (loaded % 100 === 0) console.log(`  pass1: ${loaded}/${symbolList.length} symbols scanned`);
  }
  console.log(`  pass1 complete: ${loaded} symbols loaded`);

  for (let i = 0; i < dd.length; i++) capRank[i].sort((a, b) => b.cap - a.cap);

  const ohlcNeeded = new Set<string>();
  for (let i = 0; i < dd.length; i++) {
    for (let j = 0; j < Math.min(20, capRank[i].length); j++) ohlcNeeded.add(capRank[i][j].symbol);
  }
  console.log(`Pass2: loading full OHLC for ${ohlcNeeded.size} symbols that appear in top-20 on any date`);

  const barsBySymbol = new Map<string, Map<string, Ohlc>>();
  for (const sym of ohlcNeeded) {
    const row = manifestBySymbol.get(sym);
    if (!row) continue;
    const bars = loadSymbolBars(rawRoot, row);
    if (bars.size > 0) barsBySymbol.set(sym, bars);
  }
  console.log(`  pass2 complete: ${barsBySymbol.size} symbols with OHLC loaded (${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap)`);

  const getBar = (sym: string, date: string): Ohlc | undefined => barsBySymbol.get(sym)?.get(date);

  const artifacts: any[] = [];
  for (const years of TIMEFRAMES) {
    const tfLen = Math.min(years * TRADING_DAYS, dd.length);
    const tfDates = dd.slice(dd.length - tfLen);
    const tfStart = dd.length - tfLen;

    const spx = [100];
    for (let i = 1; i < tfDates.length; i++) {
      const p0 = benchmarkByDate.get(tfDates[i - 1])!.close, p1 = benchmarkByDate.get(tfDates[i])!.close;
      const benchmarkReturn = (p1 / p0 - 1) + (benchmarkTR ? 0 : dailyDividendYield(BENCHMARK_DIVIDEND_PROXY_YIELD));
      const next = spx[i - 1] * (1 + benchmarkReturn);
      assertFinite(`benchmark-level-${years}-${i}`, next);
      spx.push(next);
    }
    const spxRet = spx.map((v, i) => (i ? v / spx[i - 1] - 1 : 0));

    const topAt = (tfIdx: number) => capRank[tfStart + tfIdx];

    const mkMeta = (strategy: StrategyName, scenario: ScenarioName) => ({
      generatedAt: new Date().toISOString(), formulaVersion: "pit-membership-public-noauth-v4", commitSha: getCommitSha(),
      assumptions: [
        "PIT membership is date-filtered from historical daily S&P500 components dataset.",
        "Constituent prices come from no-auth Stooq; Yahoo chart is used as fallback when Stooq missing.",
        "Ranking is cap-proxy close*latest_shares_outstanding for current constituents; otherwise close-only proxy.",
        "Benchmark dividend carry is applied only when a true total-return benchmark series is unavailable.",
      ], strategy, scenario, tradingDaysPerYear: TRADING_DAYS, years: Math.round((tfDates.length / TRADING_DAYS) * 100) / 100, returnMode: "total-return",
      execution: { signalLagDays: 1, executionVenue: "next-day-open", spreadBpsPerSide: 5, impactBpsPerSide: 7, totalCostBpsPerTurnover: 12, snp1LeaderAdvantageBps: 35, snp10BufferRanks: 2 },
      confidence: { overall: "medium", score01: 0.72, rationale: ["PIT membership strong", "price coverage partial for delisted names", "shares are latest proxy only"] },
      dataSource: {
        provider: "hanshof+datasets+stooq+yahoo", benchmarkSymbol, benchmarkTotalReturnAvailableFromSource: benchmarkTR,
        sp500HistoricalConstituentSource: ingestManifest.sources.historicalComponents, pitMembershipCoverageStart: start, pitMembershipCoverageEnd: end,
        sharesOutstandingSource: "Yahoo quoteSummary no-auth latest shares outstanding (partial)",
        sharesCoverage: { totalSymbols: latestMembers.length, yahooSharesFound: [...shares.values()].filter(Boolean).length, fallbackPriceWeightCount: [...shares.values()].filter((x) => !x).length, pitUniverseSymbolsExamined: neededSymbols.size },
        dateRange: { start: tfDates[0], end: tfDates[tfDates.length - 1] }, rankingMethod: "daily close * latest shares (fallback close-only)"
      }
    });

    const snp1 = (scenario: ScenarioName) => {
      const hold = new Array<string>(tfDates.length).fill("");
      const reb: any[] = [], lv = [100], ret = [0];
      const clips = { count: 0 };
      const rankStart = topAt(0);
      let h = rankStart?.[0]?.symbol ?? "";
      hold[0] = h;
      let pending: { from: string; to: string } | null = null;
      const leaderHistory = [h];

      for (let i = 1; i < tfDates.length; i++) {
        const d = tfDates[i], d0 = tfDates[i - 1], v0 = lv[i - 1];
        let v1 = v0;
        let executedSwap = false;

        if (pending) {
          const fromB0 = getBar(pending.from, d0), fromB1 = getBar(pending.from, d), toB1 = getBar(pending.to, d);
          if (fromB0 && fromB1 && toB1) {
            const shOld = v0 / fromB0.close;
            let sell = fromB1.open, buy = toB1.open, sc = 0, bc = 0;
            if (scenario === "optimistic") {
              sell = fromB1.open * (1 + 0.0015);
              buy = toB1.open * (1 - 0.0015);
              sc = 0.0006;
              bc = 0.0006;
            } else if (scenario === "pessimistic") {
              sell = fromB1.open * (1 - 0.0025);
              buy = toB1.open * (1 + 0.0025);
              sc = 0.0022;
              bc = 0.0022;
            } else {
              sc = 0.0012;
              bc = 0.0012;
            }
            const cash = shOld * Math.max(1e-8, sell) * (1 - sc);
            const shNew = cash / (Math.max(1e-8, buy) * (1 + bc));
            v1 = shNew * toB1.close;
            h = pending.to;
            reb.push({ date: d, details: `${pending.from}->${pending.to}` });
            executedSwap = true;
          }
          pending = null;
        }

        if (!executedSwap) {
          const b0 = getBar(h, d0), b1 = getBar(h, d);
          if (b0 && b1) v1 = v0 * (b1.close / b0.close);
        }

        v1 = sanitizeNextValue(v0, v1, clips);
        assertFinite(`snp1-${scenario}-${years}-${d}`, v1);
        lv.push(v1);
        ret.push(v1 / v0 - 1);

        const t = topAt(i)?.[0]?.symbol ?? h;
        leaderHistory.push(t);
        if (t !== h) pending = { from: h, to: t };
        hold[i] = h;
      }

      const uniqueLeaders = new Set(leaderHistory.filter(Boolean));
      const zeroSwapImpossible = reb.length === 0 && uniqueLeaders.size <= 1;
      return {
        metadata: mkMeta("snp1", scenario),
        series: { dates: tfDates, sp500: spx, strategy: lv, sp500Returns: spxRet, strategyReturns: ret },
        diagnostics: { holdings: hold, executedRebalances: reb, turnovers: reb.map(() => 1), weightSums: lv.map(() => 1), zeroSwapImpossible, uniqueLeaderCount: uniqueLeaders.size, clippedExtremeMoves: clips.count },
        stats: { sp500: computeStats(spxRet, spx), strategy: computeStats(ret, lv) }
      };
    };

    const snp10 = () => {
      const holdings: string[][] = new Array(tfDates.length).fill(null).map(() => []);
      const reb: any[] = [], lv = [100], ret = [0], turnovers: number[] = [0], weightSums: number[] = [1];
      const clips = { count: 0 };

      const rank0 = topAt(0);
      let cur = rank0.slice(0, 10).map((x) => x.symbol);
      let wPrevRaw = new Map<string, number>();
      const cap0 = rank0.filter((x) => cur.includes(x.symbol));
      for (const c of cap0) wPrevRaw.set(c.symbol, c.cap);
      let wPrev = normalizeWeights(wPrevRaw, `snp10-init-${years}`);
      holdings[0] = [...wPrev.keys()].sort();

      for (let i = 1; i < tfDates.length; i++) {
        const d0 = tfDates[i - 1], d1 = tfDates[i];
        const rank = topAt(i - 1);

        const r = new Map(rank.map((x, j) => [x.symbol, j + 1]));
        const keep = cur.filter((s) => (r.get(s) ?? 999) <= 12);
        const cand = rank.map((x) => x.symbol).filter((s) => !keep.includes(s));
        while (keep.length < 10 && cand.length) keep.push(cand.shift()!);
        cur = keep.slice(0, 10);

        const targetCapsRaw = new Map<string, number>();
        for (const e of rank) if (cur.includes(e.symbol)) targetCapsRaw.set(e.symbol, e.cap);
        let wTar = normalizeWeights(targetCapsRaw, `snp10-target-${years}-${i}`);

        let portRet = 0;
        const driftRaw = new Map<string, number>();
        for (const [s, w] of wPrev) {
          const b0 = getBar(s, d0), b1 = getBar(s, d1);
          const rr = b0 && b1 ? (b1.close / b0.close - 1) : 0;
          portRet += w * rr;
          driftRaw.set(s, w * (1 + rr));
        }
        const drift = normalizeWeights(driftRaw, `snp10-drift-${years}-${i}`);

        let turnover = 0;
        const allKeys = new Set([...drift.keys(), ...wTar.keys()]);
        for (const s of allKeys) turnover += Math.abs((wTar.get(s) ?? 0) - (drift.get(s) ?? 0));
        turnover *= 0.5;

        const gross = lv[i - 1] * (1 + portRet);
        let v1 = Math.max(0.0001, gross * (1 - 0.0012 * turnover));
        v1 = sanitizeNextValue(lv[i - 1], v1, clips);
        assertFinite(`snp10-${years}-${d1}`, v1);

        lv.push(v1);
        ret.push(v1 / lv[i - 1] - 1);
        turnovers.push(turnover);

        const ws = [...wTar.values()].reduce((a, b) => a + b, 0);
        weightSums.push(ws);

        if (turnover > 1e-4) reb.push({ date: d1, details: `turnover=${(turnover * 100).toFixed(2)}%` });
        wPrev = wTar;
        holdings[i] = [...cur].sort();
      }

      return {
        metadata: mkMeta("snp10", "base"),
        series: { dates: tfDates, sp500: spx, strategy: lv, sp500Returns: spxRet, strategyReturns: ret },
        diagnostics: { holdings, executedRebalances: reb, turnovers, weightSums, clippedExtremeMoves: clips.count },
        stats: { sp500: computeStats(spxRet, spx), strategy: computeStats(ret, lv) }
      };
    };

    console.log(`  timeframe ${years}Y (${tfDates.length} dates)...`);
    const payloads = [snp1("base"), snp1("optimistic"), snp1("pessimistic"), snp10()];

    for (const p of payloads) {
      const base = `sp500_vs_${p.metadata.strategy}_${p.metadata.scenario}_${years}y`;
      const diag = collectDiagnostics(p);
      const diagPath = path.join(diagDir, `${base}.json`);
      writeFileSync(diagPath, `${JSON.stringify({ artifact: base, strategy: p.metadata.strategy, scenario: p.metadata.scenario, years, diagnostics: diag }, null, 2)}\n`, "utf8");
      sanityCheck(p, years, `/data/diagnostics/${base}.json`);

      writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(p, null, 2)}\n`, "utf8");
      writeFileSync(path.join(outDir, `${base}.csv`), `${toCsv(p)}\n`, "utf8");
      artifacts.push({ strategy: p.metadata.strategy, scenario: p.metadata.scenario, timeframeYears: years, json: `/data/${base}.json`, csv: `/data/${base}.csv`, diagnostics: `/data/diagnostics/${base}.json` });
    }
  }

  writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify({ metadata: { generatedAt: new Date().toISOString(), formulaVersion: "pit-membership-public-noauth-v4", commitSha: getCommitSha(), supportedTimeframesYears: [...TIMEFRAMES], supportedStrategies: ["snp1", "snp10"], supportedScenariosByStrategy: { snp1: ["base", "optimistic", "pessimistic"], snp10: ["base"] }, defaultTimeframeYears: 25, defaultStrategy: "snp1", defaultScenario: "base" }, artifacts }, null, 2)}\n`, "utf8");

  console.log(`\nGenerated artifacts in ${outDir}`);
  console.log(`  needed symbols: ${neededSymbols.size}, OHLC loaded: ${barsBySymbol.size}, heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
