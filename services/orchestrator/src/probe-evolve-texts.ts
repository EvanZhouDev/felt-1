import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type ParentText = {
  id: string;
  text: string;
  score?: number;
};

type TextProbe = {
  id: string;
  text: string;
  metadata: {
    operator:
      | "elite"
      | "unit-mutation"
      | "unit-ablation"
      | "unit-crossover"
      | "axis-injection"
      | "syntax-reset";
    parents: string[];
    generation: number;
    details?: Record<string, unknown>;
  };
};

const DEFAULT_LIMIT = 48;
const DEFAULT_GENERATION = 1;

const genericAxes = [
  "low motion",
  "high motion",
  "soft texture",
  "sharp texture",
  "near distance",
  "deep distance",
  "warm tone",
  "cool tone",
  "high contrast",
  "low contrast",
  "foreground weight",
  "background depth",
  "human focus",
  "object focus",
  "ambient pressure",
  "emotional pressure",
  "plain structure",
  "dense structure",
  "quiet ambiguity",
  "clear certainty",
];

const modifiers = [
  "quiet",
  "dense",
  "soft",
  "sharp",
  "warm",
  "cool",
  "near",
  "distant",
  "structured",
  "muted",
  "bright",
  "heavy",
];

const args = parseArgs(process.argv.slice(2));
if (!args.parents) {
  throw new Error(
    "Usage: bun services/orchestrator/src/probe-evolve-texts.ts --parents parents.json [--out probes.json] [--limit 48] [--generation 1]",
  );
}

const parents = normalizeParents(
  JSON.parse(await readFile(args.parents, "utf8")) as unknown,
);
const probes = evolveTextPopulation(parents, {
  generation: args.generation ?? DEFAULT_GENERATION,
  limit: args.limit ?? DEFAULT_LIMIT,
});

if (args.out) {
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(probes, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(probes, null, 2));

function evolveTextPopulation(
  parents: ParentText[],
  options: {
    generation: number;
    limit: number;
  },
): TextProbe[] {
  const rankedParents = [...parents].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  );
  const seen = new Set<string>();
  const probes: TextProbe[] = [];
  const push = (probe: TextProbe) => {
    const key = normalizeText(probe.text);
    if (seen.has(key) || key.length === 0) {
      return;
    }
    seen.add(key);
    probes.push(probe);
  };

  for (const parent of rankedParents) {
    push({
      id: `elite-${slug(parent.id)}`,
      text: parent.text,
      metadata: {
        operator: "elite",
        parents: [parent.id],
        generation: options.generation,
      },
    });
  }

  const pools = [
    interleavePools(
      rankedParents.map((parent) => mutateUnits(parent, options.generation)),
    ),
    crossoverParents(rankedParents, options.generation),
    interleavePools(
      rankedParents.map((parent) => injectAxes(parent, options.generation)),
    ),
    rankedParents.map((parent) => syntaxReset(parent, options.generation)),
  ].filter((pool) => pool.length > 0);

  while (pools.length > 0 && probes.length < options.limit) {
    for (const pool of [...pools]) {
      const child = pool.shift();
      if (child) {
        push(child);
      }
      if (probes.length >= options.limit) {
        return probes;
      }
    }
    for (let index = pools.length - 1; index >= 0; index -= 1) {
      if (pools[index].length === 0) {
        pools.splice(index, 1);
      }
    }
  }

  return probes;
}

function interleavePools<T>(groups: T[][]): T[] {
  const pools = groups.map((group) => [...group]);
  const output: T[] = [];
  while (pools.some((pool) => pool.length > 0)) {
    for (const pool of pools) {
      const item = pool.shift();
      if (item) {
        output.push(item);
      }
    }
  }
  return output;
}

function mutateUnits(parent: ParentText, generation: number): TextProbe[] {
  const units = splitUnits(parent.text);
  return units.flatMap((unit, unitIndex) => {
    const modifier = modifiers[(unitIndex + generation) % modifiers.length];
    const replacement = applyModifier(unit, modifier);
    const mutatedUnits = replaceUnit(units, unitIndex, replacement);
    const probes: TextProbe[] = [
      {
        id: `mutate-${slug(parent.id)}-${unitIndex + 1}-${slug(modifier)}`,
        text: joinUnits(mutatedUnits),
        metadata: {
          operator: "unit-mutation",
          parents: [parent.id],
          generation,
          details: {
            unitIndex,
            from: unit,
            to: replacement,
          },
        },
      },
    ];
    if (units.length > 1) {
      const ablatedUnits = units.filter((_, index) => index !== unitIndex);
      probes.push({
        id: `ablate-${slug(parent.id)}-${unitIndex + 1}`,
        text: joinUnits(ablatedUnits),
        metadata: {
          operator: "unit-ablation",
          parents: [parent.id],
          generation,
          details: {
            removed: unit,
          },
        },
      });
    }
    return probes;
  });
}

function crossoverParents(
  parents: ParentText[],
  generation: number,
): TextProbe[] {
  const probes: TextProbe[] = [];
  for (let leftIndex = 0; leftIndex < parents.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < parents.length;
      rightIndex += 1
    ) {
      const left = parents[leftIndex];
      const right = parents[rightIndex];
      const leftUnits = splitUnits(left.text);
      const rightUnits = splitUnits(right.text);
      if (leftUnits.length === 1 && rightUnits.length === 1) {
        continue;
      }
      const leftCut = Math.max(1, Math.ceil(leftUnits.length / 2));
      const rightCut = Math.floor(rightUnits.length / 2);
      const childUnits = [
        ...leftUnits.slice(0, leftCut),
        ...rightUnits.slice(rightCut),
      ];
      probes.push({
        id: `crossover-${slug(left.id)}-${slug(right.id)}`,
        text: joinUnits(childUnits),
        metadata: {
          operator: "unit-crossover",
          parents: [left.id, right.id],
          generation,
          details: {
            leftCut,
            rightCut,
          },
        },
      });
    }
  }
  return probes;
}

function injectAxes(parent: ParentText, generation: number): TextProbe[] {
  const units = splitUnits(parent.text);
  return genericAxes.slice(0, Math.min(8, genericAxes.length)).map((axis) => {
    return {
      id: `axis-${slug(parent.id)}-${slug(axis)}`,
      text: appendAxis(parent.text, units, axis),
      metadata: {
        operator: "axis-injection",
        parents: [parent.id],
        generation,
        details: {
          axis,
        },
      },
    };
  });
}

function syntaxReset(parent: ParentText, generation: number): TextProbe {
  const units = splitUnits(parent.text);
  return {
    id: `syntax-reset-${slug(parent.id)}`,
    text:
      units.length === 1
        ? ensureTerminalPunctuation(units[0])
        : units.map(ensureTerminalPunctuation).join(" "),
    metadata: {
      operator: "syntax-reset",
      parents: [parent.id],
      generation,
      details: {
        fromSeparator: inferSeparator(parent.text),
      },
    },
  };
}

function applyModifier(unit: string, modifier: string): string {
  const trimmed = unit.trim();
  const normalized = normalizeText(trimmed);
  if (normalized.startsWith(`${modifier} `)) {
    return unit;
  }
  const articleMatch = trimmed.match(/^(a|an|the)\s+(.+)$/i);
  if (articleMatch) {
    const article =
      articleMatch[1].toLowerCase() === "the"
        ? articleMatch[1]
        : articleForWord(modifier, articleMatch[1]);
    return `${article} ${modifier} ${articleMatch[2]}`;
  }
  return `${modifier} ${trimmed}`;
}

function articleForWord(word: string, fallback: string): string {
  const article = /^[aeiou]/i.test(word) ? "an" : "a";
  return /^[A-Z]/.test(fallback) ? capitalize(article) : article;
}

function capitalize(value: string): string {
  return value.replace(/^./, (char) => char.toUpperCase());
}

function replaceUnit(units: string[], index: number, replacement: string) {
  const next = [...units];
  next[index] = replacement;
  return next;
}

function splitUnits(text: string): string[] {
  if (isSingleNaturalSentence(text)) {
    return [text.trim()];
  }
  const separator = inferSeparator(text);
  const units = text
    .split(separator)
    .map((unit) => unit.trim())
    .filter(Boolean);
  if (units.length > 1) {
    return units;
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 10) {
    return [text.trim()];
  }
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
}

function joinUnits(units: string[]): string {
  if (units.length === 1) {
    return units[0].trim();
  }
  return units
    .map((unit) => unit.trim())
    .filter(Boolean)
    .join(", ");
}

function appendAxis(text: string, units: string[], axis: string): string {
  if (units.length === 1 && isSingleNaturalSentence(text)) {
    return `${stripTerminalPunctuation(units[0])} with ${axis}.`;
  }
  return joinUnits([...units, axis]);
}

function isSingleNaturalSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes(",")) {
    return false;
  }
  return (trimmed.match(/[.!?]/g) ?? []).length <= 1;
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stripTerminalPunctuation(text: string): string {
  return text.trim().replace(/[.!?]+$/, "");
}

function inferSeparator(text: string): string | RegExp {
  if (text.includes(",")) {
    return ",";
  }
  if (/[.!?]\s+/.test(text)) {
    return /[.!?]\s+/;
  }
  return ",";
}

function normalizeParents(value: unknown): ParentText[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => parentFromUnknown(item, index));
  }
  if (isObject(value) && Array.isArray(value.results)) {
    return value.results.map((item, index) => parentFromUnknown(item, index));
  }
  throw new Error(
    "Parents must be a JSON array or a probe report with results.",
  );
}

function parentFromUnknown(item: unknown, index: number): ParentText {
  if (typeof item === "string") {
    return {
      id: `parent-${String(index + 1).padStart(2, "0")}`,
      text: item,
    };
  }
  if (isObject(item) && typeof item.text === "string") {
    return {
      id:
        typeof item.id === "string"
          ? item.id
          : `parent-${String(index + 1).padStart(2, "0")}`,
      text: item.text,
      score: parentScore(item),
    };
  }
  throw new Error(`Invalid parent at index ${index}.`);
}

function parentScore(item: Record<string, unknown>): number | undefined {
  if (typeof item.total === "number") {
    return item.total;
  }
  if (typeof item.adjustedSimilarity === "number") {
    return item.adjustedSimilarity;
  }
  if (isObject(item.score)) {
    if (typeof item.score.total === "number") {
      return item.score.total;
    }
    if (typeof item.score.adjustedSimilarity === "number") {
      return item.score.adjustedSimilarity;
    }
    if (typeof item.score.neuralSimilarity === "number") {
      return item.score.neuralSimilarity;
    }
  }
  if (typeof item.score === "number") {
    return item.score;
  }
  if (typeof item.neuralSimilarity === "number") {
    return item.neuralSimilarity;
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function slug(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArgs(argv: string[]): {
  parents?: string;
  out?: string;
  limit?: number;
  generation?: number;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (flag === "--parents") {
      parsed.parents = value;
      index += 1;
    } else if (flag === "--out") {
      parsed.out = value;
      index += 1;
    } else if (flag === "--limit") {
      parsed.limit = positiveInteger(value, "--limit");
      index += 1;
    } else if (flag === "--generation") {
      parsed.generation = positiveInteger(value, "--generation");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}
