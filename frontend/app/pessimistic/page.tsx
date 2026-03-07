import { ScenarioView } from "../../components/ScenarioView";
import { loadScenario } from "../../lib/prebuilt";

export default async function PessimisticPage() {
  const scenario = await loadScenario("pessimistic");
  return <ScenarioView scenarioName="Pessimistic" scenario={scenario} />;
}
