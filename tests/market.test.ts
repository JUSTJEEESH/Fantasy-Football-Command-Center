import { describe, expect, it } from 'vitest';
import { MIN_OWNERSHIP_FOR_REAL_ADP, analyzeMarket } from '@/lib/engine/market';
import { BAY_ISLANDS } from '@/lib/leagues/bay-islands';
import type { League, PlayerCard, Position } from '@/lib/types';

// ============================================================================
// The market module answers one question: where does your league's scoring
// disagree with the price everyone else is paying?
//
// It is the most dangerous module in the engine, because a wrong answer here
// is confident, specific, and acted on. Most of what follows is about the
// things it must REFUSE to conclude.
// ============================================================================

/** A board with a smooth ADP curve and projections that track it. */
function board(
  spec: Array<{ position: Position; count: number; topPoints: number; decay: number }>,
): PlayerCard[] {
  const players: PlayerCard[] = [];
  let adp = 1;
  // Interleave positions so ADP order is realistic rather than blocked.
  const queues = spec.map((s) => ({ ...s, made: 0 }));
  while (queues.some((q) => q.made < q.count)) {
    for (const q of queues) {
      if (q.made >= q.count) continue;
      players.push({
        id: `${q.position}-${q.made}`,
        name: `${q.position} Player ${q.made}`,
        position: q.position,
        team: 'ATL',
        adp: adp + Math.random() * 0.01,
        percentOwned: 90,
        projectedPoints: Math.round(q.topPoints * Math.exp(-q.decay * q.made)),
        projectionSource: 'projection',
      });
      q.made++;
      adp++;
    }
  }
  return players;
}

const STANDARD_BOARD = board([
  { position: 'RB', count: 40, topPoints: 320, decay: 0.03 },
  { position: 'WR', count: 40, topPoints: 310, decay: 0.028 },
  { position: 'QB', count: 20, topPoints: 380, decay: 0.02 },
  { position: 'TE', count: 20, topPoints: 250, decay: 0.05 },
]);

describe('what the market analysis refuses to conclude', () => {
  it('says nothing at all from too small a sample', () => {
    const tiny = STANDARD_BOARD.slice(0, 8);
    const result = analyzeMarket(tiny, BAY_ISLANDS);
    expect(result.targets).toEqual([]);
    expect(result.fades).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/too few/i);
  });

  it('ignores points that were themselves derived from ADP', () => {
    // This is the trap. An ADP-derived projection is a function of ADP, so
    // comparing the two would either find a perfect zero or, once positional
    // curves differ, manufacture an "edge" out of pure arithmetic.
    const estimated = STANDARD_BOARD.map((p) => ({
      ...p,
      projectionSource: 'adp-estimate' as const,
    }));
    const result = analyzeMarket(estimated, BAY_ISLANDS);
    expect(result.analyzed).toBe(0);
    expect(result.targets).toEqual([]);
  });

  it('ignores an ADP that is really a placeholder', () => {
    // Platforms give every barely-drafted player an ADP just shy of the last
    // pick. On real data that stacked 220 of 358 players into two buckets and
    // flipped a positional verdict by five rounds. Low ownership is how those
    // placeholders identify themselves.
    const placeholders = STANDARD_BOARD.map((p) => ({
      ...p,
      percentOwned: MIN_OWNERSHIP_FOR_REAL_ADP - 1,
    }));
    expect(analyzeMarket(placeholders, BAY_ISLANDS).analyzed).toBe(0);
  });

  it('trusts an ADP when ownership is simply not reported', () => {
    // A hand-exported CSV has no ownership column; the person who exported it
    // already decided who was worth including.
    const noOwnership = STANDARD_BOARD.map(({ percentOwned, ...rest }) => rest);
    expect(analyzeMarket(noOwnership, BAY_ISLANDS).analyzed).toBeGreaterThan(100);
  });

  it('never calls a replacement-level player a target', () => {
    // A deep bench player is cheap because he is bad. A hundred picks of
    // "edge" on someone who would never start is not an edge.
    const result = analyzeMarket(STANDARD_BOARD, BAY_ISLANDS);
    for (const target of result.targets) expect(target.vor).toBeGreaterThan(0);
  });

  it('reports how much of the board it could not use', () => {
    const mixed = [
      ...STANDARD_BOARD,
      ...STANDARD_BOARD.slice(0, 20).map((p, i) => ({
        ...p,
        id: `est-${i}`,
        projectionSource: 'adp-estimate' as const,
      })),
    ];
    const result = analyzeMarket(mixed, BAY_ISLANDS);
    expect(result.excluded).toBe(20);
    expect(result.notes.join(' ')).toMatch(/estimated from ADP/i);
  });
});

describe('the edge Bay Islands actually has', () => {
  const result = analyzeMarket(STANDARD_BOARD, BAY_ISLANDS);

  // The league's defining rule CHANGED at the 2026-08-08 party: a mandatory
  // TE was voted in. The old assertions here — TEs faded wholesale, "not
  // required to start a TE" verdict — described the old league, and keeping
  // them would freeze the app in a season that no longer exists. The
  // flex-only fade MECHANISM is still tested below, against a league shaped
  // like the old one, so the behaviour is preserved even though Bay Islands
  // no longer triggers it.
  const OLD_BAY_ISLANDS: League = {
    ...BAY_ISLANDS,
    rosterSlots: { QB: 1, RB: 2, WR: 2, FLEX: 1, K: 1, DST: 1 },
    benchSize: 7,
  };

  it('no longer blanket-fades tight ends now that one is mandatory', () => {
    const te = result.byPosition.find((p) => p.position === 'TE');
    expect(te).toBeDefined();
    expect(te!.verdict).not.toMatch(/not required to start a TE/i);
    // Required-position pricing: whatever the verdict, it is the ordinary
    // over/under/fair wording, not the structural fade.
    const old = analyzeMarket(STANDARD_BOARD, OLD_BAY_ISLANDS).byPosition.find(
      (p) => p.position === 'TE',
    );
    expect(te!.medianRoundsOfEdge).toBeGreaterThan(old!.medianRoundsOfEdge);
  });

  it('still fades a flex-only position, in a league shaped like the old one', () => {
    // The mechanism the old rules exercised must survive the rule change.
    const old = analyzeMarket(STANDARD_BOARD, OLD_BAY_ISLANDS);
    const te = old.byPosition.find((p) => p.position === 'TE');
    expect(te!.medianRoundsOfEdge).toBeLessThan(-1);
    expect(te!.verdict).toMatch(/not required to start a TE/i);
    expect(old.fades.length).toBeGreaterThan(0);
    expect(old.fades[0]!.player.position).toBe('TE');
  });

  it('expresses the gap in rounds, which is how a draft is actually felt', () => {
    const any = result.targets[0] ?? result.fades[0]!;
    expect(any.roundsOfEdge).toBeCloseTo(any.edge / BAY_ISLANDS.teamCount, 1);
  });

  it('explains every edge in words', () => {
    for (const edge of [...result.targets, ...result.fades]) {
      expect(edge.note).toMatch(/goes around pick \d+/);
    }
  });
});

describe('positional verdicts', () => {
  it('leaves undrafted players out of the verdict', () => {
    // A player nobody drafts is not mispriced; he is simply not in the draft.
    // Including the long tail of backup quarterbacks flipped QB from +1.0 to
    // −3.7 rounds on real data.
    const withTail = [
      ...STANDARD_BOARD,
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `tail-qb-${i}`,
        name: `Tail QB ${i}`,
        position: 'QB' as Position,
        team: 'ATL',
        adp: 400 + i,
        percentOwned: 95,          // owned, but far past the last pick
        projectedPoints: 40,
        projectionSource: 'projection' as const,
      })),
    ];

    const withTailQb = analyzeMarket(withTail, BAY_ISLANDS).byPosition.find(
      (p) => p.position === 'QB',
    );
    const cleanQb = analyzeMarket(STANDARD_BOARD, BAY_ISLANDS).byPosition.find(
      (p) => p.position === 'QB',
    );
    expect(withTailQb!.sampleSize).toBe(cleanQb!.sampleSize);
  });

  it('uses a median, so one outlier cannot define a position', () => {
    const withFreak = [
      ...STANDARD_BOARD,
      {
        id: 'freak',
        name: 'Freak WR',
        position: 'WR' as Position,
        team: 'ATL',
        adp: 100,
        percentOwned: 95,
        projectedPoints: 900,      // absurd on purpose
        projectionSource: 'projection' as const,
      },
    ];
    const before = analyzeMarket(STANDARD_BOARD, BAY_ISLANDS).byPosition.find(
      (p) => p.position === 'WR',
    )!;
    const after = analyzeMarket(withFreak, BAY_ISLANDS).byPosition.find(
      (p) => p.position === 'WR',
    )!;
    expect(Math.abs(after.medianRoundsOfEdge - before.medianRoundsOfEdge)).toBeLessThan(0.6);
  });

  it('stays quiet about a position with too few players to judge', () => {
    const thin = [
      ...STANDARD_BOARD.filter((p) => p.position !== 'TE'),
      ...STANDARD_BOARD.filter((p) => p.position === 'TE').slice(0, 3),
    ];
    expect(
      analyzeMarket(thin, BAY_ISLANDS).byPosition.find((p) => p.position === 'TE'),
    ).toBeUndefined();
  });
});
