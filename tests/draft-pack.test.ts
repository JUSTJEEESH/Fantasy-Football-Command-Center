import { describe, expect, it } from 'vitest';
import { DraftPackSchema, buildDraftPack, describePackFreshness } from '@/lib/draft-pack';
import { SCORING_PRESETS, scoreStatLine } from '@/lib/engine/scoring';
import { buildMockLeague, buildMockPool } from './helpers/mock-players';

const league = buildMockLeague();
const players = buildMockPool().slice(0, 20);

describe('draft pack serialization', () => {
  /**
   * Regression: DST points-allowed tiers used `Infinity` for the final bracket.
   * `JSON.stringify(Infinity)` is `null`, so every saved pack failed validation
   * on reload and the war room silently reported "no draft pack loaded" —
   * on draft day that is a total failure.
   */
  it('survives a JSON round trip', () => {
    const pack = buildDraftPack({ league, players });
    const roundTripped = JSON.parse(JSON.stringify(pack));
    expect(DraftPackSchema.safeParse(roundTripped).success).toBe(true);
  });

  it('keeps every scoring setting finite so it can be serialized', () => {
    for (const preset of Object.values(SCORING_PRESETS)) {
      const scoring = preset();
      for (const value of Object.values(scoring.perStat)) {
        expect(Number.isFinite(value)).toBe(true);
      }
      for (const tier of scoring.dstPointsAllowedTiers ?? []) {
        expect(Number.isFinite(tier.maxPointsAllowed)).toBe(true);
        expect(Number.isFinite(tier.points)).toBe(true);
      }
    }
  });

  it('still scores the worst DST bracket correctly after the change', () => {
    const scoring = SCORING_PRESETS.ppr();
    expect(scoreStatLine({ dst_pts_allowed: 60 }, scoring, 'DST')).toBe(-4);
    expect(scoreStatLine({ dst_pts_allowed: 9999 }, scoring, 'DST')).toBe(-4);
  });

  it('reports freshness as the oldest component, not the newest', () => {
    const stale = new Date('2026-08-01T00:00:00Z').toISOString();
    const fresh = new Date('2026-08-30T00:00:00Z').toISOString();
    const pack = buildDraftPack({
      league,
      players: [
        { ...players[0]!, fetchedAt: fresh },
        { ...players[1]!, fetchedAt: stale },
      ],
    });
    expect(pack.dataFetchedAt).toBe(stale);
  });
});

describe('freshness reporting (§30)', () => {
  const at = (iso: string) => buildDraftPack({ league, players: [], dataFetchedAt: iso });

  it('calls recent data fresh', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    expect(describePackFreshness(at('2026-08-30T09:00:00Z'), now)!.level).toBe('fresh');
  });

  it('flags day-old data as aging', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    expect(describePackFreshness(at('2026-08-29T00:00:00Z'), now)!.level).toBe('aging');
  });

  it('flags week-old data as stale, in words', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    const freshness = describePackFreshness(at('2026-08-20T00:00:00Z'), now)!;
    expect(freshness.level).toBe('stale');
    expect(freshness.label).toMatch(/STALE/);
    expect(freshness.label).toMatch(/Re-sync/);
  });

  it('returns nothing when there is no pack', () => {
    expect(describePackFreshness(null)).toBeNull();
  });
});
