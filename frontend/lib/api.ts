import type { SimulateParams, SimulationResponse } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export async function simulate(params: SimulateParams): Promise<SimulationResponse> {
  const response = await fetch(`${API_BASE}/simulate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Simulation failed: ${response.status}`);
  }

  return (await response.json()) as SimulationResponse;
}
