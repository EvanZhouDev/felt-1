# Vibe-metric validation — results

- normalization: `zscore_then_l2`
- time aggregation: `mean`
- pairs: 20 (10 matched / 10 mismatched)

## Conditions (text↔image)

| condition | AUC | perm p | d̄ matched | d̄ mismatched |
|---|---|---|---|---|
| 1. raw cosine | 0.71 | 0.06139 | 1.5116 | 1.6521 |
| 2. anatomical-mask (11820v) | 0.76 | 0.0261 | 1.5091 | 1.6673 |
| 3. data-driven (LOPO-CV) | 0.67 | 0.11029 | 1.3516 | 1.4834 |
| 4. CLIP cosine | 0.9 | 0.0006 | 0.7191 | 0.8302 |

## Verdict: **RED**

Best cross-validated brain metric AUC=0.76 (< 0.75). TRIBE's predicted geometry may not carry cross-modal vibe at this resolution. Next step is a learned alignment head BEFORE any generator work.
