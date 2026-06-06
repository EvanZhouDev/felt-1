const defaultInput = "the quiet river reflects the morning sky";
const defaultSeed = "a crowded night market";

export default function Home() {
  return (
    <main className="shell">
      <aside className="sidebar stack">
        <div>
          <span className="pill">Project Volta</span>
          <h1>Neural Activation Translation</h1>
          <p className="muted">
            Render input, encode activations, seed an output, and let agents
            search for a candidate with the same neural feel.
          </p>
        </div>
        <div className="panel stack">
          <strong>Architecture</strong>
          <span>Input Module.render()</span>
          <span>Frozen TRIBE Oracle</span>
          <span>Output Module.render()</span>
          <span>Agentic Search Loop</span>
        </div>
      </aside>
      <section className="main">
        <div className="section grid">
          <div className="panel stack">
            <h2>Input Module</h2>
            <label htmlFor="input-text">Input text</label>
            <textarea id="input-text" defaultValue={defaultInput} />
            <p className="muted">
              The text input module renders deterministic word events for the
              neural oracle.
            </p>
          </div>
          <div className="panel stack">
            <h2>Output Module</h2>
            <label htmlFor="seed">Seed content</label>
            <input id="seed" defaultValue={defaultSeed} />
            <p className="muted">
              The seed constrains what the output should be about, while the
              scorer optimizes neural similarity.
            </p>
          </div>
        </div>
        <div className="section panel stack">
          <h2>Agentic Loop</h2>
          <pre>{`target = oracle.encode(input.render())
state = output.initialize(seed)

repeat:
  candidate = output.render(state)
  activation = oracle.encode(candidate)
  score = neural_similarity(target, activation)
  critique = critic(score, seed, candidate)
  state = output.revise(state, critique)`}</pre>
          <div>
            <button type="button">Run Mock Search</button>{" "}
            <button type="button" className="secondary">
              View Traces
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
