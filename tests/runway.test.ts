import { describe, expect, it } from 'vitest';
import { buildRunway, urgentDeadlines } from '@/lib/engine/runway';
import { BAY_ISLANDS } from '@/lib/leagues/bay-islands';
import type { PlayerCard, Position } from '@/lib/types';

// ============================================================================
// Deadlines answer the question a drafter actually has: if I don't take a
// running back now, what is left when I pick again?
//
// The failure mode is a "deadline" that is not one — a group of two players, or
// a residual bucket of fifty whose supposed deadline is the last pick of the
// draft. Both crowd out the handful of moments that genuinely force a decision.
// ============================================================================

/**
 * A position's board with a deliberate cliff: `elite` strong players, then a
 * sharp drop, then a long flat tail.
 */
function positionBoard(
  position: Position,
  opts: { elite: number; eliteTop: number; tailTop: number; tail: number; adpStart: number },
): PlayerCard[] {
  const out: PlayerCard[] = [];
  for (let i = 0; i < opts.elite; i++) {
    out.push({
      id: `${position}-elite-${i}`,
      name: `${position} Elite ${i}`,
      position,
      team: 'ATL',
      adp: opts.adpStart + i * 2,
      projectedPoints: opts.eliteTop - i,
      projectionSource: 'projection',
    });
  }
  for (let i = 0; i < opts.tail; i++) {
    out.push({
      id: `${position}-tail-${i}`,
      name: `${position} Tail ${i}`,
      position,
      team: 'BUF',
      adp: opts.adpStart + opts.elite * 2 + i * 2,
      projectedPoints: opts.tailTop - i,
      projectionSource: 'projection',
    });
  }
  return out;
}

const BOARD: PlayerCard[] = [
  ...positionBoard('RB', { elite: 6, eliteTop: 320, tailTop: 200, tail: 40, adpStart: 1 }),
  ...positionBoard('WR', { elite: 6, eliteTop: 310, tailTop: 195, tail: 50, adpStart: 2 }),
  ...positionBoard('QB', { elite: 8, eliteTop: 380, tailTop: 260, tail: 16, adpStart: 60 }),
  ...positionBoard('TE', { elite: 4, eliteTop: 250, tailTop: 140, tail: 20, adpStart: 20 }),
];

describe('tier deadlines', () => {
  const report = buildRunway(BOARD, BAY_ISLANDS);

  it('puts a pick number on when each group empties', () => {
    expect(report.tiers.length).toBeGreaterThan(0);
    for (const tier of report.tiers) {
      expect(tier.lastAdp).toBeGreaterThanOrEqual(tier.firstAdp);
      expect(tier.deadlineRound).toBe(
        Math.max(1, Math.ceil(tier.lastAdp / BAY_ISLANDS.teamCount)),
      );
    }
  });

  it('orders by which deadline arrives first', () => {
    const deadlines = report.tiers.map((t) => t.lastAdp);
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });

  it('never reports a group of one as a deadline', () => {
    // One player is not a deadline you can plan around. If you want him, you
    // take him.
    for (const tier of report.tiers) expect(tier.count).toBeGreaterThanOrEqual(2);
  });

  it('drops the residual instead of calling it a group', () => {
    // Everything below the last cut is "the rest". On a real board that was 52
    // receivers whose deadline was the final pick of the draft — which tells
    // you nothing and buries the deadlines that matter.
    const lastPick = BAY_ISLANDS.teamCount * 15;
    for (const tier of report.tiers) {
      const isHugeAndLate = tier.count > 25 && tier.lastAdp > lastPick - BAY_ISLANDS.teamCount;
      expect(isHugeAndLate).toBe(false);
    }
  });

  it('numbers groups consecutively within a position', () => {
    // Filtering out one-player groups used to leave holes: RB1, RB3, RB5.
    for (const position of ['RB', 'WR', 'QB', 'TE'] as Position[]) {
      const numbers = report.tiers
        .filter((t) => t.position === position)
        .map((t) => t.tier)
        .sort((a, b) => a - b);
      if (numbers.length === 0) continue;
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });

  it('cuts where the drop actually is', () => {
    // The board has a sharp cliff after the elite group at each position, so
    // the first group must not run past it.
    const rb1 = report.tiers.find((t) => t.position === 'RB' && t.tier === 1);
    expect(rb1).toBeDefined();
    expect(rb1!.count).toBeLessThanOrEqual(6);
  });

  it('leaves kickers and defenses out entirely', () => {
    const board = [
      ...BOARD,
      ...positionBoard('K', { elite: 4, eliteTop: 150, tailTop: 130, tail: 20, adpStart: 150 }),
      ...positionBoard('DST', { elite: 4, eliteTop: 145, tailTop: 120, tail: 20, adpStart: 150 }),
    ];
    const withKickers = buildRunway(board, BAY_ISLANDS);
    expect(withKickers.tiers.some((t) => t.position === 'K')).toBe(false);
    expect(withKickers.tiers.some((t) => t.position === 'DST')).toBe(false);
    expect(withKickers.notes.join(' ')).toMatch(/kickers and defenses/i);
  });

  it('ignores players the draft never reaches', () => {
    const deep = [
      ...BOARD,
      {
        id: 'deep-rb',
        name: 'Very Deep Back',
        position: 'RB' as Position,
        team: 'CHI',
        adp: 900,
        projectedPoints: 250,
        projectionSource: 'projection' as const,
      },
    ];
    const result = buildRunway(deep, BAY_ISLANDS);
    for (const tier of result.tiers) {
      expect(tier.players.every((p) => p.name !== 'Very Deep Back')).toBe(true);
    }
  });

  it('says out loud that ADP is an average, not a schedule', () => {
    expect(report.notes.join(' ')).toMatch(/average, not a schedule/i);
  });

  it('survives a board too thin to group', () => {
    expect(buildRunway(BOARD.slice(0, 3), BAY_ISLANDS).tiers).toEqual([]);
  });
});

describe('which deadline is being forced right now', () => {
  const report = buildRunway(BOARD, BAY_ISLANDS);

  it('says nothing when there is no next pick to reach from', () => {
    expect(
      urgentDeadlines(report, { nextPick: null, filled: {}, league: BAY_ISLANDS }),
    ).toEqual([]);
  });

  it('drops deadlines that have already passed', () => {
    const urgent = urgentDeadlines(report, {
      nextPick: 100,
      filled: {},
      league: BAY_ISLANDS,
    });
    for (const tier of urgent) expect(tier.lastAdp).toBeGreaterThanOrEqual(100);
  });

  it('stops nagging about a position already filled', () => {
    // Bay Islands starts two running backs; with three on the roster the
    // running back cliff is somebody else's problem.
    const urgent = urgentDeadlines(report, {
      nextPick: 1,
      filled: { RB: 3 },
      league: BAY_ISLANDS,
    });
    expect(urgent.some((t) => t.position === 'RB')).toBe(false);
  });

  it('still flags a position with a starter but no depth', () => {
    const urgent = urgentDeadlines(report, {
      nextPick: 1,
      filled: { RB: 1 },
      league: BAY_ISLANDS,
    });
    expect(urgent.some((t) => t.position === 'RB')).toBe(true);
  });

  it('leads with the deadline arriving soonest', () => {
    const urgent = urgentDeadlines(report, {
      nextPick: 1,
      filled: {},
      league: BAY_ISLANDS,
    });
    const deadlines = urgent.map((t) => t.lastAdp);
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });
});
