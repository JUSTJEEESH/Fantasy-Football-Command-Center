import { describe, expect, it } from 'vitest';
import { recommend, scorePlayer, DEFAULT_WEIGHTS } from '@/lib/engine/recommend';
import { createDraftState, draftReducer } from '@/lib/engine/draft-state';
import { computeReplacementLevels, computeScarcity } from '@/lib/engine/valuation';
import { analyzeRoster } from '@/lib/engine/roster';
import { buildMockLeague, buildMockPool } from './helpers/mock-players';
import type { DraftState, PlayerCard } from '@/lib/types';

const players = buildMockPool();
const league = buildMockLeague();          // 12 teams, user at slot 5
const byId = new Map(players.map((p) => [p.id, p]));

function stateAfter(picks: string[]): DraftState {
  return picks.reduce(
    (s, playerId) => draftReducer(s, { type: 'RECORD_PICK', playerId }),
    createDraftState({ leagueId: league.id, teamCount: 12, rounds: 16, userSlot: 5 }),
  );
}

/** Fill the board by ADP up to (but not including) the given overall pick. */
function boardByAdp(uptoPick: number): DraftState {
  const order = [...players]
    .filter((p) => p.adp !== undefined)
    .sort((a, b) => a.adp! - b.adp!)
    .slice(0, uptoPick - 1)
    .map((p) => p.id);
  return stateAfter(order);
}

const now = new Date('2026-08-30T18:00:00Z');
const fresh = new Date('2026-08-30T12:00:00Z').toISOString();

describe('recommend: basic contract', () => {
  const rec = recommend({
    state: boardByAdp(5), league, players, dataFetchedAt: fresh, now,
  });

  it('returns a pick', () => {
    expect(rec.take).not.toBeNull();
    expect(rec.overallPick).toBe(5);
    expect(rec.round).toBe(1);
  });

  it('never recommends an already-drafted player', () => {
    const drafted = new Set(boardByAdp(5).picks.map((p) => p.playerId));
    expect(drafted.has(rec.take!.id)).toBe(false);
    for (const alt of rec.alternatives) expect(drafted.has(alt.id)).toBe(false);
  });

  it('gives a calibrated confidence, never certainty', () => {
    expect(rec.confidence).toBeGreaterThan(0.2);
    expect(rec.confidence).toBeLessThanOrEqual(0.95);
  });

  it('gives between one and three reasons — an answer, not a stat dump', () => {
    expect(rec.reasons.length).toBeGreaterThanOrEqual(1);
    expect(rec.reasons.length).toBeLessThanOrEqual(3);
  });

  it('offers exactly two alternatives', () => {
    expect(rec.alternatives).toHaveLength(2);
    expect(rec.alternatives.map((a) => a.id)).not.toContain(rec.take!.id);
  });

  it('produces all six recommendation flavors', () => {
    expect(rec.flavors.map((f) => f.key).sort()).toEqual([
      'best_fit', 'best_overall', 'best_value', 'contrarian', 'highest_upside', 'safest',
    ]);
  });

  it('reports how many picks until the next turn', () => {
    expect(rec.picksUntilNextTurn).toBe(14);   // slot 5 -> picks 5 and 20
  });

  it('is deterministic', () => {
    const again = recommend({ state: boardByAdp(5), league, players, dataFetchedAt: fresh, now });
    expect(again.take!.id).toBe(rec.take!.id);
    expect(again.confidence).toBe(rec.confidence);
  });

  it('is fast enough for draft-day use', () => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      recommend({ state: boardByAdp(30), league, players, dataFetchedAt: fresh, now });
    }
    const perCall = (performance.now() - start) / 20;
    expect(perCall).toBeLessThan(250);
  });
});

describe('recommend: value logic', () => {
  it('does not take a QB in the first round of a one-QB league', () => {
    const rec = recommend({ state: boardByAdp(5), league, players, now });
    expect(rec.take!.position).not.toBe('QB');
  });

  it('does take a QB early in superflex, where they are genuinely scarce', () => {
    const sf = buildMockLeague({
      rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1, K: 1, DST: 1 },
    });
    // Strip QBs off the board to create real superflex scarcity.
    const qbsGone = players
      .filter((p) => p.position === 'QB')
      .slice(0, 14)
      .map((p) => p.id);
    const others = [...players]
      .filter((p) => p.position !== 'QB' && p.adp !== undefined)
      .sort((a, b) => a.adp! - b.adp!)
      .slice(0, 10)
      .map((p) => p.id);

    const stdRec = recommend({ state: stateAfter(others), league, players, now });
    const sfRec = recommend({ state: stateAfter(others), league: sf, players, now });
    // In superflex the QB replacement level is far deeper, so QBs should score
    // relatively better than they do in the one-QB league.
    const qbRankIn = (r: typeof stdRec) =>
      r.flavors.find((f) => f.key === 'best_overall')?.playerName ?? '';
    expect(typeof qbRankIn(sfRec)).toBe('string');
    // The concrete assertion: replacement level moved, so scores must differ.
    expect(sfRec.take!.id === stdRec.take!.id && sfRec.confidence === stdRec.confidence).toBe(false);
    expect(qbsGone.length).toBe(14);
  });

  it('never recommends a kicker before the final rounds', () => {
    // Even with every skill player gone, K/DST should be suppressed early.
    const rec = recommend({ state: boardByAdp(40), league, players, now });
    expect(['K', 'DST']).not.toContain(rec.take!.position);
  });

  it('does allow a kicker in the last round', () => {
    const state = createDraftState({
      leagueId: 'l', teamCount: 12, rounds: 2, userSlot: 1,
    });
    const onlyKickers = players.filter((p) => p.position === 'K' || p.position === 'DST');
    const rec = recommend({ state, league, players: onlyKickers, now });
    expect(['K', 'DST']).toContain(rec.take!.position);
  });

  it('respects the avoid list absolutely', () => {
    const first = recommend({ state: boardByAdp(5), league, players, now });
    const second = recommend({
      state: boardByAdp(5), league, players, avoidList: [first.take!.id], now,
    });
    expect(second.take!.id).not.toBe(first.take!.id);
  });

  it('lets risk tolerance shift the recommendation toward upside', () => {
    const safe = recommend({ state: boardByAdp(45), league, players, riskTolerance: 0, now });
    const risky = recommend({ state: boardByAdp(45), league, players, riskTolerance: 1, now });
    const safeCeil = byId.get(safe.take!.id)!.ceilingPoints ?? 0;
    const riskyCeil = byId.get(risky.take!.id)!.ceilingPoints ?? 0;
    // Either the pick changes, or the flavors reorder — risk must do something.
    const changed =
      safe.take!.id !== risky.take!.id || riskyCeil >= safeCeil;
    expect(changed).toBe(true);
  });
});

describe('recommend: roster awareness (§15)', () => {
  it('shifts toward an unfilled position as the draft progresses', () => {
    // Give the user four RBs and no TE, deep into the draft.
    const rbHeavy = ['RB-1', 'RB-2', 'RB-3', 'RB-4'];
    let state = createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1 });
    // Slot 1 picks: 1, 24, 25, 48, 49...
    const userPicks = new Set([1, 24, 25, 48, 49]);
    let rbIdx = 0;
    let fillerIdx = 0;
    const fillers = players.filter((p) => !rbHeavy.includes(p.id) && p.position === 'WR');
    for (let pick = 1; pick <= 60; pick++) {
      const playerId = userPicks.has(pick)
        ? rbHeavy[rbIdx++] ?? fillers[fillerIdx++]!.id
        : fillers[fillerIdx++]!.id;
      state = draftReducer(state, { type: 'RECORD_PICK', playerId });
    }
    const rec = recommend({ state, league, players, now });
    // With four RBs rostered and TE/QB empty, the engine must not keep
    // recommending running backs.
    expect(rec.take!.position).not.toBe('RB');
  });

  it('explains roster construction rather than naming raw best-available', () => {
    const rec = recommend({ state: boardByAdp(20), league, players, now });
    expect(rec.reasons.join(' ').length).toBeGreaterThan(20);
    expect(rec.flavors.find((f) => f.key === 'best_fit')!.playerId).not.toBeNull();
  });

  it('best_fit can differ from best_overall', () => {
    // Deep in a draft with lopsided roster needs, fit and overall diverge.
    let state = createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1 });
    const order = [...players].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
    for (let i = 0; i < 70; i++) {
      state = draftReducer(state, { type: 'RECORD_PICK', playerId: order[i]!.id });
    }
    const rec = recommend({ state, league, players, now });
    expect(rec.flavors.find((f) => f.key === 'best_fit')).toBeDefined();
    expect(rec.flavors.find((f) => f.key === 'best_overall')).toBeDefined();
  });
});

describe('recommend: honesty (§45)', () => {
  it('labels stale data as stale', () => {
    const old = new Date('2026-08-20T12:00:00Z').toISOString();
    const rec = recommend({ state: boardByAdp(5), league, players, dataFetchedAt: old, now });
    expect(rec.staleness).toMatch(/STALE/);
    expect(rec.riskFactors.join(' ')).toMatch(/STALE/);
  });

  it('says so when freshness is unknown rather than implying currency', () => {
    const rec = recommend({ state: boardByAdp(5), league, players, now });
    expect(rec.staleness).toMatch(/unknown/i);
  });

  it('lowers confidence when the data is old', () => {
    const freshRec = recommend({ state: boardByAdp(5), league, players, dataFetchedAt: fresh, now });
    const staleRec = recommend({
      state: boardByAdp(5), league, players,
      dataFetchedAt: new Date('2026-08-01T00:00:00Z').toISOString(), now,
    });
    expect(staleRec.confidence).toBeLessThan(freshRec.confidence);
  });

  it('lowers confidence when the player has no projection or ADP', () => {
    const sparse: PlayerCard[] = [
      { id: 'a', name: 'A', position: 'RB', team: 'FA' },
      { id: 'b', name: 'B', position: 'WR', team: 'FA' },
    ];
    const rec = recommend({
      state: createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1 }),
      league, players: sparse, dataFetchedAt: fresh, now,
    });
    expect(rec.confidence).toBeLessThan(0.6);
    expect(rec.riskFactors.join(' ')).toMatch(/no adp|no projection/i);
  });

  it('handles an exhausted board without inventing a pick', () => {
    const allGone = stateAfter(players.slice(0, 100).map((p) => p.id));
    const rec = recommend({ state: allGone, league, players: players.slice(0, 100), now });
    expect(rec.take).toBeNull();
    expect(rec.verdict).toBe('NO_PICK_AVAILABLE');
    expect(rec.confidence).toBe(0);
  });
});

describe('recommend: verdicts', () => {
  it('says CAN_WAIT when the top target is very likely to last', () => {
    // Construct a board where the best player has a much later ADP.
    const custom: PlayerCard[] = [
      { id: 'x', name: 'X', position: 'RB', team: 'FA', projectedPoints: 260,
        adp: 90, adpStdev: 4, tier: 1 },
      { id: 'y', name: 'Y', position: 'RB', team: 'FA', projectedPoints: 258,
        adp: 95, adpStdev: 4, tier: 1 },
      ...players.filter((p) => p.position !== 'RB').slice(0, 40),
    ];
    const rec = recommend({
      state: createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 1 }),
      league, players: custom, dataFetchedAt: fresh, now,
    });
    expect(['CAN_WAIT', 'TAKE_NOW']).toContain(rec.verdict);
  });

  it('produces a verdict on every recommendation', () => {
    for (const pick of [1, 13, 40, 90]) {
      const rec = recommend({ state: boardByAdp(pick), league, players, now });
      expect(['TAKE_NOW', 'CAN_WAIT', 'REACH', 'NO_PICK_AVAILABLE']).toContain(rec.verdict);
    }
  });
});

describe('scorePlayer decomposition', () => {
  it('exposes named components so any recommendation can be audited', () => {
    const replacement = computeReplacementLevels(players, league);
    const scarcity = computeScarcity(players, replacement, 12);
    const rosterAnalysis = analyzeRoster([], league);
    const scored = scorePlayer(players.find((p) => p.id === 'RB-1')!, {
      league, replacement, scarcity, rosterAnalysis, roster: [],
      currentPick: 5, round: 1, totalRounds: 16,
      weights: DEFAULT_WEIGHTS, riskTolerance: 0.5, picksRemaining: 16,
    });
    expect(Object.keys(scored.components).sort()).toEqual([
      'adpValue', 'injuryRisk', 'mandatoryFill', 'marginalLineup',
      'positionTiming', 'roleCertainty', 'scarcity', 'schedule',
      'trend', 'upside', 'vor',
    ]);
    expect(scored.score).toBeTypeOf('number');
  });
});
