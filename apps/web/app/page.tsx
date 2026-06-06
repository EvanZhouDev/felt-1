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
          <span>InputObj.inputNode.payload</span>
          <span>Frozen TRIBE Oracle</span>
          <span>AgentOutput.outputNode.payload</span>
          <span>Judge-Guided Agent Loop</span>
        </div>
      </aside>
      <section className="main">
        <div className="section grid">
          <div className="panel stack">
            <h2>Input Object</h2>
            <label htmlFor="input-text">Input text</label>
            <textarea id="input-text" defaultValue={defaultInput} />
            <p className="muted">
              The input object contains the target node and an optional seed.
            </p>
          </div>
          <div className="panel stack">
            <h2>Output Spec</h2>
            <label htmlFor="seed">Seed content</label>
            <input id="seed" defaultValue={defaultSeed} />
            <p className="muted">
              Agents generate output nodes for the requested medium, then the
              renderer prepares them for TRIBE scoring.
            </p>
          </div>
        </div>
        <div className="section panel stack">
          <h2>Agentic Loop</h2>
          <pre>{`target = oracle.encode(render(input.inputNode.payload))
outputs = agents.generate(input, output)

repeat:
  rendered = outputs.map((o) => render(o.outputNode.payload))
  scores = rank_by_neural_similarity(target, rendered)
  decision = judge(scores, input)
  outputs = agents.generate(input, output, decision)`}</pre>
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
