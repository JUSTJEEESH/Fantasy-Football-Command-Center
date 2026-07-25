import { searchKey } from '@/lib/sources/types';
import type { NewsEventView } from '@/lib/static-data';
import type { DraftPack } from '@/lib/draft-pack';
import type { DraftState, PlayerCard } from '@/lib/types';

// ============================================================================
// Connecting the news feed to YOUR board.
//
// A headline about a player you would never draft and a headline about your
// likely third-rounder look identical in a feed. The difference is entirely in
// what you already know about him — where he goes, what tier he is in, whether
// he is still on the board — and the app already knows all of that.
//
// This module joins the two, and is deliberately separate from both so it can
// be tested without a browser and without a network.
// ============================================================================

export interface BoardContext {
  /** Average draft position, when the pack has one. */
  adp?: number;
  tier?: number;
  /** Already taken in the draft currently in progress. */
  drafted: boolean;
  /** On your roster specifically, rather than anyone's. */
  mine: boolean;
  /**
   * Within reach of your next pick. Absent when there is no draft running —
   * "reachable" is meaningless without a pick number to reach from.
   */
  reachable?: boolean;
}

/** A news player with whatever the board knows about them attached. */
export interface LinkedPlayerView {
  name: string;
  position?: string;
  team?: string | null;
  board?: BoardContext;
}

export interface BoardIndex {
  /** Present only when a draft pack has been built. */
  ready: boolean;
  lookup: (name: string) => BoardContext | undefined;
}

/** Nothing known — used before a pack exists, so callers need no null checks. */
export const EMPTY_BOARD: BoardIndex = { ready: false, lookup: () => undefined };

/**
 * Build a name → board-context lookup from the offline draft pack and the
 * draft in progress.
 *
 * Matching is on the same normalized key the news linker uses, so a player
 * linked in a headline and the same player on the board resolve identically.
 */
export function buildBoardIndex(
  pack: DraftPack | null,
  state: DraftState | null,
): BoardIndex {
  if (!pack || pack.players.length === 0) return EMPTY_BOARD;

  const draftedIds = new Set((state?.picks ?? []).map((p) => p.playerId));
  const mineIds = new Set(
    (state?.picks ?? [])
      .filter((p) => p.draftSlot === state?.userSlot)
      .map((p) => p.playerId),
  );

  // Where your next pick lands, so "reachable" means something concrete.
  //
  // Before draft day there is no draft state, but there is still a pick you
  // are preparing for: your first one. Between now and August that is the only
  // pick that exists, so falling back to it is what makes this useful during
  // the weeks of preparation rather than only during the 90 minutes of the
  // draft itself. If the slot has not been drawn yet, there is genuinely
  // nothing to reach from and the label stays off.
  const nextPick = state
    ? nextPickNumber(state)
    : (pack.league.draftSlot ?? null);

  const byKey = new Map<string, BoardContext>();
  for (const player of pack.players) {
    const context: BoardContext = {
      drafted: draftedIds.has(player.id),
      mine: mineIds.has(player.id),
    };
    if (player.adp !== undefined) context.adp = player.adp;
    if (player.tier !== undefined) context.tier = player.tier;
    if (nextPick !== null && player.adp !== undefined) {
      // A window around your next pick, one round either side.
      //
      // Both edges matter. Without the upper bound every deep sleeper counts
      // as "in reach" — a player going at ADP 190 is not a decision you face
      // at pick 3, and saying he is drains the label of meaning. Without the
      // lower bound you would miss the player you would have to reach slightly
      // for, which is exactly the call worth flagging.
      const window = state?.teamCount ?? 12;
      context.reachable =
        !context.drafted &&
        player.adp >= nextPick - window &&
        player.adp <= nextPick + window;
    }
    byKey.set(searchKey(player.name), context);
  }

  return { ready: true, lookup: (name) => byKey.get(searchKey(name)) };
}

/** The user's next pick number, or null if there isn't one left. */
function nextPickNumber(state: DraftState): number | null {
  const { teamCount: teams, userSlot } = state;
  if (!userSlot) return null;   // slot not drawn yet — nothing to reach from
  for (let pick = state.picks.length + 1; pick <= teams * state.rounds; pick++) {
    const round = Math.ceil(pick / teams);
    const inRound = ((pick - 1) % teams) + 1;
    // Snake reverses on even rounds; linear does not.
    const slot =
      state.draftType === 'linear' || round % 2 === 1 ? inRound : teams + 1 - inRound;
    if (slot === userSlot) return pick;
  }
  return null;
}

/** Attach board context to each player an event was linked to. */
export function withBoardContext(
  event: NewsEventView,
  index: BoardIndex,
): LinkedPlayerView[] {
  return event.players.map((p) => {
    const board = index.lookup(p.name);
    return board ? { ...p, board } : { ...p };
  });
}

/**
 * Does this event concern a player you might actually draft?
 *
 * Stricter than `concernsMyBoard`: not merely "still available", but inside
 * the range you would realistically spend a pick on. With a draft slot set,
 * that is the reach window around your next pick; before the slot is drawn it
 * falls back to the startable range — the first eight rounds — because
 * "available somewhere in a 600-player pool" is true of almost everyone and
 * therefore says almost nothing.
 *
 * Your own players always qualify. News about your roster is the news.
 */
export function draftRelevant(
  event: NewsEventView,
  index: BoardIndex,
  opts: { teamCount: number },
): boolean {
  if (!index.ready) return false;
  return event.players.some((p) => {
    const board = index.lookup(p.name);
    if (!board) return false;
    if (board.mine) return true;
    if (board.drafted) return false;
    if (board.reachable !== undefined) return board.reachable;
    return board.adp !== undefined && board.adp <= opts.teamCount * 8;
  });
}

/**
 * Does this event concern a player on your board?
 *
 * "On your board" means a player you could still end up with: someone in your
 * pack who has not been drafted by somebody else. A player you already own
 * counts too — news about your own roster is the most relevant news there is.
 *
 * This is the honest version of a filter that used to be labelled "My board"
 * while actually testing "was linked to any player at all". That matched
 * essentially every story and told you nothing about your team.
 */
export function concernsMyBoard(event: NewsEventView, index: BoardIndex): boolean {
  if (!index.ready) return false;
  return event.players.some((p) => {
    const board = index.lookup(p.name);
    if (!board) return false;
    if (board.mine) return true;
    return !board.drafted;
  });
}
