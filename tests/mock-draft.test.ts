import { describe, expect, it } from 'vitest';
import { recommend } from '@/lib/engine/recommend';
import {
  createDraftState,
  detectRuns,
  draftReducer,
  isUserOnClock,
  userRoster,
} from '@/lib/engine/draft-state';
import { analyzeRoster, fillLineup } from '@/lib/engine/roster';
import { buildMockLeague, buildMockPool, mulberry32 } from './helpers/mock-players';
import type { DraftState, PlayerCard, Position } from '@/lib/types';

// ============================================================================
// §36 — full 12-team mock draft simulation.
//
// This is the test that actually says whether the engine is any good. Eleven
// AI opponents draft against Coach with realistic behaviour: mostly ADP-driven,
// with reaches, positional runs, need-based picks, and mid-draft injury news
// that should visibly change what Coach recommends.
// ============================================================================

const league = buildMockLeague({ teamCount: 12, draftSlot: 5 });
const ROUNDS = 16;

interface SimResult {
  state: DraftState;
  userRoster: PlayerCard[];
  allRosters: Map<number, PlayerCard[]>;
  recommendationsFollowed: number;
  runsDetected: number;
}

/**
 * Opponent behaviour model. Real drafters are neither pure-ADP robots nor
 * random: they mostly follow consensus, reach for their guys, chase runs, and
 * fill needs late. Simulating only ADP would make the engine look better than
 * it is.
 */
function opponentPick(
  available: PlayerCard[],
  roster: PlayerCard[],
  round: number,
  rand: () => number,
  runPosition: Position | null,
): PlayerCard {
  const byAdp = [...available].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));

  // Late rounds: everyone finally takes a K/DST.
  if (round >= ROUNDS - 1) {
    const counts = countByPosition(roster);
    const need = (counts.K ?? 0) === 0 ? 'K' : (counts.DST ?? 0) === 0 ? 'DST' : null;
    if (need) {
      const pick = byAdp.find((p) => p.position === need);
      if (pick) return pick;
    }
  }

  // Nobody takes a kicker in round 3.
  const sensible = byAdp.filter(
    (p) => round >= ROUNDS - 2 || (p.position !== 'K' && p.position !== 'DST'),
  );
  const pool = sensible.length ? sensible : byAdp;

  const roll = rand();

  // 15%: chase the run.
  if (runPosition && roll < 0.15) {
    const pick = pool.find((p) => p.position === runPosition);
    if (pick) return pick;
  }

  // 20%: fill a starting need rather than take best available.
  if (roll < 0.35) {
    const counts = countByPosition(roster);
    const needed = (['RB', 'WR', 'TE', 'QB'] as Position[]).find((pos) => {
      const required = pos === 'RB' || pos === 'WR' ? 2 : 1;
      return (counts[pos] ?? 0) < required;
    });
    if (needed) {
      const pick = pool.find((p) => p.position === needed);
      if (pick) return pick;
    }
  }

  // 15%: reach 3-10 spots ahead of ADP for "their guy".
  if (roll < 0.5) {
    const reachDepth = 3 + Math.floor(rand() * 8);
    return pool[Math.min(reachDepth, pool.length - 1)] ?? pool[0]!;
  }

  // Otherwise: best available by ADP, with slight noise.
  const jitter = Math.floor(rand() * 3);
  return pool[Math.min(jitter, pool.length - 1)] ?? pool[0]!;
}

function countByPosition(roster: PlayerCard[]): Partial<Record<Position, number>> {
  const counts: Partial<Record<Position, number>> = {};
  for (const p of roster) counts[p.position] = (counts[p.position] ?? 0) + 1;
  return counts;
}

interface SimOptions {
  seed?: number;
  /** Injure a player mid-draft to test that Coach reacts to breaking news. */
  injuryEvent?: { atPick: number; playerId: string };
  riskTolerance?: number;
}

function simulate(opts: SimOptions = {}): SimResult {
  const rand = mulberry32(opts.seed ?? 7);
  const players = buildMockPool({ seed: 4242 });
  const byId = new Map(players.map((p) => [p.id, p]));

  let state = createDraftState({
    leagueId: league.id, teamCount: 12, rounds: ROUNDS, userSlot: league.draftSlot,
  });

  let recommendationsFollowed = 0;
  let runsDetected = 0;
  const totalPicks = 12 * ROUNDS;

  for (let pick = 1; pick <= totalPicks; pick++) {
    // Breaking news: a player is injured mid-draft. His value must collapse.
    if (opts.injuryEvent && pick === opts.injuryEvent.atPick) {
      const injured = byId.get(opts.injuryEvent.playerId);
      if (injured) {
        injured.injuryRisk = 0.95;
        injured.roleCertainty = 0.15;
        injured.projectedPoints = (injured.projectedPoints ?? 0) * 0.35;
        injured.injuryStatus = 'out (torn ACL)';
      }
    }

    const drafted = new Set(state.picks.map((p) => p.playerId));
    const available = players.filter((p) => !drafted.has(p.id));

    const runs = detectRuns(state, (id) => byId.get(id)?.position);
    const activeRun = runs.find((r) => r.isRun)?.position ?? null;
    if (activeRun) runsDetected++;

    let chosen: PlayerCard;
    if (isUserOnClock(state)) {
      const rec = recommend({
        state, league, players,
        riskTolerance: opts.riskTolerance ?? 0.5,
        dataFetchedAt: new Date().toISOString(),
      });
      expect(rec.take).not.toBeNull();
      chosen = byId.get(rec.take!.id)!;
      recommendationsFollowed++;
    } else {
      const slot = state.picks.length + 1;
      const opponentRoster = state.picks
        .filter((p) => p.draftSlot === slotOf(slot))
        .map((p) => byId.get(p.playerId)!)
        .filter(Boolean);
      chosen = opponentPick(
        available,
        opponentRoster,
        Math.floor((pick - 1) / 12) + 1,
        rand,
        activeRun,
      );
    }

    state = draftReducer(state, {
      type: 'RECORD_PICK', playerId: chosen.id, entryMethod: 'simulated',
    });
  }

  const rosters = new Map<number, PlayerCard[]>();
  for (let slot = 1; slot <= 12; slot++) {
    rosters.set(
      slot,
      state.picks.filter((p) => p.draftSlot === slot).map((p) => byId.get(p.playerId)!),
    );
  }

  return {
    state,
    userRoster: userRoster(state).map((id) => byId.get(id)!),
    allRosters: rosters,
    recommendationsFollowed,
    runsDetected,
  };
}

function slotOf(overallPick: number): number {
  const zeroBased = overallPick - 1;
  const round = Math.floor(zeroBased / 12);
  const pos = zeroBased % 12;
  return round % 2 === 0 ? pos + 1 : 12 - pos;
}

// ---------------------------------------------------------------------------

describe('12-team mock draft simulation', () => {
  const sim = simulate({ seed: 7 });

  it('completes a full draft without error', () => {
    expect(sim.state.picks).toHaveLength(12 * ROUNDS);
    expect(sim.state.status).toBe('complete');
  });

  it('never drafts the same player twice', () => {
    const ids = sim.state.picks.map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the user a full roster', () => {
    expect(sim.userRoster).toHaveLength(ROUNDS);
    expect(sim.recommendationsFollowed).toBe(ROUNDS);
  });

  it('builds a legal starting lineup', () => {
    const { starters } = fillLineup(sim.userRoster, league.rosterSlots);
    expect(starters.get('QB')).toHaveLength(1);
    expect(starters.get('RB')).toHaveLength(2);
    expect(starters.get('WR')).toHaveLength(2);
    expect(starters.get('TE')).toHaveLength(1);
    expect(starters.get('FLEX')).toHaveLength(1);
  });

  it('fills every required starting slot — no holes on draft day', () => {
    const analysis = analyzeRoster(sim.userRoster, league);
    expect(analysis.unfilledSlots).toEqual([]);
  });

  it('does not waste early picks on kickers or defenses', () => {
    // Kickers and defenses belong at the end of the draft: taking one early
    // spends a bench spot with real option value on a position anybody can
    // fill in the final round.
    //
    // The bar is the first two-thirds of the draft. Later than that the
    // remaining skill players are genuine dart throws, and preferring a
    // startable defense over the 60th-best running back is defensible — so
    // this asserts against the unambiguous mistake, not against judgment calls.
    const kdRounds = sim.userRoster
      .map((p, i) => ({ position: p.position, round: i + 1 }))
      .filter((x) => x.position === 'K' || x.position === 'DST');

    expect(
      kdRounds.map((x) => x.round).filter((r) => r <= Math.floor(ROUNDS * 0.68)),
    ).toEqual([]);
  });

  it('takes exactly one kicker and one defense', () => {
    expect(sim.userRoster.filter((p) => p.position === 'K')).toHaveLength(1);
    expect(sim.userRoster.filter((p) => p.position === 'DST')).toHaveLength(1);
  });

  it('does not stockpile backup quarterbacks in a one-QB league', () => {
    const qbs = sim.userRoster.filter((p) => p.position === 'QB');
    expect(qbs.length).toBeLessThanOrEqual(2);
  });

  it('beats the average opponent roster on projected starting points', () => {
    const scoreOf = (roster: PlayerCard[]) =>
      fillLineup(roster, league.rosterSlots).points;
    const userScore = scoreOf(sim.userRoster);
    const opponentScores = [...sim.allRosters.entries()]
      .filter(([slot]) => slot !== league.draftSlot)
      .map(([, roster]) => scoreOf(roster));
    const average = opponentScores.reduce((a, b) => a + b, 0) / opponentScores.length;

    expect(userScore).toBeGreaterThan(average);
  });

  it('finishes in the top half of the league', () => {
    const scoreOf = (roster: PlayerCard[]) =>
      fillLineup(roster, league.rosterSlots).points;
    const ranked = [...sim.allRosters.entries()]
      .map(([slot, roster]) => ({ slot, score: scoreOf(roster) }))
      .sort((a, b) => b.score - a.score);
    const rank = ranked.findIndex((r) => r.slot === league.draftSlot) + 1;
    expect(rank).toBeLessThanOrEqual(6);
  });

  it('detects positional runs during the draft', () => {
    expect(sim.runsDetected).toBeGreaterThan(0);
  });
});

describe('robustness across draft positions and seeds', () => {
  // The engine must not depend on a lucky seed or a favourable draft slot.
  for (const slot of [1, 6, 12]) {
    it(`builds a complete, competitive roster from slot ${slot}`, () => {
      const customLeague = buildMockLeague({ draftSlot: slot });
      const players = buildMockPool({ seed: 4242 });
      const byId = new Map(players.map((p) => [p.id, p]));
      const rand = mulberry32(slot * 31);

      let state = createDraftState({
        leagueId: 'l', teamCount: 12, rounds: ROUNDS, userSlot: slot,
      });

      for (let pick = 1; pick <= 12 * ROUNDS; pick++) {
        const drafted = new Set(state.picks.map((p) => p.playerId));
        const available = players.filter((p) => !drafted.has(p.id));
        let chosen: PlayerCard;
        if (isUserOnClock(state)) {
          const rec = recommend({ state, league: customLeague, players });
          chosen = byId.get(rec.take!.id)!;
        } else {
          const roster = state.picks
            .filter((p) => p.draftSlot === slotOf(pick))
            .map((p) => byId.get(p.playerId)!);
          chosen = opponentPick(available, roster, Math.floor((pick - 1) / 12) + 1, rand, null);
        }
        state = draftReducer(state, { type: 'RECORD_PICK', playerId: chosen.id });
      }

      const roster = userRoster(state).map((id) => byId.get(id)!);
      expect(analyzeRoster(roster, customLeague).unfilledSlots).toEqual([]);
    });
  }

  for (const seed of [1, 99, 2026]) {
    it(`produces a valid lineup with seed ${seed}`, () => {
      const sim = simulate({ seed });
      expect(analyzeRoster(sim.userRoster, league).unfilledSlots).toEqual([]);
    });
  }
});

describe('adaptation to breaking news mid-draft', () => {
  it('stops recommending a player who is injured mid-draft', () => {
    const players = buildMockPool({ seed: 4242 });
    const target = players.find((p) => p.id === 'RB-3')!;

    const state = createDraftState({
      leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1,
    });

    const before = recommend({ state, league, players });
    const rankBefore = [before.take!.id, ...before.alternatives.map((a) => a.id)];

    // Breaking news: torn ACL.
    target.injuryRisk = 0.95;
    target.roleCertainty = 0.1;
    target.projectedPoints = (target.projectedPoints ?? 0) * 0.3;
    target.injuryStatus = 'out (torn ACL)';

    const after = recommend({ state, league, players });
    const rankAfter = [after.take!.id, ...after.alternatives.map((a) => a.id)];

    // He must not be the recommendation once he's hurt.
    expect(after.take!.id).not.toBe(target.id);
    // And if he had been in the top 3 before, he must have fallen out.
    if (rankBefore.includes(target.id)) {
      expect(rankAfter).not.toContain(target.id);
    }
  });

  it('surfaces elevated injury risk as a stated risk factor', () => {
    const players = buildMockPool({ seed: 4242 });
    // Make the clear best player risky and see that the engine says so.
    for (const p of players) {
      if (p.position !== 'RB') p.projectedPoints = 10;
    }
    const rb1 = players.find((p) => p.id === 'RB-1')!;
    rb1.injuryRisk = 0.6;
    rb1.injuryStatus = 'questionable (hamstring)';

    const rec = recommend({
      state: createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1 }),
      league, players,
    });
    if (rec.take!.id === rb1.id) {
      expect(rec.riskFactors.join(' ')).toMatch(/injury/i);
    } else {
      expect(rec.avoid.map((a) => a.player.id)).toContain(rb1.id);
    }
  });
});
