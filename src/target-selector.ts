import type { CdpTarget } from "./cdp.js";

export type TargetSelectorConfig = {
  exactTitles?: string[];
  titleIncludes?: string[];
  urlIncludes?: string[];
};

export type TargetCandidate = {
  target: CdpTarget;
  score: number;
  reasons: string[];
};

const DEFAULT_CONFIG: Required<TargetSelectorConfig> = {
  exactTitles: ["SharedJSContext"],
  titleIncludes: ["SharedJSContext", "Shared Context"],
  urlIncludes: [],
};

export function rankSharedContextTargets(
  targets: CdpTarget[],
  config: TargetSelectorConfig = {},
): TargetCandidate[] {
  const resolved = {
    exactTitles: config.exactTitles ?? DEFAULT_CONFIG.exactTitles,
    titleIncludes: config.titleIncludes ?? DEFAULT_CONFIG.titleIncludes,
    urlIncludes: config.urlIncludes ?? DEFAULT_CONFIG.urlIncludes,
  };

  return targets
    .filter((target) => Boolean(target.webSocketDebuggerUrl))
    .map((target) => scoreTarget(target, resolved))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
}

export function selectSharedContextTarget(
  targets: CdpTarget[],
  config?: TargetSelectorConfig,
): TargetCandidate | null {
  return rankSharedContextTargets(targets, config)[0] ?? null;
}

function scoreTarget(target: CdpTarget, config: Required<TargetSelectorConfig>): TargetCandidate {
  let score = 0;
  const reasons: string[] = [];

  if (config.exactTitles.includes(target.title)) {
    score += 100;
    reasons.push(`title=${target.title}`);
  }

  for (const fragment of config.titleIncludes) {
    if (target.title.includes(fragment)) {
      score += 25;
      reasons.push(`title includes ${fragment}`);
    }
  }

  for (const fragment of config.urlIncludes) {
    if (target.url.includes(fragment)) {
      score += 10;
      reasons.push(`url includes ${fragment}`);
    }
  }

  return { target, score, reasons };
}
