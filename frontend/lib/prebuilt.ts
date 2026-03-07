import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrebuiltScenario } from "./types";

export async function loadScenario(scenario: "optimistic" | "pessimistic"): Promise<PrebuiltScenario> {
  const filename = `sp500_vs_snp1_${scenario}.json`;
  const fullPath = path.join(process.cwd(), "public", "data", filename);
  const content = await readFile(fullPath, "utf8");
  return JSON.parse(content) as PrebuiltScenario;
}
