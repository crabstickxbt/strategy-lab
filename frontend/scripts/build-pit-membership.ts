import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DailySnapshot = { date: string; symbols: string[] };

type MembershipChange = { date: string; added: string[]; removed: string[]; count: number };

function parseHistoricalComponents(csvText: string): DailySnapshot[] {
  const lines = csvText.trim().split(/\r?\n/);
  const out: DailySnapshot[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const p = line.indexOf(",");
    if (p < 0) continue;
    const date = line.slice(0, p).trim();
    const raw = line.slice(p + 1).replace(/^"|"$/g, "");
    const symbols = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    out.push({ date, symbols: [...new Set(symbols)].sort() });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function buildChanges(daily: DailySnapshot[]): MembershipChange[] {
  const out: MembershipChange[] = [];
  let prev = new Set<string>();
  for (const row of daily) {
    const next = new Set(row.symbols);
    const added = row.symbols.filter((s) => !prev.has(s));
    const removed = [...prev].filter((s) => !next.has(s)).sort();
    if (added.length || removed.length || out.length === 0) {
      out.push({ date: row.date, added, removed, count: row.symbols.length });
    }
    prev = next;
  }
  return out;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, "..", "..");
  const rawRoot = path.join(root, "data", "raw");
  const snapshotDate = (await readFile(path.join(rawRoot, "latest.txt"), "utf8").catch(() => "")).trim();
  const effectiveSnapshot = snapshotDate || new Date().toISOString().slice(0, 10);
  const histPath = path.join(rawRoot, effectiveSnapshot, "sources", "sp500_historical_components.csv");
  const histCsv = await readFile(histPath, "utf8");

  const daily = parseHistoricalComponents(histCsv);
  const changes = buildChanges(daily);

  const outDir = path.join(root, "data", "processed");
  mkdirSync(outDir, { recursive: true });

  await writeFile(path.join(outDir, "pit_membership_daily.json"), `${JSON.stringify(daily)}\n`, "utf8");
  await writeFile(path.join(outDir, "pit_membership_changes.json"), `${JSON.stringify(changes, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "pit_membership_manifest.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    snapshotDate: effectiveSnapshot,
    rows: daily.length,
    firstDate: daily[0]?.date,
    lastDate: daily[daily.length - 1]?.date,
    uniqueSymbols: [...new Set(daily.flatMap((d) => d.symbols))].length,
    changesRows: changes.length,
  }, null, 2)}\n`);

  console.log(`Built PIT membership: ${daily.length} dates, ${changes.length} change rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
