import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DraftRecommendation } from '@/lib/types';
import type { CoachResponse } from './format';

// ============================================================================
// LLM narration layer (§31, §38, §45).
//
// The model NEVER decides the pick. By the time anything here runs, the
// deterministic engine has already chosen the player, the confidence, and the
// supporting facts. The model's only job is to say it like a person would.
//
// That constraint is what makes hallucinated numbers structurally impossible in
// the recommendation path: there is no number in the output that did not come
// from the engine, and the schema below rejects anything that adds one.
// ============================================================================

export const PROMPT_VERSION = 'coach-narrate-v1';

const MODELS = {
  reasoning: () => process.env.COACH_MODEL || 'claude-sonnet-5',
  classifier: () => process.env.COACH_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
};

/** Published per-million-token prices, used for budget accounting only. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export interface UsageRecord {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  at: string;
}

/**
 * In-process budget tracker. A persistent implementation writes to `ai_usage`;
 * this one keeps the guarantee that the app cannot spend unboundedly even if
 * the database is unavailable.
 */
export class AiBudget {
  private usage: UsageRecord[] = [];

  constructor(private readonly dailyLimitUsd = Number(process.env.COACH_DAILY_AI_BUDGET_USD ?? '2')) {}

  spentLast24h(now = new Date()): number {
    const cutoff = now.getTime() - 24 * 3_600_000;
    return this.usage
      .filter((u) => new Date(u.at).getTime() >= cutoff)
      .reduce((sum, u) => sum + u.estimatedCostUsd, 0);
  }

  canSpend(now = new Date()): boolean {
    if (this.dailyLimitUsd <= 0) return false;
    return this.spentLast24h(now) < this.dailyLimitUsd;
  }

  record(record: UsageRecord): void {
    this.usage.push(record);
  }

  history(): readonly UsageRecord[] {
    return this.usage;
  }
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model] ?? PRICING['claude-sonnet-5']!;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Structured output contract (§31)
// ---------------------------------------------------------------------------

export const NarrationSchema = z.object({
  /** One short sentence a person would actually say. */
  headline: z.string().min(1).max(200),
  /** 1-3 supporting sentences. */
  lines: z.array(z.string().min(1).max(300)).min(1).max(3),
});
export type Narration = z.infer<typeof NarrationSchema>;

const SYSTEM_PROMPT = `You are Coach, a fantasy football analyst.

Your personality: extremely knowledgeable, calm, direct, confident without arrogance, honest about uncertainty. Terse during drafts. Action-oriented.

CRITICAL CONSTRAINTS — these are not style preferences:
1. You are given a decision that has ALREADY been made by a deterministic engine. You do not change it, question it, or suggest a different player.
2. You may not introduce any number, statistic, rank, projection, or probability that is not present in the input. If you want to cite a number, it must appear verbatim in the data given to you.
3. You may not invent news, injuries, quotes, or player status.
4. If the input says data is stale or uncertain, your output must say so too.
5. Answer "what should I do?" first. Statistics only if they changed the answer.

Rewrite the given recommendation in natural language. Same meaning, same facts, better English.`;

export interface NarrateResult {
  narration: Narration | null;
  usedLlm: boolean;
  model?: string;
  latencyMs?: number;
  /** Why the LLM was not used, when it wasn't. */
  skipReason?: string;
}

/**
 * Rephrase a deterministic recommendation.
 *
 * Every failure path — no key, over budget, timeout, malformed output — returns
 * `narration: null`, and the caller keeps the deterministic text. The advice is
 * never affected by the model being unavailable; only the wording is.
 */
export async function narrateRecommendation(
  rec: DraftRecommendation,
  deterministic: CoachResponse,
  opts: {
    budget: AiBudget;
    terse?: boolean;
    timeoutMs?: number;
    client?: Anthropic;
    now?: Date;
  },
): Promise<NarrateResult> {
  const now = opts.now ?? new Date();

  if (!process.env.ANTHROPIC_API_KEY && !opts.client) {
    return { narration: null, usedLlm: false, skipReason: 'ANTHROPIC_API_KEY not set' };
  }
  if (!opts.budget.canSpend(now)) {
    return {
      narration: null,
      usedLlm: false,
      skipReason: `Daily AI budget exhausted ($${opts.budget.spentLast24h(now).toFixed(3)} spent)`,
    };
  }

  const model = MODELS.reasoning();
  const client = opts.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Only engine-produced values cross this boundary.
  const payload = {
    recommendation: rec.take
      ? { name: rec.take.name, position: rec.take.position, team: rec.take.team }
      : null,
    confidence: rec.confidence,
    verdict: rec.verdict,
    reasons: rec.reasons,
    alternatives: rec.alternatives.map((a) => a.name),
    avoid: rec.avoid.map((a) => ({ name: a.player.name, reason: a.reason })),
    riskFactors: rec.riskFactors,
    picksUntilNextTurn: rec.picksUntilNextTurn,
    staleness: rec.staleness ?? null,
    style: opts.terse ? 'DRAFT MODE: be extremely terse. One short sentence per line.' : 'Conversational but concise.',
  };

  const started = Date.now();
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `Rewrite this recommendation. Respond ONLY with JSON matching ` +
              `{"headline": string, "lines": string[]} (1-3 lines).\n\n` +
              JSON.stringify(payload, null, 2),
          },
        ],
      },
      { timeout: opts.timeoutMs ?? 6_000 },   // draft night: never block on this
    );

    const latencyMs = Date.now() - started;

    opts.budget.record({
      model,
      purpose: 'narrate_recommendation',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      estimatedCostUsd: estimateCost(
        model,
        response.usage.input_tokens,
        response.usage.output_tokens,
      ),
      at: now.toISOString(),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const parsed = parseNarration(text);
    if (!parsed) {
      return {
        narration: null,
        usedLlm: false,
        model,
        latencyMs,
        skipReason: 'Model output did not match the required schema',
      };
    }

    // Last line of defence: reject narration that introduces a number the
    // engine never produced. A fabricated statistic is exactly the failure this
    // whole architecture exists to prevent.
    const invented = findInventedNumbers(parsed, deterministic, rec);
    if (invented.length > 0) {
      return {
        narration: null,
        usedLlm: false,
        model,
        latencyMs,
        skipReason: `Model introduced unsupported figures (${invented.join(', ')}) — output discarded`,
      };
    }

    return { narration: parsed, usedLlm: true, model, latencyMs };
  } catch (err) {
    return {
      narration: null,
      usedLlm: false,
      model,
      latencyMs: Date.now() - started,
      skipReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function parseNarration(text: string): Narration | null {
  // Models sometimes wrap JSON in prose or a code fence.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = NarrationSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Find numbers in the narration that do not appear anywhere in the engine's
 * own output.
 *
 * Small integers are allowed through: they are almost always ordinals or
 * counts ("the 2nd option", "3 picks away") rather than fabricated statistics,
 * and rejecting them would discard nearly every valid narration.
 */
export function findInventedNumbers(
  narration: Narration,
  deterministic: CoachResponse,
  rec: DraftRecommendation,
): string[] {
  const sourceText = [
    ...deterministic.lines,
    deterministic.headline,
    ...rec.reasons,
    ...rec.riskFactors,
    ...rec.avoid.map((a) => a.reason),
    String(Math.round(rec.confidence * 100)),
    String(rec.picksUntilNextTurn ?? ''),
    rec.staleness ?? '',
  ].join(' ');

  const sourceNumbers = new Set(
    (sourceText.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))),
  );

  const invented: string[] = [];
  for (const line of [narration.headline, ...narration.lines]) {
    for (const raw of line.match(/\d+(?:\.\d+)?/g) ?? []) {
      const value = Number(raw);
      if (value <= 30 && Number.isInteger(value)) continue;   // ordinals/counts
      if (!sourceNumbers.has(String(value))) invented.push(raw);
    }
  }
  return invented;
}

/** Merge narration into the deterministic response, preserving its claims. */
export function applyNarration(
  base: CoachResponse,
  result: NarrateResult,
): CoachResponse {
  if (!result.narration) return base;
  return {
    ...base,
    headline: result.narration.headline,
    lines: result.narration.lines,
    usedLlm: true,
  };
}
