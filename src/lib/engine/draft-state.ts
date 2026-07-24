import type { DraftPick, DraftState, Position } from '@/lib/types';

// ============================================================================
// Draft board state machine.
//
// Pure reducer. Every mutation returns a new state, which is what makes undo
// and correction trivial and what lets the whole thing run in the browser with
// no network (§2 principle 2).
// ============================================================================

export const DRAFT_ENGINE_VERSION = '1.0.0';

export type DraftAction =
  | { type: 'RECORD_PICK'; playerId: string; draftSlot?: number; entryMethod?: DraftPick['entryMethod'] }
  | { type: 'UNDO_LAST' }
  | { type: 'CORRECT_PICK'; overallPick: number; playerId: string; draftSlot?: number }
  | { type: 'RESET' };

export function createDraftState(params: {
  leagueId: string;
  teamCount: number;
  rounds: number;
  userSlot: number;
  draftType?: 'snake' | 'linear';
}): DraftState {
  if (!Number.isInteger(params.userSlot)) {
    throw new Error(
      'A draft slot is required to start a draft. Set it in Settings once your ' +
        'league draws the order.',
    );
  }
  if (params.userSlot < 1 || params.userSlot > params.teamCount) {
    throw new Error(
      `userSlot ${params.userSlot} is outside 1..${params.teamCount}`,
    );
  }
  return {
    leagueId: params.leagueId,
    teamCount: params.teamCount,
    rounds: params.rounds,
    draftType: params.draftType ?? 'snake',
    userSlot: params.userSlot,
    picks: [],
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Pick math
// ---------------------------------------------------------------------------

/** Which draft slot is on the clock at a given 1-indexed overall pick. */
export function slotForOverallPick(
  overallPick: number,
  teamCount: number,
  draftType: 'snake' | 'linear' = 'snake',
): number {
  const zeroBased = overallPick - 1;
  const round = Math.floor(zeroBased / teamCount);       // 0-indexed
  const posInRound = zeroBased % teamCount;              // 0-indexed
  if (draftType === 'linear' || round % 2 === 0) return posInRound + 1;
  return teamCount - posInRound;                          // snake: odd rounds reverse
}

export function roundForOverallPick(overallPick: number, teamCount: number): number {
  return Math.floor((overallPick - 1) / teamCount) + 1;
}

export function pickInRound(overallPick: number, teamCount: number): number {
  return ((overallPick - 1) % teamCount) + 1;
}

/** Every overall pick number belonging to a given slot, in order. */
export function picksForSlot(
  slot: number,
  teamCount: number,
  rounds: number,
  draftType: 'snake' | 'linear' = 'snake',
): number[] {
  const out: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const posInRound =
      draftType === 'linear' || round % 2 === 1 ? slot : teamCount - slot + 1;
    out.push((round - 1) * teamCount + posInRound);
  }
  return out;
}

/** The next overall pick number, i.e. who is on the clock. */
export function currentOverallPick(state: DraftState): number {
  return state.picks.length + 1;
}

export function isUserOnClock(state: DraftState): boolean {
  return (
    slotForOverallPick(currentOverallPick(state), state.teamCount, state.draftType) ===
    state.userSlot
  );
}

/** The user's next pick at or after the current one; null if the draft is over. */
export function userNextPick(state: DraftState): number | null {
  const all = picksForSlot(
    state.userSlot,
    state.teamCount,
    state.rounds,
    state.draftType,
  );
  const current = currentOverallPick(state);
  return all.find((p) => p >= current) ?? null;
}

/**
 * How many picks happen before the user's *following* turn.
 *
 * Interpreted as "if I pick now, how many players come off the board before I
 * pick again" — which is the number that decides whether waiting is safe. If
 * the user is not on the clock, it counts from now to their next turn instead.
 */
export function picksUntilNextTurn(state: DraftState): number | null {
  const all = picksForSlot(
    state.userSlot,
    state.teamCount,
    state.rounds,
    state.draftType,
  );
  const current = currentOverallPick(state);
  const upcoming = all.filter((p) => p >= current);

  if (upcoming.length === 0) return null;
  if (upcoming[0] === current) {
    // On the clock: gap to the following pick.
    return upcoming.length > 1 ? upcoming[1]! - current - 1 : null;
  }
  return upcoming[0]! - current;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'RECORD_PICK': {
      const overall = currentOverallPick(state);
      const maxPicks = state.teamCount * state.rounds;
      if (overall > maxPicks) return { ...state, status: 'complete' };

      if (state.picks.some((p) => p.playerId === action.playerId)) {
        throw new DraftError(
          `${action.playerId} has already been drafted (pick ${
            state.picks.find((p) => p.playerId === action.playerId)!.overallPick
          }).`,
        );
      }

      const pick: DraftPick = {
        overallPick: overall,
        round: roundForOverallPick(overall, state.teamCount),
        pickInRound: pickInRound(overall, state.teamCount),
        draftSlot:
          action.draftSlot ??
          slotForOverallPick(overall, state.teamCount, state.draftType),
        playerId: action.playerId,
        entryMethod: action.entryMethod ?? 'manual',
        at: new Date().toISOString(),
      };

      const picks = [...state.picks, pick];
      return {
        ...state,
        picks,
        status: picks.length >= maxPicks ? 'complete' : 'active',
      };
    }

    case 'UNDO_LAST': {
      if (state.picks.length === 0) return state;
      return {
        ...state,
        picks: state.picks.slice(0, -1),
        status: 'active',
      };
    }

    case 'CORRECT_PICK': {
      const idx = state.picks.findIndex((p) => p.overallPick === action.overallPick);
      if (idx === -1) {
        throw new DraftError(`No pick recorded at overall pick ${action.overallPick}.`);
      }
      const duplicate = state.picks.find(
        (p) => p.playerId === action.playerId && p.overallPick !== action.overallPick,
      );
      if (duplicate) {
        throw new DraftError(
          `${action.playerId} is already recorded at pick ${duplicate.overallPick}.`,
        );
      }
      const picks = [...state.picks];
      const existing = picks[idx]!;
      picks[idx] = {
        ...existing,
        playerId: action.playerId,
        draftSlot: action.draftSlot ?? existing.draftSlot,
      };
      return { ...state, picks };
    }

    case 'RESET':
      return { ...state, picks: [], status: 'pending' };
  }
}

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

// ---------------------------------------------------------------------------
// Views over the board
// ---------------------------------------------------------------------------

export function draftedPlayerIds(state: DraftState): Set<string> {
  return new Set(state.picks.map((p) => p.playerId));
}

export function rosterForSlot(state: DraftState, slot: number): string[] {
  return state.picks.filter((p) => p.draftSlot === slot).map((p) => p.playerId);
}

export function userRoster(state: DraftState): string[] {
  return rosterForSlot(state, state.userSlot);
}

/** Every team's roster, keyed by draft slot. */
export function allRosters(state: DraftState): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (let slot = 1; slot <= state.teamCount; slot++) map.set(slot, []);
  for (const pick of state.picks) {
    map.get(pick.draftSlot)?.push(pick.playerId);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Positional run detection (§16)
// ---------------------------------------------------------------------------

export interface PositionalRun {
  position: Position;
  countInWindow: number;
  windowSize: number;
  /** Share of the window taken by this position. */
  rate: number;
  /** Multiple of the position's baseline pick rate. 2.0 = twice normal. */
  intensity: number;
  isRun: boolean;
}

/**
 * Detect positional runs in the last `windowSize` picks.
 *
 * A run is not just "several went recently" — it's "several went *faster than
 * this position normally goes*". Six RBs in ten picks is a run; six WRs in ten
 * picks during the WR-heavy middle rounds may be perfectly normal. Comparing
 * against a baseline rate is what separates the two.
 */
export function detectRuns(
  state: DraftState,
  positionOf: (playerId: string) => Position | undefined,
  opts: {
    windowSize?: number;
    baselineRates?: Partial<Record<Position, number>>;
    minCount?: number;
    minIntensity?: number;
  } = {},
): PositionalRun[] {
  const windowSize = opts.windowSize ?? 10;
  const minCount = opts.minCount ?? 3;
  const minIntensity = opts.minIntensity ?? 1.6;

  const window = state.picks.slice(-windowSize);
  if (window.length === 0) return [];

  const counts = new Map<Position, number>();
  for (const pick of window) {
    const pos = positionOf(pick.playerId);
    if (pos) counts.set(pos, (counts.get(pos) ?? 0) + 1);
  }

  // Baseline: the observed rate across the whole draft so far, falling back to
  // league-typical shares early on when there isn't enough history.
  const overall = new Map<Position, number>();
  for (const pick of state.picks) {
    const pos = positionOf(pick.playerId);
    if (pos) overall.set(pos, (overall.get(pos) ?? 0) + 1);
  }

  const runs: PositionalRun[] = [];
  for (const [position, countInWindow] of counts) {
    const rate = countInWindow / window.length;
    const provided = opts.baselineRates?.[position];
    const observedBaseline =
      state.picks.length >= 24
        ? (overall.get(position) ?? 0) / state.picks.length
        : undefined;
    const baseline = provided ?? observedBaseline ?? FALLBACK_RATES[position];
    const intensity = baseline > 0 ? rate / baseline : 0;

    runs.push({
      position,
      countInWindow,
      windowSize: window.length,
      rate: Math.round(rate * 100) / 100,
      intensity: Math.round(intensity * 100) / 100,
      isRun: countInWindow >= minCount && intensity >= minIntensity,
    });
  }

  return runs.sort((a, b) => b.intensity - a.intensity);
}

const FALLBACK_RATES: Record<Position, number> = {
  RB: 0.34,
  WR: 0.36,
  TE: 0.11,
  QB: 0.13,
  K: 0.03,
  DST: 0.03,
};

/** Observed share of picks by position so far — feeds scarcity urgency. */
export function observedPickRates(
  state: DraftState,
  positionOf: (playerId: string) => Position | undefined,
  lookback = 24,
): Partial<Record<Position, number>> {
  const window = state.picks.slice(-lookback);
  if (window.length < 8) return {};
  const counts = new Map<Position, number>();
  for (const pick of window) {
    const pos = positionOf(pick.playerId);
    if (pos) counts.set(pos, (counts.get(pos) ?? 0) + 1);
  }
  const out: Partial<Record<Position, number>> = {};
  for (const [pos, n] of counts) out[pos] = n / window.length;
  return out;
}
