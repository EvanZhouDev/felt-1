export type ImageSeedPromptConstraint = {
  adherence: number;
  penalty: number;
  subjectPresent: boolean;
  replacementLanguage: boolean;
  additiveLanguage: boolean;
  targetLeakage: boolean;
};

const STOP_WORDS = new Set([
  "about",
  "added",
  "create",
  "entire",
  "feel",
  "image",
  "input",
  "main",
  "only",
  "output",
  "preserve",
  "read",
  "subject",
  "target",
  "that",
  "the",
  "while",
  "whose",
  "with",
]);

export function imageSeedPromptConstraint(args: {
  seedText: string;
  seedPrompt: string;
  candidatePrompt: string;
}): ImageSeedPromptConstraint {
  const seedTerms = contentTerms(args.seedText);
  const prompt = normalize(args.candidatePrompt);
  const subjectPresent =
    seedTerms.length > 0 && seedTerms.some((term) => prompt.includes(term));
  const seedPattern = seedRegex(seedTerms);
  const replacementLanguage =
    /\b(entire|whole|dominant|main|centered|full[- ]?frame|primary)\b.{0,48}\b(subject|image|frame|form)\b/.test(
      prompt,
    ) ||
    (seedPattern
      ? new RegExp(
          `\\b(${seedPattern})\\b.{0,56}\\b(entire|whole|dominant|main|primary|centered)\\b`,
        ).test(prompt)
      : false);
  const additiveLanguage =
    seedPattern !== undefined &&
    (new RegExp(
      `\\b(a few|clusters?|scattered|placed|added|sits?|sitting)\\b.{0,80}\\b(${seedPattern})\\b`,
    ).test(prompt) ||
      new RegExp(
        `\\b(${seedPattern})\\b.{0,80}\\b(in|inside|within|onto|near|beside|placed|added|sits?|sitting)\\b`,
      ).test(prompt));
  const targetLeakageTerms = targetLeakageTermsFromSeedPrompt(args.seedPrompt);
  const targetLeakage = targetLeakageTerms.some((term) =>
    hasPositiveTerm(prompt, term),
  );
  const negativeSceneLanguage =
    /\bno\b.{0,40}\b(unrelated|scene|room|interior|props?|setting|background)\b/.test(
      prompt,
    );
  const adherence = clamp01(
    0.1 +
      (subjectPresent ? 0.45 : 0) +
      (replacementLanguage ? 0.35 : 0) +
      (negativeSceneLanguage ? 0.1 : 0) -
      (additiveLanguage ? 0.45 : 0) -
      (targetLeakage ? 0.2 : 0),
  );

  const basePenalty = subjectPresent ? (1 - adherence) * 0.55 : 0.65;
  const penaltyFloor = Math.max(
    targetLeakage ? 0.65 : 0,
    additiveLanguage ? 0.65 : 0,
  );

  return {
    adherence,
    penalty: clamp01(Math.max(basePenalty, penaltyFloor)),
    subjectPresent,
    replacementLanguage,
    additiveLanguage,
    targetLeakage,
  };
}

function targetLeakageTermsFromSeedPrompt(prompt: string): string[] {
  const normalized = normalize(prompt);
  const matches = [
    ...normalized.matchAll(
      /\bnot\s+(?:(?:an|a|the)\s+)?([a-z][a-z0-9 -]{2,48}?)(?:\s+with|\s+plus|\s+containing|[.,;]|$)/g,
    ),
  ];
  return unique(
    matches
      .flatMap((match) => contentTerms(match[1] ?? ""))
      .filter((term) => term.length >= 4),
  );
}

function hasPositiveTerm(text: string, term: string): boolean {
  const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "g");
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - 30), index);
    const suffix = text.slice(index + term.length, index + term.length + 24);
    if (!/\b(no|not|without)\b[^,.!?;]*$/.test(prefix)) {
      if (/^\s+(feel|feeling|vibe|style|atmosphere|mood)\b/.test(suffix)) {
        continue;
      }
      if (
        /^\s+(?:target\s+)?(?:photo|image)?\s*(?:is\s+)?only\s+(?:the\s+)?(?:perceptual\s+)?(?:style|vibe|feel)\b/.test(
          suffix,
        )
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function contentTerms(text: string): string[] {
  return unique(
    normalize(text)
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9-]/g, ""))
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function seedRegex(terms: string[]): string | undefined {
  const escaped = terms.map(escapeRegex);
  return escaped.length > 0 ? escaped.join("|") : undefined;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
