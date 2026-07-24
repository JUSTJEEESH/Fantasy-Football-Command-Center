import { describe, expect, it } from 'vitest';
import {
  DraftError,
  allRosters,
  createDraftState,
  currentOverallPick,
  detectRuns,
  draftReducer,
  draftedPlayerIds,
  isUserOnClock,
  picksForSlot,
  picksUntilNextTurn,
  pickInRound,
  roundForOverallPick,
  slotForOverallPick,
  userNextPick,
  userRoster,
} from '@/lib/engine/draft-state';
import type { DraftState, Position } from '@/lib/types';

const base = () =>
  createDraftState({ leagueId: 'l1', teamCount: 12, rounds: 16, userSlot: 5 });

function record(state: DraftState, ...playerIds: string[]): DraftState {
  return playerIds.reduce(
    (s, playerId) => draftReducer(s, { type: 'RECORD_PICK', playerId }),
    state,
  );
}

describe('snake draft math', () => {
  it('runs round 1 forward', () => {
    expect(slotForOverallPick(1, 12)).toBe(1);
    expect(slotForOverallPick(5, 12)).toBe(5);
    expect(slotForOverallPick(12, 12)).toBe(12);
  });

  it('reverses round 2', () => {
    expect(slotForOverallPick(13, 12)).toBe(12);
    expect(slotForOverallPick(24, 12)).toBe(1);
  });

  it('runs round 3 forward again', () => {
    expect(slotForOverallPick(25, 12)).toBe(1);
    expect(slotForOverallPick(36, 12)).toBe(12);
  });

  it('does not reverse in a linear draft', () => {
    expect(slotForOverallPick(13, 12, 'linear')).toBe(1);
    expect(slotForOverallPick(24, 12, 'linear')).toBe(12);
  });

  it('computes round and pick-in-round', () => {
    expect(roundForOverallPick(1, 12)).toBe(1);
    expect(roundForOverallPick(12, 12)).toBe(1);
    expect(roundForOverallPick(13, 12)).toBe(2);
    expect(pickInRound(13, 12)).toBe(1);
    expect(pickInRound(24, 12)).toBe(12);
  });

  it('lists every pick belonging to a slot, snaking correctly', () => {
    // Slot 5 in a 12-team snake: 5, 20, 29, 44, ...
    expect(picksForSlot(5, 12, 4)).toEqual([5, 20, 29, 44]);
    // Turn slot: back-to-back picks at the wheel.
    expect(picksForSlot(12, 12, 3)).toEqual([12, 13, 36]);
    expect(picksForSlot(1, 12, 3)).toEqual([1, 24, 25]);
  });

  it('assigns every pick in a full draft exactly once', () => {
    const teamCount = 12;
    const rounds = 16;
    const all = new Set<number>();
    for (let slot = 1; slot <= teamCount; slot++) {
      for (const pick of picksForSlot(slot, teamCount, rounds)) {
        expect(all.has(pick)).toBe(false);
        all.add(pick);
      }
    }
    expect(all.size).toBe(teamCount * rounds);
  });

  it('rejects a draft slot outside the league', () => {
    expect(() =>
      createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 13 }),
    ).toThrow();
  });
});

describe('picks until next turn', () => {
  it('counts the gap between the wheel picks for a middle slot', () => {
    let state = base();                       // user at slot 5, picks 5 and 20
    state = record(state, ...ids(4));         // picks 1-4 gone, user on the clock
    expect(isUserOnClock(state)).toBe(true);
    expect(picksUntilNextTurn(state)).toBe(14); // picks 6..19
  });

  it('counts down to the next turn when not on the clock', () => {
    let state = base();
    state = record(state, ...ids(2));         // pick 3 is up, user picks at 5
    expect(isUserOnClock(state)).toBe(false);
    expect(picksUntilNextTurn(state)).toBe(2);
  });

  it('reports a one-pick gap at the turn', () => {
    let state = createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 12 });
    state = record(state, ...ids(11));        // pick 12 = user, next is 13
    expect(picksUntilNextTurn(state)).toBe(0);
  });

  it('returns null once the user has no picks left', () => {
    let state = createDraftState({ leagueId: 'l', teamCount: 4, rounds: 2, userSlot: 1 });
    state = record(state, ...ids(8));         // full draft
    expect(userNextPick(state)).toBeNull();
    expect(picksUntilNextTurn(state)).toBeNull();
  });
});

describe('reducer: record, undo, correct', () => {
  it('records a pick with correct round and slot', () => {
    const state = record(base(), 'p1');
    expect(state.picks).toHaveLength(1);
    expect(state.picks[0]).toMatchObject({
      overallPick: 1, round: 1, pickInRound: 1, draftSlot: 1, playerId: 'p1',
    });
    expect(state.status).toBe('active');
  });

  it('advances the clock', () => {
    const state = record(base(), 'a', 'b', 'c');
    expect(currentOverallPick(state)).toBe(4);
  });

  it('refuses to draft the same player twice', () => {
    const state = record(base(), 'p1');
    expect(() => draftReducer(state, { type: 'RECORD_PICK', playerId: 'p1' })).toThrow(
      DraftError,
    );
  });

  it('undoes the last pick', () => {
    const state = record(base(), 'a', 'b');
    const undone = draftReducer(state, { type: 'UNDO_LAST' });
    expect(undone.picks.map((p) => p.playerId)).toEqual(['a']);
    expect(currentOverallPick(undone)).toBe(2);
  });

  it('frees the player again after an undo', () => {
    let state = record(base(), 'a');
    state = draftReducer(state, { type: 'UNDO_LAST' });
    expect(draftedPlayerIds(state).has('a')).toBe(false);
    expect(() => draftReducer(state, { type: 'RECORD_PICK', playerId: 'a' })).not.toThrow();
  });

  it('is a no-op undoing an empty board', () => {
    expect(draftReducer(base(), { type: 'UNDO_LAST' }).picks).toHaveLength(0);
  });

  it('corrects a mis-entered pick in place', () => {
    let state = record(base(), 'a', 'b', 'c');
    state = draftReducer(state, { type: 'CORRECT_PICK', overallPick: 2, playerId: 'z' });
    expect(state.picks.map((p) => p.playerId)).toEqual(['a', 'z', 'c']);
    expect(state.picks[1]!.overallPick).toBe(2);   // ordering preserved
  });

  it('refuses a correction that duplicates another pick', () => {
    const state = record(base(), 'a', 'b');
    expect(() =>
      draftReducer(state, { type: 'CORRECT_PICK', overallPick: 1, playerId: 'b' }),
    ).toThrow(DraftError);
  });

  it('refuses a correction to a pick that has not happened', () => {
    const state = record(base(), 'a');
    expect(() =>
      draftReducer(state, { type: 'CORRECT_PICK', overallPick: 7, playerId: 'z' }),
    ).toThrow(DraftError);
  });

  it('supports reassigning a pick to a different team', () => {
    let state = record(base(), 'a');
    state = draftReducer(state, {
      type: 'CORRECT_PICK', overallPick: 1, playerId: 'a', draftSlot: 4,
    });
    expect(state.picks[0]!.draftSlot).toBe(4);
  });

  it('marks the draft complete on the final pick', () => {
    let state = createDraftState({ leagueId: 'l', teamCount: 2, rounds: 2, userSlot: 1 });
    state = record(state, 'a', 'b', 'c', 'd');
    expect(state.status).toBe('complete');
  });

  it('resets the board', () => {
    const state = draftReducer(record(base(), 'a', 'b'), { type: 'RESET' });
    expect(state.picks).toHaveLength(0);
    expect(state.status).toBe('pending');
  });

  it('never mutates the previous state', () => {
    const before = record(base(), 'a');
    const snapshot = JSON.stringify(before);
    draftReducer(before, { type: 'RECORD_PICK', playerId: 'b' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('roster views', () => {
  it('routes picks to the right teams through the snake', () => {
    let state = base();
    state = record(state, ...ids(24));     // two full rounds
    const rosters = allRosters(state);
    expect(rosters.get(1)).toEqual(['p1', 'p24']);   // slot 1 picks 1 and 24
    expect(rosters.get(12)).toEqual(['p12', 'p13']); // the turn
    expect(userRoster(state)).toEqual(['p5', 'p20']);
  });
});

describe('positional run detection', () => {
  const positions: Record<string, Position> = {};
  const posOf = (id: string) => positions[id];

  function boardWith(sequence: readonly Position[]): DraftState {
    let state = createDraftState({ leagueId: 'l', teamCount: 12, rounds: 16, userSlot: 5 });
    sequence.forEach((pos, i) => {
      const id = `x${i}`;
      positions[id] = pos;
      state = draftReducer(state, { type: 'RECORD_PICK', playerId: id });
    });
    return state;
  }

  it('flags a genuine run', () => {
    // A quiet opening, then 6 RBs inside the last 10 picks — far above the
    // ~34% baseline share for the position.
    const state = boardWith([
      'WR', 'WR', 'TE', 'QB',
      'RB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'TE', 'QB',
    ]);
    const rb = detectRuns(state, posOf, { windowSize: 10 }).find(
      (r) => r.position === 'RB',
    );
    expect(rb?.countInWindow).toBe(6);
    expect(rb?.isRun).toBe(true);
  });

  it('does not flag a normal distribution of picks as a run', () => {
    const state = boardWith(['RB','WR','WR','RB','TE','WR','QB','RB','WR','RB'] as Position[]);
    const runs = detectRuns(state, posOf, { windowSize: 10 });
    expect(runs.every((r) => !r.isRun)).toBe(true);
  });

  it('flags a QB run, which is rarer and so needs fewer picks', () => {
    const state = boardWith(['WR','RB','QB','QB','QB','WR','RB','WR','RB','WR'] as Position[]);
    const runs = detectRuns(state, posOf, { windowSize: 10 });
    expect(runs.find((r) => r.position === 'QB')?.isRun).toBe(true);
  });

  it('returns nothing on an empty board', () => {
    expect(detectRuns(base(), posOf)).toEqual([]);
  });

  it('sorts runs by intensity', () => {
    const state = boardWith(['QB','QB','QB','RB','RB','WR','WR','WR','TE','RB'] as Position[]);
    const runs = detectRuns(state, posOf, { windowSize: 10 });
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i - 1]!.intensity).toBeGreaterThanOrEqual(runs[i]!.intensity);
    }
  });
});

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i + 1}`);
}
