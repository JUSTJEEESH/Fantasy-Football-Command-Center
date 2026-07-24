import { describe, expect, it } from 'vitest';
import {
  formatComparison,
  formatDraftPick,
  formatStaleWarning,
  formatUnknown,
  formatWhatIf,
  formatWhy,
} from '@/lib/coach/format';
import {
  AiBudget,
  applyNarration,
  estimateCost,
  findInventedNumbers,
  narrateRecommendation,
  parseNarration,
} from '@/lib/coach/llm';
import { recommend } from '@/lib/engine/recommend';
import { createDraftState, draftReducer } from '@/lib/engine/draft-state';
import { buildMockLeague, buildMockPool } from './helpers/mock-players';
import type { DraftRecommendation } from '@/lib/types';

const players = buildMockPool();
const league = buildMockLeague();

function recAtPick(n: number): DraftRecommendation {
  const order = [...players]
    .sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999))
    .slice(0, n - 1);
  const state = order.reduce(
    (s, p) => draftReducer(s, { type: 'RECORD_PICK', playerId: p.id }),
    createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 5 }),
  );
  return recommend({
    state, league, players,
    dataFetchedAt: new Date().toISOString(),
  });
}

describe('draft pick formatting (§18)', () => {
  const rec = recAtPick(5);
  const response = formatDraftPick(rec);

  it('leads with the action, in a form readable at arm\'s length', () => {
    expect(response.headline).toMatch(/^TAKE: [A-Z]/);
  });

  it('includes alternatives', () => {
    expect(response.lines.join(' ')).toMatch(/If gone:/);
  });

  it('includes a verdict', () => {
    expect(response.lines.join(' ')).toMatch(/Verdict:/);
  });

  it('gives one reason in terse draft mode and more when asked', () => {
    const terse = formatDraftPick(rec, { terse: true });
    const full = formatDraftPick(rec, { terse: false });
    expect(terse.lines.length).toBeLessThanOrEqual(full.lines.length);
  });

  it('tags the pick as a RECOMMENDATION, not a fact', () => {
    const recommendation = response.claims.find((c) => c.kind === 'RECOMMENDATION');
    expect(recommendation).toBeDefined();
    expect(recommendation!.confidence).toBe(rec.confidence);
  });

  it('tags reasoning as INFERENCE, never FACT', () => {
    const kinds = new Set(response.claims.map((c) => c.kind));
    expect(kinds.has('INFERENCE')).toBe(true);
    expect(kinds.has('FACT')).toBe(false);
  });

  it('does not use an LLM', () => {
    expect(response.usedLlm).toBe(false);
  });

  it('handles an empty board without inventing a pick', () => {
    const empty = formatDraftPick({ ...rec, take: null, verdict: 'NO_PICK_AVAILABLE' });
    expect(empty.headline).toMatch(/no pick available/i);
    expect(empty.claims[0]!.kind).toBe('UNCERTAINTY');
  });
});

describe('follow-up formatting', () => {
  const rec = recAtPick(5);

  it('explains why', () => {
    const why = formatWhy(rec);
    expect(why.headline).toMatch(new RegExp(rec.take!.name));
    expect(why.lines.length).toBeGreaterThan(0);
  });

  it('says there is nothing to explain when there is no pick', () => {
    expect(formatWhy({ ...rec, take: null }).headline).toMatch(/no recommendation/i);
  });

  it('walks down the alternatives', () => {
    const first = formatWhatIf(rec, 1);
    expect(first.headline).toMatch(/^Then take/);
    expect(first.headline).toContain(rec.alternatives[0]!.name.toUpperCase());
  });

  it('lowers confidence the further down the list it goes', () => {
    expect(formatWhatIf(rec, 2).confidence!).toBeLessThan(formatWhatIf(rec, 1).confidence!);
  });

  it('stops rather than inventing a fourth option', () => {
    const tooFar = formatWhatIf(rec, 9);
    expect(tooFar.headline).toMatch(/as far down the list/i);
    expect(tooFar.claims[0]!.kind).toBe('UNCERTAINTY');
  });
});

describe('honesty helpers (§45)', () => {
  it('says it does not know, rather than guessing', () => {
    const unknown = formatUnknown('2027 rookie projections');
    expect(unknown.headline).toMatch(/don't have reliable current information/i);
    expect(unknown.claims[0]!.kind).toBe('UNCERTAINTY');
  });

  it('describes staleness in human terms', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    expect(formatStaleWarning('2026-08-30T11:50:00Z', now)).toBeUndefined();
    expect(formatStaleWarning('2026-08-30T06:00:00Z', now)).toMatch(/6 hours ago/);
    expect(formatStaleWarning('2026-08-25T12:00:00Z', now)).toMatch(/STALE/);
    expect(formatStaleWarning(undefined, now)).toMatch(/unknown/i);
  });
});

describe('comparison formatting (§22)', () => {
  it('leads with the verdict, then the numbers', () => {
    const a = players.find((p) => p.id === 'RB-1')!;
    const b = players.find((p) => p.id === 'WR-1')!;
    const response = formatComparison(a, b, {
      winner: a, reason: 'Bigger edge over replacement at a scarcer position.', confidence: 0.7,
    });
    expect(response.headline).toBe(a.name.toUpperCase());
    expect(response.lines[0]).toMatch(/scarcer position/);
    expect(response.lines.join('\n')).toMatch(/Projected/);
  });
});

// ---------------------------------------------------------------------------

describe('AI budget control (§38)', () => {
  it('permits spending under the limit', () => {
    expect(new AiBudget(1).canSpend()).toBe(true);
  });

  it('stops once the daily limit is reached', () => {
    const budget = new AiBudget(0.01);
    budget.record({
      model: 'claude-sonnet-5', purpose: 'test',
      inputTokens: 10_000, outputTokens: 10_000,
      estimatedCostUsd: 0.5, at: new Date().toISOString(),
    });
    expect(budget.canSpend()).toBe(false);
  });

  it('treats a zero budget as the LLM being switched off', () => {
    expect(new AiBudget(0).canSpend()).toBe(false);
  });

  it('rolls old spend out of the 24h window', () => {
    const budget = new AiBudget(0.1);
    budget.record({
      model: 'claude-sonnet-5', purpose: 'test',
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 5,
      at: new Date('2026-08-01T00:00:00Z').toISOString(),
    });
    expect(budget.canSpend(new Date('2026-08-30T00:00:00Z'))).toBe(true);
  });

  it('prices the cheap model below the expensive one', () => {
    expect(estimateCost('claude-haiku-4-5-20251001', 1_000_000, 0)).toBeLessThan(
      estimateCost('claude-opus-5', 1_000_000, 0),
    );
  });
});

describe('LLM narration guardrails (§31, §45)', () => {
  const rec = recAtPick(5);
  const deterministic = formatDraftPick(rec);

  it('parses well-formed JSON', () => {
    expect(parseNarration('{"headline":"Take him.","lines":["He is the best left."]}'))
      .toEqual({ headline: 'Take him.', lines: ['He is the best left.'] });
  });

  it('parses JSON wrapped in a code fence', () => {
    expect(
      parseNarration('```json\n{"headline":"H","lines":["L"]}\n```'),
    ).toEqual({ headline: 'H', lines: ['L'] });
  });

  it('parses JSON surrounded by prose', () => {
    expect(
      parseNarration('Sure! {"headline":"H","lines":["L"]} Hope that helps.'),
    ).toEqual({ headline: 'H', lines: ['L'] });
  });

  it('rejects malformed output rather than salvaging it', () => {
    expect(parseNarration('not json at all')).toBeNull();
    expect(parseNarration('{"headline":"H"}')).toBeNull();        // lines missing
    expect(parseNarration('{"headline":"H","lines":[]}')).toBeNull(); // empty lines
  });

  it('catches a fabricated statistic', () => {
    const invented = findInventedNumbers(
      { headline: 'Take him.', lines: ['He is projected for 312.7 points this year.'] },
      deterministic,
      rec,
    );
    expect(invented).toContain('312.7');
  });

  it('allows small integers, which are ordinals not statistics', () => {
    expect(
      findInventedNumbers(
        { headline: 'Take him.', lines: ['Your 2nd option is close behind.'] },
        deterministic,
        rec,
      ),
    ).toEqual([]);
  });

  it('allows numbers the engine actually produced', () => {
    const figure = rec.reasons.join(' ').match(/\d+/)?.[0];
    if (figure) {
      expect(
        findInventedNumbers(
          { headline: 'Take him.', lines: [`That is worth ${figure} points.`] },
          deterministic,
          rec,
        ),
      ).toEqual([]);
    }
  });

  it('skips the LLM when no API key is configured', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await narrateRecommendation(rec, deterministic, {
        budget: new AiBudget(1),
      });
      expect(result.usedLlm).toBe(false);
      expect(result.skipReason).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('skips the LLM when the budget is exhausted', async () => {
    const result = await narrateRecommendation(rec, deterministic, {
      budget: new AiBudget(0),
      client: {} as never,
    });
    expect(result.usedLlm).toBe(false);
    expect(result.skipReason).toMatch(/budget/i);
  });

  it('degrades to deterministic prose when the model call fails', async () => {
    const failing = {
      messages: {
        create: async () => {
          throw new Error('network down');
        },
      },
    } as never;

    const result = await narrateRecommendation(rec, deterministic, {
      budget: new AiBudget(1), client: failing,
    });
    expect(result.usedLlm).toBe(false);
    expect(result.skipReason).toMatch(/network down/);

    // The advice itself is untouched — only the wording would have changed.
    const final = applyNarration(deterministic, result);
    expect(final.headline).toBe(deterministic.headline);
    expect(final.usedLlm).toBe(false);
  });

  it('discards narration that invents a statistic, keeping the safe text', async () => {
    const lying = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'text',
              text: '{"headline":"Take him.","lines":["He posted 1847.3 yards last year."]}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    } as never;

    const result = await narrateRecommendation(rec, deterministic, {
      budget: new AiBudget(1), client: lying,
    });
    expect(result.usedLlm).toBe(false);
    expect(result.skipReason).toMatch(/unsupported figures/);
    expect(applyNarration(deterministic, result).headline).toBe(deterministic.headline);
  });

  it('accepts clean narration and records the spend', async () => {
    const budget = new AiBudget(1);
    const good = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'text',
              text: '{"headline":"Take him — he is the last back in this tier.","lines":["The next option is a clear step down."]}',
            },
          ],
          usage: { input_tokens: 800, output_tokens: 60 },
        }),
      },
    } as never;

    const result = await narrateRecommendation(rec, deterministic, {
      budget, client: good,
    });
    expect(result.usedLlm).toBe(true);
    expect(budget.spentLast24h()).toBeGreaterThan(0);

    const final = applyNarration(deterministic, result);
    expect(final.headline).toMatch(/last back in this tier/);
    expect(final.usedLlm).toBe(true);
    // Claims come from the engine and survive rewording untouched.
    expect(final.claims).toEqual(deterministic.claims);
  });
});
