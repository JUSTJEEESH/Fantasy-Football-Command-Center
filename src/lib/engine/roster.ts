import type { League, LineupSlot, PlayerCard, Position } from '@/lib/types';
import { POSITIONS, SLOT_ELIGIBILITY } from '@/lib/types';
import { round2 } from './scoring';

// ============================================================================
// Roster awareness (§15).
//
// The engine must know that after RB1/RB2/WR1/WR2 the marginal value of a
// third RB is not the same as the marginal value of a third WR, and that both
// differ from filling an empty starting TE slot. That is what this module
// computes: how much a given player would actually add to THIS roster.
// ============================================================================

export interface RosterAnalysis {
  /** Count of rostered players by position. */
  counts: Record<Position, number>;
  /** Starting slots still unfilled, in priority order. */
  unfilledSlots: LineupSlot[];
  /** 0..1 need per position; 1 = an empty required starting slot. */
  needs: Record<Position, number>;
  /** Total projected points of the optimal starting lineup. */
  startingPoints: number;
  /** Positions where the roster is weakest relative to what it must start. */
  weakestPositions: Position[];
  /** Bye weeks with 2+ starters unavailable. */
  byeConflicts: Array<{ week: number; playerIds: string[] }>;
  /** Roster spots filled vs total. */
  filled: number;
  total: number;
}

/**
 * Greedily fill the optimal starting lineup: dedicated slots first (they are
 * the most constrained), then flex slots from whatever is left. Greedy is
 * correct here because slot eligibility is nested — anything eligible for a
 * dedicated slot is also flex-eligible, never the reverse.
 */
export function fillLineup(
  roster: PlayerCard[],
  rosterSlots: Partial<Record<LineupSlot, number>>,
): { starters: Map<LineupSlot, PlayerCard[]>; bench: PlayerCard[]; points: number } {
  const remaining = [...roster].sort(
    (a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0),
  );
  const starters = new Map<LineupSlot, PlayerCard[]>();
  let points = 0;

  // Dedicated single-position slots first, then progressively wider flexes.
  const order: LineupSlot[] = [
    'QB', 'RB', 'WR', 'TE', 'K', 'DST',
    'WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPERFLEX',
  ];

  for (const slot of order) {
    const count = rosterSlots[slot] ?? 0;
    if (count <= 0) continue;
    const eligible = SLOT_ELIGIBILITY[slot];
    const picked: PlayerCard[] = [];
    for (let i = 0; i < count; i++) {
      const idx = remaining.findIndex((p) => eligible.includes(p.position));
      if (idx === -1) break;
      const [player] = remaining.splice(idx, 1);
      picked.push(player!);
      points += player!.projectedPoints ?? 0;
    }
    if (picked.length) starters.set(slot, picked);
  }

  return { starters, bench: remaining, points: round2(points) };
}

export function analyzeRoster(
  roster: PlayerCard[],
  league: League,
): RosterAnalysis {
  const counts = Object.fromEntries(POSITIONS.map((p) => [p, 0])) as Record<
    Position,
    number
  >;
  for (const p of roster) counts[p.position]++;

  const { starters, points } = fillLineup(roster, league.rosterSlots);

  // Which starting slots are still empty?
  const unfilledSlots: LineupSlot[] = [];
  for (const [slot, required] of Object.entries(league.rosterSlots) as Array<
    [LineupSlot, number]
  >) {
    if (slot === 'BENCH') continue;
    const filledCount = starters.get(slot)?.length ?? 0;
    for (let i = filledCount; i < required; i++) unfilledSlots.push(slot);
  }

  // Need per position. An empty dedicated slot is maximal need; an empty flex
  // spreads need across its eligible positions. Depth beyond the starting
  // requirement decays rather than dropping to zero — a 3rd RB still has real
  // value as insurance and flex fodder, just less than a 1st.
  const needs = Object.fromEntries(POSITIONS.map((p) => [p, 0])) as Record<
    Position,
    number
  >;
  for (const slot of unfilledSlots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    const share = 1 / eligible.length;
    for (const pos of eligible) {
      needs[pos] = Math.min(1, needs[pos] + (eligible.length === 1 ? 1 : share));
    }
  }
  for (const pos of POSITIONS) {
    if (needs[pos] > 0) continue;
    // Starters covered — remaining value is depth value, decaying with count.
    const required = requiredStarters(league.rosterSlots, pos);
    const depth = Math.max(0, counts[pos] - required);
    const depthValue =
      pos === 'K' || pos === 'DST'
        ? 0
        : Math.max(0, 0.35 * Math.pow(0.55, depth));
    needs[pos] = round2(depthValue);
  }

  // Weakest = highest need among positions we must start.
  const weakestPositions = POSITIONS.filter(
    (p) => requiredStarters(league.rosterSlots, p) > 0,
  )
    .sort((a, b) => needs[b] - needs[a])
    .filter((p) => needs[p] > 0.3)
    .slice(0, 3);

  // Bye conflicts among likely starters only — a bench player's bye is free.
  const starterIds = new Set(
    [...starters.values()].flat().map((p) => p.id),
  );
  const byeMap = new Map<number, string[]>();
  for (const p of roster) {
    if (!p.byeWeek || !starterIds.has(p.id)) continue;
    byeMap.set(p.byeWeek, [...(byeMap.get(p.byeWeek) ?? []), p.id]);
  }
  const byeConflicts = [...byeMap.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([week, playerIds]) => ({ week, playerIds }))
    .sort((a, b) => a.week - b.week);

  const total =
    Object.entries(league.rosterSlots)
      .filter(([s]) => s !== 'BENCH')
      .reduce((sum, [, n]) => sum + (n ?? 0), 0) + league.benchSize;

  return {
    counts,
    unfilledSlots,
    needs,
    startingPoints: points,
    weakestPositions,
    byeConflicts,
    filled: roster.length,
    total,
  };
}

/** How many starters of a position the league requires (flex counted fractionally). */
export function requiredStarters(
  rosterSlots: Partial<Record<LineupSlot, number>>,
  position: Position,
): number {
  return rosterSlots[position as LineupSlot] ?? 0;
}

/**
 * Marginal value of adding a player to this roster, in projected points.
 *
 * Measured by rebuilding the optimal lineup with the player added and taking
 * the difference. That automatically handles "he'd be my WR4 and I only start
 * 3" (small gain, flex-dependent) versus "he'd be my only TE" (large gain),
 * without any hand-tuned position rules.
 *
 * `replacementPoints` matters more than it looks. Without it, an unfilled slot
 * is valued as if it would otherwise score zero — so in the middle rounds a
 * kicker appears to add ~150 points, because the kicker slot is still empty.
 * That is not the real counterfactual: nobody starts week 1 with an empty
 * kicker slot. Padding the roster with replacement-level players at every
 * unfilled slot makes this "points above what I could otherwise field", which
 * is the number that should actually drive a pick.
 */
export function marginalLineupValue(
  roster: PlayerCard[],
  candidate: PlayerCard,
  league: League,
  replacementPoints?: Partial<Record<Position, number>>,
): number {
  const padded = replacementPoints
    ? [...roster, ...replacementFillers(replacementPoints, league)]
    : roster;
  const before = fillLineup(padded, league.rosterSlots).points;
  const after = fillLineup([...padded, candidate], league.rosterSlots).points;
  return round2(after - before);
}

/**
 * Synthetic replacement-level players, one per position per startable slot.
 * They stand in for "whoever I could get off the last rounds or waivers", so
 * an empty slot is never valued as a zero.
 */
function replacementFillers(
  replacementPoints: Partial<Record<Position, number>>,
  league: League,
): PlayerCard[] {
  const slotsTotal = Object.entries(league.rosterSlots)
    .filter(([slot]) => slot !== 'BENCH')
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);

  const fillers: PlayerCard[] = [];
  for (const position of POSITIONS) {
    const points = replacementPoints[position];
    if (points === undefined) continue;
    for (let i = 0; i < slotsTotal; i++) {
      fillers.push({
        id: `__replacement_${position}_${i}`,
        name: `Replacement ${position}`,
        position,
        team: null,
        projectedPoints: points,
      });
    }
  }
  return fillers;
}

/**
 * Roster-fit multiplier, 0.6..1.35.
 *
 * Deliberately bounded. Positional need should tilt close calls, not override
 * a genuinely large talent gap — reaching two tiers down to fill a slot in
 * round 3 loses more than it gains, and an unbounded need factor would do
 * exactly that.
 */
export function rosterFitMultiplier(
  analysis: RosterAnalysis,
  candidate: PlayerCard,
  league: League,
  opts: { round: number; totalRounds: number } = { round: 1, totalRounds: 16 },
): number {
  const need = analysis.needs[candidate.position] ?? 0;

  // Need matters more as the draft progresses: in round 1 take the best player,
  // by round 10 an unfilled starting slot is an emergency.
  const progress = Math.min(1, opts.round / Math.max(1, opts.totalRounds * 0.75));
  const needWeight = 0.15 + 0.45 * progress;

  let multiplier = 1 + needWeight * (need - 0.4);

  // Roster limits: never recommend a player who cannot be rostered, and heavily
  // damp positions that are already full past any plausible use.
  const required = requiredStarters(league.rosterSlots, candidate.position);
  const count = analysis.counts[candidate.position] ?? 0;
  if ((candidate.position === 'K' || candidate.position === 'DST') && count >= required) {
    multiplier *= 0.15;
  }
  if (candidate.position === 'QB' && count >= required + 1) multiplier *= 0.3;

  // NOTE: the cost of drafting a K/DST early is deliberately NOT applied here.
  // A multiplier cannot express it correctly — scaling a small positive score
  // can never push a player below the deep-bench alternatives it should lose
  // to. It is modeled as an explicit points cost in recommend.ts
  // (EARLY_KDST_COST) instead.

  return round2(Math.max(0.05, Math.min(1.35, multiplier)));
}
