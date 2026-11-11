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

const THINKING_SUFFIX_TOKENS =
  "low|medium|high|minimal|min|med|normal|auto|max|xhigh|extra\\s+high|deep";

/**
 * Strips any thinking level suffix (`-low`, `-medium`, `-high`, `-xhigh`, `-max`, `(low)`, `:high`, etc.)
 * so model names returned to API clients and dashboards are always clean base model identifiers.
 */
export function stripModelThinkingSuffix(rawModel: string): string {
  if (!rawModel) return rawModel;
  return rawModel
    .trim()
    .replace(/^agy\//i, "")
    .replace(
      new RegExp(
        `\\s*[([]\\s*(?:${THINKING_SUFFIX_TOKENS})\\s*[)\\]]\\s*$`,
        "i"
      ),
      ""
    )
    .replace(
      new RegExp(`[:@/]\\s*(?:${THINKING_SUFFIX_TOKENS})\\s*$`, "i"),
      ""
    )
    .replace(
      /-(?:low|medium|high|minimal|min|med|normal|auto|max|xhigh|deep)(?=-(?:trial|preview|exp)\b)/i,
      ""
    )
    .replace(
      /-(?:low|medium|high|minimal|min|med|normal|auto|max|xhigh|deep)(?:-thinking)?$/i,
      ""
    )
    .trim();
}

export function cleanModelDisplayName(rawName: string, baseId: string): string {
  if (!rawName) return baseId;
  let cleaned = rawName
    .trim()
    .replace(
      new RegExp(
        `\\s*[([]\\s*(?:${THINKING_SUFFIX_TOKENS})\\s*[)\\]]\\s*$`,
        "i"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\s*[-–—:|@/]+\\s*(?:${THINKING_SUFFIX_TOKENS})\\s*$`,
        "i"
      ),
      ""
    )
    .replace(
      /\s+(?:low|medium|high|minimal|max|xhigh|extra\s+high)\s*$/i,
      ""
    )
    .trim();

  if (!cleaned.includes(" ")) {
    cleaned = stripModelThinkingSuffix(cleaned);
  }
  return cleaned || baseId;
}

export function normalizeThinkingLevel(raw?: string | null): ThinkingLevel | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "minimal" || v === "min") return "low";
  if (v === "medium" || v === "med" || v === "normal" || v === "auto") return "medium";
  if (v === "high" || v === "xhigh" || v === "max" || v === "extra high" || v === "deep") return "high";
  return null;
}

function extractModelVariant(rawModelId: string): {
  baseId: string;
  level: ThinkingLevel | null;
  isCanonicalLevel: boolean;
} {
  const trimmed = rawModelId.trim().replace(/^agy\//i, "");

  // 1. Bracket/colon/at/slash syntax: e.g. `gemini-4-carbon(high)`, `gemini-4-carbon:low`, `gemini-4-carbon@high`
  const symbolMatch = trimmed.match(
    new RegExp(
      `^(.*?)(?:[:@/(\\[]\\s*(${THINKING_SUFFIX_TOKENS})\\s*[)\\]]?)$`,
      "i"
    )
  );
  if (symbolMatch) {
    const rawLv = symbolMatch[2].trim().toLowerCase();
    const level = normalizeThinkingLevel(rawLv);
    const baseId = stripModelThinkingSuffix(symbolMatch[1]);
    return {
      baseId,
      level,
      isCanonicalLevel: rawLv === level,
    };
  }

  // 2. Hyphen suffix syntax: e.g. `gemini-4-carbon-high`, `gemini-4-carbon-xhigh`, `gemini-4-carbon-high-thinking`
  const hyphenMatch = trimmed.match(
    /^(.*?)-(low|medium|high|minimal|min|med|normal|auto|max|xhigh|deep)(?:-(thinking|trial|preview|exp))?$/i
  );
  if (hyphenMatch) {
    const rawLv = hyphenMatch[2].toLowerCase();
    const level = normalizeThinkingLevel(rawLv);
    const trailingTag = hyphenMatch[3]?.toLowerCase();
    const prefixBase = stripModelThinkingSuffix(hyphenMatch[1]);
    const baseId =
      trailingTag && trailingTag !== "thinking" && trailingTag !== "trial"
        ? `${prefixBase}-${trailingTag}`
        : prefixBase;
    return {
      baseId,
      level,
      isCanonicalLevel: rawLv === level && !trailingTag,
    };
  }

  return {
    baseId: stripModelThinkingSuffix(trimmed),
    level: null,
    isCanonicalLevel: false,
  };
}

/**
 * Aggregates raw ACP model entries (e.g. `gemini-4-carbon-low/medium/high`, `gemini-4-argon-low/medium/high`)
 * into unified base models (`gemini-4-carbon`, `gemini-4-argon` with `thinkingLevels: ["low", "medium", "high"]`).
 */
export function buildUnifiedModelCatalog(
  rawModels: AcpModelInfo[]
): UnifiedModelCatalogItem[] {
  const map = new Map<string, UnifiedModelCatalogItem>();

  for (const m of rawModels) {
    const rawId = (m.modelId || "").trim();
    if (!rawId) continue;

    const { baseId, level, isCanonicalLevel } = extractModelVariant(rawId);
    const cleanName = cleanModelDisplayName(m.name || baseId, baseId);

    if (level) {
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
      } else if (item.name === item.id && cleanName && cleanName !== baseId) {
        item.name = cleanName;
      }

      if (!item.thinkingLevels.includes(level)) {
        item.thinkingLevels.push(level);
      }
      if (!item.variants[level] || isCanonicalLevel) {
        item.variants[level] = rawId;
      }
    } else {
      // Model without thinking effort suffix
      if (!map.has(baseId)) {
        map.set(baseId, {
          id: baseId,
          name: cleanName || baseId,
          thinkingLevels: ["medium"],
          defaultThinkingLevel: "medium",
          variants: {
            medium: rawId,
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
  const normalizedModelStr = rawModelStr.replace(/^agy\//i, "").trim();

  const parsedVariant = extractModelVariant(normalizedModelStr);
  const candidateBase = parsedVariant.baseId;
  const suffixLevel = parsedVariant.level;

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
    catalog.find((c) => c.id.toLowerCase() === normalizedModelStr.toLowerCase());

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
      baseModelId: stripModelThinkingSuffix(catalogEntry.id),
      thinkingLevel: effectiveLevel,
      acpModelId,
    };
  }

  // Fallback if custom/unlisted model ID is passed
  const hasExplicitHyphenVariant =
    !bodyLevel &&
    /-(?:low|medium|high|minimal|min|med|normal|auto|max|xhigh|deep)(?:-(?:thinking|trial|preview|exp))?$/i.test(
      normalizedModelStr
    );
  const fallbackAcpId = hasExplicitHyphenVariant
    ? normalizedModelStr
    : `${candidateBase}-${desiredLevel}`;

  return {
    requestedModel: rawModelStr,
    baseModelId: candidateBase,
    thinkingLevel: desiredLevel,
    acpModelId: fallbackAcpId,
  };
}
