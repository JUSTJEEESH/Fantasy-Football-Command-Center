import { describe, expect, it } from 'vitest';
import {
  SCORING_PRESETS,
  positionalDemandPerTeam,
  scoreStatLine,
  startingSlotCount,
} from '@/lib/engine/scoring';
import type { StatLine } from '@/lib/types';

describe('scoreStatLine', () => {
  const rbLine: StatLine = {
    rush_att: 250,
    rush_yds: 1100,
    rush_td: 9,
    targets: 70,
    receptions: 55,
    rec_yds: 450,
    rec_td: 2,
    fumbles_lost: 2,
  };

  it('scores a standard (non-PPR) line correctly', () => {
    // 1100*0.1 + 9*6 + 450*0.1 + 2*6 + 2*(-2) = 110 + 54 + 45 + 12 - 4
    expect(scoreStatLine(rbLine, SCORING_PRESETS.standard(), 'RB')).toBe(217);
  });

  it('adds a full point per reception in PPR', () => {
    expect(scoreStatLine(rbLine, SCORING_PRESETS.ppr(), 'RB')).toBe(217 + 55);
  });

  it('adds half a point per reception in half-PPR', () => {
    expect(scoreStatLine(rbLine, SCORING_PRESETS.half_ppr(), 'RB')).toBe(217 + 27.5);
  });

  it('applies TE premium only to tight ends', () => {
    const teLine: StatLine = { receptions: 80, rec_yds: 900, rec_td: 7 };
    const te = scoreStatLine(teLine, SCORING_PRESETS.te_premium(), 'TE');
    const wr = scoreStatLine(teLine, SCORING_PRESETS.te_premium(), 'WR');
    expect(te - wr).toBe(40); // 80 receptions x 0.5 bonus
  });

  it('scores a QB line with the passing rate', () => {
    const qb: StatLine = { pass_yds: 4500, pass_td: 32, pass_int: 12, rush_yds: 300, rush_td: 3 };
    // 180 + 128 - 24 + 30 + 18
    expect(scoreStatLine(qb, SCORING_PRESETS.ppr(), 'QB')).toBe(332);
  });

  it('ignores stat keys the league does not score', () => {
    const scoring = SCORING_PRESETS.ppr();
    const withUnknown = { ...rbLine, some_future_stat: 999 } as StatLine;
    expect(scoreStatLine(withUnknown, scoring, 'RB')).toBe(
      scoreStatLine(rbLine, scoring, 'RB'),
    );
  });

  it('supports fully custom scoring without code changes', () => {
    const custom = {
      perStat: { rush_yds: 0.2, rush_td: 10, receptions: 2 },
    };
    expect(scoreStatLine({ rush_yds: 100, rush_td: 1, receptions: 5 }, custom, 'RB')).toBe(
      20 + 10 + 10,
    );
  });

  it('applies DST points-allowed brackets', () => {
    const scoring = SCORING_PRESETS.ppr();
    expect(scoreStatLine({ dst_pts_allowed: 0 }, scoring, 'DST')).toBe(10);
    expect(scoreStatLine({ dst_pts_allowed: 10 }, scoring, 'DST')).toBe(4);
    expect(scoreStatLine({ dst_pts_allowed: 45 }, scoring, 'DST')).toBe(-4);
  });

  it('handles an empty stat line', () => {
    expect(scoreStatLine({}, SCORING_PRESETS.ppr(), 'WR')).toBe(0);
  });
});

describe('roster shape helpers', () => {
  const slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };

  it('counts starting slots excluding bench', () => {
    expect(startingSlotCount({ ...slots, BENCH: 6 })).toBe(9);
  });

  it('counts flex demand fractionally, not as a whole slot', () => {
    const rb = positionalDemandPerTeam(slots, 'RB');
    expect(rb).toBeGreaterThan(2);   // 2 dedicated + a share of flex
    expect(rb).toBeLessThan(2.6);
  });

  it('gives TE a smaller flex share than RB or WR', () => {
    expect(positionalDemandPerTeam(slots, 'TE')).toBeLessThan(
      positionalDemandPerTeam(slots, 'RB'),
    );
  });

  it('routes superflex demand overwhelmingly to QB', () => {
    const sf = { QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 };
    expect(positionalDemandPerTeam(sf, 'QB')).toBeGreaterThan(1.7);
  });

  it('gives zero demand to positions with no slot', () => {
    expect(positionalDemandPerTeam({ QB: 1, RB: 2 }, 'DST')).toBe(0);
  });
});
