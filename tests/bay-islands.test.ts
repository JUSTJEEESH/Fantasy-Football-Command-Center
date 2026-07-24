import { describe, expect, it } from 'vitest';
import {
  BAY_ISLANDS,
  BAY_ISLANDS_ROUNDS,
  BAY_ISLANDS_SCORING,
} from '@/lib/leagues/bay-islands';
import { scoreStatLine, positionalDemandPerTeam } from '@/lib/engine/scoring';
import { computeReplacementLevels, valueOverReplacement } from '@/lib/engine/valuation';
import { analyzeRoster, fillLineup } from '@/lib/engine/roster';
import { recommend } from '@/lib/engine/recommend';
import { createDraftState, draftReducer, picksForSlot } from '@/lib/engine/draft-state';
import { analyzePositionalLandscape, planAllSlots } from '@/lib/engine/slot-planner';
import { LeagueSettingsSchema } from '@/lib/types';
import { buildMockPool } from './helpers/mock-players';
import type { PlayerCard, StatLine } from '@/lib/types';

// ============================================================================
// The real league. These tests assert the rules as written on the settings
// page, so that a future change to the engine cannot silently break them.
// ============================================================================

const league = { ...BAY_ISLANDS, draftSlot: 1 };
const players = buildMockPool({ seed: 4242 });

describe('league configuration', () => {
  it('validates against the schema', () => {
    expect(LeagueSettingsSchema.safeParse(BAY_ISLANDS).success).toBe(true);
  });

  it('accepts an undrawn draft order', () => {
    expect(BAY_ISLANDS.draftSlot).toBeNull();
    expect(LeagueSettingsSchema.safeParse(BAY_ISLANDS).success).toBe(true);
  });

  it('has 8 starters and 15 total roster spots', () => {
    const starters = Object.entries(BAY_ISLANDS.rosterSlots)
      .filter(([slot]) => slot !== 'BENCH')
      .reduce((sum, [, n]) => sum + (n ?? 0), 0);
    expect(starters).toBe(8);
    expect(starters + BAY_ISLANDS.benchSize).toBe(15);
    expect(BAY_ISLANDS_ROUNDS).toBe(15);
  });

  it('requires zero starting tight ends', () => {
    expect(BAY_ISLANDS.rosterSlots.TE ?? 0).toBe(0);
  });
});

describe('scoring matches the settings page', () => {
  it('pays 6 points for a passing touchdown, not 4', () => {
    expect(scoreStatLine({ pass_td: 1 }, BAY_ISLANDS_SCORING, 'QB')).toBe(6);
  });

  it('pays 1 point per 20 passing yards', () => {
    expect(scoreStatLine({ pass_yds: 300 }, BAY_ISLANDS_SCORING, 'QB')).toBe(15);
  });

  it('penalizes interceptions and lost fumbles by 1, not 2', () => {
    expect(scoreStatLine({ pass_int: 1 }, BAY_ISLANDS_SCORING, 'QB')).toBe(-1);
    expect(scoreStatLine({ fumbles_lost: 1 }, BAY_ISLANDS_SCORING, 'RB')).toBe(-1);
  });

  it('pays the 100-yard rushing game bonus', () => {
    expect(scoreStatLine({ rush_100_bonus: 4 }, BAY_ISLANDS_SCORING, 'RB')).toBe(12);
  });

  it('is full PPR', () => {
    expect(scoreStatLine({ receptions: 10 }, BAY_ISLANDS_SCORING, 'WR')).toBe(10);
  });

  it('gives tight ends no reception premium', () => {
    const line: StatLine = { receptions: 10, rec_yds: 100 };
    expect(scoreStatLine(line, BAY_ISLANDS_SCORING, 'TE')).toBe(
      scoreStatLine(line, BAY_ISLANDS_SCORING, 'WR'),
    );
  });

  it('does not penalize a missed field goal', () => {
    expect(scoreStatLine({ fg_miss: 3 }, BAY_ISLANDS_SCORING, 'K')).toBe(0);
  });

  it('uses this league\'s defense points-allowed ladder', () => {
    expect(scoreStatLine({ dst_pts_allowed: 0 }, BAY_ISLANDS_SCORING, 'DST')).toBe(5);
    expect(scoreStatLine({ dst_pts_allowed: 10 }, BAY_ISLANDS_SCORING, 'DST')).toBe(3);
    expect(scoreStatLine({ dst_pts_allowed: 17 }, BAY_ISLANDS_SCORING, 'DST')).toBe(1);
    // No negative brackets: a blowout simply scores zero.
    expect(scoreStatLine({ dst_pts_allowed: 45 }, BAY_ISLANDS_SCORING, 'DST')).toBe(0);
  });

  it('scores a realistic QB season', () => {
    const qb: StatLine = {
      pass_yds: 4500, pass_td: 32, pass_int: 12, rush_yds: 300, rush_td: 3,
    };
    // 225 + 192 - 12 + 30 + 18
    expect(scoreStatLine(qb, BAY_ISLANDS_SCORING, 'QB')).toBe(453);
  });

  it('scores a realistic RB season', () => {
    const rb: StatLine = {
      rush_yds: 1100, rush_td: 9, receptions: 55, rec_yds: 450, rec_td: 2,
      fumbles_lost: 2, rush_100_bonus: 3,
    };
    // 110 + 54 + 55 + 45 + 12 - 2 + 9
    expect(scoreStatLine(rb, BAY_ISLANDS_SCORING, 'RB')).toBe(283);
  });
});

describe('the zero-TE rule and what it does to value', () => {
  it('collapses tight end demand to a share of the flex spot', () => {
    const teDemand = positionalDemandPerTeam(BAY_ISLANDS.rosterSlots, 'TE');
    const rbDemand = positionalDemandPerTeam(BAY_ISLANDS.rosterSlots, 'RB');
    expect(teDemand).toBeLessThan(0.2);
    expect(rbDemand).toBeGreaterThan(2);
  });

  it('sets replacement level at tight end near the very top of the position', () => {
    const replacement = computeReplacementLevels(players, league);
    // With ~12 teams starting one TE, replacement is around TE14. Here it must
    // be far shallower, because almost nobody has to start one.
    expect(replacement.index.TE).toBeLessThan(4);
    expect(replacement.index.RB).toBeGreaterThan(25);
  });

  it('leaves almost every tight end below replacement level', () => {
    const replacement = computeReplacementLevels(players, league);
    const positive = players
      .filter((p) => p.position === 'TE')
      .filter((p) => valueOverReplacement(p, replacement) > 0);
    expect(positive.length).toBeLessThanOrEqual(3);
  });

  it('does not require a tight end for a legal lineup', () => {
    const roster: PlayerCard[] = [
      mk('qb', 'QB', 400), mk('rb1', 'RB', 300), mk('rb2', 'RB', 250),
      mk('wr1', 'WR', 280), mk('wr2', 'WR', 240), mk('flex', 'RB', 200),
      mk('k', 'K', 140), mk('d', 'DST', 130),
    ];
    expect(analyzeRoster(roster, league).unfilledSlots).toEqual([]);
    expect(fillLineup(roster, league.rosterSlots).starters.has('TE')).toBe(false);
  });

  it('says so explicitly in the positional landscape', () => {
    const landscape = analyzePositionalLandscape(players, league);
    const te = landscape.find((l) => l.position === 'TE')!;
    expect(te.note).toMatch(/ZERO tight ends/i);
    expect(te.note).toMatch(/FLEX/);
  });
});

describe('position maximums are enforced as hard caps', () => {
  it('never recommends a player at a position that is already full', () => {
    // Fill the tight end cap of 3, then confirm no TE can be recommended.
    const tes = players.filter((p) => p.position === 'TE').slice(0, 3);
    let state = createDraftState({
      leagueId: league.id, teamCount: 12, rounds: 15, userSlot: 1,
    });
    // Slot 1 picks at 1, 24, 25. Give the user three TEs and fill the rest.
    const userPicks = new Set(picksForSlot(1, 12, 15, 'snake').slice(0, 3));
    let teIndex = 0;
    const filler = players.filter((p) => p.position === 'WR');
    let fillerIndex = 0;

    for (let pick = 1; pick <= 25; pick++) {
      const playerId = userPicks.has(pick)
        ? tes[teIndex++]!.id
        : filler[fillerIndex++]!.id;
      state = draftReducer(state, { type: 'RECORD_PICK', playerId });
    }

    const rec = recommend({ state, league, players });
    expect(rec.take!.position).not.toBe('TE');
    for (const alt of rec.alternatives) expect(alt.position).not.toBe('TE');
  });

  it('caps quarterbacks at four', () => {
    expect(BAY_ISLANDS.positionLimits?.QB).toBe(4);
    expect(BAY_ISLANDS.positionLimits?.TE).toBe(3);
    expect(BAY_ISLANDS.positionLimits?.DST).toBe(3);
  });
});

describe('a full 15-round draft in this league', () => {
  it('produces a legal roster from every draft slot', () => {
    for (const slot of [1, 6, 12]) {
      const slotLeague = { ...BAY_ISLANDS, draftSlot: slot };
      let state = createDraftState({
        leagueId: BAY_ISLANDS.id, teamCount: 12, rounds: 15, userSlot: slot,
      });
      const userPicks = new Set(picksForSlot(slot, 12, 15, 'snake'));

      for (let pick = 1; pick <= 12 * 15; pick++) {
        const drafted = new Set(state.picks.map((p) => p.playerId));
        const available = players.filter((p) => !drafted.has(p.id));
        if (available.length === 0) break;

        const chosenId = userPicks.has(pick)
          ? recommend({ state, league: slotLeague, players }).take?.id
          : [...available].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999))[0]!.id;
        if (!chosenId) break;

        state = draftReducer(state, { type: 'RECORD_PICK', playerId: chosenId });
      }

      const roster = state.picks
        .filter((p) => p.draftSlot === slot)
        .map((p) => players.find((x) => x.id === p.playerId)!)
        .filter(Boolean);

      expect(roster).toHaveLength(15);
      // Every required starting slot filled.
      expect(analyzeRoster(roster, slotLeague).unfilledSlots).toEqual([]);
      // No position over its cap.
      for (const [position, limit] of Object.entries(BAY_ISLANDS.positionLimits ?? {})) {
        const count = roster.filter((p) => p.position === position).length;
        expect(count).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('does not stockpile tight ends when none are required', () => {
    const slotLeague = { ...BAY_ISLANDS, draftSlot: 6 };
    let state = createDraftState({
      leagueId: BAY_ISLANDS.id, teamCount: 12, rounds: 15, userSlot: 6,
    });
    const userPicks = new Set(picksForSlot(6, 12, 15, 'snake'));

    for (let pick = 1; pick <= 12 * 15; pick++) {
      const drafted = new Set(state.picks.map((p) => p.playerId));
      const available = players.filter((p) => !drafted.has(p.id));
      if (available.length === 0) break;
      const chosenId = userPicks.has(pick)
        ? recommend({ state, league: slotLeague, players }).take?.id
        : [...available].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999))[0]!.id;
      if (!chosenId) break;
      state = draftReducer(state, { type: 'RECORD_PICK', playerId: chosenId });
    }

    const roster = state.picks
      .filter((p) => p.draftSlot === 6)
      .map((p) => players.find((x) => x.id === p.playerId)!);
    expect(roster.filter((p) => p.position === 'TE').length).toBeLessThanOrEqual(1);
  });
});

describe('slot planner', () => {
  const result = planAllSlots(players, BAY_ISLANDS, { rounds: 15, seed: 1 });

  it('produces a plan for all twelve slots', () => {
    expect(result.plans).toHaveLength(12);
    expect(result.ranking).toHaveLength(12);
  });

  it('knows which picks each slot owns', () => {
    const slot1 = result.plans.find((p) => p.slot === 1)!;
    expect(slot1.picks.slice(0, 3)).toEqual([1, 24, 25]);
    const slot12 = result.plans.find((p) => p.slot === 12)!;
    expect(slot12.picks.slice(0, 3)).toEqual([12, 13, 36]);
  });

  it('reports the longest wait between picks', () => {
    // The turn slots wait longest between their paired picks.
    expect(result.plans.find((p) => p.slot === 1)!.longestGap).toBe(22);
    expect(result.plans.find((p) => p.slot === 12)!.longestGap).toBe(22);
    expect(result.plans.find((p) => p.slot === 6)!.longestGap).toBeLessThan(22);
  });

  it('recommends an opening pick for each slot', () => {
    for (const plan of result.plans) {
      expect(plan.earlyPicks.length).toBeGreaterThan(0);
      expect(plan.earlyPicks[0]!.playerName).toBeTruthy();
    }
  });

  it('builds a complete roster from every slot', () => {
    for (const plan of result.plans) {
      const total = Object.values(plan.rosterShape).reduce((a, b) => a + b, 0);
      expect(total).toBe(15);
    }
  });

  it('states its assumptions rather than presenting itself as a forecast', () => {
    expect(result.assumptions.length).toBeGreaterThan(2);
    expect(result.assumptions.join(' ')).toMatch(/indicative, not precise/);
  });

  it('is deterministic for a given seed', () => {
    const again = planAllSlots(players, BAY_ISLANDS, { rounds: 15, seed: 1 });
    expect(again.plans[0]!.earlyPicks[0]!.playerName).toBe(
      result.plans[0]!.earlyPicks[0]!.playerName,
    );
  });
});

function mk(id: string, position: PlayerCard['position'], points: number): PlayerCard {
  return { id, name: id, position, team: 'FA', projectedPoints: points };
}
