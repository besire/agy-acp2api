import { config, ThinkingLevel } from "../config.js";
import { AcpModelInfo } from "../types/acp.js";
import { OpenAIChatCompletionRequest } from "../types/openai.js";

export interface UnifiedModelCatalogItem {
  id: string;
  name: string;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel;
  variants: Partial<Record<ThinkingLevel, string>>;
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
 * Parses model string and request parameters (`reasoning_effort`, `thinking`, `reasoning`, or model suffixes)
 * into a unified `{ baseModelId, thinkingLevel, acpModelId }`.
 */
export function resolveModelAndThinking(
  req: OpenAIChatCompletionRequest,
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

  // 3. Check request body reasoning parameters (`reasoning_effort`, `thinking`, `reasoning`)
  let bodyLevel: ThinkingLevel | null = null;
  if (req.reasoning_effort) {
    bodyLevel = normalizeThinkingLevel(req.reasoning_effort);
  } else if (req.thinking) {
    if (req.thinking.effort || req.thinking.level) {
      bodyLevel = normalizeThinkingLevel(req.thinking.effort || req.thinking.level);
    } else if (typeof req.thinking.budget_tokens === "number") {
      if (req.thinking.budget_tokens <= 4096) bodyLevel = "low";
      else if (req.thinking.budget_tokens <= 16384) bodyLevel = "medium";
      else bodyLevel = "high";
    }
  } else if (req.reasoning) {
    if (req.reasoning.effort || req.reasoning.level) {
      bodyLevel = normalizeThinkingLevel(req.reasoning.effort || req.reasoning.level);
    } else if (typeof req.reasoning.max_tokens === "number") {
      if (req.reasoning.max_tokens <= 4096) bodyLevel = "low";
      else if (req.reasoning.max_tokens <= 16384) bodyLevel = "medium";
      else bodyLevel = "high";
    }
  }

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
