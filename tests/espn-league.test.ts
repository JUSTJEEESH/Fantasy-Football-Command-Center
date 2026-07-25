import { describe, expect, it } from 'vitest';
import {
  parseLeaguePayload,
  planSync,
  slotOfTeam,
} from '@/lib/sources/espn-league';
import { createDraftState, draftReducer } from '@/lib/engine/draft-state';
import type { DraftState, PlayerCard } from '@/lib/types';

// ============================================================================
// This code runs DURING the live draft, applying picks to the user's board as
// other managers make them. A wrong action here corrupts the one artifact the
// whole evening depends on, so the tests lean on the refusals: never guess an
// unmatched player, never rewrite recorded history, never draft ESPN's
// placeholder ghosts.
// ============================================================================

/** A plausible mDraftDetail/mSettings/mTeam payload. */
function leaguePayload(opts: {
  picks?: Array<{ overallPickNumber: number; playerId: number; teamId: number }>;
  pickOrder?: number[];
  inProgress?: boolean;
  drafted?: boolean;
}) {
  return {
    id: 1234567,
    seasonId: 2026,
    settings: {
      name: 'Bay Islands Fantasy',
      draftSettings: { pickOrder: opts.pickOrder ?? [4, 7, 1, 9, 2, 11, 3, 8, 5, 12, 6, 10] },
    },
    status: { teamsJoined: 12 },
    teams: [
      { id: 1, location: 'Team', nickname: 'One', abbrev: 'ONE' },
      { id: 4, name: 'The Commish', abbrev: 'CMSH' },
      { id: 7, location: '', nickname: '', abbrev: 'SVN' },
    ],
    draftDetail: {
      drafted: opts.drafted ?? false,
      inProgress: opts.inProgress ?? true,
      picks: opts.picks ?? [],
    },
  };
}

const PLAYERS: PlayerCard[] = [
  { id: 'RB-gibbs', name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', espnId: 4429795 },
  { id: 'RB-bijan', name: 'Bijan Robinson', position: 'RB', team: 'ATL', espnId: 4430807 },
  { id: 'WR-nacua', name: 'Puka Nacua', position: 'WR', team: 'LAR', espnId: 4426515 },
  // Manually-imported player the pack never got an ESPN id for.
  { id: 'WR-csv', name: 'Csv Import Guy', position: 'WR', team: 'CHI' },
];

function stateWithPicks(playerIds: string[]): DraftState {
  let state = createDraftState({
    leagueId: 'bay-islands',
    teamCount: 12,
    rounds: 15,
    userSlot: 3,
  });
  for (const id of playerIds) {
    state = draftReducer(state, { type: 'RECORD_PICK', playerId: id, entryMethod: 'manual' });
  }
  return state;
}

describe('parsing an ESPN league payload', () => {
  it('extracts the draft order as slots', () => {
    const snapshot = parseLeaguePayload(leaguePayload({}));
    expect(snapshot.draftOrder).toEqual([4, 7, 1, 9, 2, 11, 3, 8, 5, 12, 6, 10]);
    // Team 4 drafts first, team 7 second.
    expect(slotOfTeam(snapshot, 4)).toBe(1);
    expect(slotOfTeam(snapshot, 7)).toBe(2);
    expect(slotOfTeam(snapshot, 999)).toBeNull();
  });

  it('treats an unpublished draft order as null, not as an empty order', () => {
    const snapshot = parseLeaguePayload(leaguePayload({ pickOrder: [] }));
    expect(snapshot.draftOrder).toBeNull();
    expect(slotOfTeam(snapshot, 4)).toBeNull();
  });

  it('assembles team names from whichever fields ESPN filled in', () => {
    const snapshot = parseLeaguePayload(leaguePayload({}));
    const names = new Map(snapshot.teams.map((t) => [t.id, t.name]));
    expect(names.get(4)).toBe('The Commish');
    expect(names.get(1)).toBe('Team One');
    expect(names.get(7)).toBe('SVN');          // nothing but an abbrev
  });

  it('refuses to treat placeholder picks as selections', () => {
    // ESPN pre-fills the whole board with playerId 0 before anyone picks.
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 1, playerId: 4429795, teamId: 4 },
          { overallPickNumber: 2, playerId: 0, teamId: 7 },
          { overallPickNumber: 3, playerId: 0, teamId: 1 },
        ],
      }),
    );
    expect(snapshot.picks).toHaveLength(1);
  });

  it('orders picks by overall pick regardless of payload order', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 2, playerId: 4430807, teamId: 7 },
          { overallPickNumber: 1, playerId: 4429795, teamId: 4 },
        ],
      }),
    );
    expect(snapshot.picks.map((p) => p.overallPick)).toEqual([1, 2]);
  });
});

describe('planning a sync', () => {
  it('produces the actions that catch the board up', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 1, playerId: 4429795, teamId: 4 },
          { overallPickNumber: 2, playerId: 4430807, teamId: 7 },
        ],
      }),
    );
    const plan = planSync(stateWithPicks([]), snapshot, PLAYERS);
    expect(plan.status).toBe('apply');
    if (plan.status === 'apply') {
      expect(plan.actions.map((a) => (a.type === 'RECORD_PICK' ? a.playerId : ''))).toEqual([
        'RB-gibbs',
        'RB-bijan',
      ]);
    }
  });

  it('reports in-sync when there is nothing to do', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({ picks: [{ overallPickNumber: 1, playerId: 4429795, teamId: 4 }] }),
    );
    expect(planSync(stateWithPicks(['RB-gibbs']), snapshot, PLAYERS).status).toBe('in-sync');
  });

  it('halts at a pick whose player is not on the board, applying nothing past it', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 1, playerId: 4429795, teamId: 4 },
          { overallPickNumber: 2, playerId: 999999, teamId: 7 },   // unknown
          { overallPickNumber: 3, playerId: 4426515, teamId: 1 },
        ],
      }),
    );
    const plan = planSync(stateWithPicks([]), snapshot, PLAYERS);
    expect(plan.status).toBe('unmatched');
    if (plan.status === 'unmatched') {
      // Gibbs, before the unknown pick, still applies. Nacua, after it, must
      // NOT — recording him at the wrong overall pick corrupts the snake math.
      expect(plan.actions).toHaveLength(1);
      expect(plan.overallPick).toBe(2);
      expect(plan.espnPlayerId).toBe(999999);
    }
  });

  it('refuses to rewrite recorded history on a disagreement', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({ picks: [{ overallPickNumber: 1, playerId: 4430807, teamId: 4 }] }),
    );
    // Our board says pick 1 was Gibbs; ESPN says Bijan.
    const plan = planSync(stateWithPicks(['RB-gibbs']), snapshot, PLAYERS);
    expect(plan.status).toBe('conflict');
    if (plan.status === 'conflict') {
      expect(plan.overallPick).toBe(1);
      expect(plan.detail).toMatch(/Jahmyr Gibbs/);
      expect(plan.detail).toMatch(/Bijan Robinson/);
      expect(plan.actions).toHaveLength(0);
    }
  });

  it('trusts a manually-recorded player who has no ESPN id', () => {
    // Typed by the person in the room; positional trust beats an id we never had.
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 1, playerId: 555, teamId: 4 },      // their id for CSV guy
          { overallPickNumber: 2, playerId: 4430807, teamId: 7 },
        ],
      }),
    );
    const plan = planSync(stateWithPicks(['WR-csv']), snapshot, PLAYERS);
    expect(plan.status).toBe('apply');
    if (plan.status === 'apply') expect(plan.count).toBe(1);
  });

  it('applied picks survive the reducer round-trip', () => {
    const snapshot = parseLeaguePayload(
      leaguePayload({
        picks: [
          { overallPickNumber: 1, playerId: 4429795, teamId: 4 },
          { overallPickNumber: 2, playerId: 4430807, teamId: 7 },
          { overallPickNumber: 3, playerId: 4426515, teamId: 1 },
        ],
      }),
    );
    const plan = planSync(stateWithPicks([]), snapshot, PLAYERS);
    expect(plan.status).toBe('apply');
    let state = stateWithPicks([]);
    for (const action of plan.actions) state = draftReducer(state, action);
    expect(state.picks).toHaveLength(3);
    // And a re-plan against the same snapshot is now a no-op.
    expect(planSync(state, snapshot, PLAYERS).status).toBe('in-sync');
  });
});
