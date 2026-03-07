import type { SimulateParams } from "../lib/types";

type Props = {
  params: SimulateParams;
  onChange: (next: SimulateParams) => void;
};

const FIELDS: Array<{ key: keyof SimulateParams; label: string; min: number; max: number; step: number }> = [
  { key: "drift", label: "Drift", min: -0.2, max: 0.4, step: 0.005 },
  { key: "vol", label: "Volatility", min: 0, max: 1.2, step: 0.01 },
  { key: "shockFrequency", label: "Shock Frequency", min: 0, max: 0.2, step: 0.001 },
  { key: "shockAmplitude", label: "Shock Amplitude", min: 0, max: 0.2, step: 0.001 },
];

export function ControlsPanel({ params, onChange }: Props) {
  return (
    <section className="card">
      <h2>SNP1 Controls</h2>
      <div className="grid">
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}: {params[f.key].toFixed(3)}</span>
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={params[f.key]}
              onChange={(e) => onChange({ ...params, [f.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
