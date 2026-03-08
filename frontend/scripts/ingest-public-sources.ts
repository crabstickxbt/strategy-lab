import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HISTORICAL_COMPONENTS_URL =
  "https://raw.githubusercontent.com/hanshof/sp500_constituents/main/sp_500_historical_components.csv";
const CURRENT_CONSTITUENTS_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const BENCHMARK_CANDIDATES = ["^spx", "^spxt", "^spxtr", "^sp500tr"];

const SNAPSHOT_DATE = new Date().toISOString().slice(0, 10);

type FetchResult = { symbol: string; source: "stooq" | "yahoo" | "none"; rows: number; file?: string; note?: string };

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "strategy-lab-ingest/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

function parseHistoricalSymbols(csvText: string): { allSymbols: string[]; dates: string[] } {
  const lines = csvText.trim().split(/\r?\n/);
  const set = new Set<string>();
  const dates: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const firstComma = line.indexOf(",");
    if (firstComma < 0) continue;
    const date = line.slice(0, firstComma);
    const raw = line.slice(firstComma + 1).replace(/^"|"$/g, "");
    if (!date) continue;
    dates.push(date);
    for (const s of raw.split(",")) {
      const sym = s.trim().toUpperCase();
      if (sym) set.add(sym);
    }
  }
  return { allSymbols: [...set].sort(), dates: dates.sort() };
}

function parseCurrentSymbols(csvText: string): string[] {
  const lines = csvText.trim().split(/\r?\n/);
  const out: string[] = [];
  const header = lines[0].split(",");
  const symbolIdx = header.findIndex((h) => h.toLowerCase() === "symbol");
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    const sym = (cols[symbolIdx] ?? "").trim().toUpperCase();
    if (sym) out.push(sym);
  }
  return [...new Set(out)].sort();
}

function toStooqSymbol(symbol: string): string {
  return `${symbol.toLowerCase().replace(/\./g, "-").replace(/\//g, "-")}.us`;
}

function toYahooSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/\./g, "-").replace(/\//g, "-");
}

async function fetchStooq(symbol: string): Promise<string | null> {
  const stooq = toStooqSymbol(symbol);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`;
  try {
    const txt = await fetchText(url, 4000);
    const lines = txt.trim().split(/\r?\n/);
    if (lines.length < 20 || !lines[0].startsWith("Date,Open,High,Low,Close")) return null;
    return txt;
  } catch {
    return null;
  }
}

async function fetchYahoo(symbol: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.floor(now - 40 * 365.25 * 24 * 3600);
  const y = toYahooSymbol(symbol);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&period1=${start}&period2=${now}`;
  try {
    const txt = await fetchText(url, 7000);
    const obj = JSON.parse(txt);
    const timestamps = obj?.chart?.result?.[0]?.timestamp;
    if (!Array.isArray(timestamps) || timestamps.length < 20) return null;
    return txt;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function dirSizeBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(p);
    else total += (await stat(p)).size;
  }
  return total;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, "..", "..");
  const snapshotRoot = path.join(root, "data", "raw", SNAPSHOT_DATE);
  const sourcesDir = path.join(snapshotRoot, "sources");
  const stooqDir = path.join(snapshotRoot, "prices", "stooq");
  const yahooDir = path.join(snapshotRoot, "prices", "yahoo");
  mkdirSync(sourcesDir, { recursive: true });
  mkdirSync(stooqDir, { recursive: true });
  mkdirSync(yahooDir, { recursive: true });

  const historicalCsv = await fetchText(HISTORICAL_COMPONENTS_URL);
  const currentCsv = await fetchText(CURRENT_CONSTITUENTS_URL);
  await writeFile(path.join(sourcesDir, "sp500_historical_components.csv"), historicalCsv, "utf8");
  await writeFile(path.join(sourcesDir, "sp500_current_constituents.csv"), currentCsv, "utf8");

  const historical = parseHistoricalSymbols(historicalCsv);
  const current = parseCurrentSymbols(currentCsv);
  const allSymbols = [...new Set([...historical.allSymbols, ...current])].sort();

  for (const b of BENCHMARK_CANDIDATES) {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(b)}&i=d`;
    try {
      const txt = await fetchText(url, 12000);
      await writeFile(path.join(snapshotRoot, `benchmark_${b.replace(/[^a-z0-9]/gi, "")}.csv`), txt, "utf8");
    } catch {
      // continue
    }
  }

  let done = 0;
  const results = await mapLimit(allSymbols, 8, async (symbol): Promise<FetchResult> => {
    const stooq = await fetchStooq(symbol);
    if (stooq) {
      const file = path.join(stooqDir, `${symbol}.csv`);
      await writeFile(file, stooq, "utf8");
      const rows = Math.max(0, stooq.trim().split(/\r?\n/).length - 1);
      done += 1;
      if (done % 100 === 0) console.log(`fetched ${done}/${allSymbols.length}`);
      return { symbol, source: "stooq", rows, file: path.relative(snapshotRoot, file) };
    }
    const yahoo = await fetchYahoo(symbol);
    if (yahoo) {
      const file = path.join(yahooDir, `${symbol}.json`);
      await writeFile(file, yahoo, "utf8");
      const obj = JSON.parse(yahoo);
      const rows = obj?.chart?.result?.[0]?.timestamp?.length ?? 0;
      done += 1;
      if (done % 100 === 0) console.log(`fetched ${done}/${allSymbols.length}`);
      return { symbol, source: "yahoo", rows, file: path.relative(snapshotRoot, file) };
    }
    done += 1;
    if (done % 100 === 0) console.log(`fetched ${done}/${allSymbols.length}`);
    return { symbol, source: "none", rows: 0, note: "no data from stooq/yahoo" };
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    snapshotDate: SNAPSHOT_DATE,
    sources: {
      historicalComponents: HISTORICAL_COMPONENTS_URL,
      currentConstituents: CURRENT_CONSTITUENTS_URL,
      benchmarkCandidates: BENCHMARK_CANDIDATES,
      priceEndpoints: [
        "https://stooq.com/q/d/l/?s=<symbol>&i=d",
        "https://query2.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&period1=<unix>&period2=<unix>",
      ],
    },
    coverage: {
      historicalUniqueSymbols: historical.allSymbols.length,
      currentSymbols: current.length,
      totalUniverseSymbols: allSymbols.length,
      stooqSuccess: results.filter((r) => r.source === "stooq").length,
      yahooFallbackSuccess: results.filter((r) => r.source === "yahoo").length,
      missing: results.filter((r) => r.source === "none").length,
      pitDateStart: historical.dates[0],
      pitDateEnd: historical.dates[historical.dates.length - 1],
    },
    symbols: results,
  };
  await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "data", "raw", "latest.txt"), `${SNAPSHOT_DATE}\n`, "utf8");

  const bytes = await dirSizeBytes(snapshotRoot);
  console.log(`Ingest complete: ${snapshotRoot}`);
  console.log(`Universe=${allSymbols.length}, stooq=${manifest.coverage.stooqSuccess}, yahoo=${manifest.coverage.yahooFallbackSuccess}, missing=${manifest.coverage.missing}`);
  console.log(`Snapshot size ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
