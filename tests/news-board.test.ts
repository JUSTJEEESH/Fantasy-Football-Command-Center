import { describe, expect, it } from 'vitest';
import {
  EMPTY_BOARD,
  buildBoardIndex,
  concernsMyBoard,
  draftRelevant,
  withBoardContext,
} from '@/lib/news-board';
import { buildDraftPack } from '@/lib/draft-pack';
import { BAY_ISLANDS } from '@/lib/leagues/bay-islands';
import type { NewsEventView } from '@/lib/static-data';
import type { DraftState, PlayerCard } from '@/lib/types';

// ============================================================================
// The news feed's "My board" filter used to test `players.length > 0` — "was
// this linked to anybody at all" — while being labelled as though it filtered
// to your team. It matched nearly every story and told you nothing.
//
// These tests pin the honest version: your board means players you could still
// end up with, plus the ones you already own.
// ============================================================================

const players: PlayerCard[] = [
  { id: 'rb1', name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', adp: 1.7, tier: 1 },
  { id: 'wr1', name: 'Puka Nacua', position: 'WR', team: 'LAR', adp: 3.7, tier: 1 },
  { id: 'qb1', name: 'Patrick Mahomes', position: 'QB', team: 'KC', adp: 24, tier: 2 },
  { id: 'rb2', name: 'Deep Sleeper', position: 'RB', team: 'CHI', adp: 190, tier: 9 },
];

const pack = buildDraftPack({ league: BAY_ISLANDS, players });

function state(picks: Array<{ playerId: string; draftSlot: number }>): DraftState {
  return {
    leagueId: BAY_ISLANDS.id,
    teamCount: 12,
    rounds: 15,
    draftType: 'snake',
    userSlot: 3,
    status: 'active',
    picks: picks.map((p, i) => ({
      overallPick: i + 1,
      round: Math.ceil((i + 1) / 12),
      pickInRound: ((i % 12) + 1),
      draftSlot: p.draftSlot,
      playerId: p.playerId,
      entryMethod: 'manual' as const,
      at: '2026-07-25T00:00:00.000Z',
    })),
  };
}

function event(names: string[]): NewsEventView {
  return {
    id: names.join('-'),
    headline: `${names[0] ?? 'Someone'} in the news`,
    eventType: 'injury',
    classification: 'IMPORTANT',
    fantasyImpact: 'MEDIUM',
    impactScore: 50,
    confidence: 0.8,
    playerDirection: 'NEGATIVE',
    positions: [],
    players: names.map((name) => ({ name })),
    sources: [{ name: 'Test' }],
    signals: [],
  };
}

describe('board context on a news item', () => {
  it('knows nothing before a draft pack exists', () => {
    const index = buildBoardIndex(null, null);
    expect(index.ready).toBe(false);
    expect(index.lookup('Jahmyr Gibbs')).toBeUndefined();
  });

  it('attaches ADP and tier from your own pack', () => {
    const index = buildBoardIndex(pack, null);
    const context = index.lookup('Patrick Mahomes')!;
    expect(context.adp).toBe(24);
    expect(context.tier).toBe(2);
    expect(context.drafted).toBe(false);
  });

  it('matches names the same way the news linker does', () => {
    // Accents and suffixes must not break the join, or a linked player would
    // silently show no board context at all.
    const withSuffix = buildDraftPack({
      league: BAY_ISLANDS,
      players: [{ id: 'x', name: 'Marvin Harrison Jr.', position: 'WR', team: 'ARI', adp: 30 }],
    });
    expect(buildBoardIndex(withSuffix, null).lookup('Marvin Harrison')?.adp).toBe(30);
  });

  it('marks a player somebody else took as drafted, not as yours', () => {
    const index = buildBoardIndex(pack, state([{ playerId: 'rb1', draftSlot: 7 }]));
    const context = index.lookup('Jahmyr Gibbs')!;
    expect(context.drafted).toBe(true);
    expect(context.mine).toBe(false);
  });

  it('marks a player you took as yours', () => {
    const index = buildBoardIndex(pack, state([{ playerId: 'rb1', draftSlot: 3 }]));
    expect(index.lookup('Jahmyr Gibbs')!.mine).toBe(true);
  });

  it('calls a player in reach of your next pick reachable', () => {
    // Slot 3, no picks made: next pick is 3. Gibbs (ADP 1.7) is going before
    // it but is close enough to reach for; the deep sleeper at ADP 190 is not
    // a decision you face right now.
    const index = buildBoardIndex(pack, state([]));
    expect(index.lookup('Jahmyr Gibbs')!.reachable).toBe(true);
    expect(index.lookup('Deep Sleeper')!.reachable).toBe(false);
  });

  it('has no opinion on reach when the draft slot is not drawn yet', () => {
    // The slot is unknown until the Aug 8 party, and "in reach" is meaningless
    // without a pick number to reach from.
    const noSlot = { ...state([]), userSlot: 0 };
    const index = buildBoardIndex(pack, noSlot);
    expect(index.lookup('Jahmyr Gibbs')!.reachable).toBeUndefined();
  });

  it('follows the snake back around on even rounds', () => {
    // 12 picks made, slot 3: round 2 reverses, so the next pick is 22, not 15.
    const picks = Array.from({ length: 12 }, (_, i) => ({
      playerId: `filler-${i}`,
      draftSlot: i + 1,
    }));
    const index = buildBoardIndex(pack, state(picks));
    // ADP 24 is within 12 of pick 22; a linear draft would have put the next
    // pick at 15 and judged this differently.
    expect(index.lookup('Patrick Mahomes')!.reachable).toBe(true);
  });
});

describe('the "my board" filter', () => {
  it('is empty rather than everything when no pack is loaded', () => {
    // The old behaviour matched any event with a linked player, which was
    // almost all of them, while claiming to be about your team.
    expect(concernsMyBoard(event(['Jahmyr Gibbs']), EMPTY_BOARD)).toBe(false);
  });

  it('includes a player still available to you', () => {
    const index = buildBoardIndex(pack, state([]));
    expect(concernsMyBoard(event(['Puka Nacua']), index)).toBe(true);
  });

  it('excludes a player another team already took', () => {
    const index = buildBoardIndex(pack, state([{ playerId: 'wr1', draftSlot: 9 }]));
    expect(concernsMyBoard(event(['Puka Nacua']), index)).toBe(false);
  });

  it('always includes your own players — that is the news that matters most', () => {
    const index = buildBoardIndex(pack, state([{ playerId: 'wr1', draftSlot: 3 }]));
    expect(concernsMyBoard(event(['Puka Nacua']), index)).toBe(true);
  });

  it('excludes a player who is not in your pack at all', () => {
    const index = buildBoardIndex(pack, state([]));
    expect(concernsMyBoard(event(['Some Practice Squad Guy']), index)).toBe(false);
  });

  it('includes an event if any linked player qualifies', () => {
    const index = buildBoardIndex(pack, state([{ playerId: 'wr1', draftSlot: 9 }]));
    expect(concernsMyBoard(event(['Puka Nacua', 'Patrick Mahomes']), index)).toBe(true);
  });
});

describe('rendering view', () => {
  it('leaves players the board has never heard of without context', () => {
    const index = buildBoardIndex(pack, state([]));
    const view = withBoardContext(event(['Nobody Special']), index);
    expect(view[0]!.board).toBeUndefined();
  });

  it('keeps every linked player, with or without context', () => {
    const index = buildBoardIndex(pack, state([]));
    const view = withBoardContext(event(['Puka Nacua', 'Nobody Special']), index);
    expect(view.map((p) => p.name)).toEqual(['Puka Nacua', 'Nobody Special']);
    expect(view[0]!.board).toBeDefined();
  });
});

describe('before draft day, when there is no draft state', () => {
  // This is the state the app lives in for the weeks of preparation, so "in
  // reach" has to mean something here or it means nothing at all until the
  // draft actually starts.
  const withSlot = buildDraftPack({
    league: { ...BAY_ISLANDS, draftSlot: 3 },
    players,
  });

  it('reaches from your first pick', () => {
    const index = buildBoardIndex(withSlot, null);
    expect(index.lookup('Jahmyr Gibbs')!.reachable).toBe(true);
    expect(index.lookup('Deep Sleeper')!.reachable).toBe(false);
  });

  it('says nothing about reach until the slot is drawn', () => {
    // The Bay Islands slot is unknown until the August 8 party. Guessing one
    // would put a confident label on a pick position nobody has.
    const index = buildBoardIndex(buildDraftPack({ league: BAY_ISLANDS, players }), null);
    expect(BAY_ISLANDS.draftSlot).toBeNull();
    expect(index.lookup('Jahmyr Gibbs')!.reachable).toBeUndefined();
  });

  it('still reports ADP and tier without a slot', () => {
    const index = buildBoardIndex(buildDraftPack({ league: BAY_ISLANDS, players }), null);
    expect(index.lookup('Jahmyr Gibbs')!.adp).toBe(1.7);
  });
});

describe('draft-range relevance for the briefing', () => {
  const packWithSlot = buildDraftPack({
    league: { ...BAY_ISLANDS, draftSlot: 3 },
    players,
  });

  it('says nothing without a board — relevance to nothing is not a claim', () => {
    expect(draftRelevant(event(['Jahmyr Gibbs']), EMPTY_BOARD, { teamCount: 12 })).toBe(false);
  });

  it('flags a player in reach of your pick', () => {
    const index = buildBoardIndex(packWithSlot, null);
    expect(draftRelevant(event(['Jahmyr Gibbs']), index, { teamCount: 12 })).toBe(true);
  });

  it('does not flag a deep-bench player just because he is available', () => {
    // "Available somewhere in a 600-player pool" is true of nearly everyone,
    // which is exactly why it must not be the bar.
    const index = buildBoardIndex(packWithSlot, null);
    expect(draftRelevant(event(['Deep Sleeper']), index, { teamCount: 12 })).toBe(false);
  });

  it('falls back to the startable range before the slot is drawn', () => {
    // No slot → no reach window → the first eight rounds stand in for it.
    const index = buildBoardIndex(buildDraftPack({ league: BAY_ISLANDS, players }), null);
    expect(draftRelevant(event(['Patrick Mahomes']), index, { teamCount: 12 })).toBe(true);
    expect(draftRelevant(event(['Deep Sleeper']), index, { teamCount: 12 })).toBe(false);
  });

  it('always flags your own players', () => {
    const index = buildBoardIndex(packWithSlot, state([{ playerId: 'wr1', draftSlot: 3 }]));
    expect(draftRelevant(event(['Puka Nacua']), index, { teamCount: 12 })).toBe(true);
  });

  it('drops a player someone else already took', () => {
    const index = buildBoardIndex(packWithSlot, state([{ playerId: 'rb1', draftSlot: 7 }]));
    expect(draftRelevant(event(['Jahmyr Gibbs']), index, { teamCount: 12 })).toBe(false);
  });
});
