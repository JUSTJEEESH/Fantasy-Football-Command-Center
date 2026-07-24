import { describe, expect, it } from 'vitest';
import {
  assignTiers,
  computeReplacementLevels,
  computeScarcity,
  valueOverReplacement,
} from '@/lib/engine/valuation';
import { buildMockLeague, buildMockPool } from './helpers/mock-players';
import type { PlayerCard } from '@/lib/types';

const pool = buildMockPool();
const league = buildMockLeague();

describe('replacement level', () => {
  const replacement = computeReplacementLevels(pool, league);

  it('sets a deeper baseline for positions the league starts more of', () => {
    // 12 teams x ~2.45 RB demand -> baseline near RB30, vs ~QB13 for 1 QB.
    expect(replacement.index.RB).toBeGreaterThan(replacement.index.QB);
    expect(replacement.index.WR).toBeGreaterThan(replacement.index.QB);
  });

  it('produces a higher points baseline at QB than at TE', () => {
    // QBs score more in absolute terms, which is exactly why raw points are a
    // bad way to rank across positions.
    expect(replacement.points.QB).toBeGreaterThan(replacement.points.TE);
  });

  it('scales the baseline with league size', () => {
    const small = computeReplacementLevels(pool, buildMockLeague({ teamCount: 8 }));
    const large = computeReplacementLevels(pool, buildMockLeague({ teamCount: 14 }));
    expect(large.index.RB).toBeGreaterThan(small.index.RB);
    expect(large.points.RB).toBeLessThan(small.points.RB);
  });

  it('pushes QB replacement much deeper in superflex', () => {
    const superflex = buildMockLeague({
      rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1, K: 1, DST: 1 },
    });
    const sf = computeReplacementLevels(pool, superflex);
    const std = computeReplacementLevels(pool, league);
    expect(sf.index.QB).toBeGreaterThan(std.index.QB);
  });

  it('does not crash on an empty pool', () => {
    const empty = computeReplacementLevels([], league);
    expect(empty.points.RB).toBe(0);
  });
});

describe('value over replacement', () => {
  const replacement = computeReplacementLevels(pool, league);

  it('ranks the top RB above the top QB despite fewer raw points', () => {
    const rb1 = pool.find((p) => p.id === 'RB-1')!;
    const qb1 = pool.find((p) => p.id === 'QB-1')!;
    expect(qb1.projectedPoints!).toBeGreaterThan(rb1.projectedPoints!);
    // ...but VOR flips it, which is the entire point of the metric.
    expect(valueOverReplacement(rb1, replacement)).toBeGreaterThan(
      valueOverReplacement(qb1, replacement),
    );
  });

  it('gives replacement-level players a VOR near zero', () => {
    const idx = replacement.index.RB;
    const rbs = pool
      .filter((p) => p.position === 'RB')
      .sort((a, b) => b.projectedPoints! - a.projectedPoints!);
    const baselinePlayer = rbs[idx]!;
    expect(Math.abs(valueOverReplacement(baselinePlayer, replacement))).toBeLessThan(1);
  });

  it('gives deep bench players a negative VOR', () => {
    const rbs = pool
      .filter((p) => p.position === 'RB')
      .sort((a, b) => b.projectedPoints! - a.projectedPoints!);
    expect(valueOverReplacement(rbs[rbs.length - 1]!, replacement)).toBeLessThan(0);
  });
});

describe('tiers', () => {
  it('assigns tier 1 to the best player at each position', () => {
    const tiers = assignTiers(pool);
    expect(tiers.get('RB-1')).toBe(1);
    expect(tiers.get('WR-1')).toBe(1);
    expect(tiers.get('TE-1')).toBe(1);
  });

  it('never assigns a better tier to a lower-projected player', () => {
    const tiers = assignTiers(pool);
    const rbs = pool
      .filter((p) => p.position === 'RB')
      .sort((a, b) => b.projectedPoints! - a.projectedPoints!);
    for (let i = 1; i < rbs.length; i++) {
      expect(tiers.get(rbs[i]!.id)!).toBeGreaterThanOrEqual(tiers.get(rbs[i - 1]!.id)!);
    }
  });

  it('breaks tiers where a real gap exists', () => {
    const cliff: PlayerCard[] = [
      mk('a', 'TE', 260), mk('b', 'TE', 255), mk('c', 'TE', 250),
      mk('d', 'TE', 180), mk('e', 'TE', 176),   // 70-point cliff
    ];
    const tiers = assignTiers(cliff);
    expect(tiers.get('c')).toBe(1);
    expect(tiers.get('d')).toBe(2);
  });

  it('caps tier size so a flat position does not become one giant tier', () => {
    const flat = Array.from({ length: 20 }, (_, i) => mk(`f${i}`, 'QB', 300 - i * 0.5));
    const tiers = assignTiers(flat, { maxPerTier: 6 });
    expect(tiers.get('f19')).toBeGreaterThan(1);
  });

  it('handles a single-player position', () => {
    expect(assignTiers([mk('solo', 'K', 140)]).get('solo')).toBe(1);
  });
});

describe('scarcity', () => {
  const replacement = computeReplacementLevels(pool, league);

  it('raises urgency as the top tier thins out', () => {
    // Explicit board: a 4-player top tier with a real cliff beneath it.
    const board = (topTierSize: number): PlayerCard[] => [
      ...Array.from({ length: topTierSize }, (_, i) => ({
        ...mk(`elite-${i}`, 'RB', 300 - i), tier: 1,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        ...mk(`mid-${i}`, 'RB', 240 - i), tier: 2,
      })),
    ];
    const four = computeScarcity(board(4), replacement, 12).RB.urgency;
    const two = computeScarcity(board(2), replacement, 12).RB.urgency;
    const one = computeScarcity(board(1), replacement, 12).RB.urgency;

    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(four);
  });

  it('raises urgency as the next turn gets further away', () => {
    const board: PlayerCard[] = [
      { ...mk('a', 'RB', 300), tier: 1 },
      { ...mk('b', 'RB', 298), tier: 1 },
      { ...mk('c', 'RB', 240), tier: 2 },
    ];
    const soon = computeScarcity(board, replacement, 3).RB.urgency;
    const later = computeScarcity(board, replacement, 20).RB.urgency;
    expect(later).toBeGreaterThan(soon);
  });

  it('reports low urgency when the tier drop is negligible', () => {
    const flat: PlayerCard[] = [
      { ...mk('a', 'RB', 200), tier: 1 },
      { ...mk('b', 'RB', 199.5), tier: 2 },
      { ...mk('c', 'RB', 199), tier: 3 },
    ];
    expect(computeScarcity(flat, replacement, 15).RB.urgency).toBeLessThan(0.2);
  });

  it('reports zero urgency when the next turn is immediate', () => {
    expect(computeScarcity(pool, replacement, 0).RB.urgency).toBe(0);
  });

  it('measures the tier dropoff as points lost past the cliff', () => {
    const s = computeScarcity(pool, replacement, 10);
    expect(s.RB.tierDropoff).toBeGreaterThanOrEqual(0);
    expect(s.RB.remainingInTopTier).toBeGreaterThan(0);
  });

  it('handles a position with nothing left', () => {
    const noTes = pool.filter((p) => p.position !== 'TE');
    const s = computeScarcity(noTes, replacement, 10);
    expect(s.TE.remaining).toBe(0);
    expect(s.TE.urgency).toBe(0);
    expect(s.TE.topTier).toBeNull();
  });
});

function mk(id: string, position: PlayerCard['position'], points: number): PlayerCard {
  return { id, name: id, position, team: 'FA', projectedPoints: points };
}
