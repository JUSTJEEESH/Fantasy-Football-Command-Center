import { describe, expect, it } from 'vitest';
import {
  ESPN_STAT_IDS,
  buildRows,
  normalizeTeam,
  verifyStatMapping,
} from '@/lib/sources/espn';

// ============================================================================
// The ESPN adapter's job is not to trust ESPN — it is to check ESPN's payload
// against itself before publishing anything derived from it. These tests are
// mostly about that check: it has to pass on a faithful payload and it has to
// fail on a payload whose stat ids have shifted underneath us.
// ============================================================================

/** ESPN's PPR rulebook, restated here so the fixtures are built independently
 *  of the constant the implementation checks against. */
const PPR = {
  '3': 0.04,   // pass yards
  '4': 4,      // pass TD
  '20': -2,    // interception
  '24': 0.1,   // rush yards
  '25': 6,     // rush TD
  '53': 1,     // reception
  '42': 0.1,   // receiving yards
  '43': 6,     // receiving TD
  '72': -2,    // fumble lost
} as const;

function appliedTotalFor(stats: Record<string, number>): number {
  let total = 0;
  for (const [id, value] of Object.entries(stats)) {
    total += (PPR[id as keyof typeof PPR] ?? 0) * value;
  }
  // ESPN reports to one decimal place, so the fixtures do too — the tolerance
  // in the checker has to survive that rounding.
  return Math.round(total * 10) / 10;
}

/** A plausible season line for each position, scaled by `factor`. */
function statsFor(position: 'QB' | 'RB' | 'WR', factor: number): Record<string, number> {
  if (position === 'QB') {
    return {
      '0': Math.round(560 * factor),
      '1': Math.round(370 * factor),
      '3': Math.round(4200 * factor),
      '4': Math.round(28 * factor),
      '20': Math.round(11 * factor),
      '23': Math.round(58 * factor),
      '24': Math.round(340 * factor),
      '25': Math.round(4 * factor),
      '72': Math.round(3 * factor),
    };
  }
  if (position === 'RB') {
    return {
      '23': Math.round(250 * factor),
      '24': Math.round(1100 * factor),
      '25': Math.round(9 * factor),
      '58': Math.round(60 * factor),
      '53': Math.round(46 * factor),
      '42': Math.round(380 * factor),
      '43': Math.round(2 * factor),
      '72': Math.round(2 * factor),
    };
  }
  return {
    '58': Math.round(140 * factor),
    '53': Math.round(92 * factor),
    '42': Math.round(1250 * factor),
    '43': Math.round(8 * factor),
    '23': Math.round(6 * factor),
    '24': Math.round(40 * factor),
    '72': Math.round(1 * factor),
  };
}

const POSITION_IDS = { QB: 1, RB: 2, WR: 3 } as const;

/**
 * A faithful ESPN payload. `mutateStats` lets a test ship a payload whose raw
 * numbers no longer mean what the id map says they mean, while leaving
 * `appliedTotal` correct for the numbers ESPN actually intended — which is
 * exactly the shape of the failure the checker exists to catch.
 */
function fixturePayload(
  count = 60,
  mutateStats?: (stats: Record<string, number>) => Record<string, number>,
): Array<{ player: Record<string, unknown> }> {
  const order: Array<'QB' | 'RB' | 'WR'> = ['QB', 'RB', 'WR'];
  return Array.from({ length: count }, (_, i) => {
    const position = order[i % 3]!;
    const factor = 1 - (i / count) * 0.7;
    const trueStats = statsFor(position, factor);
    const total = appliedTotalFor(trueStats);
    const shipped = mutateStats ? mutateStats(trueStats) : trueStats;
    return {
      player: {
        id: 1000 + i,
        fullName: `Player ${i}`,
        defaultPositionId: POSITION_IDS[position],
        proTeamId: (i % 32) + 1,
        injuryStatus: i % 10 === 0 ? 'QUESTIONABLE' : 'ACTIVE',
        ownership: { averageDraftPosition: i + 1.5, percentOwned: 99 - i * 0.5 },
        draftRanksByRankType: { PPR: { rank: i + 1 }, STANDARD: { rank: i + 2 } },
        stats: [
          // A weekly split and an actuals row are present on real payloads and
          // must not be mistaken for the season projection.
          { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 12.3, stats: { '3': 250 } },
          { seasonId: 2026, statSourceId: 0, statSplitTypeId: 0, appliedTotal: 0, stats: {} },
          { seasonId: 2026, statSourceId: 1, statSplitTypeId: 0, appliedTotal: total, stats: shipped },
        ],
      },
    };
  });
}

const CTX = {
  season: 2026,
  fetchedAt: '2026-07-25T00:00:00.000Z',
  abbrevById: { 1: 'ATL', 2: 'BUF', 3: 'CHI', 12: 'KC' } as Record<number, string>,
};

describe('ESPN stat mapping verification', () => {
  it('confirms the mapping when ESPN sends what the id map expects', () => {
    const rows = fixturePayload().map((e) => {
      const stats = e.player.stats as Array<{ statSplitTypeId: number; statSourceId: number; stats: Record<string, number>; appliedTotal: number }>;
      const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0)!;
      return { stats: season.stats, appliedTotal: season.appliedTotal };
    });

    const verdict = verifyStatMapping(rows);
    expect(verdict.ok).toBe(true);
    expect(verdict.agreement).toBeGreaterThan(0.95);
    expect(verdict.medianError).toBeLessThan(2);
  });

  it('rejects the mapping when ESPN renumbers a scoring stat', () => {
    // Receptions move from id 53 to id 41 — the single most damaging change
    // possible in a PPR league, and one that leaves every other stat intact.
    const rows = fixturePayload(60, (stats) => {
      const moved = { ...stats };
      if (moved['53'] !== undefined) {
        moved['41'] = moved['53'];
        delete moved['53'];
      }
      return moved;
    }).map((e) => {
      const stats = e.player.stats as Array<{ statSplitTypeId: number; statSourceId: number; stats: Record<string, number>; appliedTotal: number }>;
      const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0)!;
      return { stats: season.stats, appliedTotal: season.appliedTotal };
    });

    const verdict = verifyStatMapping(rows);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/stat-id mapping/i);
  });

  it('refuses to certify the mapping from too small a sample', () => {
    const verdict = verifyStatMapping([
      { stats: { '3': 4000, '4': 30 }, appliedTotal: 280 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/too few/i);
  });

  it('is not dragged under by kickers and defenses it never claimed to map', () => {
    // This is the first live run, reproduced. The mapping was correct — median
    // error 0.6 points — but ~16% of the board is K and DST, which score
    // through stat ids this adapter does not map, so they reconstructed to
    // roughly nothing and voted the verdict down to 81%.
    const skill = fixturePayload(60).map((e) => {
      const stats = e.player.stats as Array<{ statSourceId: number; statSplitTypeId: number; stats: Record<string, number>; appliedTotal: number }>;
      const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0)!;
      const positionId = e.player.defaultPositionId as number;
      const position = ({ 1: 'QB', 2: 'RB', 3: 'WR' } as const)[positionId as 1 | 2 | 3];
      return { stats: season.stats, appliedTotal: season.appliedTotal, position };
    });

    // Kickers: real point totals, and stat ids that appear nowhere in the map.
    const kickers = Array.from({ length: 14 }, () => ({
      stats: { '83': 25, '84': 3, '86': 40 },
      appliedTotal: 130,
      position: 'K' as const,
    }));

    expect(verifyStatMapping([...skill, ...kickers]).ok).toBe(true);

    // And the same sample judged without the position filter is exactly the
    // false alarm that shipped: high agreement among the rows under test,
    // dragged below the bar by rows that were never under test.
    const unfiltered = verifyStatMapping(
      [...skill, ...kickers].map(({ stats, appliedTotal }) => ({ stats, appliedTotal })),
    );
    expect(unfiltered.ok).toBe(false);
  });

  it('still fails when a mapped position genuinely breaks', () => {
    // The position filter must not become a way to pass by ignoring bad news.
    const broken = fixturePayload(60, (stats) => {
      const moved = { ...stats };
      if (moved['53'] !== undefined) {
        moved['41'] = moved['53'];
        delete moved['53'];
      }
      return moved;
    }).map((e) => {
      const stats = e.player.stats as Array<{ statSourceId: number; statSplitTypeId: number; stats: Record<string, number>; appliedTotal: number }>;
      const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0)!;
      const positionId = e.player.defaultPositionId as number;
      return {
        stats: season.stats,
        appliedTotal: season.appliedTotal,
        position: ({ 1: 'QB', 2: 'RB', 3: 'WR' } as const)[positionId as 1 | 2 | 3],
      };
    });

    const verdict = verifyStatMapping(broken);
    expect(verdict.ok).toBe(false);
    // And it names which positions broke, so the next person knows where to look.
    const wr = verdict.byPosition.find((b) => b.position === 'WR');
    const qb = verdict.byPosition.find((b) => b.position === 'QB');
    expect(wr!.agreement).toBeLessThan(0.5);   // receptions moved — WRs wrecked
    expect(qb!.agreement).toBeGreaterThan(0.9); // QBs barely catch passes
  });

  it('is not fooled by rows with no production', () => {
    // Zero reconstructs to zero under any mapping at all, so a payload made
    // entirely of empty rows must not read as a confirmed mapping.
    const rows = Array.from({ length: 200 }, () => ({ stats: {}, appliedTotal: 0 }));
    expect(verifyStatMapping(rows).ok).toBe(false);
  });
});

describe('ESPN draft board rows', () => {
  it('extracts ADP, draft rank, team and projections from a faithful payload', () => {
    const result = buildRows(fixturePayload(), CTX);
    expect(result.ok).toBe(true);
    expect(result.mapping?.ok).toBe(true);
    expect(result.items.length).toBe(60);

    const first = result.items[0]!;
    expect(first.name).toBe('Player 0');
    expect(first.position).toBe('QB');
    expect(first.team).toBe('ATL');
    expect(first.adp).toBeCloseTo(1.5);
    expect(first.draftRank).toBe(1);
    expect(first.projectedStats?.pass_yds).toBeGreaterThan(3000);
    expect(first.projectedStats?.pass_td).toBeGreaterThan(20);
  });

  it('reads the season projection, not the weekly split or the actuals row', () => {
    const result = buildRows(fixturePayload(), CTX);
    // The weekly split in the fixture carries 250 pass yards; the season row
    // carries thousands. Picking the wrong row would be silently plausible.
    expect(result.items[0]!.projectedStats!.pass_yds!).toBeGreaterThan(1000);
  });

  it('withholds every projection when the mapping check fails', () => {
    const result = buildRows(
      fixturePayload(60, (stats) => {
        const moved = { ...stats };
        if (moved['53'] !== undefined) {
          moved['41'] = moved['53'];
          delete moved['53'];
        }
        return moved;
      }),
      CTX,
    );

    expect(result.mapping?.ok).toBe(false);
    // ADP still ships — it needs no stat mapping to be trustworthy.
    expect(result.items.every((r) => r.adp !== undefined)).toBe(true);
    // Projections do not.
    expect(result.items.every((r) => r.projectedStats === undefined)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/projections were dropped/i);
  });

  it('treats ESPN\'s zero ADP as "undrafted", not as the first pick', () => {
    const payload = fixturePayload(60);
    (payload[5]!.player as { ownership: { averageDraftPosition: number } }).ownership.averageDraftPosition = 0;
    const result = buildRows(payload, CTX);
    expect(result.items[5]!.adp).toBeUndefined();
  });

  it('skips non-fantasy positions rather than guessing at them', () => {
    const payload = fixturePayload(60);
    (payload[7]!.player as { defaultPositionId: number }).defaultPositionId = 9; // DL
    const result = buildRows(payload, CTX);
    expect(result.items.length).toBe(59);
    expect(result.items.some((r) => r.name === 'Player 7')).toBe(false);
  });

  it('leaves the team null when the abbreviation is unknown rather than inventing one', () => {
    const result = buildRows(fixturePayload(60), { ...CTX, abbrevById: {} });
    expect(result.items.every((r) => r.team === null)).toBe(true);
  });
});

describe('team normalization', () => {
  it('maps ESPN\'s Washington abbreviation onto the one every other source uses', () => {
    expect(normalizeTeam('WSH')).toBe('WAS');
  });

  it('passes through the abbreviations that already agree', () => {
    expect(normalizeTeam('kc')).toBe('KC');
    expect(normalizeTeam('LAR')).toBe('LAR');
  });
});

describe('the stat id map itself', () => {
  it('covers every stat ESPN\'s PPR scoring actually pays for', () => {
    // If a paid stat were missing from the map, the verification would fail on
    // every build; this asserts the intent directly so the reason is obvious.
    const paid = ['3', '4', '20', '24', '25', '53', '42', '43', '72'];
    for (const id of paid) expect(ESPN_STAT_IDS[id]).toBeDefined();
  });
});
