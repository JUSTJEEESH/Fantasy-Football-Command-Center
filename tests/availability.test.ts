import { describe, expect, it } from 'vitest';
import {
  analyzeWait,
  availabilityAtPick,
  defaultAdpStdev,
  likelyAvailableAt,
  normalCdf,
} from '@/lib/engine/availability';
import type { PlayerCard } from '@/lib/types';

function p(id: string, adp: number, points: number, stdev?: number): PlayerCard {
  return {
    id, name: id, position: 'RB', team: 'FA',
    adp, adpStdev: stdev, projectedPoints: points,
  };
}

describe('normalCdf', () => {
  it('is 0.5 at the mean', () => {
    expect(normalCdf(0, 0, 1)).toBeCloseTo(0.5, 3);
  });

  it('matches known quantiles', () => {
    expect(normalCdf(1, 0, 1)).toBeCloseTo(0.8413, 3);
    expect(normalCdf(-1.96, 0, 1)).toBeCloseTo(0.025, 3);
  });

  it('is monotonic', () => {
    let prev = 0;
    for (let x = -3; x <= 3; x += 0.5) {
      const v = normalCdf(x, 0, 1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('defaultAdpStdev', () => {
  it('grows with ADP — consensus is tight early and loose late', () => {
    expect(defaultAdpStdev(120)).toBeGreaterThan(defaultAdpStdev(5));
  });
});

describe('availabilityAtPick', () => {
  it('gives a low probability of surviving well past ADP', () => {
    const e = availabilityAtPick(p('a', 20, 250, 5), 40, 15);
    expect(e.probability).toBeLessThan(0.05);
  });

  it('gives a high probability of surviving to a pick well before ADP', () => {
    const e = availabilityAtPick(p('a', 60, 200, 8), 30, 15);
    expect(e.probability).toBeGreaterThan(0.95);
  });

  it('is near a coin flip exactly at ADP', () => {
    const e = availabilityAtPick(p('a', 30, 220, 6), 30, 5);
    expect(e.probability).toBeGreaterThan(0.4);
    expect(e.probability).toBeLessThan(0.6);
  });

  it('conditions on having already survived to the current pick', () => {
    // ADP 20 but still on the board at pick 30: the raw model says he is long
    // gone, so the conditional estimate must be higher than the raw one.
    const raw = 1 - normalCdf(35, 20, 5);
    const conditioned = availabilityAtPick(p('a', 20, 250, 5), 35, 30).probability;
    expect(conditioned).toBeGreaterThan(raw);
  });

  it('admits when the ADP model no longer discriminates', () => {
    const e = availabilityAtPick(p('a', 20, 250, 3), 90, 80);
    expect(e.probability).toBe(0.5);
    expect(e.assumptions.join(' ')).toMatch(/coin flip/i);
  });

  it('always states its assumptions', () => {
    expect(availabilityAtPick(p('a', 30, 200), 40, 20).assumptions.length).toBeGreaterThan(0);
  });

  it('flags a missing ADP as unreliable rather than guessing quietly', () => {
    const noAdp: PlayerCard = { id: 'x', name: 'x', position: 'WR', team: 'FA', projectedPoints: 200 };
    const e = availabilityAtPick(noAdp, 40, 20);
    expect(e.assumptions.join(' ')).toMatch(/no adp/i);
  });
});

describe('analyzeWait', () => {
  const target = p('target', 45, 240, 6);

  it('says wait when he is very likely to last and the fallback is close', () => {
    const w = analyzeWait(target, [target, p('alt', 50, 236)], 30, 20);
    expect(w.canWait).toBe(true);
    expect(w.reasoning).toMatch(/safe to wait/i);
  });

  it('says take now when he is very likely to be gone', () => {
    const w = analyzeWait(target, [target, p('alt', 60, 190)], 70, 40);
    expect(w.canWait).toBe(false);
    expect(w.reasoning).toMatch(/take him now/i);
  });

  it('says take now when the cost of missing is high even at decent odds', () => {
    // 55% to last, but the drop to the fallback is 60 points — expected cost
    // ~27 points, which is not a risk worth taking.
    const w = analyzeWait(p('t', 50, 260, 10), [p('t', 50, 260, 10), p('alt', 55, 200)], 51, 45);
    expect(w.expectedCost).toBeGreaterThan(8);
    expect(w.canWait).toBe(false);
  });

  it('handles having no next pick', () => {
    const w = analyzeWait(target, [target], null, 40);
    expect(w.canWait).toBe(false);
    expect(w.reasoning).toMatch(/last pick/i);
  });

  it('identifies the fallback at the same position', () => {
    const w = analyzeWait(target, [target, p('alt1', 55, 210), p('alt2', 60, 205)], 60, 40);
    expect(w.fallback?.id).toBe('alt1');
  });
});

describe('likelyAvailableAt', () => {
  const pool = [
    p('early', 5, 300, 3),
    p('mid', 40, 250, 8),
    p('late', 90, 180, 12),
  ];

  it('returns only players above the probability threshold', () => {
    const out = likelyAvailableAt(pool, 30, 10, { minProbability: 0.5 });
    expect(out.map((e) => e.playerId)).not.toContain('early');
    expect(out.map((e) => e.playerId)).toContain('late');
  });

  it('sorts by projected points, best first', () => {
    const out = likelyAvailableAt(pool, 80, 10, { minProbability: 0.01 });
    const points = out.map(
      (e) => pool.find((x) => x.id === e.playerId)!.projectedPoints ?? 0,
    );
    expect([...points].sort((a, b) => b - a)).toEqual(points);
  });

  it('respects the limit', () => {
    expect(likelyAvailableAt(pool, 200, 1, { minProbability: 0, limit: 2 })).toHaveLength(2);
  });
});
