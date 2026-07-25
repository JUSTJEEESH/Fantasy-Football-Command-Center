import { describe, expect, it } from 'vitest';
import {
  BASELINE_INJURY_RISK,
  BASELINE_ROLE_CERTAINTY,
  injuryRiskFor,
  playersFromPack,
  roleCertaintyFor,
} from '@/lib/pack-from-static';
import { BAY_ISLANDS } from '@/lib/leagues/bay-islands';
import type { PlayerPack, PlayerPackEntry } from '@/lib/static-data';

// ============================================================================
// This module is the bridge between the data the build ships and the engine
// that ranks it. The tests below care about two things: that real numbers
// survive the crossing intact, and that inferred numbers stay labelled as
// inferences.
// ============================================================================

function packOf(players: PlayerPackEntry[]): PlayerPack {
  return {
    generatedAt: '2026-07-25T00:00:00.000Z',
    ok: true,
    sources: [{ key: 'sleeper', name: 'Sleeper', ok: true, itemCount: players.length }],
    season: 2026,
    players,
  };
}

const QB_STATS = {
  pass_yds: 4200,
  pass_td: 30,
  pass_int: 10,
  rush_yds: 400,
  rush_td: 6,
  fumbles_lost: 3,
};

describe('injury designation → risk', () => {
  it('leaves risk at the engine default when nothing is reported', () => {
    expect(injuryRiskFor(null).risk).toBe(BASELINE_INJURY_RISK);
    expect(injuryRiskFor(undefined).risk).toBe(BASELINE_INJURY_RISK);
  });

  it('treats an explicit ACTIVE as no concern, not as proof of durability', () => {
    expect(injuryRiskFor('ACTIVE').risk).toBe(BASELINE_INJURY_RISK);
    expect(injuryRiskFor('ACTIVE').label).toBeNull();
  });

  it('orders the designations by how much time they actually cost', () => {
    const ir = injuryRiskFor('INJURY_RESERVE').risk;
    const out = injuryRiskFor('Out').risk;
    const doubtful = injuryRiskFor('Doubtful').risk;
    const questionable = injuryRiskFor('Questionable').risk;
    expect(ir).toBeGreaterThan(out);
    expect(out).toBeGreaterThan(doubtful - 0.001);
    expect(doubtful).toBeGreaterThan(questionable);
    expect(questionable).toBeGreaterThan(BASELINE_INJURY_RISK);
  });

  it('reads both platforms\' spellings of the same designation', () => {
    // Sleeper says "IR", ESPN says "INJURY_RESERVE". Same thing.
    expect(injuryRiskFor('IR').risk).toBe(injuryRiskFor('INJURY_RESERVE').risk);
    expect(injuryRiskFor('Sus').risk).toBe(injuryRiskFor('SUSPENSION').risk);
  });

  it('raises the flag on an unrecognized designation instead of discarding it', () => {
    const verdict = injuryRiskFor('LIMBO');
    expect(verdict.risk).toBeGreaterThan(BASELINE_INJURY_RISK);
    expect(verdict.risk).toBeLessThan(0.5);
    expect(verdict.label).toBe('limbo');
  });

  it('produces a label a person can read, not a raw enum', () => {
    expect(injuryRiskFor('INJURY_RESERVE').label).toBe('on injured reserve');
    expect(injuryRiskFor('Questionable').label).toBe('questionable');
  });
});

describe('depth chart → role certainty', () => {
  it('separates a backup quarterback from a third receiver', () => {
    // Both are "the number 2/3 guy" but only one of them plays.
    expect(roleCertaintyFor('QB', 2, undefined)).toBeLessThan(0.25);
    expect(roleCertaintyFor('WR', 3, undefined)).toBeGreaterThan(0.5);
  });

  it('rates a bell-cow back above a committee back', () => {
    expect(roleCertaintyFor('RB', 1, undefined)).toBeGreaterThan(
      roleCertaintyFor('RB', 2, undefined),
    );
  });

  it('falls back to the engine default when there is nothing to go on', () => {
    expect(roleCertaintyFor('WR', undefined, undefined)).toBe(BASELINE_ROLE_CERTAINTY);
  });

  it('lets near-universal ownership rescue a stale depth chart, but never lower it', () => {
    // A 99%-rostered player listed as RB2 is a known quantity.
    expect(roleCertaintyFor('RB', 2, 99)).toBeGreaterThan(roleCertaintyFor('RB', 2, 5));
    // ...but ownership must not drag a confirmed starter down.
    expect(roleCertaintyFor('RB', 1, 99)).toBe(roleCertaintyFor('RB', 1, undefined));
  });

  it('handles a depth chart position deeper than the curve', () => {
    expect(roleCertaintyFor('WR', 9, undefined)).toBeGreaterThan(0);
    expect(roleCertaintyFor('WR', 9, undefined)).toBeLessThan(0.2);
  });
});

describe('building player cards from a shipped pack', () => {
  it('scores ESPN projections under the league rules, not ESPN\'s', () => {
    const { players } = playersFromPack(
      packOf([
        {
          id: 'QB-test-1',
          name: 'Test Passer',
          position: 'QB',
          team: 'BUF',
          adp: 30,
          projectedStats: QB_STATS,
        },
      ]),
      BAY_ISLANDS,
    );

    // Bay Islands: 6-point passing TDs and 1/20 passing yards, against ESPN's
    // 4-point TDs and 1/25 yards. Hand-computed under this league's rules:
    //   4200 * 0.05 = 210, 30 * 6 = 180, 10 * -1 = -10,
    //   400 * 0.1 = 40, 6 * 6 = 36, 3 * -1 = -3   →  453
    expect(players[0]!.projectedPoints).toBeCloseTo(453, 0);
  });

  it('shows the rules actually mattered — ESPN\'s own scoring gives a different number', () => {
    const { players } = playersFromPack(
      packOf([
        { id: 'QB-1', name: 'A', position: 'QB', team: 'BUF', projectedStats: QB_STATS },
      ]),
      BAY_ISLANDS,
    );
    // ESPN PPR would score this line at 4200*.04 + 30*4 + 10*-2 + 400*.1 + 6*6
    // + 3*-2 = 168+120-20+40+36-6 = 338. If the league rules were being
    // ignored we would see that number instead.
    expect(players[0]!.projectedPoints).not.toBeCloseTo(338, 0);
  });

  it('carries real ADP through with its source attached', () => {
    const { players, summary } = playersFromPack(
      packOf([
        { id: 'RB-1', name: 'A', position: 'RB', team: 'ATL', adp: 4.2, adpSource: 'ESPN' },
      ]),
      BAY_ISLANDS,
    );
    expect(players[0]!.adp).toBe(4.2);
    expect(players[0]!.adpSource).toBe('ESPN');
    expect(summary.withAdp).toBe(1);
  });

  it('does not count an ADP-derived estimate as a projection', () => {
    const { players, summary } = playersFromPack(
      packOf([{ id: 'RB-1', name: 'A', position: 'RB', team: 'ATL', adp: 4.2 }]),
      BAY_ISLANDS,
    );
    // The board still gets a number to rank with...
    expect(players[0]!.projectedPoints).toBeGreaterThan(0);
    // ...but the summary must not claim a projection exists.
    expect(summary.withProjection).toBe(0);
    expect(summary.notes.join(' ')).toMatch(/estimated from ADP/i);
  });

  it('leaves points undefined when there is neither a projection nor an ADP', () => {
    // The engine reads an undefined projection as "low confidence" and says so.
    // Filling it in with a guess would silently launder that uncertainty.
    const { players } = playersFromPack(
      packOf([{ id: 'WR-1', name: 'Deep Bench', position: 'WR', team: 'CHI' }]),
      BAY_ISLANDS,
    );
    expect(players[0]!.projectedPoints).toBeUndefined();
  });

  it('orders the board by ADP, putting unranked players last', () => {
    const { players } = playersFromPack(
      packOf([
        { id: 'WR-3', name: 'Unranked', position: 'WR', team: 'CHI' },
        { id: 'RB-1', name: 'Early', position: 'RB', team: 'ATL', adp: 2 },
        { id: 'WR-2', name: 'Later', position: 'WR', team: 'PHI', adp: 40 },
      ]),
      BAY_ISLANDS,
    );
    expect(players.map((p) => p.name)).toEqual(['Early', 'Later', 'Unranked']);
  });

  it('attaches bye weeks and reports when there are none', () => {
    const withBye = playersFromPack(
      packOf([{ id: 'RB-1', name: 'A', position: 'RB', team: 'ATL', adp: 3, byeWeek: 12 }]),
      BAY_ISLANDS,
    );
    expect(withBye.players[0]!.byeWeek).toBe(12);
    expect(withBye.summary.withBye).toBe(1);

    const without = playersFromPack(
      packOf([{ id: 'RB-1', name: 'A', position: 'RB', team: 'ATL', adp: 3 }]),
      BAY_ISLANDS,
    );
    expect(without.summary.notes.join(' ')).toMatch(/No bye weeks published/i);
  });

  it('turns a reported designation into engine-visible risk', () => {
    const { players, summary } = playersFromPack(
      packOf([
        {
          id: 'RB-1',
          name: 'Hurt Back',
          position: 'RB',
          team: 'ATL',
          adp: 20,
          injuryStatus: 'IR',
        },
        { id: 'RB-2', name: 'Healthy Back', position: 'RB', team: 'BUF', adp: 21 },
      ]),
      BAY_ISLANDS,
    );

    const hurt = players.find((p) => p.name === 'Hurt Back')!;
    const healthy = players.find((p) => p.name === 'Healthy Back')!;
    expect(hurt.injuryRisk!).toBeGreaterThan(healthy.injuryRisk!);
    expect(hurt.injuryNote).toBe('on injured reserve');
    expect(summary.withInjuryDesignation).toBe(1);
  });

  it('says out loud that the yardage bonuses are not in the projection', () => {
    // Bay Islands pays a 100-yard rushing bonus. A season total cannot say how
    // many games cleared it, so the bonus is omitted — and admitted.
    const { summary } = playersFromPack(
      packOf([
        { id: 'RB-1', name: 'A', position: 'RB', team: 'ATL', adp: 3, projectedStats: { rush_yds: 1400, rush_td: 10 } },
      ]),
      BAY_ISLANDS,
    );
    expect(summary.notes.join(' ')).toMatch(/bonuses are not included/i);
  });

  it('assigns tiers so the board has structure to reason about', () => {
    const entries: PlayerPackEntry[] = Array.from({ length: 40 }, (_, i) => ({
      id: `RB-${i}`,
      name: `Back ${i}`,
      position: 'RB' as const,
      team: 'ATL',
      adp: i + 1,
      projectedStats: { rush_yds: 1500 - i * 30, rush_td: 12 - i * 0.2, receptions: 40 },
    }));
    const { players } = playersFromPack(packOf(entries), BAY_ISLANDS);
    const tiers = new Set(players.map((p) => p.tier));
    expect(tiers.size).toBeGreaterThan(1);
    expect(players[0]!.tier).toBe(1);
  });

  it('survives an empty pack without throwing', () => {
    const { players, summary } = playersFromPack(packOf([]), BAY_ISLANDS);
    expect(players).toEqual([]);
    expect(summary.players).toBe(0);
  });
});
