import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Daily = { date: string; symbols: string[] };

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, "..", "..");
  const daily: Daily[] = JSON.parse(await readFile(path.join(root, "data", "processed", "pit_membership_daily.json"), "utf8"));

  assert.ok(daily.length > 3000, "expected many daily rows");
  for (let i = 1; i < daily.length; i += 1) {
    assert.ok(daily[i].date >= daily[i - 1].date, `non-monotonic date at ${i}`);
  }

  const badCounts = daily.filter((d) => d.symbols.length < 400 || d.symbols.length > 550);
  assert.ok(badCounts.length === 0, `unexpected member count rows: ${badCounts.length}`);

  let excessiveTurnoverDays = 0;
  for (let i = 1; i < daily.length; i += 1) {
    const prev = new Set(daily[i - 1].symbols);
    const cur = new Set(daily[i].symbols);
    let delta = 0;
    for (const s of cur) if (!prev.has(s)) delta += 1;
    for (const s of prev) if (!cur.has(s)) delta += 1;
    if (delta > 30) excessiveTurnoverDays += 1;
  }
  assert.ok(excessiveTurnoverDays < 20, `too many high-turnover days: ${excessiveTurnoverDays}`);

  console.log("PIT membership tests passed", {
    rows: daily.length,
    first: daily[0].date,
    last: daily[daily.length - 1].date,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
