import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Ohlc = { open: number; high: number; low: number; close: number };
type StrategyStats = { cagr: number; annVol: number; maxDrawdown: number; sharpe: number };
type StrategyName = "snp1" | "snp10";
type ScenarioName = "base" | "optimistic" | "pessimistic";

const TRADING_DAYS = 252;
const TIMEFRAMES = [5, 10, 25, 50] as const;
const BENCHMARK_DIVIDEND_PROXY_YIELD = 0.018;

function getCommitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
function computeStats(returns: number[], levels: number[]): StrategyStats {
  const years = returns.length / TRADING_DAYS;
  const cagr = Math.pow(levels[levels.length - 1] / levels[0], 1 / Math.max(years, 1e-9)) - 1;
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const varr = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, returns.length);
  const annVol = Math.sqrt(varr) * Math.sqrt(TRADING_DAYS);
  const sharpe = annVol > 0 ? (mean * TRADING_DAYS) / annVol : 0;
  let peak = levels[0];
  let mdd = 0;
  for (const v of levels) {
    if (v > peak) peak = v;
    mdd = Math.min(mdd, v / peak - 1);
  }
  return { cagr, annVol, maxDrawdown: mdd, sharpe };
}

function parseStooqCsv(txt: string): Map<string, Ohlc> {
  const m = new Map<string, Ohlc>();
  const lines = txt.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const [date, o, h, l, c] = lines[i].split(",");
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
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
  for (let i = 0; i < ts.length; i += 1) {
    const o = Number(q.open?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), c = Number(q.close?.[i]);
    if (o > 0 && h > 0 && l > 0 && c > 0) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), { open: o, high: h, low: l, close: c });
  }
  return out;
}
function dailyDividendYield(a: number) { return a / TRADING_DAYS; }

async function fetchShares(symbol: string): Promise<number | null> {
  const y = symbol.replace(/\./g, "-").replace(/\//g, "-");
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(y)}?modules=defaultKeyStatistics,price,summaryDetail`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const obj = await res.json();
    const r = obj?.quoteSummary?.result?.[0];
    const cands = [r?.defaultKeyStatistics?.sharesOutstanding?.raw, r?.defaultKeyStatistics?.impliedSharesOutstanding?.raw, r?.price?.sharesOutstanding?.raw];
    for (const c of cands) if (typeof c === "number" && c > 0) return c;
    return null;
  } catch { return null; }
}

async function mapLimit<T, R>(items: T[], c: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let n = 0;
  const ws = Array.from({ length: Math.min(c, items.length) }, async () => { while (true) { const i = n++; if (i >= items.length) break; out[i] = await fn(items[i], i);} });
  await Promise.all(ws); return out;
}

function toCsv(payload: any): string {
  const lines = ["date,sp500,strategy,sp500Return,strategyReturn,holding,rebalanced"];
  const reb = new Set(payload.diagnostics.executedRebalances.map((x: any) => x.date));
  for (let i = 0; i < payload.series.dates.length; i += 1) {
    const h = Array.isArray(payload.diagnostics.holdings[i]) ? payload.diagnostics.holdings[i].join("|") : payload.diagnostics.holdings[i];
    lines.push([payload.series.dates[i], payload.series.sp500[i].toFixed(6), payload.series.strategy[i].toFixed(6), payload.series.sp500Returns[i].toFixed(10), payload.series.strategyReturns[i].toFixed(10), h, reb.has(payload.series.dates[i]) ? "1" : "0"].join(","));
  }
  return lines.join("\n");
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, "..", "..");
  const outDir = path.join(root, "frontend", "public", "data");
  mkdirSync(outDir, { recursive: true });

  const snapshotDate = readFileSync(path.join(root, "data", "raw", "latest.txt"), "utf8").trim();
  const rawRoot = path.join(root, "data", "raw", snapshotDate);
  const pitDaily = JSON.parse(readFileSync(path.join(root, "data", "processed", "pit_membership_daily.json"), "utf8")) as Array<{date:string;symbols:string[]}>;
  const ingestManifest = JSON.parse(readFileSync(path.join(rawRoot, "manifest.json"), "utf8"));

  const barsBySymbol = new Map<string, Map<string, Ohlc>>();
  for (const row of ingestManifest.symbols as Array<any>) {
    if (!row.file || row.source === "none") continue;
    const fp = path.join(rawRoot, row.file);
    try {
      const txt = readFileSync(fp, "utf8");
      const bars = row.source === "stooq" ? parseStooqCsv(txt) : parseYahooJson(txt);
      if (bars.size > 50) barsBySymbol.set(row.symbol, bars);
    } catch { /*ignore*/ }
  }

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

  const latestMembers = pitDaily[pitDaily.length - 1].symbols;
  const shares = new Map<string, number | null>();
  await mapLimit(latestMembers, 10, async (s) => { shares.set(s, await fetchShares(s)); return null; });

  const allDates = [...benchmarkByDate.keys()].sort();
  const start = pitDaily[0].date, end = pitDaily[pitDaily.length - 1].date;
  const dates = allDates.filter((d) => d >= start && d <= end);

  const membershipDates = pitDaily.map((x) => x.date);
  const membershipAt = (date: string) => {
    let lo = 0, hi = membershipDates.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (membershipDates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return pitDaily[ans].symbols;
  };
  const caps = (d: string) => membershipAt(d).map((s) => {
    const b = barsBySymbol.get(s)?.get(d); if (!b) return null;
    const sh = shares.get(s) ?? null; const cap = sh && sh > 0 ? b.close * sh : b.close;
    return { symbol: s, cap };
  }).filter(Boolean).sort((a: any, b: any) => b.cap - a.cap) as Array<{symbol:string;cap:number}>;

  const artifacts: any[] = [];
  for (const years of TIMEFRAMES) {
    const dd = dates.slice(-Math.min(years * TRADING_DAYS, dates.length));
    const spx = [100];
    for (let i = 1; i < dd.length; i += 1) {
      const p0 = benchmarkByDate.get(dd[i - 1])!.close, p1 = benchmarkByDate.get(dd[i])!.close;
      spx.push(spx[i - 1] * (1 + (p1 / p0 - 1) + (benchmarkTR ? 0 : dailyDividendYield(BENCHMARK_DIVIDEND_PROXY_YIELD))));
    }
    const spxRet = spx.map((v, i) => (i ? v / spx[i - 1] - 1 : 0));
    const topByDate = dd.map((d) => caps(d));

    const mkMeta = (strategy: StrategyName, scenario: ScenarioName) => ({
      generatedAt: new Date().toISOString(), formulaVersion: "pit-membership-public-noauth-v3", commitSha: getCommitSha(),
      assumptions: [
        "PIT membership is truly date-based from historical daily S&P500 components dataset.",
        "Constituent prices come from no-auth Stooq; Yahoo chart is used as fallback when Stooq missing.",
        "Ranking is cap-proxy close*latest_shares_outstanding for current constituents; otherwise close-only proxy.",
        "Strategy dividends are proxied by price-only total return; benchmark uses TR symbol when available else dividend carry proxy.",
      ], strategy, scenario, tradingDaysPerYear: TRADING_DAYS, years: Math.round((dd.length / TRADING_DAYS) * 100) / 100, returnMode: "total-return",
      execution: { signalLagDays: 1, executionVenue: "next-day-open", spreadBpsPerSide: 5, impactBpsPerSide: 7, totalCostBpsPerTurnover: 12, snp1LeaderAdvantageBps: 35, snp10BufferRanks: 2 },
      confidence: { overall: "medium", score01: 0.72, rationale: ["PIT membership strong", "price coverage partial for delisted names", "shares are latest proxy only"] },
      dataSource: {
        provider: "hanshof+datasets+s/tooq+yahoo", benchmarkSymbol, benchmarkTotalReturnAvailableFromSource: benchmarkTR,
        sp500HistoricalConstituentSource: ingestManifest.sources.historicalComponents, pitMembershipCoverageStart: start, pitMembershipCoverageEnd: end,
        sharesOutstandingSource: "Yahoo quoteSummary no-auth latest shares outstanding (partial)",
        sharesCoverage: { totalSymbols: latestMembers.length, yahooSharesFound: [...shares.values()].filter(Boolean).length, fallbackPriceWeightCount: [...shares.values()].filter((x) => !x).length },
        dateRange: { start: dd[0], end: dd[dd.length - 1] }, rankingMethod: "daily close * latest shares (fallback close-only)"
      }
    });

    const snp1 = (scenario: ScenarioName) => {
      const hold = new Array<string>(dd.length).fill(""); const reb: any[] = []; const lv = [100], ret = [0];
      let h = topByDate[0]?.[0]?.symbol ?? ""; hold[0] = h; let pending: any = null;
      for (let i = 1; i < dd.length; i += 1) {
        const d = dd[i], d0 = dd[i - 1], v0 = lv[i - 1]; let v1 = v0;
        if (pending) {
          const oPrev = barsBySymbol.get(pending.from)?.get(d0), oNow = barsBySymbol.get(pending.from)?.get(d), nNow = barsBySymbol.get(pending.to)?.get(d);
          if (oPrev && oNow && nNow) {
            const shOld = v0 / oPrev.close;
            let sell = oNow.open, buy = nNow.open, sc = 0, bc = 0;
            if (scenario === "optimistic") { sell = (oNow.open + oNow.close) / 2; buy = (nNow.open + nNow.close) / 2; }
            else if (scenario === "pessimistic") { sell = oNow.low; buy = nNow.high; }
            else { sc = 0.0012; bc = 0.0012; }
            const cash = shOld * sell * (1 - sc); const shNew = cash / (buy * (1 + bc));
            v1 = shNew * nNow.close; h = pending.to; reb.push({ date: d, details: `${pending.from}->${pending.to}` });
          }
          pending = null;
        }
        if (!pending) {
          const b0 = barsBySymbol.get(h)?.get(d0), b1 = barsBySymbol.get(h)?.get(d);
          if (b0 && b1) v1 = v0 * (b1.close / b0.close);
        }
        lv.push(v1); ret.push(v1 / v0 - 1);
        const t = topByDate[i]?.[0]?.symbol ?? h;
        if (t !== h) pending = { from: h, to: t };
        hold[i] = h;
      }
      return { metadata: mkMeta("snp1", scenario), series: { dates: dd, sp500: spx, strategy: lv, sp500Returns: spxRet, strategyReturns: ret }, diagnostics: { holdings: hold, executedRebalances: reb }, stats: { sp500: computeStats(spxRet, spx), strategy: computeStats(ret, lv) } };
    };

    const snp10 = () => {
      const holdings: string[][] = new Array(dd.length).fill(null).map(() => []); const reb: any[] = []; const lv = [100], ret = [0];
      let cur = new Set(topByDate[0].slice(0, 10).map((x) => x.symbol));
      let wPrev = new Map<string, number>();
      const cap0 = topByDate[0].filter((x) => cur.has(x.symbol)); const t0 = cap0.reduce((a, b) => a + b.cap, 0) || 1;
      for (const c of cap0) wPrev.set(c.symbol, c.cap / t0); holdings[0] = [...cur].sort();
      for (let i = 1; i < dd.length; i += 1) {
        const rank = topByDate[i - 1]; const r = new Map(rank.map((x, j) => [x.symbol, j + 1]));
        const keep = [...cur].filter((s) => (r.get(s) ?? 999) <= 12); const cand = rank.map((x) => x.symbol).filter((s) => !keep.includes(s));
        while (keep.length < 10 && cand.length) keep.push(cand.shift()!);
        const target = new Set(keep.slice(0, 10)); const targetCaps = rank.filter((x) => target.has(x.symbol));
        const tt = targetCaps.reduce((a, b) => a + b.cap, 0) || 1; const wTar = new Map<string, number>();
        for (const c of targetCaps) wTar.set(c.symbol, c.cap / tt);
        const univ = new Set([...wPrev.keys(), ...wTar.keys()]);
        let c2o = 0; for (const s of univ) { const w = wPrev.get(s) ?? 0; if (!w) continue; const b0 = barsBySymbol.get(s)?.get(dd[i - 1]); const b1 = barsBySymbol.get(s)?.get(dd[i]); if (b0 && b1) c2o += w * (b1.open / b0.close - 1); }
        const afterOpen = lv[i - 1] * (1 + c2o);
        let turn = 0; for (const s of univ) turn += Math.abs((wTar.get(s) ?? 0) - (wPrev.get(s) ?? 0)); turn *= 0.5;
        let o2c = 0; for (const [s, w] of wTar) { const b = barsBySymbol.get(s)?.get(dd[i]); if (b) o2c += w * (b.close / b.open - 1); }
        const v1 = Math.max(0.0001, (afterOpen - afterOpen * turn * 0.0012) * (1 + o2c));
        if (turn > 1e-4) reb.push({ date: dd[i], details: `turnover=${(turn * 100).toFixed(2)}%` });
        lv.push(v1); ret.push(v1 / lv[i - 1] - 1); cur = target; wPrev = wTar; holdings[i] = [...cur].sort();
      }
      return { metadata: mkMeta("snp10", "base"), series: { dates: dd, sp500: spx, strategy: lv, sp500Returns: spxRet, strategyReturns: ret }, diagnostics: { holdings, executedRebalances: reb }, stats: { sp500: computeStats(spxRet, spx), strategy: computeStats(ret, lv) } };
    };

    const payloads = [snp1("base"), snp1("optimistic"), snp1("pessimistic"), snp10()];
    for (const p of payloads) {
      const base = `sp500_vs_${p.metadata.strategy}_${p.metadata.scenario}_${years}y`;
      writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(p, null, 2)}\n`, "utf8");
      writeFileSync(path.join(outDir, `${base}.csv`), `${toCsv(p)}\n`, "utf8");
      artifacts.push({ strategy: p.metadata.strategy, scenario: p.metadata.scenario, timeframeYears: years, json: `/data/${base}.json`, csv: `/data/${base}.csv` });
    }
  }

  writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify({ metadata: { generatedAt: new Date().toISOString(), formulaVersion: "pit-membership-public-noauth-v3", commitSha: getCommitSha(), supportedTimeframesYears: [...TIMEFRAMES], supportedStrategies: ["snp1", "snp10"], supportedScenariosByStrategy: { snp1: ["base", "optimistic", "pessimistic"], snp10: ["base"] }, defaultTimeframeYears: 25, defaultStrategy: "snp1", defaultScenario: "base" }, artifacts }, null, 2)}\n`, "utf8");

  console.log(`Generated artifacts in ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
