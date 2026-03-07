import Link from "next/link";

export default function HomePage() {
  return (
    <main className="container">
      <h1>Strategy Lab</h1>
      <p>
        Static GitHub Pages build with precomputed SNP1 results. Choose a scenario to inspect deterministic historical
        simulation artifacts.
      </p>

      <section className="card">
        <h2>Scenarios</h2>
        <ul>
          <li><Link href="/optimistic">Optimistic execution: both legs at avg(open, close) on t+1</Link></li>
          <li><Link href="/pessimistic">Pessimistic execution: sell old at LOW, buy new at HIGH on t+1</Link></li>
        </ul>
      </section>

      <section className="card">
        <h2>Also available</h2>
        <p>
          <Link href="/simulator">Open the interactive local simulator</Link> for parameter tweaking. Static scenario
          pages remain the default UX for deployment.
        </p>
      </section>
    </main>
  );
}
