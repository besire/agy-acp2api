import { config, ThinkingLevel } from "../config.js";
import { AcpModelInfo } from "../types/acp.js";

export interface UnifiedModelCatalogItem {
  id: string;
  name: string;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel;
  variants: Partial<Record<ThinkingLevel, string>>;
}

/** What a request asks for: a model name (maybe with an effort suffix) and an explicit effort. */
export interface ModelSelection {
  model?: string;
  effort?: ThinkingLevel | null;
}

export interface ResolvedModelTarget {
  requestedModel: string;
  baseModelId: string;
  thinkingLevel: ThinkingLevel;
  acpModelId: string;
}

const LEVEL_ORDER: ThinkingLevel[] = ["low", "medium", "high"];

/**
 * Strips any thinking level suffix (`-low`, `-medium`, `-high`, `(low)`, `:high`, etc.)
 * so model names returned to API clients are always clean base model identifiers.
 */
export function stripModelThinkingSuffix(rawModel: string): string {
  if (!rawModel) return rawModel;
  return rawModel
    .trim()
    .replace(/\s*[([]\s*(?:low|medium|high|minimal|max|xhigh)\s*[)\]]\s*$/i, "")
    .replace(/[:@/]\s*(?:low|medium|high|minimal|max|xhigh)\s*$/i, "")
    .replace(/-(?:low|medium|high)$/i, "")
    .trim();
}

export function normalizeThinkingLevel(raw?: string | null): ThinkingLevel | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "minimal" || v === "min") return "low";
  if (v === "medium" || v === "med" || v === "normal" || v === "auto") return "medium";
  if (v === "high" || v === "xhigh" || v === "max" || v === "deep") return "high";
  return null;
}

/** Maps a thinking token budget onto the three effort levels ACP models expose. */
export function thinkingLevelFromBudget(budgetTokens: number): ThinkingLevel {
  if (budgetTokens <= 4096) return "low";
  if (budgetTokens <= 16384) return "medium";
  return "high";
}

/**
 * Aggregates raw ACP model entries (e.g. `gemini-4-argon-low/medium/high`)
 * into unified base models (`gemini-4-argon` with `thinkingLevels: ["low", "medium", "high"]`).
 */
export function buildUnifiedModelCatalog(
  rawModels: AcpModelInfo[]
): UnifiedModelCatalogItem[] {
  const map = new Map<string, UnifiedModelCatalogItem>();

  for (const m of rawModels) {
    const match = m.modelId.match(/^(.*)-(low|medium|high)$/i);
    if (match) {
      const baseId = match[1];
      const level = match[2].toLowerCase() as ThinkingLevel;
      const cleanName = m.name.replace(/\s*\((Low|Medium|High)\)\s*$/i, "").trim();

      let item = map.get(baseId);
      if (!item) {
        item = {
          id: baseId,
          name: cleanName || baseId,
          thinkingLevels: [],
          defaultThinkingLevel: config.defaultThinkingLevel,
          variants: {},
        };
        map.set(baseId, item);
      }

      if (!item.thinkingLevels.includes(level)) {
        item.thinkingLevels.push(level);
      }
      item.variants[level] = m.modelId;
    } else {
      // Model without -low/-medium/-high suffix
      if (!map.has(m.modelId)) {
        map.set(m.modelId, {
          id: m.modelId,
          name: m.name || m.modelId,
          thinkingLevels: ["medium"],
          defaultThinkingLevel: "medium",
          variants: {
            medium: m.modelId,
          },
        });
      }
    }
  }

  // Sort thinkingLevels consistently: low -> medium -> high
  for (const item of map.values()) {
    item.thinkingLevels.sort(
      (a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b)
    );
    if (!item.thinkingLevels.includes(item.defaultThinkingLevel)) {
      item.defaultThinkingLevel =
        item.thinkingLevels.includes("medium")
          ? "medium"
          : item.thinkingLevels[0] || "medium";
    }
  }

  return Array.from(map.values());
}

/**
 * Parses the model string (`-high`, `(low)`, `:medium` suffixes) and the explicit effort
 * into a unified `{ baseModelId, thinkingLevel, acpModelId }`.
 */
export function resolveModelAndThinking(
  req: ModelSelection,
  rawModels: AcpModelInfo[]
): ResolvedModelTarget {
  const catalog = buildUnifiedModelCatalog(rawModels);
  const rawModelStr = (req.model || config.defaultModel || "gemini-3.8-flash").trim();

  let candidateBase = rawModelStr;
  let suffixLevel: ThinkingLevel | null = null;

  // 1. Check bracket/colon/at/slash syntax: e.g. `gemini-4-argon(high)`, `gemini-4-argon:low`, `gemini-4-argon@high`
  const symbolMatch = candidateBase.match(
    /^(.*?)(?:[:@/(\[]\s*(low|medium|high|minimal|max|xhigh)\s*[)\]]?)$/i
  );
  if (symbolMatch) {
    candidateBase = symbolMatch[1].trim();
    suffixLevel = normalizeThinkingLevel(symbolMatch[2]);
  } else {
    // 2. Check hyphen suffix syntax: e.g. `gemini-4-argon-high`
    const hyphenMatch = candidateBase.match(/^(.*)-(low|medium|high)$/i);
    if (hyphenMatch) {
      candidateBase = hyphenMatch[1].trim();
      suffixLevel = normalizeThinkingLevel(hyphenMatch[2]);
    }
  }

  const bodyLevel = req.effort ?? null;

  // Priority: Explicit body reasoning_effort > Explicit model string suffix > Default config thinking level
  const desiredLevel: ThinkingLevel =
    bodyLevel || suffixLevel || config.defaultThinkingLevel || "medium";

  // 4. Match against unified catalog
  const catalogEntry =
    catalog.find((c) => c.id.toLowerCase() === candidateBase.toLowerCase()) ||
    catalog.find((c) => c.id.toLowerCase() === rawModelStr.toLowerCase());

  if (catalogEntry) {
    const effectiveLevel = catalogEntry.variants[desiredLevel]
      ? desiredLevel
      : catalogEntry.defaultThinkingLevel;
    const acpModelId =
      catalogEntry.variants[effectiveLevel] ||
      Object.values(catalogEntry.variants)[0] ||
      `${catalogEntry.id}-${effectiveLevel}`;

    return {
      requestedModel: rawModelStr,
      baseModelId: catalogEntry.id,
      thinkingLevel: effectiveLevel,
      acpModelId,
    };
  }

  // Fallback if custom/unlisted model ID is passed
  const fallbackAcpId = rawModelStr.match(/-(low|medium|high)$/i)
    ? rawModelStr
    : `${candidateBase}-${desiredLevel}`;

  return {
    requestedModel: rawModelStr,
    baseModelId: candidateBase,
    thinkingLevel: desiredLevel,
    acpModelId: fallbackAcpId,
  };
}
