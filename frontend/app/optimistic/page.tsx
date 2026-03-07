import { ScenarioView } from "../../components/ScenarioView";
import { loadScenario } from "../../lib/prebuilt";

export default async function OptimisticPage() {
  const scenario = await loadScenario("optimistic");
  return <ScenarioView scenarioName="Optimistic" scenario={scenario} />;
}
