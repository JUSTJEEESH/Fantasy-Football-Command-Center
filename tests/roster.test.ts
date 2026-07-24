import { describe, expect, it } from 'vitest';
import {
  analyzeRoster,
  fillLineup,
  marginalLineupValue,
  rosterFitMultiplier,
} from '@/lib/engine/roster';
import { buildMockLeague } from './helpers/mock-players';
import type { PlayerCard, Position } from '@/lib/types';

const league = buildMockLeague(); // QB1 RB2 WR2 TE1 FLEX1 K1 DST1, bench 6

function p(id: string, position: Position, points: number, bye?: number): PlayerCard {
  return { id, name: id, position, team: 'FA', projectedPoints: points, byeWeek: bye };
}

describe('fillLineup', () => {
  it('fills dedicated slots before flex', () => {
    const roster = [
      p('rb1', 'RB', 300), p('rb2', 'RB', 250), p('rb3', 'RB', 200),
      p('wr1', 'WR', 280), p('wr2', 'WR', 240),
      p('te1', 'TE', 180), p('qb1', 'QB', 380),
    ];
    const { starters, points } = fillLineup(roster, league.rosterSlots);
    expect(starters.get('RB')!.map((x) => x.id)).toEqual(['rb1', 'rb2']);
    expect(starters.get('WR')!.map((x) => x.id)).toEqual(['wr1', 'wr2']);
    // The best remaining flex-eligible player takes the FLEX slot.
    expect(starters.get('FLEX')![0]!.id).toBe('rb3');
    expect(points).toBe(300 + 250 + 280 + 240 + 180 + 380 + 200);
  });

  it('leaves surplus players on the bench', () => {
    const roster = [
      p('rb1', 'RB', 300), p('rb2', 'RB', 250), p('rb3', 'RB', 200), p('rb4', 'RB', 150),
    ];
    const { bench } = fillLineup(roster, league.rosterSlots);
    expect(bench.map((x) => x.id)).toEqual(['rb4']);
  });

  it('handles an empty roster', () => {
    const { points, bench } = fillLineup([], league.rosterSlots);
    expect(points).toBe(0);
    expect(bench).toEqual([]);
  });

  it('routes a QB into superflex once the QB slot is used', () => {
    const sf = buildMockLeague({
      rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 },
    });
    const roster = [
      p('qb1', 'QB', 400), p('qb2', 'QB', 360),
      p('rb1', 'RB', 200), p('rb2', 'RB', 190),
      p('wr1', 'WR', 210), p('wr2', 'WR', 205), p('te1', 'TE', 150),
    ];
    const { starters } = fillLineup(roster, sf.rosterSlots);
    expect(starters.get('SUPERFLEX')![0]!.id).toBe('qb2');
  });
});

describe('analyzeRoster', () => {
  it('reports every starting slot unfilled on an empty roster', () => {
    const a = analyzeRoster([], league);
    expect(a.unfilledSlots).toHaveLength(9);
    expect(a.needs.RB).toBe(1);
    expect(a.needs.QB).toBe(1);
    expect(a.filled).toBe(0);
  });

  it('drops need to depth value once starters are covered', () => {
    const roster = [
      p('rb1', 'RB', 300), p('rb2', 'RB', 250),
      p('wr1', 'WR', 280), p('wr2', 'WR', 240),
      p('te1', 'TE', 180), p('qb1', 'QB', 380),
      p('flex', 'RB', 200), p('k', 'K', 140), p('d', 'DST', 130),
    ];
    const a = analyzeRoster(roster, league);
    expect(a.unfilledSlots).toHaveLength(0);
    expect(a.needs.RB).toBeLessThan(0.4);
    expect(a.needs.RB).toBeGreaterThan(0);      // depth still has some value
    expect(a.needs.K).toBe(0);                  // a second kicker is worthless
  });

  it('ranks an empty starting position as the weakest', () => {
    const roster = [
      p('rb1', 'RB', 300), p('rb2', 'RB', 250), p('rb3', 'RB', 220),
      p('wr1', 'WR', 280), p('wr2', 'WR', 240),
      p('qb1', 'QB', 380),
    ];
    expect(analyzeRoster(roster, league).weakestPositions).toContain('TE');
  });

  it('flags bye-week conflicts among starters only', () => {
    const roster = [
      p('rb1', 'RB', 300, 7), p('rb2', 'RB', 250, 7),
      p('wr1', 'WR', 280, 9),
    ];
    const a = analyzeRoster(roster, league);
    expect(a.byeConflicts).toEqual([{ week: 7, playerIds: ['rb1', 'rb2'] }]);
  });

  it('ignores a bye clash between two benched players', () => {
    const roster = [
      p('rb1', 'RB', 300, 3), p('rb2', 'RB', 290, 3), p('rb3', 'RB', 280, 3),
      p('rb4', 'RB', 100, 11), p('rb5', 'RB', 99, 11),   // both bench
    ];
    const a = analyzeRoster(roster, league);
    expect(a.byeConflicts.map((c) => c.week)).not.toContain(11);
  });
});

describe('marginalLineupValue', () => {
  const roster = [
    p('rb1', 'RB', 300), p('rb2', 'RB', 250),
    p('wr1', 'WR', 280), p('wr2', 'WR', 240),
    p('qb1', 'QB', 380),
  ];

  it('credits the full value of filling an empty starting slot', () => {
    expect(marginalLineupValue(roster, p('te', 'TE', 180), league)).toBe(180);
  });

  it('credits only the flex upgrade for a surplus player at a full position', () => {
    // No TE yet, so an extra RB lands in FLEX at full value...
    const withTe = [...roster, p('te', 'TE', 180), p('flex', 'RB', 200)];
    // ...but once FLEX is taken by a 200-point RB, a 150-point RB adds nothing.
    expect(marginalLineupValue(withTe, p('rb5', 'RB', 150), league)).toBe(0);
  });

  it('credits the upgrade when a new player beats an existing starter', () => {
    const full = [...roster, p('te', 'TE', 180), p('flex', 'RB', 200)];
    // A 260-point RB displaces the 200-point flex: +60.
    expect(marginalLineupValue(full, p('rbX', 'RB', 260), league)).toBe(60);
  });
});

describe('rosterFitMultiplier', () => {
  it('boosts a position of genuine need', () => {
    const empty = analyzeRoster([], league);
    const m = rosterFitMultiplier(empty, p('te', 'TE', 180), league, {
      round: 6, totalRounds: 16,
    });
    expect(m).toBeGreaterThan(1);
  });

  it('stays bounded so need never overrides a large talent gap', () => {
    const empty = analyzeRoster([], league);
    const m = rosterFitMultiplier(empty, p('te', 'TE', 180), league, {
      round: 16, totalRounds: 16,
    });
    expect(m).toBeLessThanOrEqual(1.35);
  });

  it('weights need more heavily later in the draft', () => {
    const a = analyzeRoster([], league);
    const early = rosterFitMultiplier(a, p('te', 'TE', 180), league, { round: 1, totalRounds: 16 });
    const late = rosterFitMultiplier(a, p('te', 'TE', 180), league, { round: 11, totalRounds: 16 });
    expect(late).toBeGreaterThan(early);
  });

  it('damps a second kicker, who can never be started', () => {
    const a = analyzeRoster([p('k1', 'K', 145)], league);
    expect(
      rosterFitMultiplier(a, p('k2', 'K', 140), league, { round: 15, totalRounds: 16 }),
    ).toBeLessThan(0.3);
  });

  it('damps a third quarterback in a one-QB league', () => {
    const roster = [p('qb1', 'QB', 380), p('qb2', 'QB', 360)];
    const a = analyzeRoster(roster, league);
    expect(
      rosterFitMultiplier(a, p('qb3', 'QB', 340), league, { round: 8, totalRounds: 16 }),
    ).toBeLessThan(0.5);
  });
});
